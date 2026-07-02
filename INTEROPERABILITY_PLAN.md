# Interoperability Plan

**Review date:** 2026-07-02
**Scope:** Can the AAFP MCP transport interoperate with existing MCP SDK implementations?

---

## 1. Executive Summary

**The AAFP MCP transport cannot directly interoperate with existing MCP SDK
implementations (Python, TypeScript, Go, Java, Kotlin) because those SDKs do
not implement the AAFP transport.** MCP explicitly allows custom transports,
but each SDK must implement the transport binding separately.

However, **the transport can interoperate at the protocol level** because:

1. The MCP messages exchanged are standard JSON-RPC 2.0, identical to those
   on stdio or HTTP transports.
2. The rmcp SDK's `Transport<R>` trait is the canonical extension point for
   custom transports in Rust.
3. The AAFP transport preserves MCP message content byte-for-byte — no
   transcoding, no modification.

The path to full interoperability is incremental: start with rmcp-only
testing (already done), then implement AAFP transport adapters for other
SDKs, then run cross-SDK conformance tests.

---

## 2. Target SDKs

### 2.1 Official MCP SDKs

| SDK | Language | Repository | Status |
|-----|----------|------------|--------|
| **rmcp** | Rust | https://crates.io/crates/rmcp | **Already integrated** (AAFP transport implemented) |
| **@modelcontextprotocol/sdk** | TypeScript | https://github.com/modelcontextprotocol/typescript-sdk | Not integrated |
| **mcp** | Python | https://github.com/modelcontextprotocol/python-sdk | Not integrated |
| **go-sdk** | Go | https://github.com/modelcontextprotocol/go-sdk | Not integrated |
| **java-sdk** | Java | https://github.com/modelcontextprotocol/java-sdk | Not integrated |
| **kotlin-sdk** | Kotlin | https://github.com/modelcontextprotocol/kotlin-sdk | Not integrated |

### 2.2 Custom transport support

The MCP specification [1] explicitly states:

> "Clients and servers MAY implement additional custom transport mechanisms
> to suit their specific needs. The protocol is transport-agnostic and can
> be implemented over any communication channel that supports bidirectional
> message exchange."

Source: https://modelcontextprotocol.io/specification/draft/basic/transports

Each SDK provides its own extension point for custom transports:
- **rmcp (Rust)**: `Transport<R>` trait — **already implemented**
- **TypeScript**: Custom transport class implementing `Transport` interface
- **Python**: Custom transport class implementing `Transport` protocol
- **Go**: Custom transport implementing `Transport` interface

### 2.3 Recommended interop targets

| Priority | SDK | Rationale |
|----------|-----|-----------|
| 1 | rmcp (Rust) | Already done — AAFP transport works end-to-end |
| 2 | Python SDK | Most widely used MCP SDK; Python is the dominant AI language |
| 3 | TypeScript SDK | Second most used; covers Node.js ecosystem |
| 4 | Go SDK | Natural fit — AAFP already has a Go implementation |

---

## 3. Supported MCP Versions

### 3.1 MCP protocol versions

| Version | Date | Status |
|---------|------|--------|
| 2024-10-07 | Oct 2024 | Legacy |
| 2024-11-05 | Nov 2024 | Legacy |
| 2025-03-26 | Mar 2025 | Legacy |
| 2025-06-18 | Jun 2025 | Legacy |
| **2025-11-25** | **Nov 2025** | **Current stable** |
| 2026-07-28 | Jul 2026 (planned) | Release candidate — breaking changes |

### 3.2 rmcp version

The `aafp-transport-mcp` crate depends on `rmcp = "1.7"`, which supports
MCP protocol version 2025-11-25.

### 3.3 Version compatibility

The AAFP transport is **transport-layer only** — it does not participate in
MCP protocol version negotiation. The `initialize` request (which carries
the protocol version) is handled by the rmcp SDK's service layer, not by
the transport. Therefore:

- The AAFP transport supports whatever MCP version rmcp supports.
- Upgrading to a new MCP version requires upgrading rmcp, not the transport.
- The 2026-07-28 MCP version (which removes the initialize handshake) will
  work with the AAFP transport as long as rmcp supports it.

---

## 4. Conformance Strategy

### 4.1 Existing conformance test suites

| Tool | Type | URL |
|------|------|-----|
| **@modelcontextprotocol/conformance** | Official | https://github.com/modelcontextprotocol/conformance |
| **mcp-compliance** | Community (88 tests) | https://github.com/yawlabs/mcp-compliance |
| **mcp-test** | Community (24 tests) | https://github.com/cahlan/mcp-test |
| **MCPBench** | Cross-language matrix | https://github.com/unimcp/mcpbench |

### 4.2 Challenge: transport assumptions

All existing conformance test suites assume stdio or HTTP transport. They
cannot directly test an AAFP transport server because they have no AAFP
client implementation.

**Two approaches to solve this:**

**Approach A: Protocol-level testing**
Capture the JSON-RPC messages exchanged over AAFP and compare them against
expected MCP messages. This tests protocol compliance without requiring
the test framework to understand AAFP.

**Approach B: AAFP client adapter for test frameworks**
Implement an AAFP transport adapter for the conformance test framework,
allowing it to connect to AAFP transport servers. This is more thorough
but requires implementing AAFP in the test framework's language.

**Recommendation:** Start with Approach A (protocol-level testing), which
can be done entirely in Rust. Move to Approach B when the Python AAFP
adapter is available.

### 4.3 Protocol-level conformance tests

These tests verify that the AAFP transport produces correct MCP messages:

1. **Initialize handshake**: Verify `initialize` request/response is correct
2. **Capability negotiation**: Verify `capabilities` field in initialize response
3. **Tools**: Verify `tools/list` and `tools/call` produce correct JSON-RPC
4. **Resources**: Verify `resources/list` and `resources/read`
5. **Prompts**: Verify `prompts/list` and `prompts/get`
6. **Ping**: Verify `ping` request/response
7. **Error handling**: Verify malformed requests produce correct JSON-RPC errors
8. **Shutdown**: Verify `shutdown` request/response

These tests can be added to the existing `aafp-transport-mcp` conformance
test suite. They would:
1. Set up an AAFP transport connection
2. Send MCP JSON-RPC requests via the transport
3. Capture the raw JSON-RPC messages (before AAFP framing)
4. Compare against expected MCP message schemas

---

## 5. Automated CI Approach

### 5.1 Phase 1: Rust-only CI (immediate)

```yaml
# .github/workflows/mcp-transport.yml
jobs:
  mcp-transport-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - name: Run MCP transport tests
        run: cargo test -p aafp-transport-mcp
      - name: Run conformance tests
        run: cargo test -p aafp-transport-mcp --test conformance
      - name: Run benchmarks (smoke test)
        run: cargo bench --bench mcp_transport -- --warm-up-time 1 --measurement-time 2 --sample-size 10
```

### 5.2 Phase 2: Protocol-level conformance (short-term)

Add a `tests/protocol_conformance.rs` test that:
1. Starts an rmcp server with the AAFP transport
2. Connects an rmcp client with the AAFP transport
3. Exchanges MCP messages (initialize, tools/list, tools/call)
4. Asserts that the JSON-RPC messages match MCP specification examples

### 5.3 Phase 3: Cross-SDK interop (medium-term)

When the Python AAFP adapter is available:
1. Start an rmcp server with AAFP transport (Rust)
2. Connect a Python MCP client with AAFP transport (Python)
3. Exchange MCP messages
4. Verify both sides agree on the results

This requires:
- A Python AAFP transport implementation (wrapping the AAFP Rust crate via
  PyO3, or a pure-Python QUIC + ML-DSA-65 implementation)
- A CI runner with both Rust and Python installed

### 5.4 Phase 4: Full conformance suite (long-term)

Integrate with `@modelcontextprotocol/conformance` by implementing an AAFP
transport adapter for the conformance runner. This is the gold standard but
requires significant effort.

---

## 6. Remaining Blockers

### 6.1 No AAFP transport in other SDKs

**Blocker:** The Python, TypeScript, Go, Java, and Kotlin MCP SDKs do not
implement the AAFP transport. Cross-SDK interop testing is impossible until
at least one other SDK has an AAFP transport adapter.

**Mitigation:** The AAFP transport is a thin layer (QUIC + handshake +
framing). A Python adapter could be built using:
- `quic` (Python QUIC library) or `aioquic`
- A Python ML-DSA-65 library
- The AAFP framing format (28-byte header, simple to implement)

Alternatively, a PyO3 wrapper around the Rust `aafp-transport-mcp` crate
would provide a Python AAFP transport without reimplementing the protocol.

### 6.2 No AAFP client in conformance test frameworks

**Blocker:** Existing MCP conformance test suites (official and community)
assume stdio or HTTP transport. They cannot connect to an AAFP server.

**Mitigation:** Use protocol-level testing (Approach A above) until AAFP
adapters are available for the conformance frameworks.

### 6.3 MCP protocol version transition

**Blocker:** The 2026-07-28 MCP version introduces breaking changes
(stateless protocol, removes initialize handshake). If rmcp upgrades to
this version, the AAFP transport must be retested.

**Mitigation:** The transport layer is version-agnostic. The rmcp service
layer handles protocol version negotiation. As long as rmcp's `Transport<R>`
trait contract doesn't change, the AAFP transport will work.

### 6.4 Stream ID compliance

**Blocker:** The current implementation uses stream ID 1, which violates
RFC-0002 §7.1. While this doesn't affect MCP interop, it affects AAFP
protocol compliance.

**Mitigation:** Fix the stream ID to 4 (see TRANSPORT_ARCHITECTURE_REVIEW.md).

---

## 7. What Has Been Verified

### 7.1 rmcp ↔ rmcp over AAFP (verified)

The existing tests and examples verify that:
- An rmcp client can connect to an rmcp server over AAFP
- The full MCP lifecycle works: initialize → tools/list → tools/call
- JSON-RPC messages are correctly framed and unframed
- Bidirectional communication works (server can send notifications)
- Close semantics work correctly

This is verified by:
- 4 integration tests (`tests/integration.rs`)
- 8 conformance tests (`tests/conformance.rs`)
- 2 examples (`mcp_over_aafp.rs`, `simple_transport.rs`)

### 7.2 What has NOT been verified

- rmcp client ↔ Python MCP server over AAFP
- rmcp client ↔ TypeScript MCP server over AAFP
- Python MCP client ↔ rmcp server over AAFP
- TypeScript MCP client ↔ rmcp server over AAFP
- AAFP transport against the official MCP conformance suite
- AAFP transport with MCP protocol version 2026-07-28

---

## 8. Recommended Next Steps

| Step | Effort | Value |
|------|--------|-------|
| 1. Fix stream ID to 4 (RFC compliance) | Low | High |
| 2. Add protocol-level conformance tests | Medium | High |
| 3. Set up CI with Rust-only tests | Low | High |
| 4. Build Python AAFP transport adapter (PyO3) | High | Medium |
| 5. Run cross-SDK interop tests (rmcp ↔ Python) | Medium | High |
| 6. Integrate with official MCP conformance suite | High | Medium |

Steps 1-3 can be done immediately. Step 4 is the key enabler for steps 5-6.

---

## References

- [1] MCP Specification, Transports: https://modelcontextprotocol.io/specification/draft/basic/transports
- [2] MCP Specification, Versioning: https://modelcontextprotocol.io/specification/draft/basic/versioning
- [3] rmcp crate: https://crates.io/crates/rmcp
- [4] rmcp documentation: https://docs.rs/rmcp/
- [5] MCP Conformance: https://github.com/modelcontextprotocol/conformance
- [6] MCPBench: https://github.com/unimcp/mcpbench
- [7] Python MCP SDK: https://github.com/modelcontextprotocol/python-sdk
- [8] TypeScript MCP SDK: https://github.com/modelcontextprotocol/typescript-sdk
- [9] Go MCP SDK: https://github.com/modelcontextprotocol/go-sdk
