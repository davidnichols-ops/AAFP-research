# Builder Continuation Prompt — Finish the Project (D4 → E1-E4 → F1-F4)

Copy everything below the line and paste it as the first message to the Builder model.

---

You are the Builder. You are resuming execution of the AAFP implementation plans. D1, D2, D3 are complete. You are finishing the ENTIRE remaining project: D4, then all of Track E (E1-E4), then all of Track F (F1-F4). That is 9 plans and 111 steps — the whole rest of the roadmap. You are expected to work through all of them in this session, committing and pushing after each plan completes.

You are capable of this. In the previous session you completed D2 (A2A v1.0 spec conformance: types.rs rewrite, 18 new spec tests, 40 total A2A tests) and D3 (Rust↔Go Level 2 interop: 7 integration tests, 39 fixtures verified byte-for-byte, stale Go fixtures regenerated) in under an hour. The remaining plans are comparable in complexity. Do not pace yourself — execute at full speed, plan by plan, and do not stop until all 9 plans are done or you hit a genuine blocker.

## Current Progress

- **Tracks A, B:** COMPLETE (69/70 steps)
- **Track C:** COMPLETE (37/37 steps)
- **Track D:** D1, D2, D3 COMPLETE — D4 remaining
  - D1: Python MCP SDK 1.28.1 ↔ Rust rmcp 1.8.0 interop. Adapter rewritten for anyio streams. Fixed PyO3 mutex deadlock. 6/6 Python tests, 1011 Rust tests.
  - D2: A2A transport updated to v1.0 spec (flat Part, SCREAMING_SNAKE_CASE enums, SendMessageRequest wrapping). 18 new spec_conformance tests with exact v1.0 JSON examples. 40 A2A tests pass, 1051 total. **NOTE: STATUS.md was NOT updated for D2 — you must fix this first (see below).**
  - D3: Rust↔Go Level 2 frame-level interop. 7 Rust integration tests spawn Go fixture generator, verify 39 fixtures byte-for-byte (CBOR, frames, handshake, AgentRecord, transcript hash, session ID, RPC). Regenerated stale Go fixtures for A-3/A-4 changes. 1058 total workspace tests. Go has no QUIC transport (transport-agnostic wire-format library), so Level 1 (live QUIC) is deferred to v1.1.
- **Track E:** NOT STARTED — you are doing all of it (E1-E4)
- **Track F:** NOT STARTED — you are doing all of it (F1-F4)

**Total: ~122/218 steps complete (56%)** — you are completing the remaining ~96 steps plus fixing the D2 STATUS gap.

## FIRST THING: Fix the D2 STATUS.md gap

The previous session completed D2 but forgot to update STATUS.md. Before starting D4, fix this:

1. Read `implementation-plans/STATUS.md`
2. Find the D2 section (currently shows all `[ ]` and `NOT STARTED`)
3. Mark D2.1-D2.7 as `[x]` with notes based on what was actually done:
   - D2.1: Researched A2A SDKs — official Python (a2a-sdk v1.1.0), Go (a2a-go v2.0.0), JS, Java, .NET, Rust SDKs exist. A TCK exists at a2aproject/a2a-tck but tests over HTTP/gRPC/JSON-RPC, not QUIC. All SDKs use HTTP — none support QUIC. Strategy B (spec examples) chosen.
   - D2.2: Strategy B (spec examples) + types.rs update to A2A v1.0
   - D2.3: Updated types.rs to v1.0 spec (flat Part, SCREAMING_SNAKE_CASE enums, SendMessageRequest wrapping, response wrapping). Updated server.rs dispatch, client.rs. Updated existing tests. Wrote 18 new spec_conformance.rs tests with exact v1.0 JSON examples.
   - D2.4: All tests pass — 40 A2A tests (18 new spec_conformance + existing), 1051 total workspace tests.
   - D2.5: JSON result written to test-results/interop/a2a-reference.json. Dashboard regenerated.
   - D2.6: Committed (rust `3a00274`, umbrella `620e2b2`) and pushed.
   - D2.7: Verified — 40 A2A tests pass, 1051 total.
4. Set D2 status to COMPLETE
5. Also update the summary table at the bottom of STATUS.md (D1, D2, D3 should all show COMPLETE with correct step counts; total completed should be ~122)
6. Commit this fix: `git commit -m "docs: fix STATUS.md — mark D2 complete (was done in 620e2b2 but not tracked)"`

## What Changed Since D2/D3

1. **All repos are pushed and clean.** Working tree is clean. Umbrella at `3a0c136`, rust at `468b6aa`, go at `61d7d51`.

2. **Key artifacts from D1-D3 (reuse these):**
   - `implementations/rust/crates/aafp-py/.venv/` — Python venv with mcp 1.28.1, maturin, pytest, pytest-asyncio. Activate: `source implementations/rust/crates/aafp-py/.venv/bin/activate`
   - `implementations/rust/crates/aafp-transport-mcp/examples/mcp_server.rs` — standalone Rust MCP server (echo tool) for interop tests. Server-only, loops accepting connections.
   - `implementations/rust/crates/aafp-py/tests/test_mcp_sdk_interop.py` — reference interop test (subprocess server pattern).
   - `implementations/rust/crates/aafp-transport-a2a/tests/spec_conformance.rs` — 18 A2A v1.0 spec conformance tests (from D2).
   - `implementations/rust/crates/aafp-tests/tests/go_interop.rs` — 7 Rust↔Go frame-level interop tests (from D3).
   - `test-results/interop/python-mcp-sdk.json`, `test-results/interop/a2a-reference.json`, `test-results/interop/rust-go-cross.json` — example JSON result files. Use as templates.
   - `test-results/dashboards/index.html` — auto-generated dashboard showing 3/3 interop tests passing.

3. **Known gotchas (learned in D1-D3):**
   - The Python MCP SDK uses anyio memory streams, NOT read/write callables. Any Python adapter must be an `@asynccontextmanager` yielding `(read_stream, write_stream)`.
   - The PyO3 `PyAafpTransport` must NOT wrap send and receive in a single mutex — they deadlock. Use `send_handle()` for concurrent send.
   - The `mcp_over_aafp` example runs its OWN client — cannot be used as a subprocess server. Use `mcp_server.rs` instead.
   - Tests spawning Rust servers via `cargo run` take ~5-8s to compile/start. Use 60-120s timeouts.
   - Always `await agent.shutdown()` before Python process exit, or segfault.
   - Go has NO QUIC transport — it's a transport-agnostic wire-format library. Don't attempt Level 1 live QUIC interop with Go.
   - The A2A v1.0 spec uses SCREAMING_SNAKE_CASE for enums (ProtoJSON convention) and flat Part (no `kind` discriminator). types.rs was updated in D2 — don't revert it.
   - Go fixtures must be regenerated when Rust CBOR/handshake types change. The Go fixture generator is at `implementations/go/cmd/` (check exact path).

## Start Here (read these files before doing anything)

1. `implementation-plans/STATUS.md` — Confirm current state (fix D2 gap first, then D4 is next)
2. `implementation-plans/CONTEXT.md` — All project background knowledge
3. `implementation-plans/SCHEDULE.md` — 10-week timeline, dependency graph
4. `BUILD.md` — Complete build & test instructions
5. `test-results/README.md` — Test results infrastructure + JSON schema

Then read ALL the remaining plan files (read them all upfront so you understand the full scope):
6. `implementation-plans/track-d-interop/D4-mcp-conformance-suite.md`
7. `implementation-plans/track-e-protocol/E1-ping-pong-keepalive.md`
8. `implementation-plans/track-e-protocol/E2-discovery-over-quic.md`
9. `implementation-plans/track-e-protocol/E3-networked-pubsub.md`
10. `implementation-plans/track-e-protocol/E4-relay-nat-traversal.md`
11. `implementation-plans/track-f-production/F1-performance-validation.md`
12. `implementation-plans/track-f-production/F2-rustdoc-documentation.md`
13. `implementation-plans/track-f-production/F3-revocation-mechanism.md`
14. `implementation-plans/track-f-production/F4-persistent-dht.md`

Also read the relevant source/RFC files as you reach each plan. Key ones:
- `RFCs/0002-transport-framing.md` §4.7-4.8 (for E1 PING/PONG)
- `crates/aafp-messaging/src/framing.rs` (PING/PONG frame types already defined)
- `RFCs/0004-discovery.md` §3 (for E2 discovery)
- `crates/aafp-discovery/src/` (capability_dht.rs, discovery_v1.rs, bootstrap.rs)
- `crates/aafp-messaging/src/pubsub.rs` (for E3 — current local-only impl)
- `crates/aafp-nat/src/` (relay.rs, dcutr.rs, auto_nat.rs — all stubs for E4)
- `crates/aafp-benchmark/src/` (env_report.rs — for F1)
- `crates/aafp-identity/src/` (for F3 revocation)
- `RFCs/0003-identity-authentication.md` §5 (for F3 revocation)

## Execution Order (this session — ALL of it)

```
1. FIX D2 STATUS.md gap (quick — see above)
2. D4  — MCP conformance suite (research official suite; fall back to spec-based own tests)
3. E1  — PING/PONG keep-alive (RFC-0002 §4.7-4.8) — unblocks E2/E3/E4/F1/F4
4. E2  — Discovery announce/lookup over QUIC (RFC-0004 §3) — unblocks E3/E4/F4
5. E3  — Networked PubSub / floodsub over QUIC (write RFC 0009 first)
6. E4  — Relay protocol / NAT traversal (write RFC 0010 first) — after E2
7. F1  — Performance benchmarks (criterion) — after E1-E4
8. F2  — Rustdoc documentation for all public APIs — independent, can do anytime
9. F3  — CRL-based revocation mechanism — independent, can do anytime
10. F4 — Persistent DHT backend (SQLite) — after E2
```

**Dependency-respecting order:** D4 → E1 → E2 → E3 → E4 → F1 → F2 → F3 → F4

F2 and F3 are independent (no blockers) — you can do them in any order relative to the others. F4 requires E2. F1 requires E1-E4. If you want to interleave F2/F3 between E-plans to keep momentum when an E-plan hits a snag, that's fine.

**Commit and push after EACH plan completes.** Do not batch multiple plans into one commit. Update `STATUS.md` in the same commit as the work it tracks. This is non-negotiable — the previous session forgot to update STATUS.md for D2, and that caused a tracking gap.

## Plan-by-Plan Guidance

### D4: MCP Conformance Suite
Research the official MCP conformance suite (`web_search` for github.com/modelcontextprotocol/conformance and modelcontextprotocol.io). AAFP carries MCP over QUIC, so the official suite (if it exists) likely only supports stdio/HTTP and can't plug in directly. If so, create spec-based conformance tests in `implementations/rust/crates/aafp-transport-mcp/tests/official_conformance.rs` covering: transport connect/send/receive/close, initialize handshake, tools/list, tools/call, resources, prompts, logging, graceful close. Reuse `mcp_server.rs` as the server under test. Write JSON result to `test-results/conformance/mcp-conformance.json` (category `conformance`, NOT `interop`). Write `CONFORMANCE_RESULTS.md`. Regenerate dashboard.

### E1: PING/PONG Keep-Alive
Frame types 0x07 (PING) and 0x08 (PONG) are already defined in `aafp-messaging/src/framing.rs` — encoding/decoding works. You need to add the LOGIC: `PingTracker` (track outstanding PINGs, detect missed PONGs), `KeepAliveConfig` (interval 30s, timeout 10s, max_missed 3), background task sending PING on stream 0, PONG response on receiving PING, connection close on max_missed. Add `with_keepalive()` to `AgentBuilder`. Read RFC-0002 §4.7-4.8 first. This is the most self-contained E-plan — no network dependencies beyond what already exists.

### E2: Discovery Over QUIC
`aafp-discovery` has `capability_dht.rs` (in-memory), `discovery_v1.rs` (RPC method constants defined but NOT wired to QUIC), `bootstrap.rs`. You need to: implement `DiscoveryRpcHandler` (server-side: handle announce/lookup RPC with rate limiting), `DiscoveryClient` (client-side: send announce/lookup over QUIC), wire into SDK (route `aafp.discovery.*` RPCs to handler), implement bootstrap node connection. Read RFC-0004 §3. Rate limits: announce 1/60s, lookup 10/60s per connection. AgentRecords have TTL.

### E3: Networked PubSub
Current `pubsub.rs` is local-only (186 lines, uses `tokio::sync::broadcast`). Upgrade to floodsub: published messages forwarded to all known peers subscribed to the topic. Write RFC 0009 first (concise, 200-300 lines: SUBSCRIBE/UNSUBSCRIBE, PUBLISH, frame format, floodsub v1, gossipsub v2 as future work). Add "seen" cache to prevent message loops. Use bounded channels for backpressure. Keep it simple — floodsub is sufficient for small networks.

### E4: Relay / NAT Traversal
`aafp-nat/src/relay.rs` is a 202-line stub. `dcutr.rs` and `auto_nat.rs` are stubs. Write RFC 0010 first (300-400 lines: relay reservation, relayed connection, wire format using RPC frames for control + DATA frames for relayed traffic, reservation lifecycle with TTL, capacity limits, DCUtR). Implement in phases: reservation protocol → data forwarding → AutoNAT → DCUtR. Each phase is independently useful. Hole punching won't work for symmetric NATs — fall back to relay, document which NAT types are supported.

### F1: Performance Benchmarks
`aafp-benchmark` crate has `env_report.rs` (283 lines) and empty `lib.rs`. Use `criterion` for benchmarks. Implement: crypto benchmarks (ML-DSA-65 keygen/sign/verify), framing benchmarks (encode/decode at 64B-64KB), transport benchmarks (handshake time, single/multi-stream throughput), session/memory benchmarks. Run `cargo bench --workspace`, write JSON results to `test-results/performance/{crypto,framing,transport,session}.json`, create `PERFORMANCE_REPORT.md` with honest results vs targets. Targets: keygen <50ms, sign <10ms, verify <15ms, frame encode/decode 1KB <10µs, time-to-first-msg <500ms, throughput >10k msg/s single stream. If targets aren't met (post-quantum crypto is slower), document honestly — don't fake results.

### F2: Rustdoc Documentation
Run `cargo doc --workspace --no-deps 2>&1 | grep "warning:"` to audit. Document EVERY public item across ALL crates: aafp-sdk (highest priority — Agent, AgentBuilder, AgentClient, AgentServer, establish_session), aafp-core (Session, SessionState, AuthorizationProvider), aafp-crypto (MlDsa65, AgentKeypair, ReplayCache, constants), aafp-identity (AgentId, AgentRecord, CapabilityDescriptor), aafp-messaging (Frame, FrameType, PubSub, PingTracker from E1), aafp-transport-quic (QuicConnection, streams, export_tls_binding), transport binding crates, aafp-discovery (from E2), aafp-nat (from E4). Verify: `cargo doc --workspace --no-deps` builds with 0 warnings, `RUSTDOCFLAGS="-D rustdoc::broken-intra-doc-links" cargo doc --workspace --no-deps` passes, `cargo test --doc --workspace` passes. Add usage examples with ` ```no_run ` blocks.

### F3: CRL-Based Revocation
No revocation mechanism exists. Implement CRL (Certificate Revocation List): `RevocationEntry` (signed statement: agent_id, revoked_at, reason, revoking_key_id, signature), `RevocationList` (CBOR-encoded, TTL-based), `RevocationStore` (merged view of all known CRLs). Integrate with handshake (check after identity verification, reject with ERROR 2002 if revoked). Integrate with discovery (CRLs distributed as capability `aafp.revocation.crl`). Write RFC amendment. Self-revocation v1 (agent signs with own key). Read RFC-0003 §5 and AMENDMENTS-0001 §C3 first.

### F4: Persistent DHT (SQLite)
Replace in-memory `HashMap` DHT with pluggable backend. Add `rusqlite` with `bundled` feature (check version is >7 days old). Create `CapabilityDhtBackend` trait, `InMemoryDht` (existing, now implements trait), `PersistentDht` (SQLite-backed). Schema: agent_records table with agent_id (BLOB PK), cbor_data, capabilities (TEXT), expires_at, updated_at. Indexes on capabilities and expires_at. Make `CapabilityDht` generic over backend. Add `AgentBuilder.with_persistent_dht(path)`. WAL mode for read concurrency. Test persistence across reopen. Read `capability_dht.rs` first.

## Golden Rules (non-negotiable)

1. **NEVER skip verification.** A plan is not done until the VERIFY steps pass.
2. **NEVER mark a step complete unless it is actually complete.** Update `STATUS.md` after every step — and ACTUALLY update it this time (D2 was forgotten last session).
3. **NEVER commit secrets, credentials, or `.env` files.**
4. **NEVER force-push or rewrite git history.**
5. **ALWAYS follow existing code conventions.** Read `CONTEXT.md` and `implementations/rust/AGENTS.md`.
6. **ALWAYS run `cargo fmt --all -- --check` and `cargo clippy --workspace` before committing Rust changes.**
7. **ALWAYS run `gofmt -l .` before committing Go changes.**
8. **ALWAYS write a commit message that explains WHY, not just WHAT.** Use the commit message templates in each plan.
9. **ALWAYS update `STATUS.md` in the same commit as the work it tracks.**
10. **If a plan step is blocked, mark it BLOCKED in `STATUS.md`** and move to the next unblocked plan.
11. **If a plan references a file that does not exist, STOP and report it.**
12. **Read the relevant RFC sections before implementing protocol features.**
13. **Do NOT modify domain separators or cryptographic constants.**
14. **Do NOT add dependencies without checking they are maintained and published >7 days ago.**
15. **Do NOT create documentation files unless explicitly specified in a plan.** (RFCs and result docs called out in plans ARE explicitly specified — those are fine.)
16. **When you commit in a submodule, also update the submodule pointer in the umbrella repo.**
17. **Commit and push after EACH plan.** Not after every 3 plans. After EACH one.

## Test Results Workflow

Every test plan (D4, F1) writes JSON results. The workflow:
1. Run the test
2. Write JSON result to the appropriate subdirectory:
   - Conformance (D4) → `test-results/conformance/<suite-name>.json`
   - Performance (F1) → `test-results/performance/<bench-name>.json`
3. Regenerate dashboard: `python3 test-results/generate_dashboard.py`
4. Commit results together with STATUS.md and submodule pointer.

JSON schema (see `test-results/README.md`): `test_name`, `test_category`, `timestamp`, `environment` (os, cpu, rust_version, aafp_version, commit), `status`, `duration_ms`, `summary`, `details`, `metrics`. Use existing files in `test-results/interop/` as templates.

## Submodule Workflow

```
/Users/david/Projects/AAFP-research/              <- umbrella repo
├── implementations/rust/                         <- submodule (github.com/davidnichols-ops/aafp)
└── implementations/go/                           <- submodule (github.com/davidnichols-ops/aafp-go)
```

When you commit in a submodule:
```bash
cd implementations/rust
git add -A
git commit -m "..."
# Then update the umbrella:
cd /Users/david/Projects/AAFP-research
git add implementations/rust
git commit -m "chore: update rust submodule — <brief description>"
```

Push after each plan:
```bash
cd implementations/rust && git push origin master
cd implementations/go && git push origin master   # only if Go changed
cd /Users/david/Projects/AAFP-research && git push origin master
```

## Commit Message Format

```bash
git commit -m "$(cat <<'EOF'
<type>: <description>

<body explaining why>

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

Types: `feat`, `fix`, `test`, `docs`, `chore`, `refactor`.

## Quick Verification Commands

Before committing Rust changes:
```bash
cd /Users/david/Projects/AAFP-research/implementations/rust
cargo fmt --all -- --check
cargo build --workspace
cargo clippy --workspace
cargo test --workspace
```

Before committing Go changes:
```bash
cd /Users/david/Projects/AAFP-research/implementations/go
gofmt -l .
go vet ./...
go test ./...
```

Python tests (aafp-py, for D4 if you write Python conformance tests):
```bash
source /Users/david/Projects/AAFP-research/implementations/rust/crates/aafp-py/.venv/bin/activate
cd /Users/david/Projects/AAFP-research/implementations/rust/crates/aafp-py
python -m pytest tests/ -v
```

Dashboard:
```bash
cd /Users/david/Projects/AAFP-research
python3 test-results/generate_dashboard.py
```

## When to Stop and Ask the User

Only stop and ask the user in these situations:

1. **Authentication failures:** If `git push` fails with permission denied.
2. **A plan references a file that doesn't exist** and you can't find it anywhere.
3. **You hit a blocker you can't resolve** after exhausting reasonable options.
4. **You believe a cryptographic constant or domain separator needs changing.**

For everything else, make a decision and proceed. You have full autonomy. Specifically:
- If no official MCP conformance suite exists or can't take a custom transport (D4), write spec-based own conformance tests.
- If a protocol feature is complex (E3 gossipsub, E4 DCUtR), implement the simpler version (floodsub, relay-only without hole punching) and document the more complex version as future work.
- If performance targets aren't met (F1), document honestly — don't fake results.
- If a dependency is needed (F4 rusqlite), check it's maintained and published >7 days ago, then add it.
- If you need to write a new RFC (E3 → RFC 0009, E4 → RFC 0010, F3 → amendment to RFC-0003), write it concisely (200-400 lines) focusing on wire format and semantics.

## What "Done" Looks Like for This Session

- [ ] D2 STATUS.md gap fixed (quick commit)
- [ ] D4: MCP conformance tests pass, JSON result in `test-results/conformance/`, `CONFORMANCE_RESULTS.md` written, STATUS.md D4.1-D4.8 marked [x]
- [ ] E1: PING/PONG keep-alive implemented, unit + integration tests pass, RFC-0002 status updated, STATUS.md E1.1-E1.11 marked [x]
- [ ] E2: Discovery announce/lookup over QUIC implemented, tests pass, STATUS.md E2.1-E2.8 marked [x]
- [ ] E3: Networked PubSub (floodsub) implemented, RFC 0009 written, tests pass, STATUS.md E3.1-E3.7 marked [x]
- [ ] E4: Relay protocol + NAT traversal implemented, RFC 0010 written, tests pass, STATUS.md E4.1-E4.10 marked [x]
- [ ] F1: Benchmark framework + performance report, JSON results in `test-results/performance/`, `PERFORMANCE_REPORT.md` written, STATUS.md F1.1-F1.10 marked [x]
- [ ] F2: All public APIs documented, `cargo doc` builds with 0 warnings, doc tests pass, STATUS.md F2.1-F2.14 marked [x]
- [ ] F3: CRL-based revocation implemented, RFC amendment written, tests pass, STATUS.md F3.1-F3.9 marked [x]
- [ ] F4: Persistent DHT (SQLite) implemented, persistence tests pass, STATUS.md F4.1-F4.11 marked [x]
- [ ] Each plan committed separately (submodule + umbrella pointer) and pushed to GitHub
- [ ] Dashboard regenerated after each test plan
- [ ] STATUS.md summary table updated with all plans COMPLETE
- [ ] **THE ENTIRE PROJECT IS DONE.** All 218/218 steps complete. Stop and report.

## Begin

Start now. Fix the D2 STATUS.md gap first (quick). Then read `implementation-plans/track-d-interop/D4-mcp-conformance-suite.md` and begin executing D4.1.

The first thing D4 asks you to do is research the MCP conformance suite (use `web_search`). Do that before writing any conformance test code. The tests must match what the official MCP specification actually requires, not assumptions.

After D4, flow directly into E1 (PING/PONG keep-alive). Read RFC-0002 §4.7-4.8 before starting. The frame types already exist — you're adding the logic.

Do not stop between plans unless you hit a genuine blocker. Commit, push, update STATUS.md, and immediately start the next plan. You are finishing the entire project in this session.
