//! Domain error taxonomy and the RFC 9457 problem+json representation.
//!
//! Mirrors `platform.yaml` `errors.taxonomy`: one category per domain failure,
//! each mapping to a stable HTTP status and a machine-readable `type` URI. The
//! domain raises `DomainError`; adapters render it as `Problem` (never leaking
//! internals, per the contract rules).

use serde::Serialize;
use thiserror::Error;

/// A domain failure category. Each maps to an HTTP status (`platform.yaml` taxonomy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCategory {
    Validation,
    Unauthenticated,
    Forbidden,
    NotFound,
    Conflict,
    RateLimited,
    Internal,
    Unavailable,
}

impl ErrorCategory {
    /// The HTTP status code for this category.
    #[must_use]
    pub const fn status(self) -> u16 {
        match self {
            Self::Validation => 400,
            Self::Unauthenticated => 401,
            Self::Forbidden => 403,
            Self::NotFound => 404,
            Self::Conflict => 409,
            Self::RateLimited => 429,
            Self::Internal => 500,
            Self::Unavailable => 503,
        }
    }

    /// The stable slug used in the problem `type` URI and logs.
    #[must_use]
    pub const fn slug(self) -> &'static str {
        match self {
            Self::Validation => "validation",
            Self::Unauthenticated => "unauthenticated",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::RateLimited => "rate_limited",
            Self::Internal => "internal",
            Self::Unavailable => "unavailable",
        }
    }

    /// A short human-readable title for the problem response.
    #[must_use]
    pub const fn title(self) -> &'static str {
        match self {
            Self::Validation => "Bad Request",
            Self::Unauthenticated => "Unauthorized",
            Self::Forbidden => "Forbidden",
            Self::NotFound => "Not Found",
            Self::Conflict => "Conflict",
            Self::RateLimited => "Too Many Requests",
            Self::Internal => "Internal Server Error",
            Self::Unavailable => "Service Unavailable",
        }
    }

    /// The machine-readable `type` URI for this category.
    #[must_use]
    pub fn type_uri(self) -> String {
        format!("urn:keel:error:{}", self.slug())
    }

    /// Whether this category is a server-side fault (5xx) whose `detail` may embed
    /// internal diagnostics (SQL text, driver/dependency errors). Such detail must not
    /// be returned to the client; it is logged server-side instead.
    #[must_use]
    pub const fn is_server_fault(self) -> bool {
        matches!(self, Self::Internal | Self::Unavailable)
    }
}

/// A domain error: a category plus a human-readable detail.
#[derive(Debug, Clone, Error)]
#[error("{category:?}: {detail}")]
pub struct DomainError {
    pub category: ErrorCategory,
    pub detail: String,
}

impl DomainError {
    /// Build a domain error in `category` with `detail`.
    #[must_use]
    pub fn new(category: ErrorCategory, detail: impl Into<String>) -> Self {
        Self {
            category,
            detail: detail.into(),
        }
    }

    /// Render as an RFC 9457 problem+json body. `instance` is an optional request URI.
    ///
    /// For server-fault categories (5xx) the `detail` is dropped: it may contain
    /// internal diagnostics (raw SQL/driver/dependency errors) that must never reach a
    /// client. Adapters log the real detail server-side before rendering. Client-fault
    /// categories (4xx) keep their detail, which is caller-facing by construction.
    #[must_use]
    pub fn to_problem(&self, instance: Option<String>) -> Problem {
        Problem {
            type_uri: self.category.type_uri(),
            title: self.category.title().to_string(),
            status: self.category.status(),
            detail: if self.category.is_server_fault() {
                None
            } else {
                Some(self.detail.clone())
            },
            instance,
        }
    }
}

/// An RFC 9457 problem+json body (`application/problem+json`).
#[derive(Debug, Clone, Serialize)]
pub struct Problem {
    #[serde(rename = "type")]
    pub type_uri: String,
    pub title: String,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{DomainError, ErrorCategory, Problem};

    #[test]
    fn status_codes_match_the_contract_taxonomy() {
        assert_eq!(ErrorCategory::Validation.status(), 400);
        assert_eq!(ErrorCategory::Unauthenticated.status(), 401);
        assert_eq!(ErrorCategory::Forbidden.status(), 403);
        assert_eq!(ErrorCategory::NotFound.status(), 404);
        assert_eq!(ErrorCategory::Conflict.status(), 409);
        assert_eq!(ErrorCategory::RateLimited.status(), 429);
        assert_eq!(ErrorCategory::Internal.status(), 500);
        assert_eq!(ErrorCategory::Unavailable.status(), 503);
    }

    #[test]
    fn type_uri_is_stable_and_namespaced() {
        assert_eq!(
            ErrorCategory::NotFound.type_uri(),
            "urn:keel:error:not_found"
        );
    }

    #[test]
    fn problem_serializes_with_rfc9457_fields_and_omits_empty() {
        let problem: Problem =
            DomainError::new(ErrorCategory::NotFound, "item missing").to_problem(None);
        let value: serde_json::Value = serde_json::to_value(&problem).unwrap();
        assert_eq!(value["type"], "urn:keel:error:not_found");
        assert_eq!(value["title"], "Not Found");
        assert_eq!(value["status"], 404);
        assert_eq!(value["detail"], "item missing");
        // instance is None, so it must be omitted entirely.
        assert!(value.get("instance").is_none());
    }

    #[test]
    fn server_faults_do_not_leak_detail_but_client_faults_keep_it() {
        // Internal/Unavailable details are built from raw dependency errors, so the
        // problem body must omit detail (logged server-side instead).
        for category in [ErrorCategory::Internal, ErrorCategory::Unavailable] {
            let problem = DomainError::new(
                category,
                "commit: error returned from database: duplicate key value",
            )
            .to_problem(None);
            assert!(
                problem.detail.is_none(),
                "{category:?} must not expose internal detail"
            );
        }
        // Client faults carry their (caller-facing) detail through.
        let problem =
            DomainError::new(ErrorCategory::Validation, "name is required").to_problem(None);
        assert_eq!(problem.detail.as_deref(), Some("name is required"));
    }
}
