# Builder Prompt: P2.7 — Simple API v2 Foundation (Phase A1 + C1)

## Objective

Implement the foundation of Simple API v2: structured params, request/response
metadata, typed errors, handler context with cancellation, and connection pool
integration. This is the highest-priority adaptation work — it addresses 8 of 10
confirmed gaps and unblocks all subsequent phases.

## Context

Read these design documents before starting:
- `SIMPLE_API_V2_DESIGN.md` — Complete v2 API design (sections 1, 2, 5, 8, 9)
- `SESSION_AFFINITY_DESIGN.md` — Connection pool integration (sections 2, 3)
- `ADAPTATION_ROADMAP.md` — Priority matrix and dependency graph

## What to Build

### Part 1: Structured Params (SIMPLE_API_V2_DESIGN.md §1)

Add a `Params` type to `crates/aafp-sdk/src/simple.rs` that wraps CBOR IntMap:

```rust
pub struct Params {
    inner: aafp_cbor::Value,
}
```

Methods: `new()`, `put_str()`, `put_bytes()`, `put_u64()`, `get_str()`, `get_bytes()`,
`get_u64()`, `to_value()`, `from_value()`. Builder pattern (returns Self).

Update `Request` and `Response` to carry `params: Params`, `text: String`,
`data: Option<Vec<u8>>`, and `metadata: RequestMetadata`. Keep `Request::text()`
and `Response::text()` working (backward compat). Add `Request::with_params()`
and `Response::with_result()`.

### Part 2: Request/Response Metadata (SIMPLE_API_V2_DESIGN.md §5)

Add `RequestMetadata` and `ResponseMetadata` structs:

```rust
pub struct RequestMetadata {
    pub capability: String,
    pub session_id: Option<[u8; 32]>,
    pub trace_id: Option<String>,
    pub deadline: Option<String>,
    pub content_type: Option<String>,
}

pub struct ResponseMetadata {
    pub content_type: Option<String>,
    pub extra: HashMap<String, String>,
}
```

Add CBOR encode/decode functions for metadata. Wire encoding uses frame
extensions or the RPC params field.

### Part 3: Handler Context + Typed Errors (SIMPLE_API_V2_DESIGN.md §2, §7, §8)

Add `HandlerContext` with `CancellationToken` and `capability: String`:

```rust
pub struct HandlerContext {
    pub cancel: tokio_util::sync::CancellationToken,
    pub capability: String,
}
```

Add `HandlerError` enum with 8 variants (Transport, Authentication, Authorization,
Discovery, Messaging, Capability, Protocol, Application) mapping to RFC-0005
error codes. Implement `to_code()` and `from_code()`.

Add `tokio-util` dependency with the `rt` feature for `CancellationToken`.

### Part 4: Per-Capability Handler Routing (SIMPLE_API_V2_DESIGN.md §2, §6)

Add `on_capability()` to `ServeBuilder`:

```rust
pub fn on_capability<F, Fut>(mut self, cap: impl Into<String>, f: F) -> Self
```

Store handlers in `HashMap<String, CapabilityHandler>`. Keep existing `handler()`
as fallback (v1 compat). In the request handling loop, use `rpc_req.method` as
the capability name to look up the handler. Set `request.metadata.capability`
and `request.metadata.session_id` before calling the handler.

### Part 5: Connection Pool Integration (SESSION_AFFINITY_DESIGN.md §2)

Add `pool: Arc<ConnectionPool>` to `ConnectedAgent`. Add `pool_config: PoolConfig`
to `ConnectBuilder` with `with_pool_config()` method. Modify `call_agent()` to
use `pool.get_or_connect()` instead of direct `transport.dial()` + `establish_session()`.

Add `pool_stats()` method to `ConnectedAgent` returning pool size, max size, peers.

### Part 6: Discovery Failover (SIMPLE_API_V2_DESIGN.md §9)

Change `DiscoveryBuilder` to use `Arc<SdkAgent>` instead of `&SdkAgent` (makes
it 'static, can be spawned). Loop through all candidates with failover instead
of only trying `candidates[0]`. Add `discover_by_id()` for direct agent calls.

## Constraints

1. **Backward compatibility is critical.** All existing P2.1-P2.5 examples and
   tests must continue to work without changes. The v1 `handler()` method and
   `Request::text()` / `Response::text()` must still function.

2. **No wire protocol changes.** Use existing CBOR encoding, frame types, and
   RPC structures. Metadata is encoded in the existing params field or frame
   extensions.

3. **Follow existing code conventions.** Check `AGENTS.md` for build/test
   commands. Use `cargo fmt`, `cargo clippy`, `cargo test --workspace`.

4. **Add tests for every new feature.** Target: 1800+ tests (currently 1718).

## Verification

```bash
cargo fmt --all -- --check   # 0 diffs
cargo build --workspace       # 0 errors, 0 warnings
cargo clippy --workspace      # 0 warnings
cargo test --workspace        # 1800+ tests, 0 failures
```

All 5 existing examples must still work:
```bash
cargo run --example echo-agent
cargo run --example translation-pipeline
cargo run --example python-weather-agent
cargo run --example relay-setup
cargo run --example multi-agent-chat
```

## Files to Modify

| File | Changes |
|------|---------|
| `crates/aafp-sdk/src/simple.rs` | Params, RequestMetadata, ResponseMetadata, HandlerContext, HandlerError, on_capability(), pool integration, failover |
| `crates/aafp-sdk/src/lib.rs` | Re-export new types |
| `crates/aafp-sdk/Cargo.toml` | Add tokio-util with rt feature |
| `crates/aafp-sdk/src/connection_pool.rs` | Return SessionId from get_or_connect() |
| `crates/aafp-sdk/tests/` | New tests for v2 features |

## Success Criteria

- [ ] `Params` type with CBOR IntMap, builder pattern, get/put methods
- [ ] `Request`/`Response` carry params + text + data + metadata
- [ ] `RequestMetadata` with capability, session_id, trace_id, deadline, content_type
- [ ] `HandlerContext` with CancellationToken + capability name
- [ ] `HandlerError` enum with 8 variants mapping to RFC-0005 codes
- [ ] `on_capability()` for per-capability handler routing
- [ ] `ConnectionPool` integrated into `ConnectedAgent`
- [ ] `with_pool_config()` on `ConnectBuilder`
- [ ] Discovery failover across all candidates
- [ ] `discover_by_id()` for direct agent calls
- [ ] All existing tests pass (1718+)
- [ ] New tests for v2 features (target 1800+ total)
- [ ] All 5 examples still work
- [ ] `cargo clippy` clean
- [ ] `cargo fmt` clean
