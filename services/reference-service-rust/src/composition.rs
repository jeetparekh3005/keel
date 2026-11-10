//! Composition root: wire the adapters to ports and build the axum app. The driving
//! adapter never imports the concrete repository; the wiring lives here.

use std::sync::Arc;

use axum::{Extension, Router};
use keel_core::http::{create_app_with_readiness, AppConfig, ReadinessCheck};
use keel_core::persistence::Database;
use keel_core::webauth::{authenticator_layer, SharedAuthenticator};

use crate::repository::SqlItemRepository;
use crate::service::ItemService;

/// Build the reference-service app: edge hardening (keel-core) wrapping the health
/// probes plus the items routes, with the item service and authenticator injected.
///
/// Readiness is a real check: `/readyz` pings the database, so a pod with an unreachable
/// datasource reports `503` and is pulled from the readiness probe rather than taking
/// traffic it cannot serve.
pub fn build_app(
    database: &Database,
    authenticator: SharedAuthenticator,
    app_config: &AppConfig,
) -> Router {
    let repository = Arc::new(SqlItemRepository::new(database));
    let service = Arc::new(ItemService::new(repository));
    let routes = crate::http::router()
        .layer(Extension(service))
        .layer(authenticator_layer(authenticator));

    let db_for_readiness = database.clone();
    let readiness: ReadinessCheck = Arc::new(move || {
        let db = db_for_readiness.clone();
        Box::pin(async move { db.ping().await })
    });

    create_app_with_readiness(app_config, routes, Some(readiness))
}

#[cfg(test)]
mod tests {
    use super::build_app;
    use crate::repository::SqlItemRepository;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use keel_core::auth::Principal;
    use keel_core::http::AppConfig;
    use keel_core::persistence::Database;
    use keel_core::testkit::{conformance, StubAuthenticator};
    use keel_core::webauth::SharedAuthenticator;
    use std::collections::{BTreeSet, HashMap};
    use std::sync::Arc;
    use tower::ServiceExt;

    fn stub(scopes: &[&str]) -> SharedAuthenticator {
        let principal = Principal {
            subject: "user-1".to_string(),
            scopes: scopes
                .iter()
                .map(ToString::to_string)
                .collect::<BTreeSet<_>>(),
            roles: BTreeSet::new(),
        };
        Arc::new(StubAuthenticator::new(HashMap::from([(
            "tok".to_string(),
            principal,
        )])))
    }

    #[tokio::test]
    async fn conformance_suite_passes() {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        let app = build_app(&db, stub(&[]), &AppConfig::default());
        conformance::assert_health(&app).await;
        conformance::assert_security_headers(&app).await;
        conformance::assert_cors_deny_by_default(&app).await;
        conformance::assert_denies_anonymous(&app, "/v1/items").await;
        conformance::assert_denies_anonymous(&app, "/v1/items/anything").await;
    }

    #[tokio::test]
    async fn malformed_body_is_rejected_as_problem_json() {
        // A body-parse failure must honor the uniform error contract (RFC 9457), not
        // return axum's default text/plain 400.
        let db = Database::connect("sqlite::memory:").await.unwrap();
        let app = build_app(&db, stub(&["items:write"]), &AppConfig::default());
        let response = app
            .oneshot(
                Request::post("/v1/items")
                    .header("authorization", "Bearer tok")
                    .header("content-type", "application/json")
                    .body(Body::from("{ not valid json"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response.headers()["content-type"],
            "application/problem+json"
        );
    }

    // The deny-by-default route-auth + scope conformance check for this service. axum has
    // no route introspection (unlike FastAPI's startup check), so every route is
    // enumerated here: anonymous callers get 401 and an authenticated caller holding only
    // an unrelated scope gets 403. A new route added without the `Authed` extractor or the
    // right scope guard fails this test instead of shipping silently. Runs on SQLite (the
    // default CI path), so it gates every PR.
    #[tokio::test]
    async fn every_route_requires_auth_and_the_correct_scope() {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        // "tok" authenticates but holds only an unrelated scope, so every route's
        // require_scopes check must reject it with 403.
        let app = build_app(&db, stub(&["unrelated:scope"]), &AppConfig::default());

        let item_body = Some(r#"{"name":"x"}"#);
        // (method, path, optional json body for body-consuming routes)
        let protected: &[(&str, &str, Option<&str>)] = &[
            ("POST", "/v1/items", item_body),
            ("GET", "/v1/items", None),
            ("GET", "/v1/items/some-id", None),
        ];
        for (method, path, body) in protected {
            conformance::assert_method_denies_anonymous(&app, method, path, *body).await;
            conformance::assert_requires_scope(&app, method, path, "tok", *body).await;
        }
    }

    async fn body_json(response: axum::response::Response) -> serde_json::Value {
        let bytes = BodyExt::collect(response.into_body())
            .await
            .unwrap()
            .to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    #[ignore = "integration: requires KEEL_TEST_DATABASE_URL (Postgres); run with `cargo test -- --include-ignored`"]
    async fn items_crud_round_trip_on_postgres() {
        // Integration test. Marked #[ignore] so a plain `cargo test` reports it as
        // "ignored" rather than silently passing without verifying anything; CI runs the
        // ignored tests with a Postgres service and the env var set. Running it without
        // the env var fails loudly (the expect below) instead of reporting a false pass.
        let url = std::env::var("KEEL_TEST_DATABASE_URL")
            .expect("KEEL_TEST_DATABASE_URL must be set to run this integration test");
        let db = Database::connect(&url).await.expect("connect postgres");
        let repo = SqlItemRepository::new(&db);
        repo.ensure_schema().await.unwrap();
        sqlx::query("DELETE FROM items")
            .execute(db.pool())
            .await
            .unwrap();

        let app = build_app(
            &db,
            stub(&["items:read", "items:write"]),
            &AppConfig::default(),
        );

        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/items")
                    .header("authorization", "Bearer tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"widget"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        let created = body_json(created).await;
        let id = created["id"].as_str().unwrap().to_string();
        assert_eq!(created["name"], "widget");

        let fetched = app
            .clone()
            .oneshot(
                Request::get(format!("/v1/items/{id}"))
                    .header("authorization", "Bearer tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(fetched.status(), StatusCode::OK);
        assert_eq!(body_json(fetched).await["name"], "widget");

        let listed = app
            .oneshot(
                Request::get("/v1/items")
                    .header("authorization", "Bearer tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        assert_eq!(body_json(listed).await["count"], 1);
    }
}
