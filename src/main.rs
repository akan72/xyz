use axum::{
    handler::HandlerWithoutStateExt, http::StatusCode, routing::{get, post}, Json, Router
};
use tower_http::services::{ServeDir, ServeFile};

use serde::{Deserialize, Serialize};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let not_found_service = handle_404.into_service();

    let app = Router::new()
        .nest_service("/", get(root))
        .nest_service(
            "/static",
            ServeDir::new("./static").not_found_service(not_found_service)
            // ServeDir::new("./static").not_found_service(ServeFile::new("assets/cig.jpeg"))
        );

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn root() -> &'static str {
    "Hello, World!"
}

async fn handle_404() -> (StatusCode, &'static str) {
    (StatusCode::NOT_FOUND, "Not Found")
}