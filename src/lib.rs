use rand::Rng;
use worker::*;

// Cig IDs go from 1 -> 9996
const CIG_MIN: u32 = 1;
const CIG_MAX: u32 = 9996;

// Worker entrypoint
#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    // Route panics to stack trace via wrangler tail
    console_error_panic_hook::set_once();

    let url = req.url()?;
    let path = url.path();

    // Replace base Cig with random one on button click
    if path == "/image" {
        let id = rand::thread_rng().gen_range(CIG_MIN..=CIG_MAX);
        return Response::from_html(format!(
            r#"<img id="cig" alt="Cigawrette" width="400" height="400" src="/cig/{id}">"#
        ));
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
                    let bytes = body.bytes().await?;
                    let headers = Headers::new();
                    // Add Edge Caching with 24hr TTL
                    headers.set("content-type", "image/jpeg")?;
                    headers.set("cache-control", "public, max-age=86400, immutable")?;
                    return Ok(Response::from_bytes(bytes)?.with_headers(headers));
                }
            }
        }
    }

    // 404 support
    let mut not_found_url = url.clone();
    not_found_url.set_path("/404.html");
    let nf_req = Request::new(not_found_url.as_str(), Method::Get)?;
    let res = env.assets("ASSETS")?.fetch_request(nf_req).await?;
    Ok(res.with_status(404))
}
