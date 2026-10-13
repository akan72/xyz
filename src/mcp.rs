//! Stateless Streamable HTTP for the site's public Markdown only.
//! https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
use serde::Deserialize;
use serde_json::{json, Value};
use worker::*;

const VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_BODY: usize = 64 * 1024;

#[derive(Debug)]
enum Plan {
    Reply(Value, u16),
    Accepted,
    ListPages(Value),
    ReadPage(Value, String),
}

fn reply(id: &Value, result: Value) -> Plan {
    Plan::Reply(json!({"jsonrpc": "2.0", "id": id, "result": result}), 200)
}

fn error(id: Option<&Value>, code: i32, message: &str, status: u16) -> Plan {
    let mut body = json!({"jsonrpc": "2.0", "error": {"code": code, "message": message}});
    if let Some(id) = id {
        body["id"] = id.clone();
    }
    Plan::Reply(body, status)
}

fn tool_result(text: &str, is_error: bool) -> Value {
    json!({"content": [{"type": "text", "text": text}], "isError": is_error})
}

fn valid_id(id: &Value) -> bool {
    id.is_string() || id.is_i64() || id.is_u64()
}

fn plan(message: Value) -> Plan {
    let id = message.get("id").filter(|id| valid_id(id));
    if !message.is_object()
        || message["jsonrpc"] != "2.0"
        || (message.get("id").is_some() && id.is_none())
    {
        return error(None, -32600, "Invalid JSON-RPC request", 400);
    }
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        // Streamable HTTP accepts client responses as well as notifications.
        if id.is_some()
            && message.get("method").is_none()
            && (message.get("result").is_some() ^ message.get("error").is_some())
            && (message["result"].is_object()
                || (message["error"]["code"].is_i64() && message["error"]["message"].is_string()))
        {
            return Plan::Accepted;
        }
        return error(id, -32600, "Invalid JSON-RPC request", 400);
    };
    if message.get("result").is_some() || message.get("error").is_some() {
        return error(id, -32600, "Invalid JSON-RPC request", 400);
    }
    if message.get("params").is_some_and(|p| !p.is_object()) {
        return error(id, -32602, "params must be an object", 400);
    }
    let Some(id) = id else {
        return if method == "initialize" {
            error(None, -32600, "initialize requires a request ID", 400)
        } else {
            Plan::Accepted
        };
    };
    let params = &message["params"];
    match method {
        "initialize" => {
            let Some(version) = params["protocolVersion"].as_str() else {
                return error(Some(id), -32602, "protocolVersion is required", 200);
            };
            if !params["capabilities"].is_object()
                || !params["clientInfo"]["name"].is_string()
                || !params["clientInfo"]["version"].is_string()
            {
                return error(
                    Some(id),
                    -32602,
                    "capabilities and clientInfo are required",
                    200,
                );
            }
            reply(
                id,
                json!({
                    "protocolVersion": if VERSIONS.contains(&version) { version } else { VERSIONS[0] },
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {
                        "name": "alexkan.xyz", "title": "Alex Kan's personal website",
                        "version": env!("CARGO_PKG_VERSION"), "websiteUrl": "https://alexkan.xyz/"
                    },
                    "instructions": "Read-only public site content. Use list_pages, then read_page with a published path. Cite the canonical Source URL in the Markdown. Developer documentation: https://alexkan.xyz/docs"
                }),
            )
        }
        "ping" => reply(id, json!({})),
        "tools/list" => {
            if params.get("cursor").is_some() {
                return error(
                    Some(id),
                    -32602,
                    "This tool list has no pagination cursor",
                    200,
                );
            }
            reply(
                id,
                json!({"tools": [
                    {
                        "name": "list_pages", "description": "List Alex Kan's published site pages with descriptions and canonical URLs.",
                        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
                        "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
                    },
                    {
                        "name": "read_page", "description": "Read a published alexkan.xyz page as Markdown. Choose a canonical path from list_pages, such as /projects.",
                        "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": false},
                        "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
                    }
                ]}),
            )
        }
        "tools/call" => {
            let Some(name) = params["name"].as_str() else {
                return error(Some(id), -32602, "Tool name is required", 200);
            };
            let empty = json!({});
            let arguments = params.get("arguments").unwrap_or(&empty);
            let Some(arguments) = arguments.as_object() else {
                return error(Some(id), -32602, "Tool arguments must be an object", 200);
            };
            match name {
                "list_pages" if arguments.is_empty() => Plan::ListPages(id.clone()),
                "list_pages" => reply(id, tool_result("list_pages takes empty arguments.", true)),
                "read_page" => match arguments.get("path").and_then(Value::as_str) {
                    Some(path) if arguments.len() == 1 => Plan::ReadPage(id.clone(), path.into()),
                    _ => reply(
                        id,
                        tool_result(
                            "read_page requires exactly one string argument: path.",
                            true,
                        ),
                    ),
                },
                _ => error(Some(id), -32602, "Unknown tool", 200),
            }
        }
        _ => error(Some(id), -32601, "Method not found", 200),
    }
}

fn allowed_origin(origin: Option<&str>, server_origin: &str) -> bool {
    origin.is_none_or(|origin| {
        origin == server_origin
            || origin == "https://alexkan.xyz"
            || origin == "https://www.alexkan.xyz"
    })
}

fn accepts_media_type(accept: &str, media_type: &str) -> bool {
    accept.split(',').any(|range| {
        let mut params = range.split(';').map(str::trim);
        let matches = params
            .next()
            .is_some_and(|value| value.eq_ignore_ascii_case(media_type));
        let quality = params
            .find(|p| p.starts_with("q="))
            .map(|p| p[2..].parse::<f32>().unwrap_or(0.0))
            .unwrap_or(1.0);
        matches && quality > 0.0 && quality <= 1.0
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    pages: Vec<Page>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    path: String,
    markdown_path: String,
}

async fn asset_text(env: &Env, url: &Url, path: &str) -> Result<Option<String>> {
    let mut url = url.clone();
    url.set_path(path);
    url.set_query(None);
    let mut response = env.assets("ASSETS")?.fetch(url.as_str(), None).await?;
    if response.status_code() == 200 {
        Ok(Some(response.text().await?))
    } else {
        Ok(None)
    }
}

async fn execute(plan: Plan, env: &Env, url: &Url) -> Result<Response> {
    let (id, path) = match plan {
        Plan::Reply(body, status) => return Ok(Response::from_json(&body)?.with_status(status)),
        Plan::Accepted => return Ok(Response::empty()?.with_status(202)),
        Plan::ListPages(id) => (id, None),
        Plan::ReadPage(id, path) => (id, Some(path)),
    };
    let result = match asset_text(env, url, "/agent-catalog.json").await? {
        Some(catalog) => {
            if let Some(path) = path {
                let catalog: Catalog = serde_json::from_str(&catalog)?;
                match catalog.pages.iter().find(|page| page.path == path) {
                    Some(page) => match asset_text(env, url, &page.markdown_path).await? {
                        Some(markdown) => tool_result(&markdown, false),
                        None => tool_result("Published Markdown is unavailable; retry later.", true),
                    },
                    None => tool_result("That path is not a published page. Use list_pages to choose an available path.", true),
                }
            } else {
                tool_result(&catalog, false)
            }
        }
        None => tool_result("The public page catalog is unavailable; retry later.", true),
    };
    Response::from_json(&json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

pub async fn handle(mut req: Request, env: &Env) -> Result<Response> {
    let url = req.url()?;
    let origin = req.headers().get("origin")?;
    if !allowed_origin(origin.as_deref(), &url.origin().ascii_serialization()) {
        return Response::error("Origin is not allowed", 403);
    }
    if req
        .headers()
        .get("mcp-protocol-version")?
        .is_some_and(|v| !VERSIONS.contains(&v.as_str()))
    {
        return Response::error("Unsupported MCP protocol version", 400);
    }
    let mut response = match req.method() {
        Method::Options => {
            let mut res = Response::empty()?.with_status(204);
            res.headers_mut()
                .set("access-control-allow-methods", "POST, OPTIONS")?;
            res.headers_mut().set(
                "access-control-allow-headers",
                "Content-Type, Accept, MCP-Protocol-Version",
            )?;
            res
        }
        Method::Post => {
            let content_type = req.headers().get("content-type")?.unwrap_or_default();
            let accept = req
                .headers()
                .get("accept")?
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !content_type
                .split(';')
                .next()
                .is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json"))
            {
                return Response::error("Use Content-Type: application/json", 415);
            }
            if !accepts_media_type(&accept, "application/json")
                || !accepts_media_type(&accept, "text/event-stream")
            {
                return Response::error(
                    "Accept must include application/json and text/event-stream",
                    406,
                );
            }
            if req
                .headers()
                .get("content-length")?
                .and_then(|v| v.parse::<usize>().ok())
                .is_some_and(|v| v > MAX_BODY)
            {
                return Response::error("Request exceeds 64 KiB", 413);
            }
            let body = req.bytes().await?;
            if body.len() > MAX_BODY {
                return Response::error("Request exceeds 64 KiB", 413);
            }
            let plan = match std::str::from_utf8(&body)
                .ok()
                .and_then(|body| serde_json::from_str(body).ok())
            {
                Some(message) => plan(message),
                None => error(None, -32700, "Invalid UTF-8 JSON", 400),
            };
            execute(plan, env, &url).await?
        }
        _ => {
            let mut res = Response::empty()?.with_status(405);
            res.headers_mut().set("allow", "POST, OPTIONS")?;
            res
        }
    };
    response.headers_mut().set("cache-control", "no-store")?;
    if let Some(origin) = origin {
        response
            .headers_mut()
            .set("access-control-allow-origin", &origin)?;
        response.headers_mut().append("vary", "Origin")?;
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(message: Value) -> Value {
        match plan(message) {
            Plan::Reply(body, _) => body,
            other => panic!("Expected reply, got {other:?}"),
        }
    }

    #[test]
    fn initialization_negotiates_versions_and_capabilities() {
        for requested in ["2025-11-25", "2025-06-18", "2025-03-26", "unknown"] {
            let body = result(
                json!({"jsonrpc":"2.0","id":"init","method":"initialize","params":{
                    "protocolVersion":requested,"capabilities":{},"clientInfo":{"name":"test","version":"1"}
                }}),
            );
            assert_eq!(body["id"], "init");
            assert_eq!(
                body["result"]["protocolVersion"],
                if requested == "unknown" {
                    VERSIONS[0]
                } else {
                    requested
                }
            );
            assert_eq!(
                body["result"]["capabilities"],
                json!({"tools":{"listChanged":false}})
            );
            assert_eq!(body["result"]["serverInfo"]["name"], "alexkan.xyz");
        }
    }

    #[test]
    fn validates_rpc_structure_and_preserves_request_ids() {
        for message in [
            json!([]),
            json!({}),
            json!({"jsonrpc":"1.0","id":1,"method":"ping"}),
            json!({"jsonrpc":"2.0","id":null,"method":"ping"}),
            json!({"jsonrpc":"2.0","id":1.2,"method":"ping"}),
        ] {
            assert_eq!(result(message)["error"]["code"], -32600);
        }
        assert_eq!(
            result(json!({"jsonrpc":"2.0","id":42,"method":"unknown"}))["id"],
            42
        );
        assert_eq!(
            result(json!({"jsonrpc":"2.0","id":42,"method":"unknown"}))["error"]["code"],
            -32601
        );
        assert_eq!(
            result(json!({"jsonrpc":"2.0","id":1,"method":"ping","params":[]}))["error"]["code"],
            -32602
        );
        assert_eq!(
            result(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}))["error"]
                ["code"],
            -32602
        );
    }

    #[test]
    fn notifications_and_client_responses_are_accepted_without_reply() {
        assert!(matches!(
            plan(json!({"jsonrpc":"2.0","method":"notifications/initialized"})),
            Plan::Accepted
        ));
        assert!(matches!(
            plan(json!({"jsonrpc":"2.0","id":1,"result":{}})),
            Plan::Accepted
        ));
        assert!(matches!(
            plan(
                json!({"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Unknown method"}})
            ),
            Plan::Accepted
        ));
    }

    #[test]
    fn validates_tools_and_arguments_before_reading_assets() {
        let call = |name, args| json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}});
        assert!(matches!(
            plan(call("list_pages", json!({}))),
            Plan::ListPages(_)
        ));
        assert!(
            matches!(plan(call("read_page", json!({"path":"/projects"}))), Plan::ReadPage(_, path) if path == "/projects")
        );
        assert_eq!(
            result(call("read_page", json!({"path":1})))["result"]["isError"],
            true
        );
        assert_eq!(
            result(call("read_page", json!({"path":"/", "extra":true})))["result"]["isError"],
            true
        );
        assert_eq!(
            result(call("list_pages", json!({"extra":true})))["result"]["isError"],
            true
        );
        assert_eq!(
            result(call("not_a_tool", json!({})))["error"]["code"],
            -32602
        );
        let tools = result(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}));
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn origin_checks_reject_unrelated_and_lookalike_hosts() {
        let server = "https://pr-41-xyz.akan72.workers.dev";
        for origin in [
            None,
            Some(server),
            Some("https://alexkan.xyz"),
            Some("https://www.alexkan.xyz"),
        ] {
            assert!(allowed_origin(origin, server));
        }
        for origin in [
            "null",
            "",
            "https://example.com",
            "https://alexkan.xyz.evil.example",
            "http://alexkan.xyz",
            "https://alexkan.xyz/path",
        ] {
            assert!(!allowed_origin(Some(origin), server));
        }
    }

    #[test]
    fn accepts_only_positive_explicit_media_ranges() {
        assert!(accepts_media_type(
            "application/json, text/event-stream;q=0.5",
            "text/event-stream"
        ));
        assert!(accepts_media_type(
            "Application/JSON; charset=utf-8",
            "application/json"
        ));
        for header in [
            "*/*",
            "text/event-stream;q=0",
            "text/event-stream;q=NaN",
            "text/event-stream;q=2",
            "text/event-stream;q=bad",
            "application/json",
        ] {
            assert!(!accepts_media_type(header, "text/event-stream"));
        }
    }
}
