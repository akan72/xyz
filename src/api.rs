//! Read-only REST access to the same published assets as the MCP tools.
use serde_json::{json, Value};
use worker::*;

#[derive(Debug, PartialEq)]
enum Route {
    Discovery,
    Pages,
    Page(String),
}

#[derive(Debug, PartialEq)]
struct Problem {
    status: u16,
    code: &'static str,
    message: &'static str,
    hint: &'static str,
}

fn missing() -> Problem {
    Problem {
        status: 404,
        code: "not_found",
        message: "The requested public resource does not exist.",
        hint: "GET /api/pages for published paths, or /openapi.json for available endpoints.",
    }
}

fn route(url: &Url, method: Method) -> std::result::Result<Route, Problem> {
    if !matches!(url.path(), "/api" | "/api/pages" | "/api/page") {
        return Err(missing());
    }
    if !matches!(method, Method::Get | Method::Head) {
        return Err(Problem {
            status: 405,
            code: "method_not_allowed",
            message: "This public API only supports reads.",
            hint: "Retry using GET or HEAD. No authentication is required.",
        });
    }
    let query: Vec<_> = url.query_pairs().collect();
    match url.path() {
        "/api" if query.is_empty() => Ok(Route::Discovery),
        "/api/pages" if query.is_empty() => Ok(Route::Pages),
        "/api/page" if query.len() == 1 && query[0].0 == "path" && query[0].1.starts_with('/') => {
            Ok(Route::Page(query[0].1.to_string()))
        }
        _ => Err(Problem {
            status: 400,
            code: "invalid_query",
            message: "The query parameters do not match this endpoint.",
            hint: "Only /api/page accepts a query: exactly one path from /api/pages, e.g. /api/page?path=%2Fprojects.",
        }),
    }
}

fn problem_body(problem: &Problem, path: &str) -> Value {
    // RFC 9457 standard fields with agent-readable extension members.
    json!({
        "type": "about:blank",
        "title": match problem.status { 400 => "Bad Request", 404 => "Not Found", 405 => "Method Not Allowed", _ => "Service Unavailable" },
        "status": problem.status, "detail": problem.message, "instance": path,
        "code": problem.code, "message": problem.message, "hint": problem.hint
    })
}

fn respond(body: &Value, status: u16, head: bool) -> Result<Response> {
    let mut response = if head {
        Response::empty()?
    } else {
        Response::from_json(body)?
    }
    .with_status(status);
    response.headers_mut().set(
        "content-type",
        if status >= 400 {
            "application/problem+json"
        } else {
            "application/json"
        },
    )?;
    response.headers_mut().set("cache-control", "no-store")?;
    response.headers_mut().set("link", "</openapi.json>; rel=\"service-desc\"; type=\"application/vnd.oai.openapi+json\", </docs>; rel=\"service-doc\"")?;
    if status == 405 {
        response.headers_mut().set("allow", "GET, HEAD")?;
    }
    Ok(response)
}

async fn asset(env: &Env, url: &Url, path: &str) -> Result<String> {
    let mut asset_url = url.clone();
    asset_url.set_path(path);
    asset_url.set_query(None);
    let mut response = env
        .assets("ASSETS")?
        .fetch(asset_url.as_str(), None)
        .await?;
    if response.status_code() != 200 {
        return Err(Error::from("Public asset unavailable"));
    }
    response.text().await
}

async fn execute(
    route: Route,
    env: &Env,
    url: &Url,
) -> Result<std::result::Result<Value, Problem>> {
    if route == Route::Discovery {
        return Ok(Ok(json!({
            "name": "alexkan.xyz Public Content API", "description": "Read Alex Kan's published personal website pages. No API key is required.",
            "docs": "/docs", "openapi": "/openapi.json", "pages": "/api/pages", "page": "/api/page{?path}"
        })));
    }
    let catalog: Value = serde_json::from_str(&asset(env, url, "/agent-catalog.json").await?)?;
    if let Route::Page(path) = route {
        let pages = catalog["pages"]
            .as_array()
            .ok_or_else(|| Error::from("Invalid public catalog"))?;
        let Some(page) = pages.iter().find(|page| page["path"] == path) else {
            return Ok(Err(missing()));
        };
        let markdown_path = page["markdownPath"]
            .as_str()
            .ok_or_else(|| Error::from("Invalid public page"))?;
        let mut page = page.clone();
        page["markdown"] = Value::String(asset(env, url, markdown_path).await?);
        Ok(Ok(page))
    } else {
        Ok(Ok(catalog))
    }
}

pub async fn handle(req: Request, env: &Env) -> Result<Response> {
    let url = req.url()?;
    let head = req.method() == Method::Head;
    let result = match route(&url, req.method()) {
        Ok(route) => execute(route, env, &url).await.unwrap_or_else(|_| {
            Err(Problem {
                status: 503,
                code: "content_unavailable",
                message: "Published content is temporarily unavailable.",
                hint: "Retry later, or read the HTML pages linked from /docs.",
            })
        }),
        Err(problem) => Err(problem),
    };
    match result {
        Ok(body) => respond(&body, 200, head),
        Err(problem) => respond(&problem_body(&problem, url.path()), problem.status, head),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn url(path: &str) -> Url {
        Url::parse(&format!("https://alexkan.xyz{path}")).unwrap()
    }

    #[test]
    fn public_routes_and_encoded_paths() {
        assert_eq!(route(&url("/api"), Method::Get), Ok(Route::Discovery));
        assert_eq!(route(&url("/api/pages"), Method::Head), Ok(Route::Pages));
        assert_eq!(
            route(&url("/api/page?path=%2Fwriting%2Fgm"), Method::Get),
            Ok(Route::Page("/writing/gm".into()))
        );
    }
    #[test]
    fn invalid_queries_and_methods_have_resolution_hints() {
        for path in [
            "/api?x=1",
            "/api/pages?path=/",
            "/api/page",
            "/api/page?path=projects",
            "/api/page?path=/&path=/docs",
            "/api/page?path=/&other=1",
        ] {
            assert_eq!(
                route(&url(path), Method::Get).unwrap_err().status,
                400,
                "{path}"
            );
        }
        for method in [Method::Post, Method::Put, Method::Delete, Method::Options] {
            let error = route(&url("/api/pages"), method).unwrap_err();
            assert_eq!(error.status, 405);
            assert!(error.hint.contains("GET or HEAD"));
        }
        assert_eq!(route(&url("/api/private"), Method::Get), Err(missing()));
    }
    #[test]
    fn problem_details_include_standard_and_extension_fields() {
        let body = problem_body(&missing(), "/api/page");
        assert_eq!(body["type"], "about:blank");
        assert_eq!(body["status"], 404);
        assert_eq!(body["title"], "Not Found");
        assert_eq!(body["instance"], "/api/page");
        assert_eq!(body["code"], "not_found");
        assert_eq!(body["detail"], body["message"]);
        assert!(body["hint"].as_str().unwrap().contains("/openapi.json"));
    }
}
