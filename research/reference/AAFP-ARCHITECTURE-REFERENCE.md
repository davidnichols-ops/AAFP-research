# AAFP Architecture Reference (Internal)

Compiled from subagent studies of the AAFP Rust implementation and RFCs.
This document serves as the authoritative baseline for AAFP's architecture
in all subsequent phases.

## 1. AgentId

- **Formula**: `AgentId = SHA-256(public_key)` — 32 bytes
- **Properties**: Algorithm-independent, quantum-safe (SHA-256)
- **Verification**: `agent_id == SHA-256(received_public_key)` (error 2007)
- **Fingerprint**: `AAFP-<base32(first_16_bytes)>-<CRC32>` for out-of-band verification
- **File**: `implementations/rust/crates/aafp-identity/src/identity_v1.rs:35-84`
- **RFC**: RFC-0003 lines 35-58

## 2. AgentRecord

CBOR map with integer keys (1-10):
1. `record_type`: "aafp-record-v1"
2. `agent_id`: 32-byte SHA-256
3. `public_key`: ML-DSA-65 (1952 bytes)
4. `capabilities`: array of CapabilityDescriptor
5. `endpoints`: array of multiaddr strings
6. `created_at`: Unix timestamp
7. `expires_at`: Unix timestamp
8. `signature`: ML-DSA-65 signature (3309 bytes)
9. `key_algorithm`: 1 = ML-DSA-65
10. `record_version`: monotonic (A-3 replay protection)

**Signature**: `ML-DSA-65.Sign(sk, "aafp-v1-record" || canonical_CBOR(fields_1-7,9))`
**Domain separator**: "aafp-v1-record" (prefix-free set)
**File**: `identity_v1.rs:109-124`, `RFC-0003:209-336`

## 3. Handshake (v1)

Three-message: `ClientHello -> ServerHello -> ClientFinished`

**Transcript hash** (chained SHA-256):
```
h = SHA-256(tls_binding)
h = SHA-256(h || canonical_CBOR(ClientHello_without_sig_and_mac))
h = SHA-256(h || canonical_CBOR(ServerHello_without_sig))
h = SHA-256(h || canonical_CBOR(ClientFinished_without_sig))
```

**ClientHello**: protocol_version, agent_id, public_key (1952B), nonce (32B),
capabilities, extensions, signature (3309B), expires_at, receiver_mac (optional DoS MAC), key_algorithm

**ServerHello**: protocol_version, agent_id, public_key, nonce, capabilities,
extensions, session_id (32B), signature, expires_at, key_algorithm

**ClientFinished**: session_id, signature

**Session ID derivation** (A-4 binds to server identity):
```
salt = client_nonce || server_nonce
ikm  = h_after_clienthello || server_agent_id
prk  = HKDF-Extract(salt, ikm)
session_id = HKDF-Expand(prk, "aafp-session-id-v1", 32)
```

**DoS MAC**: `HMAC-SHA256(HKDF(agent_id, "aafp-v1-dos-mac-key"), ClientHello_cbor)`
Optional field (key 9), MUST be omitted when absent (A-2)

**File**: `implementations/rust/crates/aafp-crypto/src/handshake_v1.rs`

## 4. UCAN Capability Chains

```
Root Agent
    |  delegates
    v
Agent B (token_1, proof=null)
    |  delegates
    v
Agent C (token_2, proof=hash(token_1))
```

**UcanToken CBOR** (integer keys):
1. `issuer`: AgentId (bstr)
2. `subject`: AgentId (bstr)
3. `capabilities`: array of Capability
4. `expires_at`: uint
5. `proof`: parent token hash (bstr or null)
6. `signature`: ML-DSA-65 signature

**Capability**: `{resource: String, action: String, constraints: Option<JSON>}`

**Capability narrowing**: child resource must equal or be a sub-resource of
parent (`child.resource == parent.resource || child.resource.starts_with(parent.resource + ".")`)

**Chain verification**: recursive — verify leaf, then parent, check capability
narrowing at each step, check expirations, check `prf` linkage

**Signature**: `ML-DSA-65.Sign(sk, "aafp-v1-ucan" || CBOR(header) || CBOR(payload))`

**File**: `implementations/rust/crates/aafp-identity/src/ucan.rs`, `RFC-0003:484-538`

## 5. Session State Machine

8 states with strict forward transitions:
```
Connecting -> TransportEstablished -> IdentityVerified ->
AuthorizationVerified -> Authenticated -> MessagingEnabled ->
Closing -> Closed
```

- Graceful shutdown: any active state -> Closing
- Abort: any non-terminal state -> Closed
- Illegal transitions rejected at runtime
- Separate from handshake state machine (which tracks sub-states within
  the IdentityVerified phase)

**AuthorizationProvider trait**: `async fn authorize(peer_agent_id, peer_public_key) -> Result<AuthContext>`

**File**: `implementations/rust/crates/aafp-core/src/session.rs:202-279`

## 6. CLOSE State Machine (CloseManager)

5 states:
1. `Open` — no CLOSE sent/received
2. `LocalCloseSent` — local CLOSE sent, awaiting peer
3. `RemoteCloseReceived` — peer CLOSE received, should respond
4. `CloseReceived` — both sides exchanged CLOSE
5. `Closed` — terminal, QUIC closed

**Transitions**:
- `initiate_close()`: Open -> LocalCloseSent (starts 5s timer)
- `on_close_received()`: Open -> RemoteCloseReceived; LocalCloseSent -> CloseReceived -> Closed (crossed close)
- `respond_close()`: RemoteCloseReceived -> CloseReceived -> Closed
- `on_timeout()`: force close from LocalCloseSent or RemoteCloseReceived
- `abort()`: immediate -> Closed

**Frame disposition**: `can_send()` and `frame_disposition()` determine if
frames can be sent/received in current state (Accept or DiscardSilently)

**Constants**: DEFAULT_CLOSE_TIMEOUT=5s, MIN=1s, MAX_MESSAGE_LEN=256

**File**: `implementations/rust/crates/aafp-messaging/src/close_manager.rs`
**RFC**: RFC-0002 section 6.6 (Rev 6 A-8)

## 7. Transport (QUIC)

- **Library**: quinn + rustls + aws-lc-rs
- **PQ KEX**: X25519MLKEM768 (hybrid, default enabled)
- **ALPN**: `aafp/1`
- **Certificates**: Self-signed Ed25519 (TOFU at TLS layer; agent identity
  verified at application layer via ML-DSA-65)
- **Streams**: Bidirectional (open_bi/accept_bi) and unidirectional (open_uni/accept_uni)
- **Stream 0**: Reserved for handshake
- **Application streams**: >= 4 (client) or >= 5 (server)

**File**: `implementations/rust/crates/aafp-transport-quic/src/config.rs`, `transport.rs`

## 8. Frame Format

28-byte header:
- Version: 1 byte
- FrameType: 1 byte (0x01-0x08)
- Flags: 1 byte (MORE=0x01, COMPRESSED=0x02, CRITICAL=0x80)
- Reserved: 1 byte (MUST be 0)
- Stream ID: 8 bytes
- Payload Length: 8 bytes
- Extension Length: 8 bytes

**Limits**: MAX_PAYLOAD=1MiB, MAX_EXTENSION=64KiB

**Frame types**: Data(0x01), Handshake(0x02), RpcRequest(0x03),
RpcResponse(0x04), Close(0x05), Error(0x06), Ping(0x07), Pong(0x08)

**File**: `implementations/rust/crates/aafp-messaging/src/framing.rs:23-61`
**RFC**: RFC-0002 lines 114-193

## 9. RPC

**RpcRequest CBOR**: `{1: id(u64), 2: method(tstr), 3: params(Value)}`
- A-1: params MUST be present, NOT null

**RpcResponse CBOR**: `{1: id(u64), 2: result(Value)?, 3: error(RpcErrorObject)?}`
- A-2: result/error omitted when absent (not null)

**RpcErrorObject CBOR**: `{1: code(u32), 2: message(tstr), 3: data(bstr)?}`

**File**: `implementations/rust/crates/aafp-messaging/src/rpc_v1.rs`

## 10. CBOR (Canonical)

Per RFC 8949 section 4.2.3:
- Map keys sorted by length-first canonical byte ordering
- Integers use shortest encoding
- No indefinite-length arrays/maps
- No duplicate map keys
- No trailing bytes after top-level value
- AAFP maps use integer keys (except metadata which uses string keys)

**Value types**: Unsigned, Negative, ByteString, TextString, Array, IntMap,
StrMap, Bool, Null

**File**: `implementations/rust/crates/aafp-cbor/src/lib.rs`

## 11. Discovery

Three layers:
1. **Bootstrap**: Seed node multiaddrs, signature verification before adding
2. **Regional**: 7 geographic regions, latency-based assignment, closest-first lookup
3. **Capability DHT**: In-memory, indexed by capability name
   - RPC methods: `aafp.discovery.announce`, `aafp.discovery.lookup`, `aafp.discovery.pex`
   - Max 100K records, rate limiting, concurrent stream limits
   - `put()`: stores by each capability, replaces if newer (record_version)
   - `get()`: retrieves all matching a capability
   - `get_all()`: intersection of multiple capabilities

**File**: `implementations/rust/crates/aafp-discovery/src/discovery_v1.rs`

## 12. Replay Protection (ReplayCache)

- **Key**: `(agent_id[32] || nonce[32])` = 64 bytes
- **Entry**: `{expires_at: Instant, last_accessed: Instant}`
- **Default retention**: 300s (min 60s, max 3600s)
- **Default max_entries**: 100,000 (min 1K, max 10M)
- **Operations**:
  - `check_and_insert()`: atomic under lock — check for existing non-expired
    entry, if found return NonceReuseError, else insert
  - `check()`: read-only
  - `insert()`: insert without check
  - `evict_expired()`: lazy batch eviction (64 per call)
- **LRU eviction**: when at capacity, evict expired first, then LRU
- **Integration**: check-before-verify, insert-after-verify in handshake drivers

**File**: `implementations/rust/crates/aafp-crypto/src/replay_cache.rs`

## 13. ML-DSA-65

- **Public key**: 1952 bytes
- **Secret key**: 4032 bytes
- **Signature**: 3309 bytes
- **Modes**: Hedged (default, side-channel resistant), Deterministic (testing)
- **Context string**: Empty (matches PQClean, enables cross-language interop)
- **Cross-language**: `keypair_from_seed()` and `sign_deterministic()` for
  FIPS 204 test vector generation; Rust+Go interop verified (A-10)

**File**: `implementations/rust/crates/aafp-crypto/src/dsa.rs`

## 14. Domain Separators (Prefix-Free)

| Context | Separator |
|---------|-----------|
| AgentRecord | `aafp-v1-record` |
| Handshake | `aafp-v1-handshake` |
| UCAN | `aafp-v1-ucan` |
| DoS MAC key | `aafp-v1-dos-mac-key` |
| Session ID | `aafp-session-id-v1` |

Prefix-free set satisfies IETF CFRG requirements for domain separation.
