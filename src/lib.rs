use rand::Rng;
use worker::*;

mod link_preview;

// Cig IDs go from 1 -> 9996
const CIG_MIN: u32 = 1;
const CIG_MAX: u32 = 9996;

// Worker entrypoint. `run_worker_first` in wrangler.toml sends paths without
// a file extension (pages, /image, /cig/*) here first; unhandled paths fall
// through to the static assets that scripts/sitegen.py builds into dist/.
#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    // Route panics to stack trace via wrangler tail
    console_error_panic_hook::set_once();

    let url = req.url()?;
    let path = url.path();

    // Replace base Cig with random one on button click (returns raw URL for preload)
    if path == "/image" {
        let id = rand::thread_rng().gen_range(CIG_MIN..=CIG_MAX);
        return Response::ok(format!("/cig/{id}"));
    }

    if let Some(id_str) = path.strip_prefix("/cig/") {
        // Validate Cig IDs
        if let Ok(id) = id_str.parse::<u32>() {
            if (CIG_MIN..=CIG_MAX).contains(&id) {
                // Fetch image from R2
                let bucket = env.bucket("BUCKET")?;
                if let Some(obj) = bucket
                    .get(format!("cig-collection/{id}.jpg"))
                    .execute()
                    .await?
                {
                    let body = obj
                        .body()
                        .ok_or_else(|| Error::from("R2 object had no body"))?;
                    let mut res = Response::from_body(body.response_body()?)?;
                    let headers = res.headers_mut();
                    // Add Edge Caching: 24hr Browser TTL & 1yr CDN TTL (allows purging updates)
                    headers.set("content-type", "image/jpeg")?;
                    headers.set("cache-control", "public, max-age=86400, s-maxage=31536000")?;
                    return Ok(res);
                }
            }
        }
    }

    let assets = env.assets("ASSETS")?;
    let page_md =
        markdown_path(path).filter(|_| matches!(req.method(), Method::Get | Method::Head));

    // Serve the page's generated Markdown copy to clients that ask for it (AI agents)
    if let Some(md_path) = &page_md {
        if wants_markdown(req.headers().get("accept")?.as_deref()) {
            let mut md_url = url.clone();
            md_url.set_path(md_path);
            // Same method and headers, so HEAD and If-None-Match (304) keep working
            let mut init = RequestInit::new();
            init.with_method(req.method())
                .with_headers(req.headers().clone());
            let res = assets
                .fetch_request(Request::new_with_init(md_url.as_str(), &init)?)
                .await?;
            if matches!(res.status_code(), 200 | 304) {
                return vary_on_accept(res);
            }
        }
    }

    // Every HTML page gets link-preview tags; see link_preview.rs. Missing paths
    // get 404.html with a 404 status (not_found_handling = "404-page").
    let mut res = assets.fetch_request(req).await?;
    let is_html = res
        .headers()
        .get("content-type")?
        .is_some_and(|t| t.starts_with("text/html"));
    if is_html && res.status_code() == 200 {
        // Crawlers expect https URLs even if the page was requested over http
        let origin = match url.host_str() {
            Some("localhost" | "127.0.0.1") => url.origin().ascii_serialization(),
            _ => url
                .origin()
                .ascii_serialization()
                .replacen("http://", "https://", 1),
        };
        let html = link_preview::add_tags(&res.text().await?, &origin, path);
        res = Response::from_html(html)?;
    }
    match page_md {
        Some(_) if res.status_code() != 404 => vary_on_accept(res),
        _ => Ok(res),
    }
}

// Path of a page's Markdown copy: / -> /index.md, /ideology -> /ideology.md.
// None for paths with a dot, which are files, not pages. Keep in sync with
// markdown_path in scripts/sitegen.py.
fn markdown_path(path: &str) -> Option<String> {
    if path.contains('.') {
        None
    } else if path.ends_with('/') {
        Some(format!("{path}index.md"))
    } else {
        Some(format!("{path}.md"))
    }
}

// True when the Accept header explicitly lists text/markdown and ranks it at
// least as high as HTML. Browsers never list text/markdown, so get HTML.
fn wants_markdown(accept: Option<&str>) -> bool {
    let accept = accept.unwrap_or_default().to_ascii_lowercase();
    let (mut markdown, mut html, mut text_any, mut any) = (0.0_f32, None, None, None);
    for range in accept.split(',') {
        let mut params = range.split(';').map(str::trim);
        let media_type = params.next().unwrap_or_default();
        let q = params
            .find_map(|p| p.strip_prefix("q=")?.parse().ok())
            .unwrap_or(1.0);
        match media_type {
            "text/markdown" => markdown = markdown.max(q),
            "text/html" => html = Some(q),
            "text/*" => text_any = Some(q),
            "*/*" => any = Some(q),
            _ => {}
        }
    }
    // HTML's weight comes from its most specific matching range
    markdown > 0.0 && markdown >= html.or(text_any).or(any).unwrap_or(0.0)
}

// Pages come as HTML or Markdown depending on Accept, so caches must key on it
fn vary_on_accept(res: Response) -> Result<Response> {
    // Headers on a fetched response are immutable; copy them first
    let headers = res.headers().clone();
    headers.append("vary", "Accept")?;
    Ok(res.with_headers(headers))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_paths() {
        assert_eq!(markdown_path("/").as_deref(), Some("/index.md"));
        assert_eq!(markdown_path("/ideology").as_deref(), Some("/ideology.md"));
        assert_eq!(markdown_path("/notes/").as_deref(), Some("/notes/index.md"));
        assert_eq!(markdown_path("/ideology.html"), None);
        assert_eq!(markdown_path("/llms.txt"), None);
        assert_eq!(markdown_path("/v1.2/"), None);
    }

    #[test]
    fn accept_negotiation() {
        assert!(wants_markdown(Some("text/markdown")));
        assert!(wants_markdown(Some(
            "text/markdown, text/html;q=0.9, */*;q=0.8"
        )));
        assert!(wants_markdown(Some("TEXT/Markdown;Q=0.5, */*;q=0.1")));
        assert!(!wants_markdown(Some(
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        )));
        assert!(!wants_markdown(Some("text/html, text/markdown;q=0.9")));
        assert!(!wants_markdown(Some("text/markdown;q=0")));
        assert!(!wants_markdown(Some("*/*")));
        assert!(!wants_markdown(Some("text/markdown;q=0.1, */*")));
        assert!(!wants_markdown(Some("text/*, text/markdown;q=0.5")));
        assert!(wants_markdown(Some("text/markdown, text/html;q=0.5, */*")));
        assert!(!wants_markdown(None));
    }
}
