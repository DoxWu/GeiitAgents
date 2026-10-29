use std::time::Duration;

pub async fn generate(url: reqwest::Url, api_key: String, model: String, prompt: String) -> Result<String, String> {
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(115)).build().map_err(|_| "Image client unavailable")?;
    let mut request = client.post(url).json(&serde_json::json!({ "model": model, "prompt": prompt, "n": 1, "size": "1024x1024", "response_format": "b64_json" }));
    if !api_key.is_empty() { request = request.bearer_auth(api_key); }
    let mut response = request.send().await.map_err(|_| "Image generation failed")?;
    if !response.status().is_success() { return Err("Image generation failed".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Invalid image response")? {
        if bytes.len() + chunk.len() > 3 * 1024 * 1024 { return Err("Image response too large".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid image response")?;
    let images = value["data"].as_array().filter(|items| items.len() == 1).ok_or("Invalid image response")?;
    let encoded = images[0]["b64_json"].as_str().filter(|text| !text.is_empty() && text.len() <= 2_000_000).ok_or("Missing embedded image")?;
    // The caller validates base64, byte size and image signature before use.
    Ok(encoded.into())
}
