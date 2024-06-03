use axum::{response::Html, Router};
use reqwest;
use base64::{engine::general_purpose, Engine as _};
use axum::routing::get;
use tower_serve_static::{ServeDir, ServeFile, include_file};
use include_dir::{Dir, include_dir};
use rand::Rng;
use std::io::{BufWriter, Cursor};
use image::{imageops::FilterType::{CatmullRom}, ImageFormat};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    static ASSETS_DIR: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/assets");

    let app = Router::new()
        .nest_service("/", root())
        .nest_service("/assets", ServeDir::new(&ASSETS_DIR))
        .nest_service("/pgp", ServeFile::new(include_file!("/assets/pgp.html")))
        .nest_service("/ideology", ServeFile::new(include_file!("/assets/ideology.html")))
        .nest_service("/image", get(get_image));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn root() -> Router {
    Router::new()
        .route_service("/", ServeFile::new(include_file!("/assets/index.html")))
        .fallback_service(ServeFile::new(include_file!("/assets/404.html")))
}

pub async fn get_image() -> impl axum::response::IntoResponse {
    // TODO: display default cig if error
    let cig_id = rand::thread_rng().gen_range(1..9997);
    let ipfs_link = format!("https://ipfs.io/ipfs/bafybeigvhgkcqqamlukxcmjodalpk2kuy5qzqtx6m4i6pvb7o3ammss3y4/{cig_id}.jpg");

    let client = reqwest::ClientBuilder::new().use_rustls_tls().build().unwrap();
    let img_bytes = client.get(ipfs_link)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();

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