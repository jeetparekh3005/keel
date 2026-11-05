//! Reference service entrypoint for the Rust vertical.
//!
//! Scaffold only: the composition root, axum app, and adapters land in later slices
//! (epic #36). It links keel-core-rust and prints the targeted contract version.

fn main() {
    println!("reference-service-rust scaffold {}", keel_core_rust::CONTRACT_VERSION);
}
