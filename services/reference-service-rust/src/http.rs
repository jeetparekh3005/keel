//! HTTP router for the items aggregate (the driving adapter). Each route declares its
//! required scope via `Authed`; the service is resolved from a request extension.

use std::sync::Arc;

use axum::extract::{Extension, Path, Query};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use keel_core::domain::errors::{DomainError, ErrorCategory};
use keel_core::webauth::Authed;
use serde::{Deserialize, Serialize};

use crate::service::ItemService;

const MAX_NAME_LEN: usize = 200;

#[derive(Deserialize)]
struct ItemIn {
    name: String,
}

#[derive(Serialize)]
struct ItemOut {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct Page {
    #[serde(default = "default_limit")]
    limit: i64,
    #[serde(default)]
    offset: i64,
}

fn default_limit() -> i64 {
    50
}

#[derive(Serialize)]
struct ItemListOut {
    items: Vec<ItemOut>,
    limit: i64,
    offset: i64,
    count: usize,
}

/// The items router (mounted at `/v1/items`).
pub fn router() -> Router {
    Router::new()
        .route("/v1/items", post(create_item).get(list_items))
        .route("/v1/items/{id}", get(get_item))
}

async fn create_item(
    authed: Authed,
    Extension(service): Extension<Arc<ItemService>>,
    Json(body): Json<ItemIn>,
) -> Result<(StatusCode, Json<ItemOut>), DomainError> {
    authed.require_scopes(&["items:write"])?;
    if body.name.is_empty() || body.name.len() > MAX_NAME_LEN {
        return Err(DomainError::new(
            ErrorCategory::Validation,
            "name must be 1..=200 characters",
        ));
    }
    let item = service.create(&body.name).await?;
    Ok((
        StatusCode::CREATED,
        Json(ItemOut {
            id: item.id,
            name: item.name,
        }),
    ))
}

async fn get_item(
    authed: Authed,
    Extension(service): Extension<Arc<ItemService>>,
    Path(id): Path<String>,
) -> Result<Json<ItemOut>, DomainError> {
    authed.require_scopes(&["items:read"])?;
    let item = service.get(&id).await?;
    Ok(Json(ItemOut {
        id: item.id,
        name: item.name,
    }))
}

async fn list_items(
    authed: Authed,
    Extension(service): Extension<Arc<ItemService>>,
    Query(page): Query<Page>,
) -> Result<Json<ItemListOut>, DomainError> {
    authed.require_scopes(&["items:read"])?;
    let limit = page.limit.clamp(1, 200);
    let offset = page.offset.max(0);
    let items = service.list(limit, offset).await?;
    let rows: Vec<ItemOut> = items
        .into_iter()
        .map(|item| ItemOut {
            id: item.id,
            name: item.name,
        })
        .collect();
    let count = rows.len();
    Ok(Json(ItemListOut {
        items: rows,
        limit,
        offset,
        count,
    }))
}
