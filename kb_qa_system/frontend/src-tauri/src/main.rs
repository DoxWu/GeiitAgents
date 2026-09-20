#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::State;
use tokio::sync::oneshot;

#[derive(Default)]
struct Requests(Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Deserialize, Serialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct Completion { content: String }

fn local_endpoint(base_url: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base_url).map_err(|_| "Invalid URL")?;
    if !["http", "https"].contains(&url.scheme())
        || ![Some("localhost"), Some("127.0.0.1"), Some("[::1]")].contains(&url.host_str())
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some()
    { return Err("Only loopback model endpoints are allowed".into()); }
    // Avoid resolving localhost through mutable DNS or an environment proxy.
    if url.host_str() == Some("localhost") { url.set_host(Some("127.0.0.1")).map_err(|_| "Invalid host")?; }
    url.set_path(&format!("{}/chat/completions", url.path().trim_end_matches('/')));
    Ok(url)
}

#[tauri::command]
async fn complete_local_model(
    request_id: String, base_url: String, api_key: String, model: String,
    messages: Vec<Message>, max_tokens: Option<u32>, state: State<'_, Requests>,
) -> Result<Completion, String> {
    let url = local_endpoint(&base_url)?;
    if request_id.len() > 100 || model.is_empty() || model.len() > 200
        || api_key.len() > 4096 || max_tokens.is_some_and(|value| !(1..=2147483647).contains(&value))
        || messages.is_empty() || messages.len() > 100
        || messages.iter().any(|m| !["user", "assistant", "system"].contains(&m.role.as_str()) || m.content.len() > 400000)
        || messages.iter().map(|m| m.content.len()).sum::<usize>() > 800000
    { return Err("Invalid model request".into()); }
    let (cancel, cancelled) = oneshot::channel();
    {
        let mut active = state.0.lock().map_err(|_| "Request state unavailable")?;
        if active.len() >= 4 || active.contains_key(&request_id) { return Err("Too many active requests".into()); }
        active.insert(request_id.clone(), cancel);
    }
    let operation = async {
        let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(115)).build().map_err(|_| "Client unavailable")?;
        let mut body = serde_json::json!({ "model": model, "messages": messages, "stream": false });
        if let Some(limit) = max_tokens { body["max_tokens"] = limit.into(); }
        let mut request = client.post(url).json(&body);
        if !api_key.is_empty() { request = request.bearer_auth(api_key); }
        let mut response = request.send().await.map_err(|_| "Model connection failed")?;
        if !response.status().is_success() { return Err("Model rejected request".to_string()); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "Invalid response")? {
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 { return Err("Response too large".into()); }
            bytes.extend_from_slice(&chunk);
        }
        let data: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid response")?;
        let content = data["choices"][0]["message"]["content"].as_str().filter(|c| !c.trim().is_empty()).ok_or("Empty response")?;
        Ok(Completion { content: content.into() })
    };
    let result = tokio::select! { result = operation => result, _ = cancelled => Err("Cancelled".into()) };
    if let Ok(mut active) = state.0.lock() { active.remove(&request_id); }
    result
}

#[tauri::command]
fn cancel_local_model(request_id: String, state: State<'_, Requests>) {
    if let Ok(mut active) = state.0.lock() {
        if let Some(cancel) = active.remove(&request_id) { let _ = cancel.send(()); }
    }
}

fn main() {
    tauri::Builder::default().manage(Requests::default())
        .invoke_handler(tauri::generate_handler![complete_local_model, cancel_local_model])
        .run(tauri::generate_context!()).expect("Desktop runtime failed");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints_are_loopback_only() {
        assert_eq!(local_endpoint("http://localhost:11434/v1").unwrap().as_str(), "http://127.0.0.1:11434/v1/chat/completions");
        for url in ["http://192.168.1.1/v1", "https://example.com/v1", "http://user:secret@127.0.0.1/v1", "http://localhost/v1?key=secret", "file:///etc/passwd"] {
            assert!(local_endpoint(url).is_err());
        }
    }
}
