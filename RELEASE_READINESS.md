# Release Readiness Review

**Date:** 2026-07-02
**Scope:** AAFP Rust implementation, with focus on the `aafp-transport-mcp` crate
**Purpose:** Honest engineering assessment of readiness for first public release

---

## 1. Completed Work

### 1.1 AAFP Core (pre-existing, stable)

The AAFP core protocol implementation is complete and has been stable through
multiple development cycles:

- **13 crates** in the Rust workspace
- **1011 tests** passing, 3 ignored, 0 failed
- **ML-DSA-65** post-quantum signatures with cross-language interop (Rust ↔ Go)
- **AAFP v1 handshake** with full state machine, replay cache, close manager
- **QUIC transport** with X25519MLKEM768 post-quantum key exchange
- **Conformance test suite** with golden trace generation
- **Criterion benchmarks** for crypto, discovery, messaging, and transport

### 1.2 MCP Transport Binding (new in this cycle)

- **`aafp-transport-mcp` crate**: Implements `rmcp::Transport<R>` trait over AAFP
- **16 tests**: 2 unit, 4 integration, 8 conformance (1 ignored), 2 doc
- **2 examples**: `mcp_over_aafp` (full rmcp client-server), `simple_transport` (raw JSON-RPC)
- **Benchmark**: Round-trip ping (250µs), one-way throughput (160K msg/s)
- **Environment reporting**: Benchmark prints CPU/OS/Rust/config at startup

### 1.3 Documentation and Analysis

- **RFC-0007**: AAFP Transport Binding for MCP (implemented, with citations)
- **RFC-0008**: AAFP Transport Binding for A2A (proposed, not implemented)
- **TRANSPORT_ARCHITECTURE_REVIEW.md**: Dependency graph, API analysis, concerns
- **COMPATIBILITY_LAYER_ANALYSIS.md**: Design principle documentation
- **INTEROPERABILITY_PLAN.md**: Phased validation roadmap
- **4 ADRs**: Architectural decision records for layering, payload preservation, DATA frames, interop strategy

### 1.4 Final Refactor (this session)

- **`QuicConnection::export_tls_binding()`**: New public method encapsulating
  the TLS exporter (RFC 5705). Replaces direct access to `quinn::Connection`
  via `raw()`.
- **`QuicConnection::raw()` deprecated**: Marked with `#[deprecated]` with
  guidance to use `export_tls_binding()`. Retained for backwards compatibility.
- **All callers updated**: `aafp-transport-mcp`, `aafp-sdk` (client, server,
  handshake_driver) now use `export_tls_binding()` instead of `raw()`.

---

## 2. Remaining Known Limitations

### 2.1 Architectural

| Limitation | Severity | Impact |
|------------|----------|--------|
| `raw()` still exists (deprecated) | Low | Backwards compat; can be removed in 0.2 |
| `build_server_config()` / `build_client_config()` return quinn types | Low | Pre-existing; not a regression |
| Duplicated handshake logic between SDK and transport | Low-Medium | Maintenance risk; wait for A2A binding to abstract |
| No AAFP CLOSE frame in transport close() | Low | Uses QUIC stream finish + connection close instead |

### 2.2 Functional

| Limitation | Severity | Impact |
|------------|----------|--------|
| `TestingAuthProvider` is the default | Medium | Production users MUST use custom auth; documented |
| No automatic reconnection | Low | By design; application responsibility |
| No connection pooling | Low | Each connection is independent |
| NAT traversal not implemented | Medium | P2P connectivity is future work |

### 2.3 Testing

| Limitation | Severity | Impact |
|------------|----------|--------|
| No cross-SDK interop tests | High | Only rmcp ↔ rmcp tested |
| No official MCP conformance tests | Medium | Protocol-level tests only |
| `neg_byte_swap_in_signature` is flaky | Low | Pre-existing; ML-DSA-65 probabilistic edge case |
| No CI automation | Medium | Manual testing only |

---

## 3. Public API Stability Assessment

### 3.1 `aafp-transport-mcp` API surface

```
pub struct AafpMcpTransport { /* private fields */ }
pub enum AafpMcpError { /* 7 variants */ }

impl AafpMcpTransport {
    pub async fn connect(agent: &Agent, addr: &str) -> Result<Self, AafpMcpError>
    pub async fn connect_with_auth(agent, addr, auth) -> Result<Self, AafpMcpError>
    pub async fn accept(agent: &Agent) -> Result<Self, AafpMcpError>
    pub async fn accept_with_auth(agent, auth) -> Result<Self, AafpMcpError>
    pub fn from_streams(send, recv, conn) -> Self
    pub fn peer_agent_id(&self) -> Option<&AgentId>
}

impl<R: ServiceRole> Transport<R> for AafpMcpTransport { ... }
```

**Assessment: STABLE.** 7 public methods, 1 struct, 1 error enum. No
implementation details exposed. The API is small and well-documented.

**Risk of breaking changes:** Low. The only likely change is adding methods
(e.g., `local_agent_id()`, `session_state()`), which is backwards-compatible.

### 3.2 `aafp-transport-quic` API changes

**New method:** `export_tls_binding(label, context) -> Result<[u8; 32], Error>`

**Deprecated method:** `raw() -> &quinn::Connection` (still available, will
be removed in a future version)

**Assessment: STABLE with deprecation.** The new method is additive. The
deprecated method is retained for backwards compatibility. No existing code
breaks.

### 3.3 `aafp-sdk` API

No public API changes. Internal `extract_tls_binding()` functions updated
to use the new `export_tls_binding()` method.

**Assessment: STABLE.**

---

## 4. Interoperability Status

| Test | Status |
|------|--------|
| rmcp client ↔ rmcp server over AAFP | ✅ Verified (16 tests) |
| rmcp client ↔ Python MCP server over AAFP | ❌ Not tested (no Python adapter) |
| rmcp client ↔ TypeScript MCP server over AAFP | ❌ Not tested (no TS adapter) |
| AAFP transport vs. official MCP conformance suite | ❌ Not tested |
| AAFP transport with MCP protocol 2026-07-28 | ❌ Not tested (not yet released) |

**Assessment: rmcp-only interop is verified. Cross-SDK interop is the next
milestone (Phase 2 of the validation roadmap).**

---

## 5. Benchmark Status

| Benchmark | Result | Environment |
|-----------|--------|-------------|
| Round-trip ping | 250 µs | Apple M4, 10 cores, release |
| One-way 10 msgs | 131 µs (76K msg/s) | Apple M4, 10 cores, release |
| One-way 100 msgs | 659 µs (152K msg/s) | Apple M4, 10 cores, release |
| One-way 1000 msgs | 6.2 ms (160K msg/s) | Apple M4, 10 cores, release |

**Assessment: Baseline established. Environment reporting implemented.
Results are reproducible within the same hardware environment.**

**Limitations:**
- Results vary by hardware; cross-environment comparison is not meaningful
- No comparison against stdio or Streamable HTTP transports
- No long-running stability tests (memory, connection count)

---

## 6. RFC Status

| RFC | Title | Status |
|-----|-------|--------|
| RFC-0002 | Transport Framing | Implemented, stable |
| RFC-0007 | MCP Transport Binding | Implemented, specification-verified |
| RFC-0008 | A2A Transport Binding | Proposed, not implemented |

**Assessment: RFC-0007 is complete with verified external specification
references. RFC-0008 is a design document only — implementation is future
work.**

---

## 7. Documentation Status

| Document | Status |
|----------|--------|
| Crate-level docs (`aafp-transport-mcp`) | Complete, with 4-layer architecture diagram |
| RFC-0007 | Complete, with citations to MCP spec |
| RFC-0008 | Complete, with citations to A2A spec |
| TRANSPORT_ARCHITECTURE_REVIEW.md | Complete |
| COMPATIBILITY_LAYER_ANALYSIS.md | Complete, with design principle |
| INTEROPERABILITY_PLAN.md | Complete, with phased roadmap |
| 4 ADRs (adr/) | Complete |
| AGENTS.md | Updated |
| README.md | Updated |
| ROADMAP.md | Updated |

**Assessment: Documentation is comprehensive. All external specification
claims are verified with citations.**

---

## 8. Recommended Semantic Version

**Recommended version: `0.1.0`**

Rationale:
- The `0.x` major version signals that the API is not yet guaranteed stable
- The `0.1` minor version indicates first public release
- All crates in the workspace are already at `0.1.0`

When the API is frozen after cross-SDK interop verification (Phase 2),
a `0.2.0` release can mark the transition. A `1.0.0` release should wait
until:
- Cross-SDK interop is verified (at least Python)
- Official MCP conformance tests pass
- The `raw()` method is removed
- CI automation is in place

---

## 9. Recommended Release Label

**Recommended label: `experimental`**

Rationale:
- Only rmcp ↔ rmcp interop is verified (no cross-SDK testing)
- No official MCP conformance testing
- No CI automation
- NAT traversal not implemented
- The A2A binding (RFC-0008) is not implemented

`experimental` accurately communicates that the implementation is functional
and tested within its own ecosystem but has not been validated against
external implementations. It invites early adopters to try it and provide
feedback without implying production readiness.

**Transition criteria to `alpha`:**
- Python AAFP transport adapter implemented
- Rust ↔ Python interop verified
- CI automation in place

**Transition criteria to `beta`:**
- Official MCP conformance tests pass
- At least one non-Rust SDK interop verified (Python or Go)
- `raw()` removed from public API

**Transition criteria to `1.0`:**
- All `beta` criteria met
- A2A transport binding implemented (RFC-0008)
- NAT traversal implemented
- Production deployment documented

---

## 10. Remaining Work Before Stable 1.0

| Work Item | Priority | Effort | Dependency |
|-----------|----------|--------|------------|
| Remove `raw()` from public API | Medium | Low | After downstream callers migrate |
| Python AAFP transport adapter (PyO3) | High | High | None |
| Rust ↔ Python interop testing | High | Medium | Python adapter |
| Go AAFP transport adapter | Medium | High | None |
| Rust ↔ Go interop testing | Medium | Medium | Go adapter |
| Official MCP conformance testing | High | High | Python adapter |
| CI automation | High | Low | None |
| A2A transport implementation (RFC-0008) | Medium | High | None |
| NAT traversal implementation | Medium | High | None |
| Protocol-level conformance tests | Medium | Medium | None |
| Long-running stability tests | Low | Medium | None |
| Comparison benchmarks vs. stdio/HTTP | Low | Low | None |

---

## 11. Final Assessment

**The implementation is ready for its first public release as an
`experimental` `0.1.0` package.**

The core functionality is complete, tested, and documented. The public API
is small and stable. The architectural design is sound and well-explained.
The remaining limitations (cross-SDK interop, CI, NAT traversal) are
appropriate for an experimental release and are clearly documented.

The most important next step is **Phase 2 of the validation roadmap**:
building a Python AAFP transport adapter and verifying Rust ↔ Python
interoperability. This is the key milestone that transitions the project
from "works within its own ecosystem" to "works with the broader MCP
ecosystem."
