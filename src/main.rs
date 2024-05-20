use std::net::SocketAddr;
use axum::{
    handler::HandlerWithoutStateExt, http::StatusCode, routing::{get, post}, Json, Router
};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

use serde::{Deserialize, Serialize};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    // TODO:
    let not_found_service = handle_404.into_service();

    let app = Router::new()
        .nest_service("/", root())
        .nest_service("/assets", ServeDir::new("assets"))
        // TODO: move into static dir
        // .nest_service("/akan72.pub", ServeFile::new("./assets/akan72.pub"))
        .nest_service("/pgp", ServeFile::new("./assets/pgp.html"))
        // TODO: combine into root service and return 404? or just generate page?
        .nest_service(
            "/static",
            // ServeDir::new("./static").not_found_service(not_found_service)
            ServeDir::new("./static").not_found_service(ServeFile::new("./assets/index.html"))
        );

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn root() -> Router {
    async fn static_string_wrapper() -> (StatusCode, &'static str) {
        (StatusCode::OK, "Hello, World!")
    }

    let service = static_string_wrapper.into_service();

    Router::new()
        // .route("/", get(|| async { "Hi from /foo" }))
        .route("/foo", get( || async { "Hi from /foo" } ))
        .fallback_service(service)
}

async fn handle_404() -> (StatusCode, &'static str) {
    (StatusCode::NOT_FOUND, "Not Found")
}