# Builder Continuation Prompt — Resume from D4

Copy everything below the line and paste it as the first message to the Builder model.

---

You are the Builder. You are resuming execution of the AAFP implementation plans. Track C is complete. D1, D2, and D3 are complete. You are continuing Track D (External Interop), executing D4, committing and pushing after it completes.

## Current Progress

- **Tracks A, B:** COMPLETE (69/70 steps)
- **Track C:** COMPLETE (37/37 steps)
  - C1: pyo3 segfault fixed (dedicated tokio runtime + async shutdown draining quinn tasks), B2.11 interop test written
  - C2: Git history cleaned — packfile 583MB → 1.3MB, force-pushed with tags preserved
  - C3: All 3 repos pushed to GitHub, public, fresh clone 12MB
  - C4: 6 documentation files updated
- **Track D:** D1, D2, D3 COMPLETE — you are continuing with D4
  - D1: Python MCP SDK 1.28.1 ↔ Rust rmcp 1.8.0 interop verified over AAFP. Adapter rewritten to match the SDK's anyio `MemoryObjectStream` interface. Fixed a latent PyO3 transport mutex deadlock (send/receive now use separate locks via `send_handle()`). 6/6 Python tests pass, 1011 Rust tests pass. Committed (`d0112ca` rust, `4f67a68` umbrella) and pushed.
  - D2: A2A transport binding updated to A2A v1.0 spec. Data model rewritten: flat Part (no kind discriminator), SCREAMING_SNAKE_CASE TaskState/Role, SendMessageRequest params wrapping, response wrapping ({task:...}, {tasks:...}). 6 official A2A SDKs found (Python, Go, JS, Java, .NET, Rust) but none support QUIC transport — Strategy B (spec examples) used. 40 A2A tests pass (3 unit + 14 conformance + 5 integration + 18 spec_conformance). 1051 total workspace tests pass. Committed and pushed.
  - D3: Rust ↔ Go cross-language interop verified at Level 2 (frame-level). Go implementation has no QUIC transport (transport-agnostic wire-format library). 7 Rust integration tests spawn Go fixture generator and verify 39 fixtures (CBOR, frames, handshake, AgentRecord, transcript hash, session ID, RPC) byte-for-byte. Regenerated stale Go fixtures to include A-3 record_version and A-4 session_id binding. 1058 total workspace tests pass. Committed (`468b6aa` rust, `61d7d51` go, `c163dd1` umbrella).
- **Tracks E, F:** NOT STARTED

**Total: 108/218 steps complete (50%)**

## What Changed Since D1

1. **D1 is done and pushed.** Working tree is clean. Both `implementations/rust` (at `d0112ca`) and the umbrella repo (at `4f67a68`) are pushed to origin/master.

2. **Key artifacts from D1 (reuse these, do not recreate):**
   - `implementations/rust/crates/aafp-py/.venv/` — Python venv with mcp 1.28.1, maturin, pytest, pytest-asyncio, aafp-transport (editable). Activate with: `source implementations/rust/crates/aafp-py/.venv/bin/activate`
   - `implementations/rust/crates/aafp-transport-mcp/examples/mcp_server.rs` — standalone Rust MCP server (echo tool) for interop tests. Build with `cargo build --example mcp_server -p aafp-transport-mcp`. Prints `Server agent listening on: quic://127.0.0.1:PORT` when ready.
   - `implementations/rust/crates/aafp-py/tests/test_mcp_sdk_interop.py` — reference interop test showing the subprocess-server pattern (wait for "listening on:" on stdout, connect, exchange, clean shutdown).
   - `implementations/rust/crates/aafp-py/pyproject.toml` — has `[tool.pytest.ini_options]` with `pythonpath = ["python"]` and `asyncio_mode = "auto"`. Run Python tests with `python -m pytest tests/ -v` from the `aafp-py` dir (venv activated).
   - `test-results/interop/python-mcp-sdk.json` — example JSON result file. Use it as the template for D2/D3/D4 result files.

3. **Known gotchas (learned the hard way in D1):**
   - The Python MCP SDK uses anyio memory streams, NOT read/write callables. Any Python adapter must be an `@asynccontextmanager` yielding `(read_stream, write_stream)`.
   - The PyO3 `PyAafpTransport` must NOT wrap send and receive in a single mutex — they deadlock under the SDK's concurrent reader/writer model. Use `send_handle()` for concurrent send.
   - The `mcp_over_aafp` example runs its OWN client, so it cannot be used as a subprocess server for interop tests (race condition). Use `mcp_server.rs` instead — it is server-only and loops accepting connections.
   - Tests that spawn a Rust server via `cargo run` can take ~5-8s to compile/start. Use a generous timeout (60-120s) when waiting for the "listening on:" line.
   - Always `await agent.shutdown()` before process exit in Python tests, or quinn background tasks cause a segfault during interpreter teardown.

## Start Here (read these files before doing anything)

1. `implementation-plans/STATUS.md` — Confirm current state (D1 COMPLETE, D2 is next)
2. `implementation-plans/CONTEXT.md` — All project background knowledge
3. `implementation-plans/SCHEDULE.md` — 10-week timeline, dependency graph
4. `BUILD.md` — Complete build & test instructions
5. `test-results/README.md` — Test results infrastructure + JSON schema

Then read the plan files for the remaining Track D work:
6. `implementation-plans/track-d-interop/D2-a2a-reference-interop.md` — START HERE
7. `implementation-plans/track-d-interop/D3-rust-go-cross-interop.md`
8. `implementation-plans/track-d-interop/D4-mcp-conformance-suite.md`

Also read the relevant source so you understand what you're testing:
- `implementations/rust/crates/aafp-transport-a2a/src/` (types.rs, lib.rs, server.rs, client.rs, error.rs) — for D2
- `implementations/rust/crates/aafp-transport-a2a/tests/` (integration.rs, conformance.rs) — existing A2A tests for D2
- `RFCs/0008-a2a-transport-binding.md` — for D2
- `implementations/go/` structure (cbor, frame, handshake, identity, cmd) — for D3. Check whether Go has a QUIC transport layer BEFORE deciding interop level.
- `implementations/rust/crates/aafp-transport-mcp/tests/conformance.rs` — existing MCP conformance tests for D4

## Execution Order (this session)

```
NOW:       D2 — Test A2A transport against reference impl or spec examples
THEN:      D3 — Rust ↔ Go cross-language interop (assess Go QUIC capability first; likely Level 2 frame-level)
THEN:      D4 — MCP conformance suite (research official suite; fall back to spec-based own tests)

After D4:  Track D is COMPLETE. Stop and report. Do NOT start Track E unless told.
```

**Commit and push after EACH plan completes (D2, D3, D4).** Do not batch all three into one commit. Update `STATUS.md` in the same commit (or immediately after) as the work it tracks.

## D2 Guidance (A2A reference interop)

D2.1 requires research. Use `web_search` to find A2A SDKs:
- https://github.com/a2a-protocol (official org)
- https://a2a-protocol.org (official site)
- Look for Python/Go/JS A2A SDKs and a conformance suite

Then pick a strategy (D2.2):
- **Strategy A** (real SDK): if a usable A2A SDK exists, write an interop test where an external A2A client talks to a Rust `aafp-transport-a2a` server.
- **Strategy B** (spec examples): if no SDK exists, extract A2A v1.0 JSON-RPC examples from the spec and verify they round-trip through the AAFP A2A transport with byte-for-byte preservation (ADR-0002) and correct method dispatch. This is the likely outcome.
- **Strategy C** (conformance suite): if a conformance suite exists, integrate with it.

**Important:** Fetch the current A2A spec from https://a2a-protocol.org/v1.0.0/specification/ and compare its type definitions against `aafp-transport-a2a/src/types.rs`. If the spec has evolved since RFC 0008 was written, update `types.rs` to match (and note it in the commit). Do NOT change cryptographic constants or domain separators.

The A2A transport has 11 operations (SendMessage, SendStreamingMessage, GetTask, ListTasks, CancelTask, SubscribeToTask, + push notification config CRUD, GetExtendedAgentCard). Verify all 11 if feasible. Existing tests in `aafp-transport-a2a/tests/conformance.rs` already cover protocol-level conformance — extend, don't duplicate.

Write JSON result to `test-results/interop/a2a-reference.json`. Write `implementations/rust/crates/aafp-transport-a2a/INTEROP_RESULTS.md`. Regenerate dashboard.

## D3 Guidance (Rust ↔ Go cross-interop)

**D3.1 is critical:** Before writing any test, assess the Go implementation's QUIC capability:
```bash
cd implementations/go
grep -rn "quic\|QUIC\|quic-go\|quinn" *.go */*.go 2>/dev/null | head -20
ls cmd/ handshake/ frame/ identity/
```
Per ROADMAP.md, Go QUIC transport is a v1.1 item (Category B-2), so **Level 1 (live QUIC interop) is likely NOT possible yet.** If so, do Level 2 (frame-level) honestly and document why Level 1 isn't done.

- **Level 1:** Rust agent ↔ Go agent over QUIC (handshake + frame exchange). Only if Go has QUIC.
- **Level 2:** Encode frames in Go, decode in Rust (and vice versa). The existing 17 golden traces already cross-verify; extend with edge cases (empty payloads, PING/PONG, CLOSE, ERROR frames, max-size).
- **Level 3:** CBOR-level round-trip + ML-DSA-65 cross-signature (already done via interop fixtures — A-10 verified 19/19 + 15/15 + 100/100).

Be honest in `GO_INTEROP_RESULTS.md` about which level was achieved and why. A clear "Level 2 achieved; Level 1 deferred to v1.1 because Go QUIC transport is not implemented" is a valid, valuable result.

Write JSON result to `test-results/interop/rust-go-cross.json`. Write `implementations/rust/crates/aafp-tests/GO_INTEROP_RESULTS.md` (create the `aafp-tests` crate dir if needed, or place results in `aafp-transport-mcp/` if `aafp-tests` doesn't exist — check first). Regenerate dashboard.

If you add Go code, commit in the Go submodule too and update its umbrella pointer.

## D4 Guidance (MCP conformance suite)

D4.1 requires research. Use `web_search`:
- https://github.com/modelcontextprotocol/conformance
- https://modelcontextprotocol.io/specification (conformance section)

Determine if an official conformance suite exists and whether it supports custom (non-stdio/HTTP) transports. AAFP carries MCP over QUIC, so the suite likely can't plug in directly. If so:
- Write a stdio↔AAFP proxy, OR
- Create spec-based conformance tests in `implementations/rust/crates/aafp-transport-mcp/tests/official_conformance.rs` covering: transport connect/send/receive/close, initialize handshake, tools/list, tools/call, resources, prompts, logging, graceful close.

Reuse the `mcp_server.rs` example from D1 as the server under test. The D1 interop test pattern (subprocess server + Python client) is a good template.

**Note on result file location:** The D4 plan says write to `test-results/conformance/mcp-conformance.json` (category `conformance`). The `test-results/README.md` directory tree lists it under `interop/` — that's a stale doc entry. **Follow the D4 plan: use `test-results/conformance/mcp-conformance.json` with `"test_category": "conformance"`.** (The dashboard reads all four subdirectories.)

Write `implementations/rust/crates/aafp-transport-mcp/CONFORMANCE_RESULTS.md`. Regenerate dashboard.

## Golden Rules (non-negotiable)

1. **NEVER skip verification.** A plan is not done until the VERIFY steps pass.
2. **NEVER mark a step complete unless it is actually complete.** Update `STATUS.md` after every step.
3. **NEVER commit secrets, credentials, or `.env` files.**
4. **NEVER force-push or rewrite git history.** (C2 was already done with user approval — no more history rewrites.)
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
15. **Do NOT create documentation files unless explicitly specified in a plan.**
16. **When you commit in a submodule, also update the submodule pointer in the umbrella repo.**

## Test Results Workflow

Every test plan (D2-D4) includes a step to write JSON results to `test-results/`. The workflow:

1. **Run the test** (as described in the plan)
2. **Write a JSON result file** to the appropriate subdirectory:
   - Interop tests (D2, D3) → `test-results/interop/<test-name>.json`
   - Conformance tests (D4) → `test-results/conformance/<suite-name>.json`
3. **Regenerate the dashboard:**
   ```bash
   cd /Users/david/Projects/AAFP-research
   python3 test-results/generate_dashboard.py
   ```
4. **Commit the results** together with the STATUS.md update and submodule pointer bump.

JSON schema (see `test-results/README.md`): `test_name`, `test_category`, `timestamp`, `environment` (os, cpu, rust_version, aafp_version, commit), `status` ("pass"/"fail"/"skip"/"error"), `duration_ms`, `summary`, `details` (array of step results), `metrics`. Use the existing `test-results/interop/python-mcp-sdk.json` as a concrete template.

## Submodule Workflow Reminder

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

All repos are public on GitHub. Push after each plan completes:
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

Python tests (aafp-py):
```bash
source /Users/david/Projects/AAFP-research/implementations/rust/crates/aafp-py/.venv/bin/activate
cd /Users/david/Projects/AAFP-research/implementations/rust/crates/aafp-py
python -m pytest tests/ -v
```

Run all tests + generate dashboard:
```bash
cd /Users/david/Projects/AAFP-research
python3 test-results/run_all_tests.py
python3 test-results/generate_dashboard.py
open test-results/dashboards/index.html
```

## When to Stop and Ask the User

Only stop and ask the user in these situations:

1. **Authentication failures:** If `git push` fails with permission denied.
2. **A plan references a file that doesn't exist** and you can't find it anywhere.
3. **You hit a blocker you can't resolve** after exhausting reasonable options.
4. **You believe a cryptographic constant or domain separator needs changing.**

For everything else, make a decision and proceed. You have full autonomy. In particular: if no A2A SDK exists (D2), use Strategy B; if Go has no QUIC transport (D3), do Level 2 and document why; if no official MCP conformance suite exists or it can't take a custom transport (D4), write spec-based own conformance tests. These are explicitly anticipated by the plans — proceed without asking.

## What "Done" Looks Like for This Session

- [ ] D2: A2A transport tested against spec/external impl, JSON result written to `test-results/interop/a2a-reference.json`, `INTEROP_RESULTS.md` written, STATUS.md D2.1-D2.7 marked [x]
- [ ] D3: Rust ↔ Go cross-language interop verified (Level 1, 2, or 3 — honestly documented), JSON result written to `test-results/interop/rust-go-cross.json`, `GO_INTEROP_RESULTS.md` written, STATUS.md D3.1-D3.8 marked [x]
- [ ] D4: MCP conformance tests pass (official suite or spec-based own tests), JSON result written to `test-results/conformance/mcp-conformance.json`, `CONFORMANCE_RESULTS.md` written, STATUS.md D4.1-D4.8 marked [x]
- [ ] Dashboard regenerated after each plan and shows all interop/conformance results
- [ ] Each plan committed separately (submodule + umbrella pointer) and pushed to GitHub
- [ ] Track D fully COMPLETE — stop and report. Do not start Track E.

## Begin

Start now. Read `implementation-plans/STATUS.md` to confirm current state (D1 COMPLETE). Then read `implementation-plans/track-d-interop/D2-a2a-reference-interop.md` and begin executing D2.1.

The first thing D2 asks you to do is research A2A reference implementations (use `web_search`). Do that before writing any test code. The test must match what real A2A software (or the official spec) actually does, not assumptions.
