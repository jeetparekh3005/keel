//! Reference service (Rust vertical): a thin service over keel-core-rust that
//! implements the items aggregate and satisfies the platform contract. Hexagonal:
//! the domain is pure, adapters implement the ports, and the composition root wires
//! them (ADR-0002, ADR-0009).

pub mod composition;
pub mod config;
pub mod domain;
pub mod http;
pub mod repository;
pub mod service;

pub use composition::build_app;
pub use config::ServiceConfig;
