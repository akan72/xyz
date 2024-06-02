use axum::Router;
use tower_serve_static::{ServeDir, ServeFile, include_file};
use include_dir::{Dir, include_dir};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    static ASSETS_DIR: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/assets");

    let app = Router::new()
        .nest_service("/", root())
        .nest_service("/assets", ServeDir::new(&ASSETS_DIR))
        .nest_service("/pgp", ServeFile::new(include_file!("/assets/pgp.html")))
        .nest_service("/ideology", ServeFile::new(include_file!("/assets/ideology.html")));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn root() -> Router {
    Router::new()
        .route_service("/", ServeFile::new(include_file!("/assets/index.html")))
        .fallback_service(ServeFile::new(include_file!("/assets/404.html")))
}