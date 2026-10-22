#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::State;
use tokio::sync::oneshot;

mod local_stream;
mod local_tools;
mod web_preview;
#[cfg(windows)]
mod organizer;

#[derive(Default)]
struct Requests(Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Deserialize, Serialize)]
struct Message {
    role: String,
    content: serde_json::Value,
}

fn valid_message_content(content: &serde_json::Value) -> bool {
    let Some(parts) = content.as_array() else {
        return content.as_str().is_some_and(|text| text.len() <= 400_000);
    };
    if parts.is_empty() || parts.len() > 4
        || parts[0].as_object().is_none_or(|part| part.len() != 2 || part.get("type") != Some(&serde_json::json!("text")))
        || !parts[0]["text"].as_str().is_some_and(|text| text.len() <= 400_000)
    { return false; }
    let mut images = 0;
    parts.iter().skip(1).all(|part| {
        if part.as_object().is_none_or(|value| value.len() != 2 || value.get("type") != Some(&serde_json::json!("image_url")))
            || part["image_url"].as_object().is_none_or(|value| value.len() != 1)
        { return false; }
        images += 1;
        let Some(url) = part["image_url"]["url"].as_str() else { return false; };
        let Some((header, data)) = url.split_once(",") else { return false; };
        if !data.is_ascii() { return false; }
        let padding = data.bytes().rev().take_while(|byte| *byte == b'=').count();
        ["data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"].contains(&header)
            && !data.is_empty() && data.len() <= 2_100_000 && data.len() % 4 == 0 && padding <= 2
            && !data[..data.len() - padding].contains('=')
            && data.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte))
    }) && images <= 3
}

#[derive(Serialize, Debug)]
struct Completion { content: String, finish_reason: &'static str }

#[derive(Serialize)]
struct TextDelta { content: String }

fn local_endpoint(base_url: &str, resource: &str) -> Result<reqwest::Url, String> {
    if base_url.len() > 8192 || base_url.chars().any(|c| c <= ' ' || c == '\u{7f}')
        || !["chat/completions", "models"].contains(&resource)
    { return Err("Invalid URL".into()); }
    let mut url = reqwest::Url::parse(base_url).map_err(|_| "Invalid URL")?;
    if !["http", "https"].contains(&url.scheme())
        || ![Some("localhost"), Some("127.0.0.1"), Some("[::1]")].contains(&url.host_str())
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some()
    { return Err("Only loopback model endpoints are allowed".into()); }
    // Avoid resolving localhost through mutable DNS or an environment proxy.
    if url.host_str() == Some("localhost") { url.set_host(Some("127.0.0.1")).map_err(|_| "Invalid host")?; }
    url.set_path(&format!("{}/{}", url.path().trim_end_matches('/'), resource));
    Ok(url)
}

fn model_endpoint(base_url: &str, resource: &str, direct: bool) -> Result<reqwest::Url, String> {
    if !direct { return local_endpoint(base_url, resource); }
    if base_url.len() > 2048 || base_url.chars().any(|c| c <= ' ' || c == '\u{7f}')
        || !["chat/completions", "models"].contains(&resource) { return Err("Invalid URL".into()); }
    let mut url = reqwest::Url::parse(base_url).map_err(|_| "Invalid URL")?;
    if url.scheme() != "https" || url.port_or_known_default() != Some(443)
        || [Some("localhost"), Some("127.0.0.1"), Some("[::1]")].contains(&url.host_str())
        || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some() { return Err("Direct providers require HTTPS on port 443".into()); }
    url.set_path(&format!("{}/{}", url.path().trim_end_matches('/'), resource));
    Ok(url)
}

async fn run_local_completion(
    request_id: String, base_url: String, api_key: String, model: String,
    messages: Vec<Message>, max_tokens: Option<u32>, on_chunk: Option<tauri::ipc::Channel<TextDelta>>, direct: bool, state: &Requests,
) -> Result<Completion, String> {
    let url = model_endpoint(&base_url, "chat/completions", direct)?;
    if request_id.is_empty() || request_id.len() > 100 || model.trim().is_empty() || model.chars().count() > 200 || model.chars().any(|c| c.is_control())
        || api_key.len() > 4096 || !api_key.bytes().all(|c| (33..=126).contains(&c)) || max_tokens.is_some_and(|value| !(1..=2147483647).contains(&value))
        || messages.is_empty() || messages.len() > 100
        || messages.iter().any(|m| !["user", "assistant", "system"].contains(&m.role.as_str()) || !valid_message_content(&m.content))
        || serde_json::to_vec(&messages).map_or(true, |body| body.len() > 6 * 1024 * 1024)
    { return Err("Invalid model request".into()); }
    let (cancel, cancelled) = oneshot::channel();
    {
        let mut active = state.0.lock().map_err(|_| "Request state unavailable")?;
        if active.len() >= 4 || active.contains_key(&request_id) { return Err("Too many active requests".into()); }
        active.insert(request_id.clone(), cancel);
    }
    let operation = async {
        let mut body = serde_json::json!({ "model": model, "messages": messages, "stream": on_chunk.is_some() });
        if let Some(limit) = max_tokens { body["max_tokens"] = limit.into(); }
        local_stream::fetch_completion(url, api_key, body, &mut |content| {
            if let Some(channel) = &on_chunk {
                channel.send(TextDelta { content: content.into() }).map_err(|_| "Stream channel unavailable")?;
            }
            Ok(())
        }).await
    };
    let result = tokio::select! { biased; _ = cancelled => Err("Cancelled".into()), result = operation => result };
    if let Ok(mut active) = state.0.lock() { active.remove(&request_id); }
    result
}

#[tauri::command]
async fn complete_local_model(
    request_id: String, base_url: String, api_key: String, model: String,
    messages: Vec<Message>, max_tokens: Option<u32>, direct: Option<bool>, state: State<'_, Requests>,
) -> Result<Completion, String> {
    run_local_completion(request_id, base_url, api_key, model, messages, max_tokens, None, direct.unwrap_or(false), &state).await
}

#[tauri::command]
async fn stream_local_model(
    request_id: String, base_url: String, api_key: String, model: String,
    messages: Vec<Message>, max_tokens: Option<u32>, on_chunk: tauri::ipc::Channel<TextDelta>, direct: Option<bool>, state: State<'_, Requests>,
) -> Result<Completion, String> {
    run_local_completion(request_id, base_url, api_key, model, messages, max_tokens, Some(on_chunk), direct.unwrap_or(false), &state).await
}

#[derive(Serialize, Debug, PartialEq)]
struct ModelId { id: String }

#[derive(Serialize, Debug, PartialEq)]
struct ModelCatalog { models: Vec<ModelId>, truncated: bool }

fn normalize_model_list(data: serde_json::Value) -> Result<ModelCatalog, String> {
    let items = data["data"].as_array().ok_or("Invalid model list")?;
    let mut result = ModelCatalog { models: Vec::new(), truncated: data["has_more"].as_bool() == Some(true) };
    let mut seen = std::collections::HashSet::new();
    for item in items {
        let id = match item["id"].as_str() {
            Some(id) if !id.trim().is_empty() && id == id.trim() && id.chars().count() <= 200
                && !id.chars().any(|c| c.is_control()) => id,
            _ => { result.truncated = true; continue; }
        };
        if !seen.insert(id) { continue; }
        if result.models.len() < 500 { result.models.push(ModelId { id: id.into() }); }
        else { result.truncated = true; }
    }
    Ok(result)
}

async fn fetch_model_list(url: reqwest::Url, api_key: String) -> Result<ModelCatalog, String> {
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20)).build().map_err(|_| "Client unavailable")?;
    let mut request = client.get(url);
    if !api_key.is_empty() { request = request.bearer_auth(api_key); }
    let mut response = request.send().await.map_err(|_| "Model list unavailable")?;
    if response.status() != reqwest::StatusCode::OK { return Err("Model list unavailable".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Invalid model list")? {
        if bytes.len() + chunk.len() > 1024 * 1024 { return Err("Model list too large".into()); }
        bytes.extend_from_slice(&chunk);
    }
    normalize_model_list(serde_json::from_slice(&bytes).map_err(|_| "Invalid model list")?)
}

#[tauri::command]
async fn list_local_models(request_id: String, base_url: String, api_key: String, direct: Option<bool>, state: State<'_, Requests>) -> Result<ModelCatalog, String> {
    let url = model_endpoint(&base_url, "models", direct.unwrap_or(false))?;
    if request_id.is_empty() || request_id.len() > 100 || api_key.len() > 4096
        || !api_key.bytes().all(|c| (33..=126).contains(&c))
    { return Err("Invalid model request".into()); }
    let (cancel, cancelled) = oneshot::channel();
    {
        let mut active = state.0.lock().map_err(|_| "Request state unavailable")?;
        if active.len() >= 4 || active.contains_key(&request_id) { return Err("Too many active requests".into()); }
        active.insert(request_id.clone(), cancel);
    }
    let result = tokio::select! { result = fetch_model_list(url, api_key) => result, _ = cancelled => Err("Cancelled".into()) };
    if let Ok(mut active) = state.0.lock() { active.remove(&request_id); }
    result
}

#[tauri::command]
fn cancel_local_model(request_id: String, state: State<'_, Requests>) {
    if let Ok(mut active) = state.0.lock() {
        if let Some(cancel) = active.remove(&request_id) { let _ = cancel.send(()); }
    }
}

#[tauri::command]
async fn complete_local_tools(request_id: String, base_url: String, api_key: String, body: String, direct: Option<bool>, state: State<'_, Requests>) -> Result<serde_json::Value, String> {
    let url = model_endpoint(&base_url, "chat/completions", direct.unwrap_or(false))?;
    if request_id.is_empty() || request_id.len() > 100 || api_key.len() > 4096 || !api_key.bytes().all(|c| (33..=126).contains(&c)) {
        return Err("Invalid tool request".into());
    }
    let (cancel, cancelled) = oneshot::channel();
    {
        let mut active = state.0.lock().map_err(|_| "Request state unavailable")?;
        if active.len() >= 4 || active.contains_key(&request_id) { return Err("Too many active requests".into()); }
        active.insert(request_id.clone(), cancel);
    }
    let result = tokio::select! { biased; _ = cancelled => Err("Cancelled".into()), result = local_tools::complete(url, api_key, body) => result };
    if let Ok(mut active) = state.0.lock() { active.remove(&request_id); }
    result
}

fn main() {
    let builder = tauri::Builder::default().manage(Requests::default())
        .invoke_system(include_str!("ipc-init.js"))
        .register_uri_scheme_protocol("geiit-preview", |_context, request| web_preview::response(request));
    #[cfg(windows)]
    let builder = builder.manage(organizer::Directories::default()).invoke_handler(tauri::generate_handler![complete_local_model, stream_local_model, list_local_models, complete_local_tools, cancel_local_model, organizer::organizer_pick_directory, organizer::organizer_release_directory, organizer::organizer_access]);
    #[cfg(not(windows))]
    let builder = builder.invoke_handler(tauri::generate_handler![complete_local_model, stream_local_model, list_local_models, complete_local_tools, cancel_local_model]);
    builder.run(tauri::generate_context!()).expect("Desktop runtime failed");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints_are_loopback_only() {
        assert_eq!(local_endpoint("http://localhost:11434/v1", "chat/completions").unwrap().as_str(), "http://127.0.0.1:11434/v1/chat/completions");
        assert_eq!(local_endpoint("http://localhost:11434/v1/", "models").unwrap().as_str(), "http://127.0.0.1:11434/v1/models");
        for url in ["http://192.168.1.1/v1", "https://example.com/v1", "http://user:secret@127.0.0.1/v1", "http://localhost/v1?key=secret", "file:///etc/passwd"] {
            assert!(local_endpoint(url, "models").is_err());
        }
    }

    #[test]
    fn direct_providers_require_explicit_https_mode() {
        assert!(model_endpoint("https://provider.example/v1", "models", false).is_err());
        assert_eq!(model_endpoint("https://provider.example/v1", "models", true).unwrap().as_str(), "https://provider.example/v1/models");
        for url in ["http://provider.example/v1", "https://localhost/v1", "https://provider.example:8443/v1", "https://key@provider.example/v1", "https://provider.example/v1?key=value"] {
            assert!(model_endpoint(url, "models", true).is_err());
        }
    }

    #[test]
    fn model_ids_are_bounded_and_metadata_is_not_capability_evidence() {
        let result = normalize_model_list(serde_json::json!({"data": [
            {"id": "chat", "capabilities": ["vision"]}, {"id": "chat"}, null,
            {"id": "bad\n"}, {"id": "bad\u{7f}"}, {"id": "x".repeat(201)}
        ]})).unwrap();
        assert_eq!(result, ModelCatalog { models: vec![ModelId { id: "chat".into() }], truncated: true });
        let items: Vec<_> = (0..501).map(|n| serde_json::json!({"id": n.to_string()})).collect();
        let result = normalize_model_list(serde_json::json!({"data": items})).unwrap();
        assert_eq!(result.models.len(), 500);
        assert!(result.truncated);
        assert!(normalize_model_list(serde_json::json!({"data": {}})).is_err());
    }

    fn provider(status: &str, body: String) -> (reqwest::Url, std::thread::JoinHandle<String>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = local_endpoint(&format!("http://127.0.0.1:{}/v1", listener.local_addr().unwrap().port()), "models").unwrap();
        let status = status.to_owned();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() { break; }
                headers.push_str(&line);
            }
            let response = format!("HTTP/1.1 {}\r\nContent-Type: application/json\r\nLocation: http://127.0.0.1:1/blocked\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, body.len(), body);
            let _ = stream.write_all(response.as_bytes());
            headers
        });
        (url, worker)
    }

    #[tokio::test]
    async fn local_catalog_http_and_redirects() {
        let (url, worker) = provider("200 OK", r#"{"data":[{"id":"native-chat","secret":"ignored"}]}"#.into());
        let result = fetch_model_list(url, "fixture-key".into()).await.unwrap();
        assert_eq!(result.models[0].id, "native-chat");
        let headers = worker.join().unwrap().to_lowercase();
        assert!(headers.starts_with("get /v1/models http/1.1"));
        assert!(headers.contains("authorization: bearer fixture-key"));
        for (status, body) in [("307 Temporary Redirect", "fixture-secret".to_string()), ("200 OK", "x".repeat(1024 * 1024 + 1))] {
            let (url, worker) = provider(status, body);
            let error = fetch_model_list(url, String::new()).await.unwrap_err();
            assert!(!error.contains("fixture-secret"));
            worker.join().unwrap();
        }
    }
}
