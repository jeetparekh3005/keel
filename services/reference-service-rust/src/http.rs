//! HTTP router for the items aggregate (the driving adapter). Each route declares its
//! required scope via `Authed`; the service is resolved from a request extension.

use std::sync::Arc;

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Extension, FromRequest, FromRequestParts, Path, Query, Request};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use keel_core::domain::errors::{DomainError, ErrorCategory};
use keel_core::webauth::Authed;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::service::ItemService;

/// `Json` extractor that renders a parse/content-type rejection as RFC 9457 problem+json
/// (Validation/400) instead of axum's default text/plain, keeping the uniform error
/// contract on malformed bodies.
struct ApiJson<T>(T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = DomainError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(json_rejection(&rejection)),
        }
    }
}

fn json_rejection(rejection: &JsonRejection) -> DomainError {
    DomainError::new(
        ErrorCategory::Validation,
        format!("invalid request body: {}", rejection.body_text()),
    )
}

/// `Query` extractor with the same problem+json rejection mapping.
struct ApiQuery<T>(T);

impl<S, T> FromRequestParts<S> for ApiQuery<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = DomainError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Query::<T>::from_request_parts(parts, state).await {
            Ok(Query(value)) => Ok(Self(value)),
            Err(rejection) => Err(query_rejection(&rejection)),
        }
    }
}

fn query_rejection(rejection: &QueryRejection) -> DomainError {
    DomainError::new(
        ErrorCategory::Validation,
        format!("invalid query parameters: {}", rejection.body_text()),
    )
}

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
    ApiJson(body): ApiJson<ItemIn>,
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
    ApiQuery(page): ApiQuery<Page>,
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
