// Static, unprivileged preview resources. No filesystem paths, generated HTML,
// model credentials, or IPC commands are exposed through this protocol.
const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

pub fn response(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let (status, mime, body) = match (request.method().as_str(), request.uri().path()) {
        ("GET", "/web-preview.html") => (200, "text/html; charset=utf-8", include_str!("../../public/web-preview.html")),
        _ => (404, "text/plain; charset=utf-8", "Not found"),
    };
    tauri::http::Response::builder().status(status)
        .header("Content-Type", mime).header("Content-Security-Policy", CSP)
        .header("X-Content-Type-Options", "nosniff").header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .body(body.as_bytes().to_vec()).expect("Static preview response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_static_get_resources_are_exposed() {
        for path in ["/web-preview.html"] {
            let result = response(tauri::http::Request::builder().uri(path).body(vec![]).unwrap());
            assert_eq!(result.status(), 200);
            assert_eq!(result.headers()["content-security-policy"], CSP);
            assert!(!result.body().is_empty());
        }
        for (method, path) in [("POST", "/web-preview.html"), ("GET", "/"), ("GET", "/../index.html"), ("GET", "/api/v1/secrets")] {
            assert_eq!(response(tauri::http::Request::builder().method(method).uri(path).body(vec![]).unwrap()).status(), 404);
        }
    }
}
