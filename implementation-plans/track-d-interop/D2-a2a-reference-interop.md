# Plan D2: Test Against A2A Reference Implementation

**Priority:** HIGH
**Track:** D (External Interop)
**Estimated effort:** 4-6 hours
**Blocked by:** C3 (repos pushed)
**Blocks:** nothing

---

## Objective

Test the AAFP A2A transport binding against a real A2A reference
implementation or A2A spec conformance examples. This proves the A2A
binding (RFC 0008, implemented in B1) works with real A2A software.

**Source:** INTEROPERABILITY_PLAN.md, RFC 0008

---

## Prerequisites

- C3 complete (repos pushed)
- B1 complete (aafp-transport-a2a implemented)
- Read `RFCs/0008-a2a-transport-binding.md` (522 lines)
- Read `implementations/rust/crates/aafp-transport-a2a/src/` (all files)

---

## Investigation: What A2A Reference Implementations Exist?

### D2.1: Research A2A reference implementations

Search for A2A protocol reference implementations:
- https://github.com/a2a-protocol — official org
- https://a2a-protocol.org — official site
- Check for Python, Go, Java, or JavaScript A2A SDKs

The A2A protocol is relatively new (2025). Reference implementations may
exist as:
- A Python SDK (`a2a-sdk` or similar)
- A Go SDK
- A JavaScript/TypeScript SDK
- Spec conformance test examples

Use `web_search` to find current A2A SDKs.

### D2.2: Determine test strategy

Based on D2.1 findings, choose one:

**Strategy A: Test against a real A2A SDK**
If a Python/Go/JS A2A SDK exists, write an interop test where:
- A Rust A2A server (using `aafp-transport-a2a`) hosts an A2A agent
- A Python/Go/JS A2A client connects and calls `SendMessage`, `GetTask`, etc.
- The A2A messages are carried over AAFP's QUIC transport

**Strategy B: Test against A2A spec JSON examples**
If no SDK exists, test against the JSON examples from the A2A spec:
- Extract known A2A JSON-RPC messages from the spec
- Send them through the AAFP A2A transport
- Verify byte-for-byte preservation (ADR-0002)
- Verify correct method dispatch

**Strategy C: Test against the A2A protocol conformance suite**
If a conformance suite exists at https://github.com/a2a-protocol/conformance
or similar, integrate with it.

### D2.3: Implement the test (Strategy A or B)

**If Strategy A (real SDK):**

Create `implementations/rust/crates/aafp-transport-a2a/tests/external_interop.rs`
or a Python test file. The test should:
1. Start a Rust A2A server with a simple handler
2. Connect an external A2A client
3. Call `SendMessage` and verify the response
4. Call `GetTask` / `ListTasks`
5. Test streaming (`SendStreamingMessage`)
6. Clean close

**If Strategy B (spec examples):**

Create `implementations/rust/crates/aafp-transport-a2a/tests/spec_conformance.rs`:

```rust
//! Test A2A transport against spec JSON examples.
//!
//! Verifies that A2A JSON-RPC messages from the official spec are
//! correctly carried over AAFP and dispatched to the right handler.

use aafp_transport_a2a::*;

#[tokio::test]
async fn test_send_message_spec_example() {
    // Use the exact JSON from the A2A v1.0 spec
    let spec_json = r#"{
        "jsonrpc": "2.0",
        "method": "SendMessage",
        "params": {
            "message": {
                "role": "user",
                "parts": [{"kind": "text", "text": "Hello, agent!"}],
                "messageId": "test-001"
            }
        },
        "id": 1
    }"#;

    // Send through AAFP transport, verify byte-for-byte preservation
    // Verify response is a valid Task object
}

#[tokio::test]
async fn test_get_task_spec_example() {
    let spec_json = r#"{
        "jsonrpc": "2.0",
        "method": "GetTask",
        "params": {"id": "task-001"},
        "id": 2
    }"#;
    // ...
}

// Add tests for all 11 operations using spec examples
```

### D2.4: Run the tests

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
cargo test -p aafp-transport-a2a --test external_interop --test spec_conformance -v
```

**Expected:** All tests pass.

### D2.5: Document results

Write a JSON result file to `test-results/interop/a2a-reference.json`:

```python
import json
from datetime import datetime

result = {
    "test_name": "a2a-reference-interop",
    "test_category": "interop",
    "timestamp": datetime.now().isoformat(),
    "environment": {
        "os": "<from uname>",
        "cpu": "<from sysctl>",
        "rust_version": "<from rustc --version>",
        "aafp_version": "rev6-rc1",
        "commit": "<from git rev-parse HEAD>",
    },
    "status": "pass",  # or "fail"
    "duration_ms": <measured>,
    "summary": "A2A transport tested against <strategy used>",
    "details": [
        {"step": "send_message", "status": "pass", "notes": "spec example correctly dispatched"},
        {"step": "get_task", "status": "pass", "notes": "spec example correctly dispatched"},
        {"step": "list_tasks", "status": "pass", "notes": "spec example correctly dispatched"},
        # ... all 11 operations
    ],
    "metrics": {"operations_tested": 11, "operations_passed": 11},
}

with open("test-results/interop/a2a-reference.json", "w") as f:
    json.dump(result, f, indent=2)
```

Then regenerate the dashboard:
```bash
python3 test-results/generate_dashboard.py
```

Also update `implementations/rust/crates/aafp-transport-a2a/INTEROP_RESULTS.md`:

```markdown
# AAFP A2A Transport Interop Results

## Test: <strategy used> against A2A v1.0 spec

**Date:** 2026-07-XX
**A2A spec version:** v1.0.0
**AAFP version:** rev6-rc1

### Results
- [x] SendMessage — spec example correctly dispatched
- [x] GetTask — spec example correctly dispatched
- [x] ListTasks — spec example correctly dispatched
- [x] CancelTask — spec example correctly dispatched
- [x] SendStreamingMessage — streaming events correctly delivered
- [x] SubscribeToTask — subscription works
- [x] Push notification configs — CRUD operations work
- [x] GetExtendedAgentCard — returns valid AgentCard
- [x] Byte-for-byte payload preservation (ADR-0002)
- [x] JSON-RPC error codes match spec (-32001 through -32009)

### Limitations
- <any issues found>
```

### D2.6: Commit

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add crates/aafp-transport-a2a/tests/ crates/aafp-transport-a2a/INTEROP_RESULTS.md
git commit -m "$(cat <<'EOF'
test: verify A2A transport against spec/external implementation

Adds interop tests for the A2A transport binding using <strategy>.
Verifies all 11 A2A operations, byte-for-byte payload preservation,
and correct JSON-RPC error code mapping.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

---

## Verification

### D2.7: Tests pass

```bash
cargo test -p aafp-transport-a2a -v
```
**Expected:** All tests pass (existing + new interop tests).

---

## Risks & Mitigations

1. **No A2A SDK exists:** The A2A protocol is new. If no SDK exists, use
   Strategy B (spec examples). This still proves the transport works
   correctly with A2A's wire format.

2. **A2A spec has changed since RFC 0008 was written:** The A2A v1.0 spec
   may have evolved. **Mitigation:** Fetch the current spec from
   https://a2a-protocol.org/v1.0.0/specification/ and compare against
   RFC 0008's type definitions. If there are differences, update the types
   in `aafp-transport-a2a/src/types.rs`.

3. **A2A uses HTTP, not QUIC:** The A2A protocol's standard transport is
   HTTP. AAFP carries A2A messages over QUIC instead. This is fine per
   ADR-0004 (interop, not replacement) — AAFP provides an alternative
   transport. The test should verify that A2A messages work correctly
   regardless of the underlying transport.

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark D2.1 through D2.7 as `[x]`
- Set D2 status to `COMPLETE`
