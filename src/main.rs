use axum::{response::Html, Router};
use base64::{engine::general_purpose, Engine as _};
use axum::routing::get;
use axum::extract::State;
use tower_serve_static::{ServeDir, ServeFile, include_file};
use include_dir::{Dir, include_dir};
use rand::Rng;
use std::io::{BufWriter, Cursor};
use image::{imageops::FilterType::{CatmullRom}, ImageFormat};
use aws_sdk_s3::{Client, config::{BehaviorVersion, Credentials, Region}};

#[derive(Clone)]
struct AppState {
    s3: Client,
    bucket: String,
}

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt::init();

    static ASSETS_DIR: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/assets");

    let account_id = std::env::var("R2_ACCOUNT_ID").expect("R2_ACCOUNT_ID");
    let access_key = std::env::var("R2_ACCESS_KEY_ID").expect("R2_ACCESS_KEY_ID");
    let secret_key = std::env::var("R2_SECRET_ACCESS_KEY").expect("R2_SECRET_ACCESS_KEY");
    let bucket = std::env::var("R2_BUCKET").expect("R2_BUCKET");

    let endpoint_url = format!("https://{account_id}.r2.cloudflarestorage.com");
    let creds = Credentials::new(access_key, secret_key, None, None, "r2");
    let cfg = aws_sdk_s3::Config::builder()
        .region(Region::new("auto"))
        .endpoint_url(&endpoint_url)
        .credentials_provider(creds)
        .behavior_version(BehaviorVersion::latest())
        .build();
    tracing::info!(bucket = %bucket, endpoint = %endpoint_url, "configured R2 client");
    let state = AppState { s3: Client::from_conf(cfg), bucket };

    let app = Router::new()
        .nest_service("/", root())
        .nest_service("/assets", ServeDir::new(&ASSETS_DIR))
        .nest_service("/pgp", ServeFile::new(include_file!("/assets/pgp.html")))
        .nest_service("/ideology", ServeFile::new(include_file!("/assets/ideology.html")))
        .route("/image", get(get_image))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn root() -> Router {
    Router::new()
        .route_service("/", ServeFile::new(include_file!("/assets/index.html")))
        .fallback_service(ServeFile::new(include_file!("/assets/404.html")))
}

async fn get_image(State(state): State<AppState>) -> impl axum::response::IntoResponse {
    let cig_id = rand::thread_rng().gen_range(1..9997);
    let key = format!("cig-collection/{cig_id}.jpg");

    tracing::info!(bucket = %state.bucket, key = %key, "fetching cig from R2");
    let obj = state.s3.get_object()
        .bucket(&state.bucket)
        .key(&key)
        .send()
        .await
        .unwrap();
    let img_bytes = obj.body.collect().await.unwrap().into_bytes();
    tracing::info!(key = %key, bytes = img_bytes.len(), "fetched cig from R2");

    let image = image::load_from_memory(&img_bytes)
        .unwrap()
        .resize(400, 400, CatmullRom);

    let mut buffer = BufWriter::new(Cursor::new(Vec::new()));
    image.write_to(&mut buffer, ImageFormat::Png).unwrap();
    let arr: Vec<u8> = buffer.into_inner().unwrap().into_inner();

    // Convert bytes to base64 string
    let buf_string = general_purpose::STANDARD.encode(&arr);
    let html_string = format!("<html><img id=\"cig\" alt=\"Cigawrette\" width=\"400\" height=\"400\" src=\"data:image/png;charset=utf-8;base64,{buf_string}\"></html>");
    (
        axum::response::AppendHeaders([(axum::http::header::CONTENT_TYPE, "text/html")]),
        Html(html_string)
    )
}
