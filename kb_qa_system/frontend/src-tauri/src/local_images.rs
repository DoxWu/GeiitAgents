use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::{header::CONTENT_LENGTH, Url};

const MAX_RESPONSE_BYTES: usize = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 1_500_000;

enum GeneratedImage {
    Embedded(String),
    Url(Url),
}

fn parse_image_result(body: &[u8], endpoint: &Url) -> Result<GeneratedImage, String> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| "Invalid image response")?;
    let image = if let Some(images) = value["data"].as_array().filter(|items| items.len() == 1) {
        images[0].clone()
    } else {
        let choices = value["output"]["choices"]
            .as_array()
            .filter(|items| items.len() == 1)
            .ok_or("Invalid image response")?;
        let images: Vec<&str> = choices[0]["message"]["content"]
            .as_array()
            .ok_or("Invalid image response")?
            .iter()
            .filter_map(|part| part["image"].as_str())
            .collect();
        if images.len() != 1 {
            return Err("Invalid image response".into());
        }
        serde_json::json!({"url": images[0]})
    };
    if let Some(encoded) = image["b64_json"]
        .as_str()
        .filter(|text| !text.is_empty() && text.len() <= 2_100_000)
    {
        return Ok(GeneratedImage::Embedded(encoded.into()));
    }
    let value = image["url"]
        .as_str()
        .filter(|url| !url.is_empty() && url.len() <= 2048)
        .ok_or("Missing image data")?;
    let url = endpoint.join(value).map_err(|_| "Invalid image URL")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || !["https", "http"].contains(&url.scheme())
    {
        return Err("Invalid image URL".into());
    }
    validate_image_url(&url, endpoint)?;
    Ok(GeneratedImage::Url(url))
}

fn local_origin(url: &Url) -> bool {
    ["localhost", "127.0.0.1", "[::1]"].contains(&url.host_str().unwrap_or(""))
}

fn same_local_origin(url: &Url, endpoint: &Url) -> bool {
    local_origin(endpoint)
        && url.scheme() == endpoint.scheme()
        && url.host_str() == endpoint.host_str()
        && url.port_or_known_default() == endpoint.port_or_known_default()
}

fn validate_image_url(url: &Url, endpoint: &Url) -> Result<(), String> {
    if same_local_origin(url, endpoint) {
        return Ok(());
    }
    if url.scheme() != "https" || url.port_or_known_default() != Some(443) {
        return Err("Image URL must use public HTTPS".into());
    }
    if let Ok(ip) = url
        .host_str()
        .unwrap_or("")
        .trim_matches(['[', ']'])
        .parse::<IpAddr>()
    {
        if !public_address(ip) {
            return Err("Image host is not public".into());
        }
    }
    Ok(())
}

fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            let second = octets[1];
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_unspecified()
                || ip.is_multicast()
                || octets[0] == 0
                || octets[0] == 100 && (64..=127).contains(&second)
                || octets[0] == 192
                    && (octets[1] == 0
                        || octets[1] == 88 && octets[2] == 99
                        || octets[1] == 0 && octets[2] == 2)
                || octets[0] == 198
                    && ((18..=19).contains(&second) || second == 51 && octets[2] == 100)
                || octets[0] == 203 && second == 0 && octets[2] == 113
                || octets[0] >= 224)
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            segments[0] & 0xe000 == 0x2000
                && !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_unique_local()
                && !ip.is_unicast_link_local()
                && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
        }
    }
}

async fn download_image(url: Url, endpoint: &Url) -> Result<Vec<u8>, String> {
    validate_image_url(&url, endpoint)?;
    let same_local_origin = same_local_origin(&url, endpoint);
    let host = url
        .host_str()
        .ok_or("Invalid image host")?
        .trim_matches(['[', ']'])
        .to_owned();
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15));

    if !same_local_origin {
        if url.scheme() != "https" || url.port_or_known_default() != Some(443) {
            return Err("Image URL must use public HTTPS".into());
        }
        let port = url.port_or_known_default().ok_or("Invalid image port")?;
        if let Ok(ip) = host.parse::<IpAddr>() {
            if !public_address(ip) {
                return Err("Image host is not public".into());
            }
        } else {
            let addresses: Vec<SocketAddr> = tokio::time::timeout(
                Duration::from_secs(5),
                tokio::net::lookup_host((host.as_str(), port)),
            )
            .await
            .map_err(|_| "Image host lookup timed out")?
            .map_err(|_| "Image host lookup failed")?
            .collect();
            if addresses.is_empty()
                || addresses
                    .iter()
                    .any(|address| !public_address(address.ip()))
            {
                return Err("Image host is not public".into());
            }
            builder = builder.resolve_to_addrs(&host, &addresses);
        }
    }

    let client = builder.build().map_err(|_| "Image client unavailable")?;
    let response = client
        .get(url)
        .header("Accept", "image/png,image/jpeg,image/webp")
        .send()
        .await
        .map_err(|_| "Image download failed")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("Image download failed".into());
    }
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length == 0 || length > MAX_IMAGE_BYTES)
    {
        return Err("Image size is invalid".into());
    }
    let mut bytes = Vec::new();
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Invalid image response")?
    {
        if bytes.len() + chunk.len() > MAX_IMAGE_BYTES {
            return Err("Image too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() || image_mime(&bytes).is_none() {
        return Err("Unsupported image format".into());
    }
    Ok(bytes)
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

pub fn validate_size(size: &str) -> Result<(), String> {
    let dimensions: Vec<&str> = size.split('x').collect();
    if dimensions.len() != 2
        || dimensions.iter().any(|value| {
            value.is_empty()
                || !value.bytes().all(|c| c.is_ascii_digit())
                || value.parse::<u32>().map_or(true, |n| {
                    !(512..=2048).contains(&n) || n % 16 != 0 || n.to_string() != *value
                })
        })
    {
        return Err("Invalid image size".into());
    }
    Ok(())
}

fn reference_bytes(references: &[String]) -> Result<Vec<(&'static str, Vec<u8>)>, String> {
    if references.len() > 2 {
        return Err("Invalid reference images".into());
    }
    references
        .iter()
        .map(|image| {
            if image.len() > 2_000_050 {
                return Err("Invalid reference images".into());
            }
            let (header, encoded) = image.split_once(',').ok_or("Invalid reference images")?;
            let mime = match header {
                "data:image/png;base64" => "image/png",
                "data:image/jpeg;base64" => "image/jpeg",
                "data:image/webp;base64" => "image/webp",
                _ => return Err("Invalid reference images".into()),
            };
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| "Invalid reference images")?;
            if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES || image_mime(&bytes) != Some(mime)
            {
                return Err("Invalid reference images".into());
            }
            Ok((mime, bytes))
        })
        .collect()
}

fn dashscope_endpoint(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("");
    [
        "dashscope.aliyuncs.com",
        "dashscope-intl.aliyuncs.com",
        "dashscope-us.aliyuncs.com",
    ]
    .contains(&host)
        || [
            ".cn-beijing.maas.aliyuncs.com",
            ".ap-southeast-1.maas.aliyuncs.com",
        ]
        .iter()
        .any(|suffix| {
            host.strip_suffix(suffix).is_some_and(|prefix| {
                !prefix.is_empty()
                    && prefix
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            })
        })
}

fn image_request(
    client: &reqwest::Client,
    mut url: Url,
    model: &str,
    prompt: &str,
    size: &str,
    references: &[String],
) -> Result<reqwest::RequestBuilder, String> {
    let images = reference_bytes(references)?;
    if images.is_empty() {
        return Ok(client.post(url).json(&serde_json::json!({ "model": model, "prompt": prompt, "n": 1, "size": size, "response_format": "b64_json" })));
    }
    if dashscope_endpoint(&url) {
        url.set_path("/api/v1/services/aigc/multimodal-generation/generation");
        let mut content: Vec<serde_json::Value> = references
            .iter()
            .map(|image| serde_json::json!({"image": image}))
            .collect();
        content.push(serde_json::json!({"text": prompt}));
        return Ok(client.post(url).json(&serde_json::json!({ "model": model, "input": {"messages": [{"role": "user", "content": content}]},
            "parameters": {"n": 1, "size": size.replace('x', "*"), "prompt_extend": false, "watermark": false} })));
    }
    let path = url
        .path()
        .strip_suffix("images/generations")
        .ok_or("Invalid image endpoint")?
        .to_owned();
    url.set_path(&format!("{path}images/edits"));
    // Bounded multipart with fixed field/filenames; avoid adding platform dependencies.
    // Ensure the delimiter cannot occur in user text or decoded image bytes.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut sequence = 0;
    let boundary = loop {
        let candidate = format!("geiit-image-{nonce:x}-{sequence}");
        if !model.contains(&candidate)
            && !prompt.contains(&candidate)
            && images.iter().all(|(_, bytes)| {
                !bytes
                    .windows(candidate.len())
                    .any(|part| part == candidate.as_bytes())
            })
        {
            break candidate;
        }
        sequence += 1;
    };
    let mut body = Vec::new();
    for (field, value) in [
        ("model", model),
        ("prompt", prompt),
        ("n", "1"),
        ("size", size),
        ("response_format", "b64_json"),
    ] {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    for (index, (mime, bytes)) in images.iter().enumerate() {
        let field = if images.len() == 1 {
            "image"
        } else {
            "image[]"
        };
        let extension = if *mime == "image/jpeg" {
            "jpg"
        } else {
            &mime[6..]
        };
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"reference-{}.{extension}\"\r\nContent-Type: {mime}\r\n\r\n", index + 1).as_bytes());
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok(client
        .post(url)
        .header(
            "Content-Type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body))
}

fn provider_error(status: u16, body: &[u8], references: bool) -> &'static str {
    let value: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
    let code = value["code"]
        .as_str()
        .or_else(|| value["error"]["code"].as_str());
    if code == Some("AllocationQuota.FreeTierOnly") {
        return "IMAGE_EDIT_QUOTA";
    }
    match status {
        401 | 403 => "IMAGE_AUTH_REJECTED",
        429 => "IMAGE_RATE_LIMIT",
        400 | 404 | 405 | 415 | 422 if references => "IMAGE_REFERENCE_UNSUPPORTED",
        _ => "Image generation failed",
    }
}

pub async fn generate(
    url: Url,
    api_key: String,
    model: String,
    prompt: String,
    size: String,
    references: Vec<String>,
) -> Result<String, String> {
    validate_size(&size)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(115))
        .build()
        .map_err(|_| "Image client unavailable")?;
    let mut request = image_request(&client, url.clone(), &model, &prompt, &size, &references)?;
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "Image generation failed")?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Invalid image response")?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("Image response too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        return Err(provider_error(status.as_u16(), &bytes, !references.is_empty()).into());
    }
    let provider_endpoint = url;
    let image = parse_image_result(&bytes, &provider_endpoint)?;
    match image {
        GeneratedImage::Embedded(encoded) => {
            let bytes = STANDARD
                .decode(&encoded)
                .map_err(|_| "Invalid image data")?;
            if bytes.len() > MAX_IMAGE_BYTES || image_mime(&bytes).is_none() {
                return Err("Invalid image data".into());
            }
            Ok(encoded)
        }
        GeneratedImage::Url(image_url) => {
            let bytes = download_image(image_url, &provider_endpoint).await?;
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err("Image too large".into());
            }
            Ok(STANDARD.encode(bytes))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference() -> String {
        format!(
            "data:image/png;base64,{}",
            STANDARD.encode(b"\x89PNG\r\n\x1a\n")
        )
    }

    #[test]
    fn sends_original_reference_bytes_in_multipart_edits() {
        let client = reqwest::Client::new();
        for count in [1, 2] {
            let endpoint = Url::parse("http://127.0.0.1:9001/v1/images/generations").unwrap();
            let request = image_request(
                &client,
                endpoint,
                "edit",
                "keep subject",
                "1536x864",
                &vec![reference(); count],
            )
            .unwrap()
            .build()
            .unwrap();
            assert_eq!(
                request.url().as_str(),
                "http://127.0.0.1:9001/v1/images/edits"
            );
            assert!(request.headers()["content-type"]
                .to_str()
                .unwrap()
                .starts_with("multipart/form-data; boundary="));
            let body = request.body().unwrap().as_bytes().unwrap();
            assert_eq!(
                body.windows(8)
                    .filter(|part| *part == b"\x89PNG\r\n\x1a\n")
                    .count(),
                count
            );
            let text = String::from_utf8_lossy(body);
            assert!(text.contains(if count == 1 {
                "name=\"image\""
            } else {
                "name=\"image[]\""
            }));
            assert!(text.contains("1536x864") && text.contains("keep subject"));
        }
    }

    #[test]
    fn sends_qwen_reference_data_to_the_same_official_origin() {
        let client = reqwest::Client::new();
        let endpoint = Url::parse(
            "https://ws-fixture.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/images/generations",
        )
        .unwrap();
        let request = image_request(
            &client,
            endpoint,
            "qwen-image-3.0-pro",
            "keep subject",
            "1536x864",
            &[reference(), reference()],
        )
        .unwrap()
        .build()
        .unwrap();
        assert_eq!(request.url().as_str(), "https://ws-fixture.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
        let body: serde_json::Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(
            body["input"]["messages"][0]["content"],
            serde_json::json!([{"image": reference()}, {"image": reference()}, {"text": "keep subject"}])
        );
        assert_eq!(body["parameters"]["size"], "1536*864");
        let result = parse_image_result(br#"{"output":{"choices":[{"message":{"content":[{"image":"https://cdn.example/result.png"}]}}]}}"#, request.url()).unwrap();
        assert!(
            matches!(result, GeneratedImage::Url(url) if url.host_str() == Some("cdn.example"))
        );
        assert!(!dashscope_endpoint(
            &Url::parse("https://dashscope.aliyuncs.com.evil.example/v1").unwrap()
        ));
    }

    #[test]
    fn rejects_mismatched_oversized_and_excessive_references() {
        assert!(reference_bytes(&vec![reference(); 3]).is_err());
        assert!(reference_bytes(&[reference().replace("image/png", "image/jpeg")]).is_err());
        assert!(reference_bytes(&["https://cdn.example/input.png".into()]).is_err());
        assert!(reference_bytes(&[format!(
            "data:image/png;base64,{}",
            STANDARD.encode(vec![0u8; MAX_IMAGE_BYTES + 1])
        )])
        .is_err());
    }

    #[test]
    fn maps_only_fixed_provider_errors() {
        assert_eq!(
            provider_error(
                403,
                br#"{"code":"AllocationQuota.FreeTierOnly","message":"secret"}"#,
                true
            ),
            "IMAGE_EDIT_QUOTA"
        );
        assert_eq!(
            provider_error(404, b"secret", true),
            "IMAGE_REFERENCE_UNSUPPORTED"
        );
        assert_eq!(
            provider_error(500, b"secret", true),
            "Image generation failed"
        );
    }

    #[test]
    fn validates_dimensions_before_provider_requests() {
        for size in ["1024x1024", "1536x864", "864x1536", "2048x2048"] {
            assert!(validate_size(size).is_ok());
        }
        for size in [
            "1x1",
            "1025x1024",
            "4096x1024",
            "1024x1024x1",
            " 1024x1024",
            "0512x1024",
        ] {
            assert!(validate_size(size).is_err());
        }
    }

    #[test]
    fn parses_embedded_and_url_image_results() {
        let endpoint = Url::parse("https://models.example/v1/images/generations").unwrap();
        let embedded =
            parse_image_result(br#"{"data":[{"b64_json":"aGVsbG8="}]}"#, &endpoint).unwrap();
        assert!(matches!(embedded, GeneratedImage::Embedded(value) if value == "aGVsbG8="));
        let linked = parse_image_result(
            br#"{"data":[{"url":"https://images.example/result?sig=test"}]}"#,
            &endpoint,
        )
        .unwrap();
        assert!(
            matches!(linked, GeneratedImage::Url(value) if value.host_str() == Some("images.example"))
        );
    }

    #[test]
    fn rejects_private_and_insecure_image_urls() {
        let endpoint = Url::parse("https://models.example/v1/images/generations").unwrap();
        for value in [
            r#"{"data":[{"url":"http://127.0.0.1/private"}]}"#,
            r#"{"data":[{"url":"https://127.0.0.1/result"}]}"#,
        ] {
            assert!(parse_image_result(value.as_bytes(), &endpoint).is_err());
        }
        assert!(!public_address("10.0.0.1".parse().unwrap()));
        assert!(image_mime(b"\x89PNG\r\n\x1a\n").is_some());
        assert!(image_mime(b"not an image").is_none());
    }

    #[tokio::test]
    async fn downloads_an_image_from_the_configured_local_model_origin() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            let _ = stream.read(&mut request).unwrap();
            let image = b"\x89PNG\r\n\x1a\n";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                image.len()
            )
            .unwrap();
            stream.write_all(image).unwrap();
        });
        let endpoint = Url::parse(&format!("http://{address}/v1/images/generations")).unwrap();
        let image_url = endpoint.join("/generated.png").unwrap();

        let downloaded = download_image(image_url, &endpoint).await.unwrap();

        server.join().unwrap();
        assert_eq!(downloaded, b"\x89PNG\r\n\x1a\n");
    }
}
