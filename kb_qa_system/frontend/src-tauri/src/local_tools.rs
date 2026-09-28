//! Structured tool planning only. This bridge never executes tools.
use serde_json::{json, Value};
use std::time::Duration;

fn allowed_name(value: &Value) -> bool {
    matches!(value.as_str(), Some("inspect_csv" | "render_chart" | "create_document"))
}

fn validate_body(body: &str) -> Result<Value, String> {
    if body.len() > 1024 * 1024 { return Err("Request too large".into()); }
    let value: Value = serde_json::from_str(body).map_err(|_| "Invalid tool request")?;
    let object = value.as_object().ok_or("Invalid tool request")?;
    if object.keys().any(|key| !["model", "messages", "tools", "tool_choice", "stream", "max_tokens"].contains(&key.as_str()))
        || value["model"].as_str().is_none_or(|model| model.trim().is_empty() || model.chars().count() > 200 || model.chars().any(|c| c.is_control()))
        || value["stream"] != false || value["tool_choice"] != "auto"
        || (!value["max_tokens"].is_null() && value["max_tokens"].as_u64().is_none_or(|n| !(1..=2147483647).contains(&n)))
    { return Err("Invalid tool request".into()); }
    let messages = value["messages"].as_array().ok_or("Invalid tool messages")?;
    if messages.is_empty() || messages.len() > 50 || messages.iter().any(|message|
        !matches!(message["role"].as_str(), Some("system" | "user" | "assistant" | "tool")))
    { return Err("Invalid tool messages".into()); }
    if serde_json::to_string(messages).map_err(|_| "Invalid messages")?.encode_utf16().count() > 200000 { return Err("Context too large".into()); }
    let mut seen = std::collections::HashSet::new();
    let mut pending = std::collections::HashSet::new();
    for message in messages {
        if message.as_object().is_none_or(|m| m.keys().any(|key| !["role", "content", "tool_calls", "tool_call_id"].contains(&key.as_str())))
            || (!message["content"].is_null() && message["content"].as_str().is_none_or(|s| s.encode_utf16().count() > 100000))
        { return Err("Invalid tool message".into()); }
        if message["role"] == "tool" {
            if !message["content"].is_string() || !message["tool_calls"].is_null()
                || message["tool_call_id"].as_str().is_none_or(|id| !pending.remove(id)) { return Err("Unexpected tool result".into()); }
        } else {
            if !pending.is_empty() || !message["tool_call_id"].is_null() { return Err("Missing tool results".into()); }
            if message["role"] == "assistant" {
                let reply = normalize_reply(&json!({"choices":[{"message":message}]}))?;
                for call in reply["tool_calls"].as_array().ok_or("Invalid calls")? {
                    let id = call["id"].as_str().ok_or("Invalid call ID")?;
                    if !seen.insert(id.to_owned()) { return Err("Repeated call ID".into()); }
                    pending.insert(id.to_owned());
                }
            } else if !message["tool_calls"].is_null() || message["content"].as_str().is_none_or(|s| s.trim().is_empty()) { return Err("Invalid text message".into()); }
        }
    }
    if !pending.is_empty() { return Err("Missing tool results".into()); }
    let tools = value["tools"].as_array().ok_or("Invalid tools")?;
    if tools.is_empty() || tools.len() > 3 || tools.iter().any(|tool| tool["type"] != "function" || !allowed_name(&tool["function"]["name"]))
    { return Err("Invalid tools".into()); }
    Ok(value)
}

pub fn normalize_reply(value: &Value) -> Result<Value, String> {
    let message = &value["choices"][0]["message"];
    let content = &message["content"];
    if !content.is_null() && content.as_str().is_none_or(|s| s.chars().count() > 100000) { return Err("Invalid tool content".into()); }
    let empty = Vec::new();
    let calls = if message["tool_calls"].is_null() { &empty } else { message["tool_calls"].as_array().ok_or("Invalid tool calls")? };
    if calls.len() > 4 { return Err("Too many tool calls".into()); }
    let mut ids = std::collections::HashSet::new();
    let mut filtered = Vec::new();
    for call in calls {
        let id = call["id"].as_str().ok_or("Invalid call ID")?;
        if id.is_empty() || id.len() > 100 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') || !ids.insert(id)
            || call["type"] != "function" || !allowed_name(&call["function"]["name"])
            || call["function"]["arguments"].as_str().is_none_or(|args| args.chars().count() > 100000)
        { return Err("Invalid tool call".into()); }
        filtered.push(json!({"id":id,"type":"function","function":{"name":call["function"]["name"],"arguments":call["function"]["arguments"]}}));
    }
    if filtered.is_empty() && content.as_str().is_none_or(|s| s.trim().is_empty()) { return Err("Empty tool reply".into()); }
    Ok(json!({"content":content,"tool_calls":filtered}))
}

pub async fn complete(url: reqwest::Url, api_key: String, body: String) -> Result<Value, String> {
    let body = validate_body(&body)?;
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(115)).build().map_err(|_| "Client unavailable")?;
    let mut request = client.post(url).json(&body);
    if !api_key.is_empty() { request = request.bearer_auth(api_key); }
    let mut response = request.send().await.map_err(|_| "Tool connection failed")?;
    if response.status() != reqwest::StatusCode::OK { return Err("Model rejected tool request".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Invalid tool response")? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 { return Err("Response too large".into()); }
        bytes.extend_from_slice(&chunk);
    }
    normalize_reply(&serde_json::from_slice(&bytes).map_err(|_| "Invalid tool response")?)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn body() -> Value { json!({"model":"fixture","messages":[{"role":"user","content":"goal"}],"tools":[{"type":"function","function":{"name":"inspect_csv","parameters":{}}}],"tool_choice":"auto","stream":false}) }
    fn call() -> Value { json!({"id":"call-1","type":"function","function":{"name":"inspect_csv","arguments":"{}"}}) }
    #[test]
    fn tool_messages_must_be_bounded_ordered_and_credential_free() {
        assert!(validate_body(&body().to_string()).is_ok());
        let mut value = body(); value["api_key"] = "fixture".into(); assert!(validate_body(&value.to_string()).is_err());
        let mut value = body(); value["messages"].as_array_mut().unwrap().push(json!({"role":"assistant","content":null,"tool_calls":[call()]}));
        assert!(validate_body(&value.to_string()).is_err());
        value["messages"].as_array_mut().unwrap().push(json!({"role":"tool","content":"{}","tool_call_id":"call-1"}));
        assert!(validate_body(&value.to_string()).is_ok());
        value["messages"].as_array_mut().unwrap().push(json!({"role":"tool","content":"{}","tool_call_id":"call-1"}));
        assert!(validate_body(&value.to_string()).is_err());
    }
    #[test]
    fn unknown_tools_duplicates_and_nontext_arguments_are_rejected() {
        let valid = json!({"choices":[{"message":{"content":null,"tool_calls":[call()]}}],"debug":"fixture-secret"});
        assert!(!normalize_reply(&valid).unwrap().to_string().contains("fixture-secret"));
        let mut value = valid.clone(); value["choices"][0]["message"]["tool_calls"][0]["function"]["name"] = "run_shell".into(); assert!(normalize_reply(&value).is_err());
        let mut value = valid.clone(); value["choices"][0]["message"]["tool_calls"].as_array_mut().unwrap().push(call()); assert!(normalize_reply(&value).is_err());
        let mut value = valid; value["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] = json!({}); assert!(normalize_reply(&value).is_err());
    }
}
