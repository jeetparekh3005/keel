//! gRPC server factory: deny-by-default auth + per-method scope authorization + mTLS
//! (ADR-0022, epic #419). The Rust mirror of the Python `keel_core` gRPC posture.
//!
//! The factory installs a tower [`AuthLayer`] by construction (see [`reference_router`]),
//! so an `ItemService` cannot be exposed unauthenticated. The layer runs ahead of tonic's
//! router, so it sees the full method path and enforces scopes from a central map (the
//! parity point with the other verticals, ADR-0022): it extracts the Bearer token from the
//! `authorization` metadata, re-verifies it via the existing [`Authenticator`] (never
//! trusting the gateway), enforces per-method scopes, and attaches the [`Principal`] to the
//! request extensions for the servicer. A missing/invalid token is `UNAUTHENTICATED`, a
//! signing-key/dependency outage is `UNAVAILABLE` (retryable, not an auth failure), and an
//! authenticated caller lacking the method's scope is `PERMISSION_DENIED`. Each call runs
//! inside a tracing span (RPC semconv), which the telemetry subscriber exports over OTLP.
//!
//! mTLS (ADR-0022 D): [`server_tls_config`]/[`client_tls_config`] build tonic's
//! `ServerTlsConfig`/`ClientTlsConfig` from PEM (cert/key/CA sourced from config or the
//! [`crate::ports::SecretProvider`], provisioned per deployment by the OpenBao/Vault PKI,
//! ADR-0007). The server requires and verifies the client certificate (mutual auth).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use tonic::body::Body;
use tonic::codegen::http;
use tonic::transport::server::Router;
use tonic::transport::{Certificate, ClientTlsConfig, Identity, Server, ServerTlsConfig};
use tonic::{Request, Response, Status};
use tower::layer::util::{Identity as IdentityLayer, Stack};
use tower::{Layer, Service};
use tracing::Instrument as _;

use crate::auth::{Authenticator, Principal};
use crate::domain::errors::{DomainError, ErrorCategory};
use crate::genproto::keel::reference::v1::item_service_server::{ItemService, ItemServiceServer};
use crate::genproto::keel::reference::v1::{
    CreateItemRequest, CreateItemResponse, GetItemRequest, GetItemResponse, Item, ListItemsRequest,
    ListItemsResponse,
};

/// Scope that opens the read methods (`GetItem`/`ListItems`).
pub const SCOPE_ITEMS_READ: &str = "items:read";
/// Scope that opens the write method (`CreateItem`).
pub const SCOPE_ITEMS_WRITE: &str = "items:write";

/// A shared authenticator for the interceptor to re-verify every call against.
pub type SharedAuthenticator = Arc<dyn Authenticator>;

/// The central authorization map for `ItemService`: full method path -> required scopes
/// (ADR-0022 option A1). Declaring scopes here (not in a proto option) lets the one
/// deny-by-default layer enforce them uniformly, the same posture as the REST edge.
#[must_use]
pub fn reference_scopes() -> HashMap<String, Vec<String>> {
    HashMap::from([
        (
            "/keel.reference.v1.ItemService/GetItem".to_string(),
            vec![SCOPE_ITEMS_READ.to_string()],
        ),
        (
            "/keel.reference.v1.ItemService/ListItems".to_string(),
            vec![SCOPE_ITEMS_READ.to_string()],
        ),
        (
            "/keel.reference.v1.ItemService/CreateItem".to_string(),
            vec![SCOPE_ITEMS_WRITE.to_string()],
        ),
    ])
}

/// Extract the Bearer token from the `authorization` header, or `None` if absent/malformed.
fn bearer_token(headers: &http::HeaderMap) -> Option<&str> {
    // RFC 7235 auth-scheme is case-insensitive, so accept any casing of "bearer".
    let value = headers.get(http::header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then_some(token)
}

/// Authenticate the call and enforce the method's required scopes, returning the
/// [`Principal`] on success or the gRPC [`Status`] to abort with.
fn authorize(
    authenticator: &dyn Authenticator,
    scopes: &HashMap<String, Vec<String>>,
    path: &str,
    headers: &http::HeaderMap,
) -> Result<Principal, Status> {
    let token = bearer_token(headers)
        .ok_or_else(|| Status::unauthenticated("missing or malformed bearer token"))?;
    let principal = authenticator.authenticate(token).map_err(|error| {
        // A signing-key/dependency outage is retryable, not an auth failure (matches the
        // REST 503 and the Python gRPC factory); anything else is an invalid credential.
        match error.category {
            ErrorCategory::Unavailable => Status::unavailable("auth dependency unavailable"),
            _ => Status::unauthenticated("invalid token"),
        }
    })?;
    // Deny-by-default: a method absent from the scope map is not exposed to anyone, even a
    // valid caller (fail-closed, not fail-open). An EXPLICIT "any authenticated caller may
    // call this" is a present-but-empty scope set (`Some(&[])`), which the `all` below passes
    // vacuously; it is deliberately distinct from absence (`None`).
    let Some(required) = scopes.get(path) else {
        return Err(Status::permission_denied("method not authorized"));
    };
    if !required
        .iter()
        .all(|scope| principal.scopes.contains(scope))
    {
        return Err(Status::permission_denied("insufficient scope"));
    }
    Ok(principal)
}

/// A tower [`Layer`] that installs deny-by-default auth + per-method scope authorization
/// ahead of the gRPC router. Applied by the factory, so a servicer cannot be served
/// without it.
#[derive(Clone)]
pub struct AuthLayer {
    authenticator: SharedAuthenticator,
    scopes: Arc<HashMap<String, Vec<String>>>,
}

impl AuthLayer {
    /// Build the layer from the authenticator and the method -> required-scopes map.
    #[must_use]
    pub fn new(authenticator: SharedAuthenticator, scopes: HashMap<String, Vec<String>>) -> Self {
        Self {
            authenticator,
            scopes: Arc::new(scopes),
        }
    }
}

impl<S> Layer<S> for AuthLayer {
    type Service = AuthService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        AuthService {
            inner,
            authenticator: self.authenticator.clone(),
            scopes: self.scopes.clone(),
        }
    }
}

/// The [`AuthLayer`]'s service: authenticates/authorizes each request before delegating to
/// the wrapped gRPC router, and rejects with the appropriate gRPC status otherwise.
#[derive(Clone)]
pub struct AuthService<S> {
    inner: S,
    authenticator: SharedAuthenticator,
    scopes: Arc<HashMap<String, Vec<String>>>,
}

impl<S> Service<http::Request<Body>> for AuthService<S>
where
    S: Service<http::Request<Body>, Response = http::Response<Body>> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = http::Response<Body>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: http::Request<Body>) -> Self::Future {
        // tower's contract: the clone observed ready in poll_ready is the one that must be
        // driven. Swap the ready inner out and move it into the future.
        let clone = self.inner.clone();
        let mut inner = std::mem::replace(&mut self.inner, clone);
        let authenticator = self.authenticator.clone();
        let scopes = self.scopes.clone();
        let path = req.uri().path().to_string();
        // RPC semconv span; the telemetry subscriber's OTel layer exports it over OTLP.
        let span = tracing::info_span!(
            "grpc.request",
            "rpc.system" = "grpc",
            "rpc.method" = %path,
        );
        Box::pin(
            async move {
                match authorize(authenticator.as_ref(), &scopes, &path, req.headers()) {
                    Ok(principal) => {
                        // Attach the authenticated principal; tonic copies HTTP extensions
                        // into the servicer's `Request`, so the handler can read it.
                        req.extensions_mut().insert(principal);
                        inner.call(req).await
                    }
                    Err(status) => Ok(status.into_http()),
                }
            }
            .instrument(span),
        )
    }
}

/// The concrete router type the factory returns: the gRPC router wrapped by the
/// deny-by-default [`AuthLayer`].
pub type ReferenceRouter = Router<Stack<AuthLayer, IdentityLayer>>;

/// Build the deny-by-default auth layer for `ItemService` (the central scope map baked in).
#[must_use]
pub fn reference_auth_layer(authenticator: SharedAuthenticator) -> AuthLayer {
    AuthLayer::new(authenticator, reference_scopes())
}

/// Build the `ItemService` gRPC server, deny-by-default by construction: the [`AuthLayer`]
/// is installed ahead of the router, so no method is reachable without a re-verified token
/// and the scope its path requires. Pass `tls` to serve over mTLS (the server then requires
/// and verifies the client certificate); pass `None` for a plaintext (in-cluster/dev) port.
///
/// Serve the returned router with `.serve(addr)` or `.serve_with_incoming(..)`.
///
/// # Errors
/// Returns an `Internal` [`DomainError`] if the TLS material is rejected (bad PEM, key
/// mismatch), so a misconfigured deployment fails fast rather than serving plaintext.
pub fn reference_router(
    authenticator: SharedAuthenticator,
    service: InMemoryItemService,
    tls: Option<ServerTlsConfig>,
) -> Result<ReferenceRouter, DomainError> {
    let mut server = Server::builder();
    if let Some(tls) = tls {
        server = server.tls_config(tls).map_err(|error| {
            DomainError::new(
                ErrorCategory::Internal,
                format!("invalid TLS config: {error}"),
            )
        })?;
    }
    Ok(server
        .layer(reference_auth_layer(authenticator))
        .add_service(ItemServiceServer::new(service)))
}

/// Server-side mTLS from PEM: serve `server_cert_pem`/`server_key_pem` and require client
/// certificates signed by `client_ca_pem`. tonic requires client auth by default, so this
/// is mutual auth (parity with the Python `mtls_server_credentials`). The PEM is sourced
/// from config or the [`crate::ports::SecretProvider`] (OpenBao/Vault PKI, ADR-0007).
#[must_use]
pub fn server_tls_config(
    server_cert_pem: &[u8],
    server_key_pem: &[u8],
    client_ca_pem: &[u8],
) -> ServerTlsConfig {
    ServerTlsConfig::new()
        .identity(Identity::from_pem(server_cert_pem, server_key_pem))
        .client_ca_root(Certificate::from_pem(client_ca_pem))
}

/// Client-side mTLS from PEM: present `client_cert_pem`/`client_key_pem` and verify the
/// server against `server_ca_pem`, checking the server certificate's SAN matches
/// `domain_name` (parity with the Python `mtls_channel_credentials`).
#[must_use]
pub fn client_tls_config(
    client_cert_pem: &[u8],
    client_key_pem: &[u8],
    server_ca_pem: &[u8],
    domain_name: impl Into<String>,
) -> ClientTlsConfig {
    ClientTlsConfig::new()
        .identity(Identity::from_pem(client_cert_pem, client_key_pem))
        .ca_certificate(Certificate::from_pem(server_ca_pem))
        .domain_name(domain_name)
}

/// An in-memory `ItemService` backing store. The focus of this slice is the auth/mTLS
/// posture, so the domain is a thread-safe `Vec` rather than the SQL repository the REST
/// aggregate uses; the servicer mirrors the REST handlers' shape (ADR-0022 option A1).
#[derive(Clone, Default)]
pub struct InMemoryItemService {
    items: Arc<Mutex<Vec<Item>>>,
}

impl InMemoryItemService {
    /// An empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

#[tonic::async_trait]
impl ItemService for InMemoryItemService {
    async fn get_item(
        &self,
        request: Request<GetItemRequest>,
    ) -> Result<Response<GetItemResponse>, Status> {
        // The principal is present by construction (the AuthLayer rejected the call
        // otherwise); reading it here is what the real repository would scope queries by.
        debug_assert!(request.extensions().get::<Principal>().is_some());
        let id = request.get_ref().id.as_str();
        let items = self.items.lock().expect("items lock poisoned");
        items
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .map(|item| Response::new(GetItemResponse { item: Some(item) }))
            .ok_or_else(|| Status::not_found(format!("item {id} not found")))
    }

    async fn list_items(
        &self,
        request: Request<ListItemsRequest>,
    ) -> Result<Response<ListItemsResponse>, Status> {
        let page = request.get_ref();
        let offset = usize::try_from(page.offset.max(0)).unwrap_or(0);
        let items = self.items.lock().expect("items lock poisoned");
        let limit = if page.limit <= 0 {
            items.len()
        } else {
            usize::try_from(page.limit).unwrap_or(items.len())
        };
        let items = items.iter().skip(offset).take(limit).cloned().collect();
        Ok(Response::new(ListItemsResponse { items }))
    }

    async fn create_item(
        &self,
        request: Request<CreateItemRequest>,
    ) -> Result<Response<CreateItemResponse>, Status> {
        let name = request.get_ref().name.trim().to_string();
        if name.is_empty() {
            return Err(Status::invalid_argument("name is required"));
        }
        let item = Item {
            id: uuid::Uuid::new_v4().to_string(),
            name,
        };
        self.items
            .lock()
            .expect("items lock poisoned")
            .push(item.clone());
        Ok(Response::new(CreateItemResponse { item: Some(item) }))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        authorize, bearer_token, client_tls_config, reference_router, reference_scopes,
        server_tls_config, InMemoryItemService, SharedAuthenticator, SCOPE_ITEMS_READ,
        SCOPE_ITEMS_WRITE,
    };
    use crate::auth::{Authenticator, Principal};
    use crate::domain::errors::{DomainError, ErrorCategory};
    use crate::genproto::keel::reference::v1::item_service_client::ItemServiceClient;
    use crate::genproto::keel::reference::v1::{
        CreateItemRequest, GetItemRequest, ListItemsRequest,
    };
    use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, IsCa, KeyPair};
    use std::collections::{BTreeSet, HashMap};
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tokio_stream::wrappers::TcpListenerStream;
    use tonic::transport::{Channel, Endpoint};
    use tonic::{Code, Request};

    fn principal(subject: &str, scopes: &[&str]) -> Principal {
        Principal {
            subject: subject.to_string(),
            scopes: scopes
                .iter()
                .map(ToString::to_string)
                .collect::<BTreeSet<_>>(),
            roles: BTreeSet::new(),
        }
    }

    // A stub IdP: "tok-read" holds items:read; "tok-write" holds read + write.
    fn stub() -> SharedAuthenticator {
        Arc::new(crate::testkit::StubAuthenticator::new(HashMap::from([
            (
                "tok-read".to_string(),
                principal("reader", &[SCOPE_ITEMS_READ]),
            ),
            (
                "tok-write".to_string(),
                principal("writer", &[SCOPE_ITEMS_READ, SCOPE_ITEMS_WRITE]),
            ),
        ])))
    }

    // An authenticator whose key source is down, to exercise the UNAVAILABLE mapping.
    struct OutageAuthenticator;
    impl Authenticator for OutageAuthenticator {
        fn authenticate(&self, _credential: &str) -> Result<Principal, DomainError> {
            Err(DomainError::new(ErrorCategory::Unavailable, "jwks down"))
        }
    }

    // Serve the reference router (optionally over mTLS) on an ephemeral loopback port.
    async fn serve(
        authenticator: SharedAuthenticator,
        tls: Option<tonic::transport::ServerTlsConfig>,
    ) -> SocketAddr {
        let router = reference_router(authenticator, InMemoryItemService::new(), tls)
            .expect("router builds");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            router
                .serve_with_incoming(TcpListenerStream::new(listener))
                .await
                .expect("server runs");
        });
        addr
    }

    async fn plaintext_client(addr: SocketAddr) -> ItemServiceClient<Channel> {
        let channel = Channel::from_shared(format!("http://{addr}"))
            .unwrap()
            .connect()
            .await
            .expect("connect");
        ItemServiceClient::new(channel)
    }

    fn authed<T>(message: T, token: &str) -> Request<T> {
        let mut request = Request::new(message);
        request
            .metadata_mut()
            .insert("authorization", format!("Bearer {token}").parse().unwrap());
        request
    }

    #[test]
    fn scope_map_declares_read_and_write_methods() {
        let scopes = reference_scopes();
        assert_eq!(
            scopes["/keel.reference.v1.ItemService/GetItem"],
            vec![SCOPE_ITEMS_READ]
        );
        assert_eq!(
            scopes["/keel.reference.v1.ItemService/CreateItem"],
            vec![SCOPE_ITEMS_WRITE]
        );
    }

    #[test]
    fn bearer_token_parsing_is_case_insensitive_and_rejects_absent() {
        let mut headers = tonic::codegen::http::HeaderMap::new();
        assert!(bearer_token(&headers).is_none());
        headers.insert("authorization", "bearer abc".parse().unwrap());
        assert_eq!(bearer_token(&headers), Some("abc"));
        headers.insert("authorization", "Basic abc".parse().unwrap());
        assert!(bearer_token(&headers).is_none());
    }

    // Deny-by-default: a valid token to a method NOT in the scope map is PERMISSION_DENIED,
    // never allowed. (Before the fail-closed fix this returned the principal, i.e. fail-open.)
    // Exercised at the `authorize` seam because no generated client can dial an unmapped path.
    #[test]
    fn authenticated_request_to_unmapped_path_is_permission_denied() {
        let authenticator = stub();
        let scopes = reference_scopes();
        let mut headers = tonic::codegen::http::HeaderMap::new();
        headers.insert("authorization", "Bearer tok-write".parse().unwrap());
        let status = authorize(
            authenticator.as_ref(),
            &scopes,
            "/keel.reference.v1.ItemService/Unmapped",
            &headers,
        )
        .unwrap_err();
        assert_eq!(status.code(), Code::PermissionDenied);
    }

    // An EXPLICIT open (a present-but-empty scope set) stays allowed for any authenticated
    // caller: it is distinct from absence, which the test above denies.
    #[test]
    fn authenticated_request_to_explicitly_open_path_is_allowed() {
        let authenticator = stub();
        let scopes = HashMap::from([("/open".to_string(), Vec::<String>::new())]);
        let mut headers = tonic::codegen::http::HeaderMap::new();
        headers.insert("authorization", "Bearer tok-read".parse().unwrap());
        let principal = authorize(authenticator.as_ref(), &scopes, "/open", &headers)
            .expect("explicitly-open path allows any authenticated caller");
        assert_eq!(principal.subject, "reader");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn no_token_is_unauthenticated() {
        let addr = serve(stub(), None).await;
        let mut client = plaintext_client(addr).await;
        let status = client
            .list_items(Request::new(ListItemsRequest {
                limit: 0,
                offset: 0,
            }))
            .await
            .unwrap_err();
        assert_eq!(status.code(), Code::Unauthenticated);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn invalid_token_is_unauthenticated() {
        let addr = serve(stub(), None).await;
        let mut client = plaintext_client(addr).await;
        let status = client
            .list_items(authed(
                ListItemsRequest {
                    limit: 0,
                    offset: 0,
                },
                "bogus",
            ))
            .await
            .unwrap_err();
        assert_eq!(status.code(), Code::Unauthenticated);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn auth_dependency_outage_is_unavailable() {
        let addr = serve(Arc::new(OutageAuthenticator), None).await;
        let mut client = plaintext_client(addr).await;
        let status = client
            .list_items(authed(
                ListItemsRequest {
                    limit: 0,
                    offset: 0,
                },
                "tok",
            ))
            .await
            .unwrap_err();
        assert_eq!(status.code(), Code::Unavailable);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn valid_token_wrong_scope_is_permission_denied() {
        // tok-read authenticates but lacks items:write, so CreateItem is forbidden.
        let addr = serve(stub(), None).await;
        let mut client = plaintext_client(addr).await;
        let status = client
            .create_item(authed(CreateItemRequest { name: "x".into() }, "tok-read"))
            .await
            .unwrap_err();
        assert_eq!(status.code(), Code::PermissionDenied);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn valid_token_with_scope_returns_payload() {
        let addr = serve(stub(), None).await;
        let mut client = plaintext_client(addr).await;

        // CreateItem needs items:write; the writer token holds it.
        let created = client
            .create_item(authed(
                CreateItemRequest {
                    name: "widget".into(),
                },
                "tok-write",
            ))
            .await
            .expect("create ok")
            .into_inner()
            .item
            .expect("item present");
        assert_eq!(created.name, "widget");
        assert!(!created.id.is_empty());

        // GetItem/ListItems need only items:read; the reader token suffices.
        let fetched = client
            .get_item(authed(
                GetItemRequest {
                    id: created.id.clone(),
                },
                "tok-read",
            ))
            .await
            .expect("get ok")
            .into_inner()
            .item
            .expect("item present");
        assert_eq!(fetched.id, created.id);

        let listed = client
            .list_items(authed(
                ListItemsRequest {
                    limit: 0,
                    offset: 0,
                },
                "tok-read",
            ))
            .await
            .expect("list ok")
            .into_inner();
        assert_eq!(listed.items.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn missing_item_is_not_found_and_empty_name_is_invalid() {
        let addr = serve(stub(), None).await;
        let mut client = plaintext_client(addr).await;

        let not_found = client
            .get_item(authed(GetItemRequest { id: "nope".into() }, "tok-read"))
            .await
            .unwrap_err();
        assert_eq!(not_found.code(), Code::NotFound);

        let invalid = client
            .create_item(authed(CreateItemRequest { name: "  ".into() }, "tok-write"))
            .await
            .unwrap_err();
        assert_eq!(invalid.code(), Code::InvalidArgument);
    }

    // --- mTLS ---------------------------------------------------------------------------

    struct Leaf {
        cert_pem: String,
        key_pem: String,
    }

    fn make_ca() -> CertifiedIssuer<'static, KeyPair> {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        CertifiedIssuer::self_signed(params, key).unwrap()
    }

    fn make_leaf(san: &str, issuer: &CertifiedIssuer<'_, KeyPair>) -> Leaf {
        let key = KeyPair::generate().unwrap();
        let params = CertificateParams::new(vec![san.to_string()]).unwrap();
        let cert = params.signed_by(&key, issuer).unwrap();
        Leaf {
            cert_pem: cert.pem(),
            key_pem: key.serialize_pem(),
        }
    }

    #[test]
    fn mtls_configs_build_from_pem() {
        let ca = make_ca();
        let ca_pem = ca.pem();
        let server = make_leaf("localhost", &ca);
        let client = make_leaf("client", &ca);
        // Builders must accept well-formed PEM without panicking (parity with the Python
        // isinstance assertions). The handshake test below proves they actually work.
        let _server_tls = server_tls_config(
            server.cert_pem.as_bytes(),
            server.key_pem.as_bytes(),
            ca_pem.as_bytes(),
        );
        let _client_tls = client_tls_config(
            client.cert_pem.as_bytes(),
            client.key_pem.as_bytes(),
            ca_pem.as_bytes(),
            "localhost",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mtls_loopback_handshake_succeeds_for_trusted_client() {
        let ca = make_ca();
        let ca_pem = ca.pem();
        let server = make_leaf("localhost", &ca);
        let client = make_leaf("client", &ca);

        let server_tls = server_tls_config(
            server.cert_pem.as_bytes(),
            server.key_pem.as_bytes(),
            ca_pem.as_bytes(),
        );
        let addr = serve(stub(), Some(server_tls)).await;

        let client_tls = client_tls_config(
            client.cert_pem.as_bytes(),
            client.key_pem.as_bytes(),
            ca_pem.as_bytes(),
            "localhost",
        );
        let channel = Endpoint::from_shared(format!("https://127.0.0.1:{}", addr.port()))
            .unwrap()
            .tls_config(client_tls)
            .unwrap()
            .connect()
            .await
            .expect("mTLS connect");
        let mut client = ItemServiceClient::new(channel);

        // A real RPC over the mutually-authenticated channel: auth still applies on top.
        let created = client
            .create_item(authed(
                CreateItemRequest {
                    name: "secure".into(),
                },
                "tok-write",
            ))
            .await
            .expect("mTLS call ok")
            .into_inner();
        assert_eq!(created.item.unwrap().name, "secure");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mtls_rejects_untrusted_client() {
        let ca = make_ca();
        let server = make_leaf("localhost", &ca);
        let server_tls = server_tls_config(
            server.cert_pem.as_bytes(),
            server.key_pem.as_bytes(),
            ca.pem().as_bytes(),
        );
        let addr = serve(stub(), Some(server_tls)).await;

        // A client whose cert is signed by a DIFFERENT CA than the server's client_ca_root:
        // the server must refuse the handshake, so no RPC can even begin.
        let rogue_ca = make_ca();
        let rogue_client = make_leaf("client", &rogue_ca);
        let client_tls = client_tls_config(
            rogue_client.cert_pem.as_bytes(),
            rogue_client.key_pem.as_bytes(),
            ca.pem().as_bytes(), // trusts the real server, but presents an untrusted cert
            "localhost",
        );
        let endpoint = Endpoint::from_shared(format!("https://127.0.0.1:{}", addr.port()))
            .unwrap()
            .tls_config(client_tls)
            .unwrap();

        // Either the connect handshake fails, or (if connect is lazy) the first RPC does.
        let rejected = match endpoint.connect().await {
            Err(_) => true,
            Ok(channel) => ItemServiceClient::new(channel)
                .list_items(authed(
                    ListItemsRequest {
                        limit: 0,
                        offset: 0,
                    },
                    "tok-read",
                ))
                .await
                .is_err(),
        };
        assert!(rejected, "untrusted client must be rejected by mTLS");
    }
}
