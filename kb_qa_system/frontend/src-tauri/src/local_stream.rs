//! Bounded OpenAI-compatible text streaming. No provider body enters error text.
use crate::Completion;
use std::time::Duration;

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_TEXT: usize = 1_000_000; // UTF-16 units, matching the frontend limit.
type Sink<'a> = dyn FnMut(&str) -> Result<(), String> + Send + 'a;

#[derive(Default)]
struct TextStream {
    bytes: usize,
    line: Vec<u8>,
    after_cr: bool,
    seen_line: bool,
    data: String,
    error_event: bool,
    done: bool,
    content: String,
    text_len: usize,
}

impl TextStream {
    fn push(&mut self, bytes: &[u8], sink: &mut Sink<'_>) -> Result<(), String> {
        self.bytes += bytes.len();
        if self.bytes > MAX_BYTES { return Err("Response too large".into()); }
        // Byte framing avoids lossy decoding when UTF-8 characters cross chunks.
        for &byte in bytes {
            if self.done { break; }
            if self.after_cr && byte == b'\n' { self.after_cr = false; continue; }
            self.after_cr = byte == b'\r';
            if byte == b'\r' || byte == b'\n' { self.consume_line(sink)?; }
            else { self.line.push(byte); }
        }
        Ok(())
    }

    fn consume_line(&mut self, sink: &mut Sink<'_>) -> Result<(), String> {
        let line = String::from_utf8(std::mem::take(&mut self.line)).map_err(|_| "Invalid stream encoding")?;
        let line = if self.seen_line { line.as_str() } else { line.strip_prefix('\u{feff}').unwrap_or(&line) };
        self.seen_line = true;
        if line.is_empty() { return self.consume_event(sink); }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "data" => { self.data.push_str(value); self.data.push('\n'); }
            "event" => self.error_event = value == "error",
            _ => {} // comments, IDs and retry hints do not alter a text completion.
        }
        Ok(())
    }

    fn consume_event(&mut self, sink: &mut Sink<'_>) -> Result<(), String> {
        if std::mem::take(&mut self.error_event) { return Err("Model stream failed".into()); }
        let data = std::mem::take(&mut self.data);
        let data = data.trim();
        if data.is_empty() { return Ok(()); }
        if data == "[DONE]" { self.done = true; return Ok(()); }
        let value: serde_json::Value = serde_json::from_str(data).map_err(|_| "Invalid stream event")?;
        if value.get("error").is_some_and(|error| !error.is_null()) { return Err("Model stream failed".into()); }
        let choices = value["choices"].as_array().ok_or("Invalid stream event")?;
        // The request asks for one answer. Never merge other choice indices.
        let choice = choices.iter().find(|choice| choice["index"].is_null() || choice["index"].as_u64() == Some(0));
        if let Some(choice) = choice {
            if let Some(delta) = choice["delta"]["content"].as_str() {
                self.text_len += delta.encode_utf16().count();
                if self.text_len > MAX_TEXT { return Err("Response too large".into()); }
                if !delta.is_empty() { sink(delta)?; self.content.push_str(delta); }
            } else if !choice["delta"]["content"].is_null() { return Err("Unsupported model content".into()); }
            if choice["finish_reason"].as_str().is_some_and(|reason| !reason.is_empty()) { self.done = true; }
        }
        Ok(())
    }

    fn finish(mut self, sink: &mut Sink<'_>) -> Result<Completion, String> {
        if !self.done {
            if !self.line.is_empty() { self.consume_line(sink)?; }
            if !self.done { self.consume_event(sink)?; }
        }
        // A clean TCP EOF alone cannot prove that generation completed.
        if !self.done { return Err("Model stream ended before completion".into()); }
        if self.content.trim().is_empty() { return Err("Empty response".into()); }
        Ok(Completion { content: self.content })
    }
}

pub async fn fetch_completion(
    url: reqwest::Url, api_key: String, body: serde_json::Value, sink: &mut Sink<'_>,
) -> Result<Completion, String> {
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(115)).build().map_err(|_| "Client unavailable")?;
    let mut request = client.post(url).json(&body);
    if !api_key.is_empty() { request = request.bearer_auth(api_key); }
    let mut response = request.send().await.map_err(|_| "Model connection failed")?;
    if !response.status().is_success() { return Err("Model rejected request".into()); }
    let is_sse = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("text/event-stream"));
    if is_sse {
        let mut stream = TextStream::default();
        while let Some(chunk) = response.chunk().await.map_err(|_| "Invalid stream response")? {
            stream.push(&chunk, sink)?;
            if stream.done { break; }
        }
        stream.finish(sink)
    } else {
        // Some compatible services ignore stream=true and return ordinary JSON.
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "Invalid response")? {
            if bytes.len() + chunk.len() > MAX_BYTES { return Err("Response too large".into()); }
            bytes.extend_from_slice(&chunk);
        }
        let data: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid response")?;
        let content = data["choices"][0]["message"]["content"].as_str().filter(|content| !content.trim().is_empty()).ok_or("Empty response")?;
        if content.encode_utf16().count() > MAX_TEXT { return Err("Response too large".into()); }
        sink(content)?;
        Ok(Completion { content: content.into() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(chunks: &[&[u8]]) -> Result<(String, Vec<String>), String> {
        let mut deltas = Vec::new();
        let mut sink = |delta: &str| { deltas.push(delta.to_owned()); Ok(()) };
        let mut stream = TextStream::default();
        for chunk in chunks { stream.push(chunk, &mut sink)?; }
        let content = stream.finish(&mut sink)?.content;
        Ok((content, deltas))
    }

    #[test]
    fn unicode_frames_survive_every_possible_split() {
        let data = concat!(": ping\r\n\r\n", "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}]}\r\n\r\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好🌏\"}}]}\r\n\r\n", "data: [DONE]").as_bytes();
        for split in 0..data.len() {
            assert_eq!(parse(&[&data[..split], &data[split..]]).unwrap(), ("你好🌏".into(), vec!["你好🌏".into()]));
        }
        let single_bytes: Vec<_> = data.chunks(1).collect();
        assert_eq!(parse(&single_bytes).unwrap().0, "你好🌏");
        assert_eq!(parse(&["\u{feff}data: {\"choices\":[{\"delta\":{\"content\":\"BOM\"}}]}\n\ndata: [DONE]\n\n".as_bytes()]).unwrap().0, "BOM");
    }

    #[test]
    fn multiline_events_cr_and_finish_reason_are_supported() {
        let data = b"data: {\"choices\":\rdata: [{\"delta\":{\"content\":\"first\"}}]}\r\rdata: {\"choices\":[{\"delta\":{\"content\":\"second\"},\"finish_reason\":\"stop\"}]}\r\r";
        assert_eq!(parse(&[data]).unwrap(), ("firstsecond".into(), vec!["first".into(), "second".into()]));
    }

    #[test]
    fn errors_empty_and_incomplete_streams_never_become_success() {
        for data in [
            "data: [DONE]\n\n", "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
            "data: invalid fixture-secret\n\n", "data: {\"error\":\"fixture-secret\"}\n\n",
            "event: error\ndata: {\"message\":\"fixture-secret\"}\n\n", "data: {\"choices\":{}}\n\n",
        ] {
            let error = parse(&[data.as_bytes()]).unwrap_err();
            assert!(!error.contains("fixture-secret"));
        }
        assert!(parse(&[b"data: \xff\n\n"]).is_err());
    }

    #[test]
    fn stream_budget_and_sink_failure_stop_emission() {
        assert!(parse(&[&vec![b'x'; MAX_BYTES + 1]]).is_err());
        let oversized = format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"{}\"}}}}]}}\n\ndata: [DONE]\n\n", "x".repeat(MAX_TEXT + 1));
        assert!(parse(&[oversized.as_bytes()]).is_err());
        let mut stream = TextStream::default();
        assert!(stream.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"text\"}}]}\n\n", &mut |_| Err("Channel closed".into())).is_err());
    }

    #[test]
    fn only_first_choice_text_is_used_and_usage_events_are_ignored() {
        let data = b"data: {\"choices\":[{\"index\":1,\"delta\":{\"content\":\"ignore\"}},{\"index\":0,\"delta\":{\"content\":\"keep\"}}]}\n\ndata: {\"choices\":[],\"usage\":{}}\n\ndata: [DONE]\n\n";
        assert_eq!(parse(&[data]).unwrap().0, "keep");
    }
}
