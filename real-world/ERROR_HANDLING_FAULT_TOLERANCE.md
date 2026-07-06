# AAFP Error Handling & Fault Tolerance Patterns

> **Research Document**: Error codes, propagation, retry, circuit breakers,
> timeouts, partial failure, cascading failure prevention, and recovery
> patterns in the Agent-to-Agent Federation Protocol (AAFP).

---

## Table of Contents

1. [Error Code Taxonomy (RFC-0005)](#1-error-code-taxonomy-rfc-0005)
2. [Error Propagation Across Agent Boundaries](#2-error-propagation-across-agent-boundaries)
3. [Retry Strategies](#3-retry-strategies)
4. [Circuit Breaker Integration](#4-circuit-breaker-integration)
5. [Timeout Handling & Deadline Propagation](#5-timeout-handling--deadline-propagation)
6. [Partial Failure in Streaming RPC](#6-partial-failure-in-streaming-rpc)
7. [Cascading Failure Prevention](#7-cascading-failure-prevention)
8. [Error Reporting to Clients](#8-error-reporting-to-clients)
9. [Error Logging](#9-error-logging)
10. [Error Recovery Patterns](#10-error-recovery-patterns)
11. [Human-Visible Errors](#11-human-visible-errors)
12. [Concrete Error Handling Examples](#12-concrete-error-handling-examples)

---

## 1. Error Code Taxonomy (RFC-0005)

AAFP defines a structured, numeric error code taxonomy in RFC-0005. Codes
are organized into thousand-digit categories, each representing a distinct
protocol layer or concern. The taxonomy is designed so that any recipient
can determine the severity and recovery options from the code alone,
without needing protocol-specific context.

### Category Ranges

| Category | Range | Description | Fatal? |
|----------|-------|-------------|--------|
| 0xxx | 0000–0999 | Success / Information | Never |
| 1xxx | 1000–1999 | Transport errors | Contextual |
| 2xxx | 2000–2999 | Authentication errors | **Always fatal** |
| 3xxx | 3000–3999 | Authorization errors | No |
| 4xxx | 4000–4999 | Discovery errors | No |
| 5xxx | 5000–5999 | Messaging errors | No |
| 6xxx | 6000–6999 | Capability errors | No |
| 7xxx | 7000–7999 | Resource errors (reserved) | No |
| 8xxx | 8000–8999 | Protocol errors | Selective |
| 9xxx | 9000–9999 | Application errors (reserved) | No |

> **Source**: `aafp-core/src/error.rs` lines 8–19. The `ErrorCategory` enum
> (lines 26–47) mirrors these ranges as a `#[repr(u32)]` enum, allowing
> `from_code()` (lines 51–65) to derive the category by integer division
> (`code / 1000`).

### Complete Error Code Listing

#### 0xxx — Success / Information

| Code | Constant | Description |
|------|----------|-------------|
| 0 | `OK` | Operation completed successfully |
| 1 | `PARTIAL` | Partial success; some operations did not complete |
| 2 | `NOT_FOUND` | Requested resource or entity was not found |

#### 1xxx — Transport Errors

| Code | Constant | Description |
|------|----------|-------------|
| 1001 | `CONNECTION_RESET` | Connection reset by peer or network |
| 1002 | `CONNECTION_TIMEOUT` | Connection timed out waiting for data |
| 1003 | `STREAM_CLOSED` | Stream closed unexpectedly |
| 1004 | `STREAM_RESET` | Stream reset by the peer |
| 1005 | `FLOW_CONTROL_ERROR` | Flow-control limit violated |
| 1006 | `TRANSPORT_UNREACHABLE` | Remote endpoint unreachable |
| 1007 | `TRANSPORT_REFUSED` | Remote endpoint refused connection |

#### 2xxx — Authentication Errors (Always Fatal)

| Code | Constant | Description |
|------|----------|-------------|
| 2001 | `INVALID_SIGNATURE` | Cryptographic signature invalid |
| 2002 | `IDENTITY_EXPIRED` | Peer identity has expired |
| 2003 | `UNKNOWN_AGENT` | Peer agent identity unknown |
| 2004 | `VERSION_MISMATCH` | Protocol version not supported |
| 2005 | `UNSUPPORTED_EXTENSIONS` | Requested extensions not supported |
| 2006 | `HANDSHAKE_FAILED` | Handshake failed (unspecified) |
| 2007 | `INVALID_AGENT_ID` | Agent ID malformed or invalid |
| 2008 | `NONCE_REUSE` | Nonce reused — replay attack detected |
| 2009 | `RECEIVER_MAC_INVALID` | Receiver MAC did not verify |
| 2010 | `UNSUPPORTED_ALGORITHM` | Cryptographic algorithm not supported |

#### 3xxx — Authorization Errors

| Code | Constant | Description |
|------|----------|-------------|
| 3001 | `UNAUTHORIZED` | Peer not authorized for requested action |
| 3002 | `INSUFFICIENT_CAPABILITY` | Peer lacks required capability |
| 3003 | `DELEGATION_CHAIN_INVALID` | Delegation chain invalid or broken |
| 3004 | `TOKEN_EXPIRED` | Authorization token expired |
| 3005 | `TOKEN_REVOKED` | Authorization token revoked |
| 3006 | `DELEGATION_DEPTH_EXCEEDED` | Delegation chain exceeds max depth |

#### 4xxx — Discovery Errors

| Code | Constant | Description |
|------|----------|-------------|
| 4001 | `DHT_ERROR` | DHT operation failed |
| 4002 | `BOOTSTRAP_FAILED` | Bootstrapping to discovery network failed |
| 4003 | `RECORD_INVALID` | Discovery record malformed or invalid |
| 4004 | `RECORD_EXPIRED` | Discovery record expired |
| 4005 | `CAPABILITY_NOT_FOUND` | Requested capability not found in discovery |
| 4006 | `ANNOUNCEMENT_REJECTED` | Discovery announcement rejected by network |

#### 5xxx — Messaging Errors

| Code | Constant | Description |
|------|----------|-------------|
| 5001 | `MALFORMED_FRAME` | Received frame was malformed |
| 5002 | `UNKNOWN_METHOD` | Requested RPC method unknown |
| 5003 | `SERIALIZATION_ERROR` | Serialization/deserialization failed |
| 5004 | `METHOD_PARAMS_INVALID` | RPC method parameters invalid |
| 5005 | `MESSAGE_TOO_LARGE` | Message exceeds maximum allowed size |
| 5006 | `STREAM_NOT_FOUND` | Requested stream not found |

#### 6xxx — Capability Errors

| Code | Constant | Description |
|------|----------|-------------|
| 6001 | `NEGOTIATION_FAILED` | Capability negotiation failed |
| 6002 | `INCOMPATIBLE` | Peer capabilities incompatible |
| 6003 | `UNSUPPORTED_CAPABILITY` | Requested capability not supported |
| 6004 | `CAPABILITY_OVERLOADED` | Capability overloaded beyond limits |

#### 8xxx — Protocol Errors

| Code | Constant | Description |
|------|----------|-------------|
| 8001 | `FRAME_TOO_LARGE` | Frame exceeds maximum allowed size |
| 8002 | `UNEXPECTED_COMPRESSION` | Unexpected compression on frame |
| 8003 | `HANDSHAKE_ON_WRONG_STREAM` | Handshake frame on wrong stream |
| 8004 | `UNKNOWN_CRITICAL_FRAME_TYPE` | Unknown critical frame type (**always fatal**) |
| 8005 | `UNKNOWN_CRITICAL_EXTENSION` | Unknown critical extension (**always fatal**) |
| 8006 | `INVALID_VERSION` | Protocol version field invalid (**always fatal**) |
| 8007 | `INVALID_FLAGS` | Frame flags invalid |
| 8008 | `RESERVED_FIELD_NONZERO` | Reserved field has non-zero value |
| 8009 | `PROTOCOL_VIOLATION` | General protocol violation (**always fatal**) |

> **Source**: `aafp-core/src/error.rs` lines 72–190 (`codes` module).

### Fatal Error Rules

RFC-0005 §4.4 defines two classes of fatal errors:

1. **All 2xxx Authentication errors** are always fatal. A failed
   authentication means the connection is fundamentally untrustworthy —
   continuing would risk operating on forged or replayed messages.

2. **Selected 8xxx Protocol errors** are always fatal:
   - `UNKNOWN_CRITICAL_FRAME_TYPE` (8004)
   - `UNKNOWN_CRITICAL_EXTENSION` (8005)
   - `INVALID_VERSION` (8006)
   - `PROTOCOL_VIOLATION` (8009)

   These indicate the peers disagree on the protocol itself — recovery
   is impossible without renegotiation.

The `is_always_fatal()` function (`error.rs` lines 200–215) encodes this
rule. The `ProtocolError::new()` constructor (lines 243–251) automatically
sets `fatal = true` for always-fatal codes. The `with_fatal(false)` override
(lines 265–269) **cannot** make an always-fatal code non-fatal — the OR
with `is_always_fatal()` ensures safety:

```rust
pub fn with_fatal(mut self, fatal: bool) -> Self {
    self.fatal = fatal || is_always_fatal(self.code);
    self
}
```

### Wire Format

The `ProtocolError` struct (`error.rs` lines 228–238) maps directly to the
CBOR `ErrorMessage` structure (RFC-0005 §4.1):

```cbor
ErrorMessage = {
    1: uint,            // code
    2: tstr,            // message
    3: bstr / null,     // data (opaque, max 4096 bytes)
    4: bool,            // fatal
}
```

The `data` field is optional opaque binary payload, truncated to 4096
bytes (RFC-0005 §9.3). This allows agents to attach structured diagnostic
information (e.g., a CBOR-encoded stack trace, a partial result, or a
machine-readable error detail map) without changing the protocol.

### Code Stability Guarantee

RFC-0005 §2.1 mandates that once assigned, error code meanings **MUST
NOT** change. This is a protocol-level ABI stability guarantee: an agent
built today must correctly interpret codes from an agent built years from
now. New codes can be added within existing category ranges, but existing
codes cannot be repurposed.

---

## 2. Error Propagation Across Agent Boundaries

AAFP errors flow through a multi-layer stack, with each layer translating
between internal error types and wire-protocol error codes.

### Error Flow Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Client Application                       │
│  Receives: SdkError (from call_agent_with_pool, etc.)      │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                    aafp-sdk (SDK Layer)                      │
│  SdkError enum — 13 variants covering all layers            │
│  HandlerError — typed errors from handler functions         │
│  Converts: HandlerError → SdkError::Messaging               │
│  Converts: SdkError → ProtocolError for wire transmission   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│              aafp-messaging (Frame Layer)                    │
│  FrameError — encoding/decoding errors                      │
│  RpcResponse.error — { code, message } in CBOR              │
│  ErrorMessage — wire-level error frame (CBOR)               │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│              aafp-core (Protocol Layer)                      │
│  ProtocolError { code, message, data, fatal }               │
│  Error enum — internal error type (8 variants)              │
│  is_always_fatal() — fatal classification                   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│           aafp-transport-quic (Transport Layer)              │
│  QUIC-level errors: connection reset, stream reset,         │
│  timeout, flow control                                      │
└─────────────────────────────────────────────────────────────┘
```

### SdkError — The SDK-Level Error Type

The `SdkError` enum (`aafp-sdk/src/lib.rs` lines 69–107) is the primary
error type that applications interact with. It has 13 variants:

| Variant | Source | Retryable? |
|---------|--------|------------|
| `Transport(String)` | Transport layer | Yes |
| `Discovery(String)` | Discovery layer | No |
| `Handshake(String)` | Handshake protocol | No |
| `Messaging(String)` | Messaging layer / handler error | No |
| `Frame(FrameError)` | Frame encoding/decoding | No |
| `NotConnected` | No connection to peer | No |
| `NotAuthenticated` | Session not in MessagingEnabled | No |
| `NotStarted` | Agent not started | No |
| `Identity(IdentityError)` | Identity layer | No |
| `Crypto(CryptoError)` | Cryptographic error | No |
| `Core(Error)` | Core crate error | Contextual |
| `Io(io::Error)` | I/O error | Yes |

### HandlerError — Server-Side Typed Errors

Handlers on the server side return `HandlerError` (`simple.rs` lines
235–293), which maps directly to RFC-0005 categories:

```rust
pub enum HandlerError {
    Transport(String),       // → 1001 CONNECTION_RESET
    Authentication(String),  // → 2001 INVALID_SIGNATURE
    Authorization(String),   // → 3001 UNAUTHORIZED
    Discovery(String),       // → 4005 CAPABILITY_NOT_FOUND
    Messaging(String),       // → 5004 METHOD_PARAMS_INVALID
    Capability(String),      // → 6003 UNSUPPORTED_CAPABILITY
    Protocol(String),        // → 8009 PROTOCOL_VIOLATION
    Application(String),     // → 9000 (reserved application error)
}
```

The `to_code()` method (`simple.rs` lines 265–276) converts a
`HandlerError` to the wire error code. The `from_code()` method (lines
279–292) performs the reverse mapping using `ErrorCategory::from_code()`.
Unknown code ranges default to `Protocol` (RFC-0005 §5.1).

### Internal-to-Wire Conversion

The `From<Error> for ProtocolError` implementation (`error.rs` lines
323–340) translates internal `aafp-core::Error` variants to wire codes:

| Internal Error | Wire Code | Wire Message |
|----------------|-----------|--------------|
| `Protocol(pe)` | (passthrough) | (passthrough) |
| `Io(_)` | 8009 `PROTOCOL_VIOLATION` | "I/O error" |
| `ConnectionClosed` | 1001 `CONNECTION_RESET` | "connection closed" |
| `NotConnected` | 1006 `TRANSPORT_UNREACHABLE` | "not connected" |
| `Transport(s)` / `Connection(s)` / `Dial(s)` / `Listen(s)` | 1001 `CONNECTION_RESET` | (original message) |
| `Stream(s)` | 1003 `STREAM_CLOSED` | (original message) |

### Error Frame Transmission

When an error occurs at the protocol level, it is transmitted as an ERROR
frame on stream 0 (the control stream). The `send_error_frame()` function
(`protocol_frames.rs` lines 32–57) encodes the `ProtocolError` into an
`ErrorMessage` CBOR payload, wraps it in a `Frame` with `FrameType::Error`,
and writes it to a bidirectional QUIC stream.

For RPC-level errors (handler returned an error), the error is embedded in
the `RpcResponse` as an `RpcErrorObject { code, message }` and sent as a
data frame on the RPC stream (`simple.rs` lines 1267–1279).

### Fatal Error Handling

When a fatal error is received:

1. The receiver **MUST** close the connection after processing the error
   frame (RFC-0002 §4.6).
2. The `CloseManager` (`close_manager.rs`) transitions through its
   five-state machine: `Open → LocalCloseSent → CloseReceived → Closed`.
3. All outstanding RPCs and streams on that connection are aborted.
4. The connection is removed from the `ConnectionPool`.

Non-fatal errors allow the connection to continue. The error is delivered
to the specific RPC or stream that caused it, but other concurrent RPCs
on the same connection are unaffected.

---

## 3. Retry Strategies

AAFP's retry layer distinguishes between three classes of errors with
fundamentally different retry semantics.

### Error Classification for Retry

The `is_retryable()` function (`routing/retry.rs` lines 59–62, specified
in `AR_T3_T4_BREAKER_HEDGING.md` Part 5, lines 616–628) classifies errors:

| Error Class | Retryable? | Rationale |
|-------------|-----------|-----------|
| `SdkError::Transport(_)` | **Yes** | Transient network failure |
| `SdkError::Connection(_)` | **Yes** | Connection dropped, may reconnect |
| `SdkError::Timeout` | **Yes** | Deadline not yet globally expired |
| `SdkError::CircuitOpen(_)` | **No** | Routing signal — skip to next candidate |
| `SdkError::ConcurrencyLimit(_)` | **No** | Routing signal — bulkhead full |
| `SdkError::Messaging(_)` | **No** | Handler ran and returned error — retry = duplicate side-effect |
| `SdkError::Discovery(_)` | **No** | Discovery failure is not transient |
| `SdkError::Handshake(_)` | **No** | Auth failures are fatal |
| `SdkError::NotAuthenticated` | **No** | Session state error |
| `SdkError::Crypto(_)` | **No** | Crypto failures are never transient |

### Idempotent vs Non-Idempotent Operations

The retry layer treats **all application-level errors as non-retryable**
regardless of idempotency. This is a conservative default: the handler
executed and returned a result (even if an error result), so retrying
would re-execute the handler's side effects.

For idempotent operations (e.g., read-only queries, stateless
computations), the caller can explicitly retry by re-issuing the call.
The retry layer's `with_retry()` function only retries transport-level
failures where the request may not have reached the handler:

```rust
pub async fn with_retry<F, Fut, T>(
    config: &RetryConfig,
    mut operation: F,
) -> Result<T, SdkError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, SdkError>>,
{
    let mut rng = rand::thread_rng();
    let mut last_err = None;

    for attempt in 0..=config.max_retries {
        match operation().await {
            Ok(val) => return Ok(val),
            Err(e) => {
                if !is_retryable(&e) {
                    return Err(e);  // Non-retryable — fail fast
                }
                last_err = Some(e);
                if attempt < config.max_retries {
                    let delay = retry_delay(config, attempt, &mut rng);
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| SdkError::Transport("retry exhausted".into())))
}
```

> **Source**: `AR_T3_T4_BREAKER_HEDGING.md` lines 635–662.

### Exponential Backoff with Jitter

The `RetryConfig` struct (`routing/retry.rs` lines 19–42) controls backoff:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `max_retries` | 3 | Maximum retry attempts (not counting initial) |
| `base_delay` | 50ms | Base delay for first retry |
| `max_delay` | 5s | Cap to prevent absurd waits |
| `jitter` | 1.0 (full) | Jitter factor in [0.0, 1.0] |

The delay formula (`AR_T3_T4_BREAKER_HEDGING.md` lines 598–610):

```
delay = min(base_delay * multiplier^attempt, max_delay)
jittered = random_in([delay * (1 - jitter), delay])  // or [0, delay] for full jitter
```

**Full jitter** (jitter = 1.0) randomizes the delay uniformly in
`[0, computed_delay]`. This is the recommended default because it
prevides maximum spread of retry attempts across concurrent callers,
preventing thundering herd problems.

**Equal jitter** (jitter = 0.5) uses `[computed_delay/2, computed_delay]`,
which preserves some backoff while still spreading attempts.

### Retry Budgets

The retry layer does not implement an explicit token-bucket retry budget.
Instead, it relies on three mechanisms to prevent retry storms:

1. **Circuit breaker**: After `failure_threshold` (default 5) consecutive
   failures, the circuit opens and all further requests are
   short-circuited — no retries are attempted against the tripped peer.

2. **Bulkhead concurrency limit**: The `ConcurrencyLimit` caps in-flight
   requests per peer (default configurable). Retries compete for the same
   slots as initial requests, preventing retry traffic from crowding out
   new requests.

3. **Max retries cap**: `max_retries = 3` by default limits each call to
   at most 4 attempts total. Combined with exponential backoff, the
   maximum total retry window is:
   - Attempt 0: immediate
   - Attempt 1: 0–50ms delay
   - Attempt 2: 0–100ms delay
   - Attempt 3: 0–200ms delay
   - Total worst case: ~350ms of retry delay

### Retry vs Failover

A critical distinction in AAFP's resilience design:

- **Retry** = same peer, same request, exponential backoff. Used for
  transient transport errors.
- **Failover** = different peer, same request, immediate. Used when the
  circuit is open or bulkhead is full.

`CircuitOpen` and `ConcurrencyLimit` errors are **not** retried — they
are routing signals that cause the `DiscoveryBuilder` to skip to the next
candidate (`simple.rs` lines 1056–1071). The failover loop tries all
discovered candidates in sequence:

```rust
let mut last_error: Option<SdkError> = None;
for peer in candidates {
    if let Some(addr) = peer.endpoints.first() {
        match call_agent_with_pool(&self.agent, &self.pool, addr, request.clone()).await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                tracing::warn!("call to {addr} failed: {e:?}, trying next candidate");
                last_error = Some(e);
                continue;
            }
        }
    }
}
Err(last_error.unwrap_or_else(|| SdkError::Discovery("all candidates failed".to_string())))
```

> **Source**: `simple.rs` lines 1057–1071.

---

## 4. Circuit Breaker Integration

The circuit breaker is the core fault-tolerance mechanism in AAFP's
Adaptive Routing Plane. It prevents cascading failures by stopping
traffic to peers that are demonstrably unhealthy.

### State Machine

The circuit breaker is a three-state machine, per-peer (keyed by
`AgentId`):

```
        consecutive_failures >= failure_threshold (5)
   Closed ─────────────────────────────────────────────► Open
     ▲                                                    │
     │ half_open_success_threshold consecutive             │ open_duration (30s) elapsed
     │ probe successes                                     ▼
     └───────────────────────────────────────────────── HalfOpen
                          probe fails ──► Open (restart cooldown)
```

> **Source**: `AR_T3_T4_BREAKER_HEDGING.md` lines 243–251.

### States

| State | Behavior | Transition In | Transition Out |
|-------|----------|---------------|----------------|
| **Closed** | Normal operation. Requests flow. Failures increment counter. | `half_open_success_threshold` consecutive probe successes | `consecutive_failures >= failure_threshold` → Open |
| **Open** | All requests short-circuited (rejected immediately). No dial, no stream. | `failure_threshold` reached, or `force_open()`, or probe failure in HalfOpen | `open_duration` elapsed → HalfOpen |
| **HalfOpen** | Limited probe requests allowed. If probes succeed → Closed. If any probe fails → Open. | `open_duration` elapses | Success threshold met → Closed; any failure → Open |

### Configuration

`CircuitBreakerConfig` (`AR_T3_T4_BREAKER_HEDGING.md` lines 57–81):

| Parameter | Default | Description |
|-----------|---------|-------------|
| `failure_threshold` | 5 | Consecutive failures to trip Closed → Open |
| `open_duration` | 30s | How long circuit stays Open before HalfOpen |
| `half_open_max_probes` | 3 | Max trial requests in HalfOpen |
| `half_open_success_threshold` | 1 | Consecutive probe successes to close |

An alternate config in `routing/config.rs` (lines 34–52) uses slightly
different defaults: `cooldown = 10s`, `half_open_max_trials = 1`. This
reflects different tuning for different deployment contexts.

### Admission Control

The `check_and_admit()` method (`AR_T3_T4_BREAKER_HEDGING.md` lines
133–165) is called **before** dialing the peer:

1. **Closed**: Return `Closed` — proceed normally.
2. **Open**: Check if `open_duration` has elapsed. If yes, atomically
   transition to `HalfOpen` and fall through to HalfOpen admission. If
   no, return `Open` — request is rejected.
3. **HalfOpen**: Admit a probe only if
   `half_open_probes_in_flight < half_open_max_probes` AND
   `half_open_probes_admitted < half_open_max_probes`. Each admitted
   probe increments both counters. If at capacity, return `Open`
   (treated as rejection for routing purposes).

### Outcome Recording

The `record_outcome()` method (`AR_T3_T4_BREAKER_HEDGING.md` lines
168–209) drives all state transitions after a call completes:

- **Success in Closed**: Reset `consecutive_failures` to 0.
- **Success in HalfOpen**: Increment `consecutive_successes`. If
  `>= half_open_success_threshold`, transition to `Closed`.
- **Failure in Closed**: Increment `consecutive_failures`. If
  `>= failure_threshold`, transition to `Open` and record `opened_at`.
- **Failure in HalfOpen**: Immediately transition to `Open`, restart
  cooldown, reset probe counters.
- **Failure in Open**: No-op (already open).

### Integration with ConnectionPool

The `call_agent_with_resilience()` function
(`AR_T3_T4_BREAKER_HEDGING.md` lines 373–412) integrates the circuit
breaker, bulkhead, and connection pool:

```
1. Dial via pool → get peer_id + connection
2. Circuit breaker check: check_and_admit(&peer_id)
   - If Open → release connection, return SdkError::CircuitOpen(peer_id)
3. Bulkhead admission: bulkhead.try_acquire(&peer_id)
   - If full → release connection, return SdkError::ConcurrencyLimit(peer_id)
4. Perform RPC (with RAII bulkhead guard for slot release)
5. Record outcome: circuit.record_outcome(&peer_id, success)
6. Release connection back to pool
```

### Critical Design Rule

`CircuitOpen` and `ConcurrencyLimit` errors **must not** increment
`consecutive_failures` in the circuit breaker. They are routing decisions,
not observed call outcomes. The circuit breaker only records outcomes from
actual RPC attempts — a rejected request is not a failure
(`AR_T3_T4_BREAKER_HEDGING.md` lines 739–742).

### Manual Override

- `force_open(agent_id)`: Immediately trips a peer's circuit (e.g., on
  transport-level connection refusal). Sets `consecutive_failures` to
  `failure_threshold` so the circuit stays open for the full cooldown.

- `reset(agent_id)`: Returns a peer's circuit to `Closed` (e.g., after
  manual intervention or operator verification that the peer is healthy).

> **Source**: `AR_T3_T4_BREAKER_HEDGING.md` lines 219–235.

---

## 5. Timeout Handling & Deadline Propagation

### RequestMetadata.deadline

AAFP propagates deadlines via `RequestMetadata.deadline`
(`simple.rs` lines 180–192):

```rust
pub struct RequestMetadata {
    pub capability: String,
    pub session_id: Option<[u8; 32]>,
    pub trace_id: Option<String>,
    pub deadline: Option<String>,      // ISO 8601 timestamp
    pub content_type: Option<String>,
}
```

The deadline is an ISO 8601 string representing the absolute time by which
the response must be received. This is an application-level deadline, not
a transport-level timeout — it travels with the request metadata across
agent boundaries.

### Deadline in Adaptive Hedging

The adaptive hedging policy (`AR_T3_T4_BREAKER_HEDGING.md` lines 519–545)
uses the deadline to decide whether to hedge:

```rust
pub fn should_hedge_adaptive(
    primary_metrics: &PeerMetrics,
    deadline_ms: f64,
) -> bool {
    if !primary_metrics.latency_ewma_ms.is_initialized() {
        return false;
    }
    let ewma = primary_metrics.latency_ewma_ms.value();
    let p99_estimate = ewma * 2.5;
    let likely_slow = p99_estimate > deadline_ms;
    // ... variance check ...
    likely_slow && high_variance
}
```

The `RoutingOptions` struct (`routing/config.rs` lines 132–143) allows
per-call deadline overrides:

```rust
pub struct RoutingOptions {
    pub deadline_ms: Option<f64>,
    pub skip_circuit: Option<bool>,
    // ...
}
```

### Timeout Layers

AAFP has multiple timeout layers, each protecting against different
failure modes:

| Layer | Timeout | Source |
|-------|---------|--------|
| QUIC connection idle | `DEFAULT_IDLE_TIMEOUT` | `connection_pool.rs` |
| Handshake | Frame read timeout | `handshake_driver.rs` |
| Close handshake | `DEFAULT_CLOSE_TIMEOUT` (5s) | `close_manager.rs` line 28 |
| RPC call | Caller-controlled via `tokio::time::timeout` | Application code |
| Hedging delay | `HedgePolicy.delay` (default 50ms) | `hedging.rs` |
| Circuit breaker cooldown | `CircuitBreakerConfig.open_duration` (30s) | `circuit.rs` |

### Deadline Propagation Pattern

When an agent receives a request with a deadline, it should:

1. **Check if deadline already expired**: If so, return immediately with
   an error (e.g., `HandlerError::Application("deadline exceeded")`).
2. **Compute remaining time**: `remaining = deadline - now`. Use this
   for any internal timeouts.
3. **Propagate to downstream calls**: If the handler calls other agents,
   pass a shortened deadline (the original deadline, not a new relative
   timeout) so the entire call chain respects the original time budget.
4. **Cancel on expiry**: The `HandlerContext.cancel` token
   (`simple.rs` lines 224–229) fires when the client disconnects.
   Handlers should also set their own timer based on the deadline.

### Close Timeout

The `CloseManager` (`close_manager.rs` lines 27–31) enforces a close
timeout:

```rust
pub const DEFAULT_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
pub const MIN_CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
```

If the peer does not respond to a CLOSE frame within the timeout, the
QUIC connection is forcibly closed. This prevents indefinite hangs during
graceful shutdown.

---

## 6. Partial Failure in Streaming RPC

Streaming RPC (server-streaming) introduces a unique failure mode: the
stream may fail mid-delivery after some frames have already been
successfully sent and consumed.

### Streaming Architecture

The streaming pipeline (`simple.rs` lines 1143–1264) works as follows:

1. **Server side**: The handler is spawned as a tokio task with a
   `mpsc::channel(32)` for sending responses. The `StreamingHandlerContext`
   provides a `ResponseSender` and a `CancellationToken`.

2. **Forwarder loop**: A select loop races between:
   - `rx.recv()` — receiving responses from the handler
   - `recv.read()` — detecting client disconnect

3. **Frame encoding**: Each response is encoded as an `RpcResponse` with
   the `MORE` flag set on intermediate frames. The final frame (without
   `MORE`) signals end-of-stream.

### Mid-Stream Error Handling

When a handler sends an error via `sender.error(HandlerError)`:

```rust
Err(err) => {
    // Handler sent an error via sender.error() — send error frame and close
    send_error_frame(&mut send, rpc_id, &err).await;
    break;
}
```

> **Source**: `simple.rs` lines 1215–1219.

The error is encoded as an `RpcResponse` with `error: Some(RpcErrorObject
{ code, message })` and sent as a data frame on the stream. The stream is
then closed (the loop breaks, `send.finish()` is called).

### Handler Return Error

If the handler itself returns `Err(HandlerError)` (as opposed to sending
an error through the `ResponseSender`), the forwarder sends an error frame
after the handler completes:

```rust
Ok(Err(err)) => {
    send_error_frame(&mut send, rpc_id, &err).await;
}
```

> **Source**: `simple.rs` lines 1244–1246.

### Handler Panic

If the handler task panics, the forwarder sends an application error:

```rust
Err(_) => {
    send_error_frame(
        &mut send, rpc_id,
        &HandlerError::Application("handler panicked".to_string()),
    ).await;
}
```

> **Source**: `simple.rs` lines 1247–1255.

### Client-Side Stream Consumption

The client reads frames in a spawned reader task (`simple.rs` lines
1327–1410). On any error:

1. **Frame decode error**: Send `Err(SdkError::Messaging(...))` to the
   channel and break.
2. **RPC response decode error**: Same — send error and break.
3. **Non-success RPC response**: Extract the error message and send
   `Err(SdkError::Messaging(msg))` to the channel, then break.
4. **End-of-stream signal**: A `Null` result without the `MORE` flag
   signals successful completion — break without error.
5. **Channel closed**: If the receiver (client) dropped the
   `ResponseStream`, the reader task stops.

### Client Disconnect Mid-Stream

If the client disconnects while the handler is still streaming, the
forwarder's `select!` detects the disconnect via `recv.read()`:

```rust
read_res = recv.read(&mut disconnect_buf) => {
    let _ = read_res;
    cancel_token.cancel();
    disconnected = true;
    break;
}
```

> **Source**: `simple.rs` lines 1173–1179.

The cancellation token fires, allowing the handler to abort long-running
operations. The forwarder then waits for the handler task to wind down
(`simple.rs` lines 1257–1260).

### Partial Result Semantics

When a stream fails mid-delivery:
- Frames already consumed by the client are **retained** — they are valid
  partial results.
- The error frame (if sent) is delivered as `Some(Err(SdkError))` on the
  next `ResponseStream::next()` call.
- Subsequent calls to `next()` return `None` (stream closed).

Clients that need atomic semantics must implement application-level
compensation or use idempotent operations that can be safely retried from
scratch.

---

## 7. Cascading Failure Prevention

AAFP employs three complementary patterns to prevent cascading failures:
bulkheads, circuit breakers, and timeouts.

### Bulkhead Pattern

The `ConcurrencyLimit` and `BulkheadRegistry`
(`AR_T3_T4_BREAKER_HEDGING.md` lines 259–328) cap the number of
concurrent in-flight requests per peer:

```rust
pub struct ConcurrencyLimit {
    max_inflight: u32,
    current: AtomicU32,
}
```

- `try_acquire()`: Atomically increments `current` if below
  `max_inflight`. Returns `false` if at capacity.
- `release()`: Atomically decrements `current`. Called via RAII
  `BulkheadGuard` to ensure slots are always freed.

The `BulkheadRegistry` maintains per-peer `ConcurrencyLimit` instances,
ensuring that a slow or overloaded peer cannot exhaust the client's
connection pool or task budget. When a peer's bulkhead is full, the
router skips to the next candidate — the rejected request does not
count as a circuit-breaker failure.

### Circuit Breaker

As described in §4, the circuit breaker stops traffic to peers with
sustained failures. This is the primary defense against cascading
failure: instead of every request to a failing peer contributing to the
cascade (timeout → retry → more load → more failures), the circuit opens
and traffic is redirected to healthy peers.

### Timeouts

Timeouts prevent indefinite waits on unresponsive peers:

- **QUIC idle timeout**: Closes connections that have been idle too long.
- **Application deadlines**: Propagated via `RequestMetadata.deadline`.
- **Hedging delay**: Limits how long the primary is waited before a
  secondary is launched.
- **Close timeout**: Prevents graceful shutdown from hanging.

### Combined Defense in Depth

The three patterns work together in the `call_agent_with_resilience()`
pipeline:

```
Request arrives
    │
    ▼
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Circuit Breaker  │────▶│    Bulkhead      │────▶│   RPC + Timeout   │
│  (skip if Open)   │     │  (reject if full) │     │  (fail if slow)   │
└──────────────────┘     └──────────────────┘     └──────────────────┘
    │                        │                        │
    ▼                        ▼                        ▼
  Skip to next            Skip to next           Record outcome
  candidate               candidate              in circuit breaker
```

- **Circuit breaker** prevents sending requests to known-bad peers.
- **Bulkhead** prevents a single slow peer from consuming all resources.
- **Timeout** prevents a single slow request from blocking indefinitely.
- **Failover** redirects traffic to healthy peers when any of the above
  triggers.

### Request Hedging as Failure Mitigation

Request hedging (`AR_T3_T4_BREAKER_HEDGING.md` Part 4, lines 420–489)
sends the same request to two agents and uses the first response. The
adaptive policy (Part 4b, lines 502–545) only hedges when the primary is
predicted to miss the deadline, avoiding unnecessary load doubling.

When hedging, the losing future is dropped, which resets the QUIC stream
(`RESET_STREAM` frame). The peer's server-side handler observes the
cancelled stream and aborts its work — this is natural QUIC-level
cancellation, requiring no application-level cancel frame.

---

## 8. Error Reporting to Clients

### HandlerError → Wire Error

When a handler returns `Err(HandlerError)`, the error is reported to the
client through two mechanisms depending on the call type:

#### Unary RPC

For unary (request-response) calls, the error is embedded in the
`RpcResponse` as an `RpcErrorObject`:

```rust
if !rpc_resp.is_success() {
    let msg = rpc_resp.error
        .map(|e| e.message)
        .unwrap_or_else(|| "unknown error".to_string());
    pool.release(&peer_id).await;
    return Err(SdkError::Messaging(msg));
}
```

> **Source**: `simple.rs` lines 1475–1483.

The `RpcErrorObject` contains `{ code: u32, message: String }`, where
`code` is the RFC-0005 error code from `HandlerError::to_code()`.

#### Streaming RPC

For streaming calls, the error is sent as a final data frame containing
the `RpcResponse` with `error: Some(...)`:

```rust
async fn send_error_frame(
    send: &mut QuicSendStream,
    rpc_id: u64,
    err: &HandlerError,
) {
    let rpc_resp = RpcResponse::error(rpc_id, RpcErrorObject::new(err.to_code(), err.to_string()));
    if let Ok(resp_bytes) = rpc_resp.encode() {
        let frame = Frame::data(0, resp_bytes);
        if let Ok(frame_bytes) = encode_frame(&frame) {
            let _ = send.write_all(&frame_bytes).await;
        }
    }
}
```

> **Source**: `simple.rs` lines 1267–1279.

#### Protocol-Level Errors

For protocol-level errors (fatal errors, malformed frames), an ERROR
frame is sent on stream 0 via `send_error_frame()` from
`protocol_frames.rs` (lines 32–57). This carries the full
`ProtocolError` struct including the `fatal` flag.

### Error Structure

The complete error information available to clients:

| Field | Source | Description |
|-------|--------|-------------|
| `code` | `HandlerError::to_code()` or `ProtocolError.code` | RFC-0005 numeric error code |
| `message` | `HandlerError` Display impl or `ProtocolError.message` | Human-readable error description |
| `data` | `ProtocolError.data` (optional) | Opaque binary payload (max 4096 bytes) |
| `fatal` | `ProtocolError.fatal` | Whether connection must be closed |

### SdkError Conversion

`HandlerError` converts to `SdkError` via:
```rust
impl From<HandlerError> for SdkError {
    fn from(err: HandlerError) -> Self {
        SdkError::Messaging(err.to_string())
    }
}
```

> **Source**: `simple.rs` lines 295–299.

Note that this conversion loses the structured error code — the client
receives a `SdkError::Messaging(String)` with the display message but not
the numeric code. For applications that need the structured code, the
RPC response layer preserves it in the `RpcErrorObject.code` field before
it is converted to `SdkError`.

---

## 9. Error Logging

### Structured Error Fields

AAFP error logging should include the following structured fields for
effective debugging and observability:

| Field | Source | Description |
|-------|--------|-------------|
| `trace_id` | `RequestMetadata.trace_id` | Distributed tracing correlation ID |
| `agent_id` | `Agent.agent_id` / `PeerInfo.agent_id` | Identity of the local or remote agent |
| `capability` | `RequestMetadata.capability` | Capability being invoked |
| `operation` | RPC method name | Specific operation within the capability |
| `error_code` | `ProtocolError.code` / `HandlerError::to_code()` | RFC-0005 numeric code |
| `error_category` | `ErrorCategory::from_code()` | Category (1xxx, 2xxx, etc.) |
| `fatal` | `ProtocolError.fatal` | Whether the error is fatal |
| `session_id` | `RequestMetadata.session_id` | Session identifier from handshake |
| `peer_addr` | `conn.remote_address()` | Network address of the peer |
| `elapsed_ms` | Computed from `Instant::now()` | Call duration in milliseconds |

### Logging in the Failover Loop

The `DiscoveryBuilder::call()` method logs warnings on candidate
failures:

```rust
Err(e) => {
    tracing::warn!("call to {addr} failed: {e:?}, trying next candidate");
    last_error = Some(e);
    continue;
}
```

> **Source**: `simple.rs` lines 1062–1066.

### Logging in the Server

The server logs on startup:
```rust
info!("Agent server started for {}", hex::encode(agent.id()));
```

> **Source**: `server.rs` line 219.

### Recommended Logging Pattern

For production deployments, errors should be logged with structured
fields:

```rust
tracing::error!(
    trace_id = %request.metadata.trace_id.as_deref().unwrap_or("unknown"),
    agent_id = %hex::encode(agent.id()),
    peer_id = %hex::encode(peer_id.as_bytes()),
    capability = %request.metadata.capability,
    error_code = %code,
    error_category = ?ErrorCategory::from_code(code),
    fatal = %fatal,
    elapsed_ms = %elapsed_ms,
    "RPC call failed: {message}"
);
```

### Metrics Integration

The `AgentMetrics` struct (`aafp-sdk/src/metrics.rs`) tracks lock-free
atomic counters for connections, messages, bytes, handshakes, DHT
records, and uptime. The `HealthStatus` enum classifies agent health as
`Healthy`, `Degraded`, or `Unhealthy` based on these counters. Error
rates should be fed into this system for health-based routing decisions.

The `PeerMetricsRegistry` (from the Adaptive Routing Plane T1 phase)
tracks per-peer EWMA latency, rolling success window, and circuit state.
These metrics drive the dynamic scoring and circuit breaker decisions.

---

## 10. Error Recovery Patterns

AAFP supports several error recovery patterns, from automatic to
application-level.

### Pattern 1: Automatic Failover

The simplest recovery pattern — already built into `DiscoveryBuilder`:
when a call to one candidate fails, the next candidate is tried
automatically. No application code is needed.

```rust
let response = agent.discover("translation")
    .call(request)
    .await?;
```

If the first translation agent fails, the SDK tries the next one. The
error is only surfaced to the application if all candidates fail.

### Pattern 2: Retry with Backoff

For transient transport errors, the retry layer automatically retries
with exponential backoff and jitter. This is transparent to the
application — the `with_retry()` function handles the retry loop
internally.

### Pattern 3: Fallback Agent

Applications can implement a fallback agent pattern by trying a primary
capability first, then falling back to a different capability or agent:

```rust
match agent.discover("inference").call(request.clone()).await {
    Ok(resp) => resp,
    Err(e) => {
        tracing::warn!("primary inference failed: {e}, falling back to backup");
        agent.discover("inference-backup").call(request).await?
    }
}
```

### Pattern 4: Cached Response

For idempotent read operations, applications can cache successful
responses and serve from cache on error:

```rust
match agent.discover("embedding").call(request.clone()).await {
    Ok(resp) => {
        cache.insert(cache_key, resp.clone());
        resp
    }
    Err(e) => {
        if let Some(cached) = cache.get(&cache_key) {
            tracing::warn!("serving cached response due to error: {e}");
            cached.clone()
        } else {
            return Err(e);
        }
    }
}
```

### Pattern 5: Degraded Mode

When a capability is unavailable, the agent can operate in degraded mode,
providing reduced functionality:

```rust
match agent.discover("summarization").call(request).await {
    Ok(resp) => resp,
    Err(e) => {
        tracing::warn!("summarization unavailable, returning raw text");
        Response::text(original_text)  // No summary, just the raw content
    }
}
```

### Pattern 6: Request Hedging

Hedging sends the same request to two agents simultaneously, using the
first response. This is built into the Adaptive Routing Plane:

```rust
let response = call_with_hedging(
    &agent, &pool,
    primary_addr, secondary_addr,
    request,
    Duration::from_millis(50),
).await?;
```

The adaptive policy (`should_hedge_adaptive()`) ensures hedging only
fires when the primary is predicted to be slow, avoiding unnecessary
load doubling.

### Pattern 7: Circuit Breaker Recovery

When a circuit opens, traffic is automatically redirected to healthy
peers. The circuit transitions through `Open → HalfOpen → Closed` as
probes succeed, gradually restoring traffic to the recovering peer. No
application intervention is needed.

### Pattern 8: Graceful Shutdown

On fatal errors, the `CloseManager` orchestrates a graceful shutdown:
send CLOSE frame → wait for peer CLOSE → close QUIC connection. This
ensures in-flight messages are completed (where possible) before the
connection is torn down.

---

## 11. Human-Visible Errors

### Translation Layer

AAFP error codes are machine-readable but not user-friendly. Applications
should translate them to human-visible messages appropriate for their
audience.

### Error Code to Message Mapping

| Code | Technical Message | User-Friendly Message |
|------|-------------------|----------------------|
| 1001 | "connection reset" | "The connection to the agent was lost. Please try again." |
| 1002 | "connection timeout" | "The agent took too long to respond. Please try again." |
| 1006 | "transport unreachable" | "The agent is not reachable. It may be offline." |
| 2001 | "invalid signature" | "Security verification failed. The connection has been closed." |
| 2003 | "unknown agent" | "The agent's identity could not be verified." |
| 3001 | "unauthorized" | "You don't have permission to use this capability." |
| 3002 | "insufficient capability" | "This agent doesn't support the requested operation." |
| 4005 | "capability not found" | "No agents were found that can handle this request." |
| 5002 | "unknown method" | "The agent doesn't support this operation." |
| 5004 | "method params invalid" | "The request parameters were invalid." |
| 6003 | "unsupported capability" | "This capability is not supported by the agent." |
| 8009 | "protocol violation" | "A protocol error occurred. Please update your software." |
| 9000 | "application error" | "The agent encountered an internal error." |

### Error Classification for Users

Errors can be classified into user-actionable categories:

| Category | User Action | Example Codes |
|----------|-------------|---------------|
| **Retryable** | "Please try again" | 1001, 1002, 1006 |
| **Permission** | "Check your permissions" | 3001, 3002, 3004 |
| **Not Found** | "No agents available" | 4005, 5002 |
| **Security** | "Security error — contact admin" | 2001, 2003, 2008 |
| **Protocol** | "Update required" | 8004, 8006, 8009 |
| **Application** | "Internal error" | 9000+ |

### Implementation Pattern

```rust
fn user_friendly_error(err: &SdkError) -> String {
    match err {
        SdkError::Transport(msg) => format!(
            "Network error: {}. The agent may be temporarily unavailable. Please try again.",
            msg
        ),
        SdkError::Discovery(msg) => format!(
            "Could not find an agent to handle this request: {}",
            msg
        ),
        SdkError::NotConnected => "Not connected to any agent. Please reconnect.".into(),
        SdkError::NotAuthenticated => "Authentication required. Please re-establish the connection.".into(),
        SdkError::Messaging(msg) => format!("The agent returned an error: {}", msg),
        SdkError::Handshake(msg) => format!("Connection setup failed: {}", msg),
        SdkError::Crypto(_) => "A security error occurred. The connection has been closed.".into(),
        SdkError::Timeout => "The request timed out. Please try again.".into(),
        _ => "An unexpected error occurred. Please try again.".into(),
    }
}
```

### Preserving Diagnostic Information

While user-facing messages should be friendly, the original error code
and technical message should be preserved in logs and (where appropriate)
in a "details" or "diagnostics" field visible to developers and operators.

---

## 12. Concrete Error Handling Examples

### Scenario 1: Connection Reset During RPC

**Trigger**: The peer's network drops mid-RPC. QUIC detects the connection
reset.

**Flow**:
1. `call_agent_with_pool()` sends the request frame.
2. `recv.read_exact()` fails with an I/O error.
3. The error propagates as `SdkError::Io(io::Error)`.
4. `is_retryable()` returns `true` — this is a transport-level error.
5. `with_retry()` waits for the backoff delay, then retries.
6. The retry opens a new connection via the pool (the old one is gone).
7. If the retry succeeds, the response is returned. If all retries fail,
   the error is surfaced to the application.

**Circuit breaker impact**: The failure is recorded via
`record_outcome(peer_id, false)`. If this is the 5th consecutive
failure, the circuit opens.

### Scenario 2: Authentication Failure (Fatal)

**Trigger**: The peer's identity has expired. The handshake fails with
code 2002 `IDENTITY_EXPIRED`.

**Flow**:
1. `establish_session()` calls `drive_client_handshake()`.
2. The server sends an ERROR frame with code 2002 and `fatal = true`.
3. `drive_client_handshake()` returns `SdkError::Handshake(...)`.
4. The error propagates to the application.
5. `is_retryable()` returns `false` — handshake errors are never retried.
6. The connection is closed (fatal error).
7. The circuit breaker is **not** updated (the failure happened before
   the RPC layer; the circuit breaker tracks RPC outcomes, not handshake
   failures).

**Recovery**: The application should prompt the user to refresh their
identity or contact the agent administrator.

### Scenario 3: Capability Not Found

**Trigger**: No agents in the DHT advertise the requested capability.

**Flow**:
1. `DiscoveryBuilder::call()` calls `agent.find_by_capability(&self.capability)`.
2. The DHT returns an empty list.
3. The function returns `Err(SdkError::Discovery("no agents found for capability '...'"))`.
4. No RPC is attempted, no circuit breaker is touched.

**Recovery**: The application can retry discovery after a delay (the
agent might come online), or fall back to a different capability.

### Scenario 4: Circuit Breaker Open

**Trigger**: A peer has failed 5 consecutive times. The circuit is Open.

**Flow**:
1. `call_agent_with_resilience()` calls `circuit.check_and_admit(&peer_id)`.
2. The circuit returns `CircuitState::Open`.
3. The function returns `Err(SdkError::CircuitOpen(peer_id))` immediately.
4. No dial, no stream, no RPC.
5. The router catches this and skips to the next candidate.
6. `CircuitOpen` is **not** retryable and **does not** increment
   `consecutive_failures`.

**Recovery**: After `open_duration` (30s), the circuit transitions to
`HalfOpen` and probe requests are admitted. If probes succeed, the
circuit closes and normal traffic resumes.

### Scenario 5: Bulkhead Full

**Trigger**: The peer already has `max_inflight` concurrent requests
in-flight.

**Flow**:
1. `call_agent_with_resilience()` calls `bulkhead.try_acquire(&peer_id)`.
2. `try_acquire()` returns `false` (at capacity).
3. The function returns `Err(SdkError::ConcurrencyLimit(peer_id))`.
4. The router skips to the next candidate.
5. `ConcurrencyLimit` is **not** retryable and **does not** increment
   `consecutive_failures`.

**Recovery**: As in-flight requests complete and slots are released,
new requests will be admitted. No explicit recovery action is needed.

### Scenario 6: Streaming RPC Fails Mid-Stream

**Trigger**: A streaming handler has sent 3 of 10 response frames, then
encounters an internal error.

**Flow**:
1. The handler calls `sender.error(HandlerError::Application("db error"))`.
2. The forwarder loop receives `Err(err)` from the channel.
3. `send_error_frame()` encodes the error as an `RpcResponse` with
   `error: Some(RpcErrorObject { code: 9000, message: "db error" })`.
4. The error frame is written to the QUIC stream.
5. The loop breaks, `send.finish()` closes the stream.
6. On the client side, `ResponseStream::next()` returns
   `Some(Err(SdkError::Messaging("db error")))`.
7. Subsequent calls to `next()` return `None`.

**Client handling**: The client has received 3 valid frames and 1 error
frame. It can process the 3 partial results or discard them depending on
the application's atomicity requirements.

### Scenario 7: Client Disconnects Mid-Stream

**Trigger**: The client cancels the streaming request (drops the
`ResponseStream`) while the handler is still producing data.

**Flow**:
1. The client drops `ResponseStream`, which drops the `mpsc::Receiver`.
2. The reader task's `tx.send(Ok(response)).await` returns `Err` (channel
   closed). The reader task breaks and drops `send`.
3. Dropping `send` closes the QUIC send stream.
4. On the server, `recv.read()` returns (EOF or error).
5. The forwarder sets `disconnected = true` and calls
   `cancel_token.cancel()`.
6. The handler's `ctx.cancel.is_cancelled()` returns `true`, allowing it
   to abort long-running operations.
7. The forwarder waits for the handler task to wind down.

**Resource cleanup**: The QUIC stream is reset, the handler is cancelled,
and the connection is released back to the pool for reuse.

### Scenario 8: Handler Panic

**Trigger**: A handler function panics (e.g., due to an unwrap on None).

**Flow**:
1. `handler_task.await` returns `Err(JoinError)` (panic).
2. The forwarder sends an error frame:
   `HandlerError::Application("handler panicked")` → code 9000.
3. The stream is closed.
4. The client receives `Err(SdkError::Messaging("handler panicked"))`.

**Circuit breaker impact**: The panic is treated as a failure in
`record_outcome()`. Repeated panics will trip the circuit, redirecting
traffic away from the unstable agent.

### Scenario 9: Deadline Exceeded

**Trigger**: The caller sets a 5-second deadline. The handler takes 8
seconds.

**Flow**:
1. The caller wraps the RPC in `tokio::time::timeout(Duration::from_secs(5), ...)`.
2. After 5 seconds, the timeout fires, the future is dropped.
3. Dropping the future drops the `QuicSendStream` / `QuicRecvStream`.
4. QUIC sends a `RESET_STREAM` frame to the peer.
5. On the server, the forwarder detects the disconnect and cancels the
   handler.
6. The caller receives `Err(Elapsed)` from the timeout, which it maps to
   `SdkError::Timeout`.

**Recovery**: The caller can retry with a different agent or a longer
deadline. The circuit breaker records the timeout as a failure.

### Scenario 10: All Candidates Fail (Exhausted Failover)

**Trigger**: Three agents advertise the capability, but all three fail
with transport errors.

**Flow**:
1. `DiscoveryBuilder::call()` iterates through candidates.
2. Candidate 1: `CONNECTION_RESET` → `tracing::warn!(...)`, continue.
3. Candidate 2: `CONNECTION_TIMEOUT` → `tracing::warn!(...)`, continue.
4. Candidate 3: `TRANSPORT_REFUSED` → `tracing::warn!(...)`, continue.
5. No more candidates. Return `Err(last_error)` — the last candidate's
   error (`TRANSPORT_REFUSED`).

**Circuit breaker impact**: Each candidate's circuit breaker records the
failure. If any candidate's circuit was already open, it was skipped
without an RPC attempt.

**Recovery**: The application should surface the error to the user. The
circuit breakers will prevent further attempts to the failed peers for
`open_duration` (30s), after which probes will be sent to test recovery.

---

## Appendix A: Error Type Reference

### SdkError (aafp-sdk/src/lib.rs)

```rust
pub enum SdkError {
    Transport(String),
    Discovery(String),
    Handshake(String),
    Messaging(String),
    Frame(FrameError),
    NotConnected,
    NotAuthenticated,
    NotStarted,
    Identity(IdentityError),
    Crypto(CryptoError),
    Core(Error),
    Io(io::Error),
}
```

### HandlerError (aafp-sdk/src/simple.rs)

```rust
pub enum HandlerError {
    Transport(String),       // → 1001
    Authentication(String),  // → 2001
    Authorization(String),   // → 3001
    Discovery(String),       // → 4005
    Messaging(String),       // → 5004
    Capability(String),      // → 6003
    Protocol(String),        // → 8009
    Application(String),     // → 9000
}
```

### ProtocolError (aafp-core/src/error.rs)

```rust
pub struct ProtocolError {
    pub code: u32,
    pub message: String,
    pub data: Option<Vec<u8>>,  // max 4096 bytes
    pub fatal: bool,
}
```

### Error (aafp-core/src/error.rs)

```rust
pub enum Error {
    Transport(String),
    Connection(String),
    Stream(String),
    Dial(String),
    Listen(String),
    NotConnected,
    ConnectionClosed,
    Protocol(ProtocolError),
    Io(io::Error),
}
```

---

## Appendix B: File Reference

| File | Content |
|------|---------|
| `aafp-core/src/error.rs` | Error codes, `ProtocolError`, `ErrorCategory`, fatal rules |
| `aafp-sdk/src/lib.rs` | `SdkError` enum (13 variants) |
| `aafp-sdk/src/simple.rs` | `HandlerError`, `RequestMetadata`, streaming error handling, failover loop |
| `aafp-sdk/src/protocol_frames.rs` | `send_error_frame()`, `send_close_frame()`, `parse_control_frame()` |
| `aafp-sdk/src/server.rs` | Server-side connection acceptance, rate limiting errors |
| `aafp-sdk/src/handshake_driver.rs` | Handshake frame validation errors |
| `aafp-sdk/src/routing/circuit.rs` | Circuit breaker state machine (stub) |
| `aafp-sdk/src/routing/retry.rs` | `RetryConfig`, `is_retryable()`, `with_retry()` (stub) |
| `aafp-sdk/src/routing/hedging.rs` | `HedgePolicy`, `call_with_hedging()`, `should_hedge_adaptive()` (stub) |
| `aafp-sdk/src/routing/config.rs` | `RoutingConfig`, `CircuitBreakerConfig`, `RoutingOptions` |
| `aafp-sdk/src/routing/integration.rs` | `ScoredCandidate`, routing pipeline (stub) |
| `aafp-sdk/src/routing/metrics.rs` | `PeerMetrics`, `Ewma`, `RollingWindow`, `CircuitState` (stub) |
| `aafp-messaging/src/close_manager.rs` | `CloseManager`, `CloseState`, close timeout |
| `builder-prompts/AR_T3_T4_BREAKER_HEDGING.md` | Full circuit breaker + hedging + retry design specification |

---

## Appendix C: Resilience Pipeline Summary

The complete resilience pipeline for a single RPC call through the
Adaptive Routing Plane:

```
1. Discover candidates (find_by_capability)
   └─ Error: SdkError::Discovery("no agents found")
      └─ Recovery: retry discovery or surface to user

2. Score + select primary (Phase T2: dynamic_score + P2C)
   └─ Filter: circuit-open peers rejected (hard constraint)
   └─ Filter: stale metrics + hard perf constraints → prune

3. Check circuit breaker for primary
   └─ If Open → SdkError::CircuitOpen(peer_id)
      └─ Recovery: skip to next candidate (not retried)

4. Check bulkhead for primary
   └─ If full → SdkError::ConcurrencyLimit(peer_id)
      └─ Recovery: skip to next candidate (not retried)

5. If hedging enabled + adaptive policy says hedge:
   └─ Select secondary candidate (next-best score)
   └─ call_with_hedging(primary, secondary, hedge_delay)
      └─ Loser future dropped → QUIC RESET_STREAM

6. Else: call_agent_with_resilience(primary)
   └─ Dial via pool → send RPC → receive response
   └─ On transport error: retry with backoff (same peer)
   └─ On app error: return error (not retried)

7. Record outcome in circuit breaker
   └─ success → reset consecutive_failures
   └─ failure → increment consecutive_failures
   └─ If threshold reached → circuit Open

8. On CircuitOpen/ConcurrencyLimit: skip to next candidate (no retry)
9. On all candidates exhausted: return last error
```

> **Source**: `AR_T3_T4_BREAKER_HEDGING.md` lines 670–683.

---

*This document is based on the AAFP Rust implementation source code and
the Adaptive Routing Plane design documents. All file paths and line
numbers refer to the implementation under `implementations/rust/crates/`.*
