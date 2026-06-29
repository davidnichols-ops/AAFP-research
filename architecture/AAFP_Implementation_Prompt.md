# AAFP Implementation Prompt for Devin Session

## Context

You are building the **Agent-Agent First Networking Protocol (AAFP)** — a post-quantum, agent-first P2P networking stack in Rust.

Two research documents exist on disk that you MUST read first:
1. `/Users/david/AAFP-research/AAFP_Research_Report.md` — feasibility study (794 lines)
2. `/Users/david/AAFP-research/AAFP_Architecture_Deliverable.md` — full architecture (1249 lines)

Read BOTH files completely before writing any code. They contain every design decision, component selection, repository structure, and implementation order you need.

## Your Mission

Implement **AAFP v0.1 (MVP)** as defined in Phase 4 of the architecture deliverable:
- 100 agents connected simultaneously (reduced from 1000 for single-machine testing)
- PQ hybrid handshake (X25519MLKEM768 + ML-DSA-65)
- AgentID (ML-DSA-65 → SHA-256 = 32 bytes)
- Capability-keyed DHT (single region)
- QUIC stream messaging
- NAT traversal (relay fallback)
- Basic CLI

## Execution Rules

1. **Do NOT ask for approval on individual file writes or cargo commands.** Work autonomously. Only pause if:
   - A command requires authentication (e.g., `git push`, `cargo publish`)
   - A destructive operation (e.g., `rm -rf`, deleting non-generated files)
   - You hit a genuine design decision not covered by this prompt or the architecture docs

2. **Work in `/Users/david/AAFP-research/aafp/`** — create this directory as the Rust workspace root.

3. **Follow the implementation order** from Section 8 of the deliverable:
   - `aafp-crypto` → `aafp-identity` → `aafp-core` → `aafp-transport-quic` → `aafp-discovery` → `aafp-nat` → `aafp-messaging` → `aafp-sdk` → `aafp-cli` → `aafp-benchmark`

4. **Use the exact crate structure** from Phase 5 of the deliverable. Do not improvise the workspace layout.

5. **Prefer existing crates over building from scratch:**
   - `quinn` for QUIC (do NOT build QUIC from scratch)
   - `rustls` with `aws-lc-rs` backend for PQ (`prefer-post-quantum` feature)
   - `liboqs-rust` or `pqcrypto-mldsa` for standalone ML-DSA-65 operations
   - Fork `libp2p-core` for Transport/Swarm/NetworkBehaviour traits (do NOT use libp2p as a dependency — fork the core traits into `aafp-core`)

6. **Write tests alongside implementation.** Every crate must have unit tests. Integration tests go in `tests/integration/`.

7. **Run `cargo build` and `cargo test` after each crate is complete.** Fix all errors before moving to the next crate.

8. **Write a `Cargo.toml` workspace** at the root with all member crates listed.

9. **If you get stuck on a build issue for more than 15 minutes, skip to the fallback for that step.** Do not spend more than 15 minutes on any single build error. See "Fallback Plans" section below.

---

## Phase 0: Build Prerequisites (DO THIS FIRST — before any code)

Before writing any Rust code, verify that all build prerequisites are installed. PQ crypto libraries have C dependencies that frequently fail on macOS.

### Step 0a: Check and install prerequisites

```bash
# Check for cmake (required by aws-lc-rs and liboqs)
which cmake || brew install cmake

# Check for clang/libclang (required by bindgen in liboqs-rust)
which clang || brew install llvm
export LIBCLANG_PATH=$(brew --prefix llvm)/lib/libc++  # may need adjustment

# Check for perl (required by aws-lc-rs build)
which perl || brew install perl

# Check for make/ninja (required by aws-lc-rs)
which make || brew install make
which ninja || brew install ninja

# Check Rust version (need 1.75+ for aws-lc-rs)
rustc --version

# Check for pkg-config (required by some PQ crates)
which pkg-config || brew install pkg-config
```

### Step 0b: Test PQ crypto builds in isolation

Before committing to the workspace, verify that the PQ crates actually build on this machine:

```bash
# Test 1: aws-lc-rs (the most common failure point)
cd /tmp && cargo new test-pq-build && cd test-pq-build
cat >> Cargo.toml << 'EOF'
[dependencies]
rustls = { version = "0.23", features = ["prefer-post-quantum", "aws-lc-rs"] }
aws-lc-rs = "1"
EOF
cargo build 2>&1 | tail -20
```

**If aws-lc-rs fails to build**, try these fixes in order:
1. `brew install cmake perl ninja` and retry
2. Set `export AWS_LC_SYS_STATIC=1` and retry
3. If still failing, fall back to `ring` backend (no PQ KEX, but lets you proceed with classical handshake for now — see Fallback Plan A below)

```bash
# Test 2: ML-DSA-65 signatures
cat >> Cargo.toml << 'EOF'
pqcrypto-mldsa = "0.1"
EOF
cargo build 2>&1 | tail -20
```

**If pqcrypto-mldsa fails to build**, try in order:
1. `brew install cmake clang` and retry
2. Try `liboqs-rust` instead: replace with `oqs-sys = "0.9"` and `oqs = "0.9"`
3. If both fail, use `ed25519-dalek` as a temporary stand-in for ML-DSA-65 (classical signatures, not PQ — see Fallback Plan B below). The API surface is identical; you can swap implementations later.

### Step 0c: Test quinn + rustls PQ integration

```bash
cat >> Cargo.toml << 'EOF'
quinn = "0.11"
tokio = { version = "1", features = ["full"] }
EOF
cargo build 2>&1 | tail -20
```

**If quinn fails**, check:
1. `brew install protoc` (quinn needs protobuf compiler)
2. Ensure Rust 1.75+ (`rustup update stable`)

### Step 0d: Record which PQ stack works

After Step 0b, record which ML-DSA-65 implementation works:
- If `pqcrypto-mldsa` works → use it
- If `liboqs-rust` works → use it
- If neither works → use `ed25519-dalek` as temporary stand-in (Fallback Plan B)

This decision determines the dependency in `aafp-crypto/Cargo.toml` and `aafp-identity/Cargo.toml`.

**Only proceed to Step 1 after all prerequisite tests pass.** Do not skip this phase.

---

## Step-by-Step Instructions

### Step 1: Setup

```bash
mkdir -p /Users/david/AAFP-research/aafp
cd /Users/david/AAFP-research/aafp
cargo init --lib
```

Create the workspace `Cargo.toml` with all 10 crates listed as members. Create each crate directory with `cargo new --lib crates/<name>`.

### Step 2: Read the architecture docs

Read both files completely:
- `/Users/david/AAFP-research/AAFP_Research_Report.md`
- `/Users/david/AAFP-research/AAFP_Architecture_Deliverable.md`

Pay special attention to:
- Phase 2 (Component Selection Matrix) — exact technology choices
- Phase 4 (MVP Definition) — what to build, what to exclude
- Phase 5 (Repository Structure) — exact crate layout and file structure
- Phase 8 (Implementation Order) — build sequence
- The "Monday morning" section at the end — Week 1 plan

### Step 3: Implement `aafp-crypto`

This is the foundation. Everything depends on it.

Implement:
- `kem.rs` — X25519MLKEM768 hybrid key encapsulation (use `rustls` + `aws-lc-rs`)
- `dsa.rs` — ML-DSA-65 signatures (use whichever PQ lib worked in Phase 0)
- `aead.rs` — ChaCha20-Poly1305 (default) + AES-256-GCM (hardware)
- `handshake.rs` — PQ hybrid 1-RTT handshake (X25519MLKEM768 KEX + ML-DSA-65 auth)
- `kdf.rs` — HKDF-SHA256 key derivation
- `traits.rs` — `CryptoProvider` trait abstraction

#### Concrete API Signatures for `aafp-crypto`

```rust
// traits.rs
pub trait SignatureScheme: Send + Sync {
    type PublicKey: AsRef<[u8]> + Clone + Send + Sync;
    type SecretKey: AsRef<[u8]> + Clone + Send + Sync;
    type Signature: AsRef<[u8]> + Clone + Send + Sync;

    fn keypair() -> (Self::PublicKey, Self::SecretKey);
    fn sign(secret: &Self::SecretKey, msg: &[u8]) -> Self::Signature;
    fn verify(public: &Self::PublicKey, msg: &[u8], sig: &Self::Signature) -> bool;
    fn algorithm_name() -> &'static str;
}

pub trait KeyEncapsulation: Send + Sync {
    type PublicKey: AsRef<[u8]> + Clone + Send + Sync;
    type SecretKey: AsRef<[u8]> + Clone + Send + Sync;
    type Ciphertext: AsRef<[u8]> + Clone + Send + Sync;
    type SharedSecret: AsRef<[u8]> + Clone + Send + Sync;

    fn keypair() -> (Self::PublicKey, Self::SecretKey);
    fn encapsulate(public: &Self::PublicKey) -> (Self::Ciphertext, Self::SharedSecret);
    fn decapsulate(secret: &Self::SecretKey, ct: &Self::Ciphertext) -> Self::SharedSecret;
    fn algorithm_name() -> &'static str;
}

// kem.rs
pub struct HybridKem;  // X25519MLKEM768
// Implements KeyEncapsulation trait
// SharedSecret = concat(X25519_shared_secret || MLKEM768_shared_secret)
// Then HKDF-SHA256 to derive final 32-byte shared secret

// dsa.rs
pub struct MlDsa65;  // ML-DSA-65
// Implements SignatureScheme trait
// PublicKey = 1952 bytes, Signature = 3309 bytes

// aead.rs
pub enum AeadAlgorithm {
    ChaCha20Poly1305,
    Aes256Gcm,
}

pub struct Aead {
    key: [u8; 32],
    algorithm: AeadAlgorithm,
}

impl Aead {
    pub fn new(key: [u8; 32], algorithm: AeadAlgorithm) -> Self;
    pub fn encrypt(&self, nonce: &[u8; 12], aad: &[u8], plaintext: &[u8]) -> Vec<u8>;
    pub fn decrypt(&self, nonce: &[u8; 12], aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, AeadError>;
}

// kdf.rs
pub fn hkdf_sha256(salt: &[u8], ikm: &[u8], info: &[u8], output_len: usize) -> Vec<u8>;

// handshake.rs
pub struct HandshakeResult {
    pub shared_secret: [u8; 32],
    pub peer_public_key: Vec<u8>,  // ML-DSA-65 public key
    pub transcript_hash: [u8; 32],
}

pub struct PqHandshake;

impl PqHandshake {
    // Client side: generates ClientHello with X25519MLKEM768 key share
    pub fn client_init() -> (ClientHello, ClientState);
    // Server side: processes ClientHello, generates ServerHello
    pub fn server_handle(client_hello: &ClientHello, server_keypair: &Keypair) -> (ServerHello, ServerState);
    // Client side: processes ServerHello, completes handshake
    pub fn client_finish(server_hello: &ServerHello, client_state: &mut ClientState) -> Result<HandshakeResult, HandshakeError>;
}
```

#### Wire Format for Handshake Messages

```
ClientHello:
  [1 byte: version = 0x01]
  [1 byte: handshake_type = 0x01 (client_hello)]
  [2 bytes: key_exchange_count (u16 BE)]
  For each key exchange:
    [2 bytes: algorithm_id (u16 BE)]  // 0x0001 = X25519MLKEM768
    [2 bytes: key_share_len (u16 BE)]
    [key_share_len bytes: key_share data]
  [2 bytes: signature_algorithm (u16 BE)]  // 0x0001 = ML-DSA-65
  [8 bytes: nonce (random)]

ServerHello:
  [1 byte: version = 0x01]
  [1 byte: handshake_type = 0x02 (server_hello)]
  [2 bytes: selected_kex_algorithm (u16 BE)]
  [2 bytes: key_share_len (u16 BE)]
  [key_share_len bytes: server key_share]
  [2 bytes: pubkey_len (u16 BE)]
  [pubkey_len bytes: server ML-DSA-65 public key (1952 bytes)]
  [4 bytes: signature_len (u32 BE)]
  [signature_len bytes: ML-DSA-65 signature over transcript]
  [8 bytes: nonce (random)]
```

Write benchmarks: handshake time (PQ hybrid vs classical X25519), signature time (ML-DSA-65 sign/verify).

Verify: `cargo test -p aafp-crypto` passes.

### Step 4: Implement `aafp-identity`

Implement:
- `keypair.rs` — ML-DSA-65 keypair generation, serialization, deserialization
- `agent_id.rs` — `AgentID = SHA-256(ML-DSA-65 pubkey)` = 32 bytes; derivation + verification
- `agent_record.rs` — `AgentRecord` struct (agent_id, pubkey, capabilities, endpoints, version, self-signature)
- `ucan.rs` — UCAN capability delegation chains (JWT-based, ML-DSA-65 signed)

#### Concrete API Signatures for `aafp-identity`

```rust
// keypair.rs
pub struct AgentKeypair {
    pub public_key: Vec<u8>,   // ML-DSA-65 public key (1952 bytes)
    pub secret_key: Vec<u8>,   // ML-DSA-65 secret key
}

impl AgentKeypair {
    pub fn generate() -> Self;
    pub fn from_bytes(secret: &[u8]) -> Result<Self, IdentityError>;
    pub fn to_bytes(&self) -> Vec<u8>;
    pub fn sign(&self, msg: &[u8]) -> Vec<u8>;
    pub fn verify(&self, msg: &[u8], sig: &[u8]) -> bool;
}

// agent_id.rs
pub type AgentId = [u8; 32];  // SHA-256(public_key)

pub fn derive_agent_id(public_key: &[u8]) -> AgentId;
pub fn verify_agent_id(agent_id: &AgentId, public_key: &[u8]) -> bool;

// agent_record.rs
#[derive(Clone, Serialize, Deserialize)]
pub struct AgentRecord {
    pub agent_id: [u8; 32],
    pub public_key: Vec<u8>,       // 1952 bytes
    pub capabilities: Vec<String>, // e.g., ["inference", "translation"]
    pub endpoints: Vec<String>,    // e.g., ["quic://1.2.3.4:4433"]
    pub version: u64,
    pub timestamp: u64,            // unix epoch seconds
    pub signature: Vec<u8>,        // self-signed ML-DSA-65 signature over the rest
}

impl AgentRecord {
    pub fn new(keypair: &AgentKeypair, capabilities: Vec<String>, endpoints: Vec<String>) -> Self;
    pub fn verify(&self) -> bool;  // verify self-signature
    pub fn to_bytes(&self) -> Vec<u8>;  // CBOR serialization
    pub fn from_bytes(data: &[u8]) -> Result<Self, IdentityError>;
}

// Serialization format: CBOR (use `ciborium` crate)
// Do NOT use JSON for wire format (too large, too slow)
// JSON is OK for CLI output and config files only

// ucan.rs
#[derive(Clone, Serialize, Deserialize)]
pub struct UcanToken {
    pub header: UcanHeader,
    pub payload: UcanPayload,
    pub signature: Vec<u8>,  // ML-DSA-65 signature over header+payload
}

#[derive(Clone, Serialize, Deserialize)]
pub struct UcanHeader {
    pub alg: String,       // "ML-DSA-65"
    pub typ: String,       // "JWT"
}

#[derive(Clone, Serialize, Deserialize)]
pub struct UcanPayload {
    pub iss: String,       // issuer AgentId (hex)
    pub aud: String,       // audience AgentId (hex)
    pub cap: Vec<Capability>,  // capabilities delegated
    pub exp: u64,          // expiration timestamp
    pub nbf: u64,          // not-before timestamp
    pub prf: Option<String>,  // proof (parent token hash, for chains)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Capability {
    pub resource: String,    // e.g., "compute.inference"
    pub action: String,      // e.g., "invoke"
    pub constraints: Option<serde_json::Value>,  // e.g., {"max_tokens": 1000}
}

impl UcanToken {
    pub fn delegate(
        issuer: &AgentKeypair,
        audience: &AgentId,
        capabilities: Vec<Capability>,
        expires_at: u64,
    ) -> Self;
    pub fn verify(&self, expected_audience: &AgentId) -> Result<(), IdentityError>;
    pub fn verify_chain(chain: &[&UcanToken], root_key: &[u8]) -> Result<(), IdentityError>;
    // verify_chain checks: each token is signed by the previous token's issuer,
    // the first token is signed by root_key, capabilities don't expand, not expired
}
```

#### UCAN Wire Format

```
UCAN Token = CBOR-encoded {
  header: {alg: "ML-DSA-65", typ: "JWT"},
  payload: {iss, aud, cap, exp, nbf, prf},
  signature: [ML-DSA-65 signature over CBOR(header) || CBOR(payload)]
}
```

Verify: `cargo test -p aafp-identity` passes.

### Step 5: Implement `aafp-core`

Fork the essential traits from `libp2p-core` into `aafp-core`. Do NOT add libp2p as a dependency. Copy and adapt the trait definitions.

Implement:
- `transport.rs` — `Transport` trait (adapted from libp2p): `listen_on`, `dial`, `poll`, with `AgentId` instead of `PeerId`
- `swarm.rs` — `Swarm` + `NetworkBehaviour` + `ConnectionHandler` traits (simplified versions of libp2p's)
- `agent_id.rs` — re-export from `aafp-identity`
- `connection.rs` — `ConnectionHandler` trait with `FromBehaviour`/`ToBehaviour` events
- `error.rs` — error types

#### Concrete API Signatures for `aafp-core`

```rust
// transport.rs
use std::task::{Context, Poll};
use futures::stream::Stream;
use crate::AgentId;

pub type Multiaddr = String;  // simplified: "quic://1.2.3.4:4433"

pub enum TransportEvent {
    Incoming { local_addr: Multiaddr, remote_addr: Multiaddr },
    ConnectionEstablished { peer: AgentId, connection: Box<dyn Connection> },
    ConnectionClosed { peer: AgentId },
    Error(Error),
}

pub trait Transport: Send {
    fn listen_on(&mut self, addr: &Multiaddr) -> Result<(), Error>;
    fn dial(&mut self, addr: &Multiaddr) -> Result<(), Error>;
    fn poll(&mut self, cx: &mut Context<'_>) -> Poll<TransportEvent>;
}

// connection.rs
pub trait Connection: Send {
    fn peer_id(&self) -> AgentId;
    fn open_stream(&mut self) -> Result<Box<dyn Stream>, Error>;
    fn accept_stream(&mut self) -> Option<Box<dyn Stream>>;
    fn close(&mut self);
}

pub trait Stream: Send + AsyncRead + AsyncWrite {
    fn id(&self) -> u64;
}

// swarm.rs
pub trait NetworkBehaviour: Send {
    type Event: Send;
    type ConnectionHandler: ConnectionHandler;

    fn on_event(&mut self, event: BehaviourEvent);
    fn poll(&mut self, cx: &mut Context<'_>) -> Poll<Self::Event>;
    fn new_handler(&self) -> Self::ConnectionHandler;
}

pub trait ConnectionHandler: Send {
    type FromBehaviour: Send;
    type ToBehaviour: Send;

    fn on_behaviour_event(&mut self, event: Self::FromBehaviour);
    fn poll(&mut self, cx: &mut Context<'_>) -> Poll<Self::ToBehaviour>;
}

// Simplified Swarm that drives Transport + NetworkBehaviour
pub struct Swarm<T: Transport, B: NetworkBehaviour> {
    transport: T,
    behaviour: B,
    connections: HashMap<AgentId, Box<dyn Connection>>,
}

impl<T: Transport, B: NetworkBehaviour> Swarm<T, B> {
    pub fn new(transport: T, behaviour: B) -> Self;
    pub fn listen_on(&mut self, addr: &Multiaddr) -> Result<(), Error>;
    pub fn dial(&mut self, addr: &Multiaddr) -> Result<(), Error>;
    pub fn poll(&mut self, cx: &mut Context<'_>) -> Poll<SwarmEvent>;
}

pub enum SwarmEvent {
    Behaviour(<dyn NetworkBehaviour>::Event),
    ConnectionEstablished { peer: AgentId },
    ConnectionClosed { peer: AgentId },
    IncomingConnection { remote_addr: Multiaddr },
    Error(Error),
}
```

Keep it minimal. The goal is to have the trait abstractions in place, not to replicate all of libp2p's complexity. If the full trait hierarchy is too complex, simplify to just `Transport` + `Connection` + `Stream` traits and skip `NetworkBehaviour`/`ConnectionHandler` for MVP (the SDK can drive connections directly).

Verify: `cargo test -p aafp-core` passes.

### Step 6: Implement `aafp-transport-quic`

Use `quinn` + `rustls` with `aws-lc-rs` PQ provider.

Implement:
- `config.rs` — `QuicConfig` struct wrapping `quinn::ClientConfig` + `quinn::ServerConfig` with `X25519MLKEM768` KEX
- `connection.rs` — QUIC connection wrapper implementing `aafp-core::Transport`
- `nat_frames.rs` — stub for NAT traversal extension frames
- `migration.rs` — stub for connection migration

#### Concrete API Signatures for `aafp-transport-quic`

```rust
// config.rs
pub struct QuicConfig {
    pub bind_addr: SocketAddr,
    pub keypair: AgentKeypair,
    pub max_concurrent_streams: u64,  // default: 100
    pub keep_alive_interval: Duration,  // default: 30s
    pub enable_pq: bool,  // default: true
}

impl QuicConfig {
    pub fn build_client_config(&self) -> quinn::ClientConfig;
    pub fn build_server_config(&self) -> quinn::ServerConfig;
    // Both configs use rustls with aws-lc-rs provider
    // KX groups: [X25519MLKEM768, X25519] (hybrid first, classical fallback)
    // Signature algorithms: [ML-DSA-65, Ed25519] (PQ first, classical fallback)
    // If PQ libs failed in Phase 0, use [X25519] and [Ed25519] only
}

// connection.rs
pub struct QuicTransport {
    endpoint: quinn::Endpoint,
    config: QuicConfig,
}

impl QuicTransport {
    pub fn new(config: QuicConfig) -> Result<Self, TransportError>;
    pub async fn connect(&self, addr: &Multiaddr) -> Result<QuicConnection, TransportError>;
    pub async fn accept(&self) -> Result<QuicConnection, TransportError>;
}

pub struct QuicConnection {
    conn: quinn::Connection,
    peer_id: AgentId,
}

impl QuicConnection {
    pub async fn open_stream(&self) -> Result<QuicStream, TransportError>;
    pub async fn accept_stream(&self) -> Result<QuicStream, TransportError>;
    pub fn peer_id(&self) -> &AgentId;
    pub fn close(&self);
}

pub struct QuicStream {
    stream: quinn::SendStream,  // or RecvStream, or both
}

impl AsyncRead for QuicStream { ... }
impl AsyncWrite for QuicStream { ... }
```

The key deliverable: two nodes can establish a QUIC connection with PQ hybrid handshake.

Verify: Write an integration test where two endpoints connect, open a stream, and exchange a message. `cargo test -p aafp-transport-quic` passes.

### Step 7: Implement `aafp-discovery`

Implement the first 3 layers of the 5-layer discovery architecture:

- `bootstrap.rs` — Layer 1: seed node list + mDNS for local discovery
- `regional.rs` — Layer 2: stub for hierarchical clustering (single region for MVP)
- `capability_dht.rs` — Layer 3: THIS IS THE CORE INNOVATION

#### Concrete API Signatures for `aafp-discovery`

```rust
// capability_dht.rs
pub type CapabilityKey = [u8; 32];  // SHA-256(capability_id || version || region_id)

pub fn capability_key(capability: &str, version: u32, region: &str) -> CapabilityKey {
    let mut hasher = Sha256::new();
    hasher.update(capability.as_bytes());
    hasher.update(&version.to_be_bytes());
    hasher.update(region.as_bytes());
    hasher.finalize().into()
}

pub struct CapabilityDht {
    local_records: HashMap<CapabilityKey, Vec<AgentId>>,
    // For MVP: simple in-memory HashMap. Production: Kademlia-style routing.
    region: String,
}

impl CapabilityDht {
    pub fn new(region: &str) -> Self;

    /// Advertise that this agent has a capability
    pub fn advertise(&mut self, capability: &str, agent_id: &AgentId) -> CapabilityKey;

    /// Lookup agents that have a capability
    pub fn lookup(&self, capability: &str) -> Vec<AgentId>;

    /// Remove an agent's advertisement
    pub fn unadvertise(&mut self, capability: &str, agent_id: &AgentId);

    /// Get all capabilities for an agent
    pub fn get_capabilities(&self, agent_id: &AgentId) -> Vec<String>;

    /// Serialize for network propagation (CBOR)
    pub fn to_bytes(&self) -> Vec<u8>;
    pub fn from_bytes(data: &[u8]) -> Result<Self, DiscoveryError>;

    /// Merge records from another node (CRDT-style union for MVP)
    pub fn merge(&mut self, other: &CapabilityDht);
}

// bootstrap.rs
pub struct Bootstrap {
    seed_nodes: Vec<Multiaddr>,
    mdns: Option<MdnsDiscovery>,  // if mdns crate available
}

impl Bootstrap {
    pub fn new(seed_nodes: Vec<Multiaddr>) -> Self;
    pub async fn discover(&self) -> Vec<Multiaddr>;
}

// regional.rs (stub for MVP)
pub struct RegionalCluster {
    region: String,
    members: Vec<AgentId>,
}

impl RegionalCluster {
    pub fn new(region: &str) -> Self;
    pub fn add_member(&mut self, agent_id: AgentId);
    pub fn members(&self) -> &[AgentId];
}
```

#### Capability DHT Wire Format

```
DHT Advertisement Message (CBOR):
{
  type: "advertise",       // or "lookup", "lookup_response", "unadvertise"
  capability: "inference",
  version: 1,
  region: "us-east",
  agent_id: [32 bytes],
  timestamp: 1234567890,
  signature: [ML-DSA-65 signature over the rest]
}

DHT Lookup Response (CBOR):
{
  type: "lookup_response",
  capability: "inference",
  agents: [[32 bytes], [32 bytes], ...],
  timestamp: 1234567890,
}
```

Verify: Write a test where 3 agents advertise different capabilities and a 4th discovers them by capability. `cargo test -p aafp-discovery` passes.

### Step 8: Implement `aafp-nat`

For MVP, implement a simple relay-based NAT traversal:

- `relay.rs` — simple relay that forwards encrypted QUIC streams between agents
- `auto_nat.rs` — detect if agent is behind NAT
- `dcutr.rs` — stub for hole punching (post-MVP)

#### Concrete API Signatures for `aafp-nat`

```rust
// relay.rs
pub struct Relay {
    listen_addr: SocketAddr,
    // Maps agent_id -> connection
    connections: HashMap<AgentId, quinn::Connection>,
}

impl Relay {
    pub fn new(listen_addr: SocketAddr) -> Self;
    pub async fn run(&mut self) -> Result<(), RelayError>;
    // When agent A wants to connect to agent B through relay:
    // 1. A connects to relay, sends "connect_to B"
    // 2. Relay opens a stream to B (if B is connected) or queues the request
    // 3. Relay pipes data between A's stream and B's stream
    // Relay CANNOT decrypt data (end-to-end encrypted by QUIC)
}

// auto_nat.rs
pub enum NatStatus {
    Public,
    PrivateNAT { observed_addr: SocketAddr },
    Unknown,
}

pub async fn detect_nat(endpoint: &quinn::Endpoint, relay_addr: &SocketAddr) -> NatStatus;
// Connects to relay, asks for observed address, compares with local address

// dcutr.rs (stub)
pub struct Dcutr;
impl Dcutr {
    pub fn new() -> Self;
    pub async fn hole_punch(&self, peer: &AgentId) -> Result<(), Error>;
    // TODO: implement actual hole punching (post-MVP)
    // For now, returns Err("not implemented, use relay")
}
```

Verify: `cargo test -p aafp-nat` passes.

### Step 9: Implement `aafp-messaging`

- `stream.rs` — wrapper around QUIC streams with backpressure
- `rpc.rs` — simple request-response framing over QUIC streams
- `framing.rs` — message framing
- `pubsub.rs` — stub for gossipsub

#### Concrete API Signatures for `aafp-messaging`

```rust
// framing.rs
pub fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, msg: &[u8]) -> async impl Future<Output = Result<(), Error>>;
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, Error>;

// Wire format:
// [4 bytes: payload length (u32 LE)]
// [payload bytes]
// Max frame size: 16 MB (16_777_216 bytes). Reject larger.

// rpc.rs
#[derive(Serialize, Deserialize)]
pub struct RpcRequest {
    pub id: u64,           // request ID for matching responses
    pub method: String,    // e.g., "discover", "ping", "echo"
    pub payload: Vec<u8>,  // CBOR-encoded arguments
}

#[derive(Serialize, Deserialize)]
pub struct RpcResponse {
    pub id: u64,           // matches request ID
    pub status: u8,        // 0 = ok, 1 = error
    pub payload: Vec<u8>,  // CBOR-encoded result or error message
}

pub struct RpcChannel {
    stream: QuicStream,
    next_id: u64,
    pending: HashMap<u64, oneshot::Sender<RpcResponse>>,
}

impl RpcChannel {
    pub fn new(stream: QuicStream) -> Self;
    pub async fn call(&mut self, method: &str, payload: &[u8]) -> Result<Vec<u8>, RpcError>;
    pub async fn serve<F>(&mut self, handler: F) -> Result<(), RpcError>
    where F: Fn(RpcRequest) -> Vec<u8>;
}

// stream.rs
pub struct MessageStream {
    inner: QuicStream,
}

impl MessageStream {
    pub async fn send(&mut self, msg: &[u8]) -> Result<(), Error>;
    pub async fn recv(&mut self) -> Result<Vec<u8>, Error>;
    // Uses framing.rs for length-prefixed messages
}

// pubsub.rs (stub)
pub trait PubSub {
    async fn publish(&mut self, topic: &str, msg: &[u8]) -> Result<(), Error>;
    async fn subscribe(&mut self, topic: &str) -> Result<Subscription, Error>;
}

pub struct Subscription;  // stub — returns stream of messages

// TODO: implement gossipsub (post-MVP)
```

#### RPC Wire Format

```
RPC Frame:
  [4 bytes: frame length (u32 LE)]
  [1 byte: message type]  // 0x01 = request, 0x02 = response
  [CBOR-encoded RpcRequest or RpcResponse]

Example RpcRequest (CBOR):
  {id: 1, method: "discover", payload: [CBOR of {capability: "inference"}]}

Example RpcResponse (CBOR):
  {id: 1, status: 0, payload: [CBOR of {agents: [[32 bytes], [32 bytes]]}]}
```

Verify: `cargo test -p aafp-messaging` passes.

### Step 10: Implement `aafp-sdk`

High-level API for agent developers:

```rust
// builder.rs
pub struct AafpBuilder {
    keypair: Option<AgentKeypair>,
    capabilities: Vec<String>,
    bind_addr: Option<SocketAddr>,
    seed_nodes: Vec<Multiaddr>,
    relay_addr: Option<SocketAddr>,
}

impl AafpBuilder {
    pub fn new() -> Self;
    pub fn with_keypair(mut self, kp: AgentKeypair) -> Self;
    pub fn with_capabilities(mut self, caps: Vec<String>) -> Self;
    pub fn with_bind_addr(mut self, addr: SocketAddr) -> Self;
    pub fn with_seed_nodes(mut self, seeds: Vec<Multiaddr>) -> Self;
    pub fn with_relay(mut self, addr: SocketAddr) -> Self;
    pub async fn build(self) -> Result<AafpClient, SdkError>;
}

// client.rs
pub struct AafpClient {
    keypair: AgentKeypair,
    agent_id: AgentId,
    transport: QuicTransport,
    discovery: CapabilityDht,
    connections: HashMap<AgentId, QuicConnection>,
    relay_addr: Option<SocketAddr>,
}

impl AafpClient {
    pub fn agent_id(&self) -> &AgentId;
    pub fn capabilities(&self) -> &[String];

    /// Discover agents by capability
    pub async fn discover(&mut self, capability: &str) -> Result<Vec<AgentId>, SdkError>;

    /// Connect to an agent (direct or via relay)
    pub async fn connect(&mut self, agent_id: &AgentId) -> Result<ConnectionHandle, SdkError>;

    /// Send a message to an agent (opens a stream, sends, closes)
    pub async fn send(&mut self, agent_id: &AgentId, msg: &[u8]) -> Result<(), SdkError>;

    /// Open a persistent stream to an agent
    pub async fn open_stream(&mut self, agent_id: &AgentId) -> Result<MessageStream, SdkError>;

    /// Make an RPC call to an agent
    pub async fn rpc(&mut self, agent_id: &AgentId, method: &str, payload: &[u8]) -> Result<Vec<u8>, SdkError>;

    /// Advertise a capability
    pub async fn advertise(&mut self, capability: &str) -> Result<(), SdkError>;

    /// Accept incoming connections (run as server)
    pub async fn accept(&mut self) -> Result<IncomingConnection, SdkError>;

    /// Run the event loop (processes discovery, connections, incoming messages)
    pub async fn run(&mut self) -> Result<(), SdkError>;
}

pub struct ConnectionHandle {
    agent_id: AgentId,
    stream: MessageStream,
}

pub struct IncomingConnection {
    pub agent_id: AgentId,
    pub stream: MessageStream,
}
```

Verify: `cargo test -p aafp-sdk` passes.

### Step 11: Implement `aafp-cli`

Use `clap` for CLI parsing.

Commands:
- `aafp init` — generate ML-DSA-65 keypair, create config file at `~/.aafp/config.json`
- `aafp start` — start AAFP node (listen + discover + accept connections)
- `aafp discover <capability>` — discover agents by capability
- `aafp connect <agent_id_hex>` — connect to an agent
- `aafp send <agent_id_hex> <message>` — send a message to an agent
- `aafp status` — show node status (agent_id, capabilities, connections, discovered agents)
- `aafp relay` — start a relay node

Config file format (`~/.aafp/config.json`):
```json
{
  "keypair_path": "~/.aafp/keypair.bin",
  "capabilities": ["inference", "translation"],
  "bind_addr": "127.0.0.1:0",
  "seed_nodes": [],
  "relay_addr": null
}
```

Verify: `cargo build -p aafp-cli` succeeds. Manual test: `./target/debug/aafp init` works.

### Step 12: Implement `aafp-benchmark`

- `handshake.rs` — benchmark PQ hybrid handshake vs classical (criterion)
- `discovery.rs` — benchmark capability lookup at 10, 100 agents
- `messaging.rs` — benchmark stream throughput + RPC latency

Verify: `cargo bench -p aafp-benchmark` runs.

### Step 13: Integration Test

Write `tests/integration/test_100_agents.rs`:
- Spin up 1 relay node
- Spin up 100 agent nodes (use tokio tasks, all on localhost with random ports)
- Each agent advertises 1-3 capabilities
- Each agent discovers agents by capability
- Each agent connects to 5 random discovered agents via direct or relay
- Each agent sends 1 message to each connected agent
- Assert: all messages received, all discoveries successful, all connections established

**Important implementation notes for the integration test:**
1. Use `127.0.0.1:0` for all bind addresses (OS assigns random ports)
2. Use a single tokio runtime with `tokio::spawn` for each agent (NOT separate processes)
3. Run with `ulimit -n 65536` (set this in the test or document it)
4. 100 agents × 5 connections = 500 QUIC connections — this is fine on localhost
5. Use `tokio::time::timeout` for each operation (10s per connection, 5s per message)
6. If 100 agents is too many, reduce to 50, then 25. Document the number that works.

### Step 14: Examples

Write `examples/`:
- `basic_connect.rs` — two agents connect + exchange messages
- `capability_discovery.rs` — agents discover each other by capability
- `relay_connect.rs` — agent connects to another via relay

### Step 15: Documentation

- Write `README.md` with quick start, architecture overview, and link to spec docs
- Write `ARCHITECTURE.md` summarizing the design
- Ensure `cargo doc --workspace` generates clean docs

---

## Fallback Plans

If you get stuck on any step for more than 15 minutes, use the fallback for that step. Do not spend more than 15 minutes on any single build error.

### Fallback Plan A: PQ KEX build failure (aws-lc-rs won't build)

If `aws-lc-rs` fails to build and cannot be fixed:
1. Switch to `rustls` with `ring` backend: `rustls = { version = "0.23", default-features = false, features = ["ring", "std"] }`
2. Use classical `X25519` KEX only (no PQ KEX)
3. In `aafp-crypto/kem.rs`, implement `X25519Kem` instead of `HybridKem`
4. Note in `ARCHITECTURE.md`: "PQ KEX deferred due to aws-lc-rs build failure on target platform. Classical X25519 used as fallback. PQ KEX to be re-enabled when build issue is resolved."
5. Continue with the rest of the implementation — the architecture is the same, just the KEX algorithm changes

### Fallback Plan B: ML-DSA-65 build failure (pqcrypto/liboqs won't build)

If neither `pqcrypto-mldsa` nor `liboqs-rust` builds:
1. Use `ed25519-dalek = "2"` for signatures
2. In `aafp-crypto/dsa.rs`, implement `Ed25519` as the `SignatureScheme`
3. `AgentId = SHA-256(ed25519_public_key)` still works (32 bytes)
4. UCAN tokens are signed with Ed25519 instead of ML-DSA-65
5. Note in `ARCHITECTURE.md`: "ML-DSA-65 deferred due to PQ library build failure. Ed25519 used as fallback. ML-DSA-65 to be re-enabled when build issue is resolved."
6. The API surface is identical — swapping Ed25519 for ML-DSA-65 later is a drop-in replacement

### Fallback Plan C: quinn build failure

If `quinn` fails to build:
1. Try `s2n-quic` as an alternative QUIC library: `s2n-quic = "1"`
2. If that also fails, fall back to TCP + manual TLS: use `tokio` TCP + `rustls` for the transport
3. In `aafp-transport-quic`, rename to `aafp-transport` and implement over TCP
4. You lose QUIC's native multiplexing — use `yamux` crate for stream multiplexing over TCP
5. Note in `ARCHITECTURE.md`: "QUIC transport deferred due to quinn build failure. TCP + rustls + yamux used as fallback."

### Fallback Plan D: Integration test too heavy (100 agents fails)

If the 100-agent integration test fails due to resource constraints:
1. Reduce to 50 agents, then 25, then 10
2. Reduce connections per agent from 5 to 2
3. If even 10 agents fails, test with 2 agents (basic connectivity test)
4. Document what worked: "Integration test runs with N agents, M connections per agent."
5. The test is still valuable at any scale — it proves the stack works end-to-end

### Fallback Plan E: Scope too large (running out of time)

If you've been working for 7+ hours and haven't completed all 10 crates, prioritize in this order:
1. **Must have:** `aafp-crypto` + `aafp-identity` + `aafp-transport-quic` + `aafp-sdk` + `aafp-cli` + 2-agent integration test
2. **Nice to have:** `aafp-discovery` + `aafp-messaging` + `aafp-nat`
3. **Skip if needed:** `aafp-core` (fold traits into `aafp-sdk`), `aafp-benchmark`, examples, docs

The minimum viable demo: `aafp init` → `aafp start` (agent 1) → `aafp start` (agent 2) → `aafp discover` → `aafp connect` → `aafp send` → message received.

### Fallback Plan F: CBOR serialization issues

If `ciborium` has issues:
1. Use `bincode` instead (simpler, faster, but not self-describing)
2. Or use `serde_json` (larger but universally compatible)
3. The serialization format doesn't matter for MVP as long as it's consistent

---

## Key Technical Decisions (Already Made — Do Not Reconsider)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Transport | Modified QUIC (quinn) | Native multiplexing, 0-RTT, migration, ECN |
| Security | X25519MLKEM768 + ML-DSA-65 | Hybrid hedging, NIST-standardized, rustls-supported |
| Identity | ML-DSA-65 → SHA-256 = 32B AgentID | PQ-secure, compact for routing |
| Discovery | Capability-keyed DHT (single region for MVP) | Discover by what agents can do, not who they are |
| Messaging | QUIC streams + RPC framing | Backpressure + request-response |
| NAT | Relay fallback for MVP, DCUtR post-MVP | Simplest path to working NAT traversal |
| libp2p | Fork core traits, don't use as dependency | Need to replace PeerId, Noise, Kademlia |
| Serialization | CBOR (wire) / JSON (config/CLI) | Compact, self-describing, serde-compatible |
| Frame format | `[4-byte LE length][payload]` | Simple, sufficient for MVP |
| Async runtime | tokio | Standard, quinn requires it |

## Dependencies (Cargo.toml)

```toml
# Workspace dependencies
[workspace.dependencies]
quinn = "0.11"
rustls = { version = "0.23", features = ["prefer-post-quantum", "aws-lc-rs"] }
aws-lc-rs = "1"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
ciborium = "0.2"
sha2 = "0.10"
hkdf = "0.12"
chacha20poly1305 = "0.10"
aes-gcm = "0.10"
clap = { version = "4", features = ["derive"] }
criterion = "0.5"
tracing = "0.1"
tracing-subscriber = "0.3"
thiserror = "1"
anyhow = "1"
bytes = "1"
futures = "0.3"
async-trait = "0.1"
tokio-util = { version = "0.7", features = ["codec"] }

# For ML-DSA-65 — use whichever worked in Phase 0:
# Option A (preferred): pqcrypto-mldsa
pqcrypto-mldsa = "0.1"
pqcrypto-traits = "0.1"

# Option B (fallback): liboqs-rust
# oqs-sys = "0.9"
# oqs = "0.9"

# Option C (last resort): ed25519-dalek (classical, not PQ)
# ed25519-dalek = "2"
```

## What NOT to Do

- Do NOT build QUIC from scratch (use quinn)
- Do NOT build TLS from scratch (use rustls)
- Do NOT implement PQ crypto from scratch (use aws-lc-rs / liboqs / pqcrypto)
- Do NOT implement Kademlia from scratch (use HashMap for MVP, note Kademlia routing as TODO)
- Do NOT add libp2p as a cargo dependency (fork the traits into aafp-core)
- Do NOT implement gossipsub for MVP (stub it)
- Do NOT implement hierarchical clustering for MVP (single region)
- Do NOT implement 0-RTT resumption for MVP (1-RTT is sufficient)
- Do NOT implement io_uring for MVP (tokio task-per-connection is fine for 100 agents)
- Do NOT implement the agent semantics layer for MVP (MCP, reputation, contracting are post-MVP)
- Do NOT write a spec document (the architecture deliverable already has the design)
- Do NOT ask for approval on file writes, cargo commands, or test runs
- Do NOT spend more than 15 minutes on a single build error — use the fallback plan
- Do NOT use JSON for wire format (use CBOR — JSON is for config/CLI only)
- Do NOT use Protobuf (adds build complexity; CBOR + serde is sufficient)

## Success Criteria

When you are done, ALL of the following must be true:

1. `cargo build --workspace` succeeds with zero errors
2. `cargo test --workspace` passes all tests
3. `cargo bench -p aafp-benchmark` runs (even if results are preliminary)
4. `./target/debug/aafp init` generates a keypair and config
5. `./target/debug/aafp start` starts a node that listens and discovers
6. The integration test with 100 agents (or as many as works) passes
7. `cargo doc --workspace` generates clean documentation
8. The code is organized exactly as specified in Phase 5 of the architecture deliverable
9. If any PQ library failed to build, `ARCHITECTURE.md` documents the fallback used

## If You Get Stuck

1. If `pqcrypto-mldsa` doesn't build → use Fallback Plan B (ed25519-dalek)
2. If `aws-lc-rs` doesn't build → use Fallback Plan A (ring backend, classical KEX)
3. If `quinn` doesn't build → use Fallback Plan C (TCP + rustls + yamux)
4. If 100-agent integration test fails → use Fallback Plan D (reduce agent count)
5. If running out of time → use Fallback Plan E (reduce scope to minimum viable demo)
6. If `ciborium` has issues → use Fallback Plan F (bincode or serde_json)
7. If you hit any design decision not covered by this prompt or the architecture docs, make the simplest choice that works and note it in `ARCHITECTURE.md`.

## Start Here

```bash
# Phase 0: Check prerequisites
which cmake || brew install cmake
which clang || brew install llvm
which perl || brew install perl
which ninja || brew install ninja
which pkg-config || brew install pkg-config

# Phase 0: Test PQ builds
cd /tmp && cargo new test-pq && cd test-pq
cat >> Cargo.toml << 'EOF'
[dependencies]
rustls = { version = "0.23", features = ["prefer-post-quantum", "aws-lc-rs"] }
aws-lc-rs = "1"
quinn = "0.11"
pqcrypto-mldsa = "0.1"
pqcrypto-traits = "0.1"
tokio = { version = "1", features = ["full"] }
EOF
cargo build 2>&1 | tail -30

# If build succeeds, proceed. If it fails, try fallbacks from Phase 0.

# Step 1: Create workspace
mkdir -p /Users/david/AAFP-research/aafp
cd /Users/david/AAFP-research/aafp
cargo init --lib
```

Then read the two architecture documents, then start implementing `aafp-crypto`.

Go.
