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
    let images = value["data"]
        .as_array()
        .filter(|items| items.len() == 1)
        .ok_or("Invalid image response")?;
    if let Some(encoded) = images[0]["b64_json"]
        .as_str()
        .filter(|text| !text.is_empty() && text.len() <= 2_100_000)
    {
        return Ok(GeneratedImage::Embedded(encoded.into()));
    }
    let value = images[0]["url"]
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

pub async fn generate(
    url: Url,
    api_key: String,
    model: String,
    prompt: String,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(115))
        .build()
        .map_err(|_| "Image client unavailable")?;
    let mut request = client.post(url.clone()).json(&serde_json::json!({ "model": model, "prompt": prompt, "n": 1, "size": "1024x1024", "response_format": "b64_json" }));
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "Image generation failed")?;
    if !response.status().is_success() {
        return Err("Image generation failed".into());
    }
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
    let provider_endpoint = url;
    let image = parse_image_result(&bytes, &provider_endpoint)?;
    match image {
        GeneratedImage::Embedded(encoded) => Ok(encoded),
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
