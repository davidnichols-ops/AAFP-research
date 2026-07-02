# Plan D3: Rust ↔ Go Cross-Language Interop Over QUIC

**Priority:** HIGH
**Track:** D (External Interop)
**Estimated effort:** 6-8 hours
**Blocked by:** C3 (repos pushed)
**Blocks:** nothing

---

## Objective

Prove that the Rust and Go implementations of AAFP can interoperate at the
wire level over real QUIC connections. This is a release criterion: "Two
independent implementations" and "Bidirectional wire interop."

Currently, cross-language interop is verified via golden traces and test
vectors (static comparison). This plan adds **live** interop: a Rust agent
connects to a Go agent (or vice versa) over QUIC, performs the AAFP
handshake, and exchanges messages.

**Source:** ROADMAP.md release criteria 1 & 2, INTEROPERABILITY_PLAN.md

---

## Prerequisites

- C3 complete (repos pushed)
- Read `implementations/go/` structure (cbor, frame, handshake, identity, etc.)
- Read `implementations/rust/crates/aafp-sdk/` structure
- Understand the Go implementation's current state (it has frame
  encoding/decoding, handshake CBOR, identity, but may NOT have a QUIC
  transport layer — check first)

---

## Investigation: Go Implementation State

### D3.1: Assess Go QUIC transport capability

The Go implementation may or may not have a QUIC transport layer. Check:

```bash
cd /Users/david/projects/AAFP-research/implementations/go
grep -rn "quic\|QUIC\|quinn\|quic-go" *.go */*.go 2>/dev/null | head -20
ls -la handshake/ frame/ identity/
```

**Key question:** Can the Go implementation:
1. Establish a QUIC connection? (needs `quic-go` or similar)
2. Send/receive AAFP frames over QUIC streams?
3. Perform the AAFP v1 handshake (ClientHello/ServerHello/ClientFinished)?
4. Verify ML-DSA-65 signatures?

If the Go implementation has QUIC transport, proceed with live interop.
If not, the interop test must be at the frame/CBOR level (encode in Go,
decode in Rust, and vice versa) — which is already done via golden traces.

### D3.2: Determine interop test level

Based on D3.1:

**Level 1 (full live interop):** Rust agent ↔ Go agent over QUIC
- Requires Go QUIC transport
- Requires Go handshake implementation
- Requires Go ML-DSA-65 (A-10, DONE)

**Level 2 (frame-level interop):** Encode in Go, decode in Rust (and vice versa)
- Already done via golden traces
- Can extend with more edge cases

**Level 3 (CBOR-level interop):** Encode CBOR in Go, decode in Rust
- Already done via interop fixtures
- Can extend with more test vectors

**If Level 1 is possible, do it.** If not, do Level 2 and document why
Level 1 isn't possible yet (Go QUIC transport is a v1.1 item per ROADMAP.md
Category B-2).

---

## Steps (if Level 1 is possible)

### D3.3: Write a Go AAFP server

Create `implementations/go/interop/rust_client_test.go` or a standalone
Go program that:
1. Generates an ML-DSA-65 keypair
2. Listens on a QUIC address
3. Accepts an AAFP connection
4. Performs the server-side handshake
5. Receives a DATA frame and echoes it back

### D3.4: Write a Rust AAFP client that connects to the Go server

Create `implementations/rust/crates/aafp-tests/tests/go_interop.rs`:

```rust
//! Test: Rust client connects to Go server over QUIC.
//!
//! Verifies cross-language wire interop at the transport level.

use aafp_sdk::{Agent, AgentBuilder};
use aafp_messaging::{Frame, FrameType, encode_frame};
use aafp_transport_quic::QuicConnection;

#[tokio::test]
async fn test_rust_client_go_server() {
    // 1. Start Go server (as subprocess)
    let go_dir = "../../implementations/go";
    let proc = tokio::process::Command::new("go")
        .arg("run")
        .arg("./cmd/interop_server")
        .current_dir(go_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to start Go server");

    // 2. Wait for server to print its address
    // 3. Create Rust agent and connect
    let agent = AgentBuilder::new().bind("127.0.0.1:0").build().await.unwrap();
    // 4. Perform AAFP handshake
    // 5. Send a DATA frame
    // 6. Receive echo response
    // 7. Verify response matches sent data
    // 8. Clean close
}
```

### D3.5: Write the reverse test (Go client → Rust server)

Create a Go test that connects to a Rust AAFP server.

### D3.6: Run both tests

```bash
# Rust client → Go server
cd /Users/david/projects/AAFP-research/implementations/rust
cargo test --test go_interop -v

# Go client → Rust server
cd /Users/david/projects/AAFP-research/implementations/go
go test ./interop/ -v
```

---

## Steps (if only Level 2 is possible)

### D3.3-alt: Extend golden trace cross-verification

The existing golden trace system (17 traces) already cross-verifies Rust
and Go. Extend it with:

1. **More frame types:** Add golden traces for PING/PONG, CLOSE, ERROR frames
2. **Edge cases:** Empty payloads, max-size payloads, extension frames
3. **Handshake messages:** Full ClientHello/ServerHello/ClientFinished sequences

Create `implementations/rust/crates/aafp-tests/tests/go_frame_interop.rs`:

```rust
//! Test: Encode frames in Go, decode in Rust (and vice versa).
//!
//! Uses the Go binary to encode frames, pipes them to Rust for decoding,
//! and verifies they match.

#[test]
fn test_go_encoded_frame_decodes_in_rust() {
    // 1. Run Go binary to encode a frame: `go run ./cmd/encode_frame --type DATA --payload "hello"`
    // 2. Capture stdout (the encoded bytes)
    // 3. Decode in Rust using aafp_messaging::Frame::decode()
    // 4. Verify frame type, stream ID, payload match
}

#[test]
fn test_rust_encoded_frame_decodes_in_go() {
    // 1. Encode a frame in Rust
    // 2. Write to a temp file
    // 3. Run Go binary to decode: `go run ./cmd/decode_frame < file`
    // 4. Capture stdout (the decoded frame info)
    // 5. Verify it matches
}
```

### D3.4-alt: Run extended cross-verification

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
cargo test --test go_frame_interop -v
```

### D3.5-alt: Document the interop level achieved

Write a JSON result file to `test-results/interop/rust-go-cross.json`:

```python
import json
from datetime import datetime

result = {
    "test_name": "rust-go-cross-interop",
    "test_category": "interop",
    "timestamp": datetime.now().isoformat(),
    "environment": {
        "os": "<from uname>",
        "cpu": "<from sysctl>",
        "rust_version": "<from rustc --version>",
        "go_version": "<from go version>",
        "aafp_version": "rev6-rc1",
        "commit": "<from git rev-parse HEAD>",
    },
    "status": "pass",
    "duration_ms": <measured>,
    "summary": "Rust ↔ Go cross-language interop at Level <X>",
    "details": [
        {"step": "frame_encode_go_decode_rust", "status": "pass", "notes": "All frame types verified"},
        {"step": "frame_encode_rust_decode_go", "status": "pass", "notes": "All frame types verified"},
        {"step": "mldsa65_cross_signature", "status": "pass", "notes": "19/19 + 15/15 + 100/100 vectors verified"},
    ],
    "metrics": {"interop_level": 2, "golden_traces_verified": 17},
}

with open("test-results/interop/rust-go-cross.json", "w") as f:
    json.dump(result, f, indent=2)
```

Then regenerate the dashboard:
```bash
python3 test-results/generate_dashboard.py
```

Also create `implementations/rust/crates/aafp-tests/GO_INTEROP_RESULTS.md`:

```markdown
# Rust ↔ Go Cross-Language Interop Results

## Interop Level Achieved: Level X

### Level 1 (Full live QUIC interop): <YES/NO>
- <if yes, describe the test>
- <if no, explain why — e.g., "Go QUIC transport not yet implemented (v1.1 item B-2)">

### Level 2 (Frame-level interop): <YES>
- 17 golden traces cross-verified
- Extended with N additional edge cases
- All frame types verified (DATA, HANDSHAKE, RPC, CLOSE, ERROR, PING, PONG)

### Level 3 (CBOR-level interop): <YES>
- 37 interop fixtures round-trip verified
- ML-DSA-65 cross-signature verification: 19/19 + 15/15 + 100/100

### Conclusion
<honest assessment of interop status>
```

### D3.6-alt: Commit

```bash
# In Rust submodule
git add crates/aafp-tests/tests/go_interop.rs crates/aafp-tests/GO_INTEROP_RESULTS.md
git commit -m "test: Rust ↔ Go cross-language interop verification"

# In Go submodule (if Go code was added)
cd /Users/david/projects/AAFP-research/implementations/go
git add -A
git commit -m "test: add interop test binaries for Rust cross-verification"

# Update umbrella
cd /Users/david/projects/AAFP-research
git add implementations/rust implementations/go
git commit -m "test: Rust ↔ Go cross-language interop verified"
```

---

## Verification

### D3.7: Tests pass

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
cargo test --test go_interop -v  # or go_frame_interop
```
**Expected:** All tests pass.

### D3.8: Results documented

Verify `GO_INTEROP_RESULTS.md` exists and honestly describes the interop
level achieved.

---

## Risks & Mitigations

1. **Go has no QUIC transport:** This is likely (ROADMAP.md lists Go QUIC
   as v1.1 item B-2). **Mitigation:** Fall back to Level 2 (frame-level
   interop). Document that live QUIC interop is a v1.1 milestone.

2. **Go ML-DSA-65 library differences:** The Go ML-DSA-65 library
   (`KarpelesLab/mldsa`) may produce different signatures than Rust's
   `fips204`. **Mitigation:** A-10 already verified cross-signature
   compatibility. If new issues arise, debug the specific signature
   that fails.

3. **Subprocess management:** Tests that spawn Go/Rust subprocesses can
   be flaky. **Mitigation:** Use proper timeouts, clean up subprocesses
   in `finally` blocks or `Drop` impls, and skip tests if the subprocess
   can't start.

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark D3.1 through D3.8 as `[x]`
- Set D3 status to `COMPLETE`
- Note the interop level achieved (1, 2, or 3)
