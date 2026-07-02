# Plan D4: MCP Conformance Suite Integration

**Priority:** MEDIUM
**Track:** D (External Interop)
**Estimated effort:** 4-6 hours
**Blocked by:** D1 (Python MCP SDK interop must work first)
**Blocks:** nothing

---

## Objective

Integrate with the official MCP conformance testing suite
(`@modelcontextprotocol/conformance`) to verify that AAFP's MCP transport
binding passes the official conformance tests, not just our own tests.

**Source:** INTEROPERABILITY_PLAN.md §5.4 (Phase 4: Full conformance suite)

---

## Prerequisites

- D1 complete (Python MCP SDK interop verified)
- Read https://github.com/modelcontextprotocol/conformance (if it exists)
- Read `implementations/rust/crates/aafp-transport-mcp/tests/conformance.rs`

---

## Steps

### D4.1: Research the MCP conformance suite

Search for the official MCP conformance suite:
- https://github.com/modelcontextprotocol/conformance
- https://modelcontextprotocol.io/specification (conformance section)

Determine:
1. Does a conformance suite exist?
2. What does it test? (transport, protocol, tools, resources, prompts)
3. How is it run? (CLI tool, test framework, Docker)
4. Can custom transports be plugged in?
5. What version of MCP does it target?

If no conformance suite exists, skip to D4.5 (document and create our own
conformance test based on the MCP spec).

### D4.2: Install the conformance suite

If the suite exists:
```bash
pip install mcp-conformance  # or whatever the package name is
# or
git clone https://github.com/modelcontextprotocol/conformance.git /tmp/mcp-conformance
```

### D4.3: Configure AAFP as a transport for the conformance suite

The conformance suite likely needs a way to connect to the server under
test. If it supports custom transports, configure it to use AAFP:

1. Start a Rust rmcp server with AAFP transport (the `mcp_over_aafp` example)
2. Configure the conformance suite to connect via AAFP
3. This may require writing a small adapter or configuration file

If the suite only supports stdio/HTTP, you may need to:
- Run the AAFP transport as a proxy that bridges stdio ↔ AAFP
- Or run the conformance suite's test cases manually against the AAFP transport

### D4.4: Run the conformance suite

```bash
# Run the conformance suite against the AAFP-backed MCP server
mcp-conformance --transport aafp --server quic://127.0.0.1:4433
# or whatever the correct invocation is
```

**Expected:** All conformance tests pass. If any fail, investigate:
- Is it an AAFP transport issue? (fix in aafp-transport-mcp)
- Is it an rmcp issue? (fix in rmcp or report upstream)
- Is it a conformance suite issue? (report upstream)

### D4.5: Document results (or create our own conformance test)

If the official suite doesn't exist or can't be used with custom transports:

Create `implementations/rust/crates/aafp-transport-mcp/tests/official_conformance.rs`
that tests against the MCP specification's conformance requirements:

```rust
//! MCP conformance tests based on the official specification.
//!
//! These tests verify that AAFP's MCP transport binding meets the
//! conformance requirements from the MCP specification.
//!
//! Source: https://modelcontextprotocol.io/specification

use aafp_transport_mcp::*;

#[tokio::test]
async fn conf_transport_connect() {
    // Conformance: transport MUST establish a connection
}

#[tokio::test]
async fn conf_transport_send_receive() {
    // Conformance: transport MUST send and receive JSON-RPC messages
}

#[tokio::test]
async fn conf_transport_close() {
    // Conformance: transport MUST close gracefully
}

#[tokio::test]
async fn conf_initialize_handshake() {
    // Conformance: client MUST send initialize, server MUST respond
}

#[tokio::test]
async fn conf_tools_list() {
    // Conformance: tools/list MUST return a list of tools
}

#[tokio::test]
async fn conf_tools_call() {
    // Conformance: tools/call MUST execute a tool and return results
}

// Add tests for resources, prompts, logging, etc. as per the MCP spec
```

### D4.6: Commit

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add crates/aafp-transport-mcp/tests/
git commit -m "$(cat <<'EOF'
test: MCP conformance suite integration

<If official suite used:>
Integrates with the official @modelcontextprotocol/conformance suite.
All conformance tests pass against the AAFP transport binding.

<If own tests created:>
Adds MCP conformance tests based on the official specification
requirements. Tests cover transport, initialization, tools, resources,
and graceful close.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

---

## Verification

### D4.7: Conformance tests pass

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
cargo test -p aafp-transport-mcp --test official_conformance -v
# or the official suite command
```
**Expected:** All tests pass.

### D4.8: Results documented

Create or update `implementations/rust/crates/aafp-transport-mcp/CONFORMANCE_RESULTS.md`:

```markdown
# MCP Conformance Results

## Conformance Suite: <official or custom>
## MCP Version: <version>
## Date: 2026-07-XX

### Results
- [x] Transport conformance (connect, send, receive, close)
- [x] Initialize handshake
- [x] tools/list + tools/call
- [x] <other conformance areas>

### Failures
- <none, or list any failures with explanation>
```

---

## Risks & Mitigations

1. **No official conformance suite exists:** The MCP ecosystem is evolving.
   If no suite exists, create our own based on the spec. **Mitigation:**
   D4.5 handles this case.

2. **Conformance suite doesn't support custom transports:** The suite may
   only test stdio/HTTP. **Mitigation:** Write a stdio↔AAFP proxy or run
   the test cases manually.

3. **MCP spec version mismatch:** The conformance suite may target a
   different MCP version than rmcp supports. **Mitigation:** Check versions
   and use the appropriate one. Document any version-specific behavior.

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark D4.1 through D4.8 as `[x]`
- Set D4 status to `COMPLETE`
