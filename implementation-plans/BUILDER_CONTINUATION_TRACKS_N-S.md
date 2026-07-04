# Builder Continuation Prompt — Tracks N-S (Production Readiness Phase 2)

Copy everything below the line and paste it as the first message to the Builder model.

---

You are the Builder. You are resuming execution of the AAFP implementation plans.
Tracks A-M are COMPLETE (270/270 steps). You are now executing Tracks N-S
(Production Readiness Phase 2 — 48 steps total).

## Current State (as of 2026-07-04)

**All previous work is committed and pushed.** The codebase has:
- 15 Rust crates, 1324 tests passing, 0 failures
- 7 RFCs (0001-0011), performance optimized to 41.47µs RTT
- Go interop library, Python PyO3 adapter, MCP + A2A transport bindings

**Builder subagents were launched in a previous session for tracks N-S.** They
produced ~4,500 lines of code across 4 tracks but did NOT commit any of it.
All uncommitted code compiles and tests pass (1324 total, 0 failures).

### Uncommitted Work (review, then commit or rework)

| Track | Step | File(s) | Lines | Status |
|-------|------|---------|-------|--------|
| O | O1 | `crates/aafp-tests/tests/wan_test.rs` | 431 | Compiles, tests pass |
| O | O1 | `crates/aafp-tests/examples/wan_test_{client,server}.rs` | 471 | Compiles |
| O | O1 | `scripts/wan-test-*.sh`, `docs/WAN_TESTING.md` | — | Shell scripts + docs |
| P | P2 | `crates/aafp-identity/src/key_directory.rs` | 730 | Compiles, module wired |
| R | R1 | `crates/aafp-discovery/src/dht_router.rs` | 1693 | Compiles, module wired |
| S | S1 | `crates/aafp-loadtest/` (6 files) | 1138 | 14 tests pass |

**IMPORTANT:** These files are untracked/unstaged in git. The Rust submodule
has a dirty working tree. Before starting new work, you must:
1. Review each uncommitted file for quality
2. Fix any issues (the loadtest test had a format string bug — already fixed)
3. Commit each track's work separately with proper STATUS.md updates
4. Then continue with the remaining steps

## FIRST TASK: Commit the uncommitted work

Before starting any new steps, commit the existing uncommitted work. Do this
track by track, in dependency order:

### Step 1: Commit Track S1 (loadtest harness)
```bash
cd /Users/david/Projects/AAFP-research/implementations/rust
# Review the code
cat crates/aafp-loadtest/src/lib.rs
cat crates/aafp-loadtest/src/runner.rs
cat crates/aafp-loadtest/tests/load_test.rs
# Run tests to verify
cargo test -p aafp-loadtest
# Format and lint
cargo fmt -p aafp-loadtest -- --check
cargo clippy -p aafp-loadtest -- -D warnings
# Commit
git add crates/aafp-loadtest/ Cargo.toml Cargo.lock
git commit -m "feat(s1): load test harness — N agents, topologies, metrics (Track S1)

Implements LoadTestConfig, Topology (mesh/star/ring/random), LoadTestRunner,
LoadTestMetrics (throughput, latency, error rate, resource usage), CLI binary.
14 tests pass (10 unit + 3 integration + 1 doctest).

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Step 2: Commit Track O1 (WAN test infrastructure)
```bash
# Review the code
cat crates/aafp-tests/tests/wan_test.rs
cat crates/aafp-tests/examples/wan_test_client.rs
cat crates/aafp-tests/examples/wan_test_server.rs
# Run tests
cargo test -p aafp-tests --test wan_test
# Commit
git add crates/aafp-tests/tests/wan_test.rs \
  crates/aafp-tests/examples/wan_test_client.rs \
  crates/aafp-tests/examples/wan_test_server.rs \
  crates/aafp-tests/Cargo.toml \
  scripts/ docs/
git commit -m "feat(o1): WAN test infrastructure — env-var-configurable harness (Track O1)

Implements wan_test.rs (configurable via AAFP_REMOTE_ADDR, AAFP_TEST_MODE,
AAFP_MSG_COUNT, AAFP_MSG_SIZE, AAFP_CONGESTION), wan_test_client/server
examples, shell scripts for two-machine testing, WAN_TESTING.md guide.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Step 3: Commit Track P2 (key directory)
```bash
# Review the code
cat crates/aafp-identity/src/key_directory.rs
# Run tests
cargo test -p aafp-identity
# Commit
git add crates/aafp-identity/src/key_directory.rs \
  crates/aafp-identity/src/lib.rs \
  crates/aafp-identity/Cargo.toml
git commit -m "feat(p2): key directory — lookup, publish, verify (Track P2)

Implements KeyDirectory with in-memory and SQLite backends, rate limiting
(1 publish/agent/hour per RFC 0011 §3.7), signature verification.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Step 4: Commit Track R1 (DHT router)
```bash
# Review the code
cat crates/aafp-discovery/src/dht_router.rs
# Run tests
cargo test -p aafp-discovery
# Commit
git add crates/aafp-discovery/src/dht_router.rs \
  crates/aafp-discovery/src/lib.rs \
  crates/aafp-discovery/Cargo.toml
git commit -m "feat(r1): multi-node DHT routing — Kademlia k-buckets (Track R1)

Implements RoutingTable with 256 k-buckets (k=20, XOR distance), DhtRouter
for iterative find_peers/announce, DhtTransport trait, PEX (Peer Exchange).

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### Step 5: Update umbrella submodule + commit STATUS.md
```bash
cd /Users/david/Projects/AAFP-research
git add implementations/rust
git commit -m "chore: update rust submodule — tracks O1, P2, R1, S1 (uncommitted work)"

# Update STATUS.md with completed steps
# (edit implementation-plans/STATUS.md to mark O1, P2, R1, S1 as [x])
git add implementation-plans/STATUS.md
git commit -m "docs: update STATUS.md — O1, P2, R1, S1 committed"
```

## AFTER committing: Continue with remaining steps

Once the uncommitted work is committed, continue with the remaining steps in
dependency order. Read the builder scripts for full details:

### Execution Order (Tracks N-S, 48 steps total)

```
Phase 5 (parallel — start immediately):
  Track N (NAT Traversal)      — N1-N8, 8 steps — BUILDER_SCRIPT_TRACK_N.txt
  Track P (Identity/PKI)       — P3-P8, 6 steps remaining — BUILDER_SCRIPT_TRACK_P.txt

Phase 6 (after N + P):
  Track O (WAN Testing)        — O2-O8, 7 steps remaining — BUILDER_SCRIPT_TRACK_O.txt
  Track Q (Security Audit)     — Q1-Q8, 8 steps — BUILDER_SCRIPT_TRACK_Q.txt
  Track S (Load & Ops)         — S2-S8, 7 steps remaining — BUILDER_SCRIPT_TRACK_S.txt

Phase 7 (after O):
  Track R (WAN Discovery)      — R2-R8, 7 steps remaining — BUILDER_SCRIPT_TRACK_R.txt
```

**Tracks N and P can start immediately in parallel.** N has no blockers. P
has P1 done and P2 committed (after step 3 above), so continue with P3.

**Tracks O, Q, S can start once N completes** (O and S need NAT traversal,
Q needs identity/PKI from P).

**Track R can start once O completes** (needs WAN test infrastructure).

## Plan Files (read before starting each track)

1. `implementation-plans/track-n-nat-traversal/N-nat-traversal.md`
2. `implementation-plans/track-o-wan-testing/O-wan-testing.md`
3. `implementation-plans/track-p-identity-pki/P-identity-pki.md`
4. `implementation-plans/track-q-security-audit/Q-security-audit.md`
5. `implementation-plans/track-r-wan-discovery/R-wan-discovery.md`
6. `implementation-plans/track-s-load-operations/S-load-operations.md`

## Builder Scripts (full context for each track)

1. `implementation-plans/BUILDER_SCRIPT_TRACK_N.txt` — NAT traversal
2. `implementation-plans/BUILDER_SCRIPT_TRACK_O.txt` — WAN testing
3. `implementation-plans/BUILDER_SCRIPT_TRACK_P.txt` — Identity/PKI
4. `implementation-plans/BUILDER_SCRIPT_TRACK_Q.txt` — Security audit
5. `implementation-plans/BUILDER_SCRIPT_TRACK_R.txt` — WAN discovery
6. `implementation-plans/BUILDER_SCRIPT_TRACK_S.txt` — Load testing

## Key Context Files (read first)

1. `implementation-plans/STATUS.md` — Current state of all tracks
2. `implementation-plans/CONTEXT.md` — Project background
3. `implementations/rust/AGENTS.md` — Build & test guide
4. `implementation-plans/WORLD_SCALE_RESEARCH.md` — Research on world-scale gaps
5. `RFCs/0011-hybrid-trust-model.md` — Trust model (for Track P)

## Quick Verification Commands

```bash
cd /Users/david/Projects/AAFP-research/implementations/rust
cargo fmt --all -- --check    # formatting
cargo build --workspace        # build (0 warnings)
cargo clippy --workspace       # lints (0 warnings)
cargo test --workspace         # 1324 tests, 0 failures
```

## Golden Rules (non-negotiable)

1. **NEVER skip verification.** A step is not done until VERIFY passes.
2. **NEVER mark a step complete unless it is actually complete.** Update STATUS.md.
3. **NEVER commit secrets, credentials, or `.env` files.**
4. **NEVER force-push or rewrite git history.**
5. **ALWAYS follow existing code conventions.** Read AGENTS.md.
6. **ALWAYS run `cargo fmt --all -- --check` and `cargo clippy --workspace` before committing.**
7. **ALWAYS update `STATUS.md` in the same commit as the work it tracks.**
8. **ALWAYS commit in the Rust submodule, then update the umbrella submodule pointer.**
9. **Commit and push after EACH step completes.** Not after every 3 steps. After EACH one.
10. **If a step is blocked, mark it BLOCKED in STATUS.md** and move to the next unblocked step.

## Submodule Workflow

```
/Users/david/Projects/AAFP-research/           <- umbrella repo
├── implementations/rust/                      <- submodule (github.com/davidnichols-ops/aafp)
└── implementations/go/                        <- submodule (github.com/davidnichols-ops/aafp-go)
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

Types: `feat`, `fix`, `test`, `docs`, `chore`, `refactor`, `perf`.

## When to Stop and Ask the User

Only stop and ask the user in these situations:
1. **Authentication failures:** If `git push` fails with permission denied.
2. **A plan references a file that doesn't exist** and you can't find it.
3. **You hit a blocker you can't resolve** after exhausting reasonable options.
4. **You believe a cryptographic constant or domain separator needs changing.**

For everything else, make a decision and proceed. You have full autonomy.

## Track N Summary (NAT Traversal — start here, no blockers)

The `aafp-nat` crate has stubs for relay, AutoNAT, and DCuTR. Make them real:
- **N1:** Relay data forwarding — forward real QUIC stream data through relay
- **N2:** AutoNAT dial-back — detect if agent is behind NAT by asking peers to dial back
- **N3:** DCuTR hole punching — replace stub with RTT-based sync hole punching
- **N4:** Relay discovery — find relay nodes via DHT capability `aafp.relay`
- **N5:** SDK integration — automatic relay fallback when direct connection fails
- **N6:** NAT test harness — 4 NAT scenarios (full-cone, restricted, port-restricted, symmetric)
- **N7:** Two-machine relay test — real cross-NAT validation (needs 2 machines or VMs)
- **N8:** Relay performance — capacity testing (concurrent relayed connections)

Read `BUILDER_SCRIPT_TRACK_N.txt` for full details.

## Track P Summary (Identity/PKI — P1 done, P2 committed, continue P3-P8)

- **P3:** Web of Trust — peer key signing, transitive trust chains
- **P4:** CA-based certificates — ML-DSA-65 signed CA certs
- **P5:** Key rotation — old key signs new key for seamless transitions
- **P6:** Networked revocation — gossip-based CRL distribution
- **P7:** TrustManager API — combine key directory + WoT + CA + revocation
- **P8:** End-to-end trust scenarios — 8 test scenarios

Read `BUILDER_SCRIPT_TRACK_P.txt` for full details.

## Research Findings (from WORLD_SCALE_RESEARCH.md)

Key findings that should inform implementation:

1. **DCUtR success rate:** 70% ± 7.1% for hole punching (from 4.4M attempts in IPFS).
   TCP and QUIC have comparable success rates. 97.6% of successes on first attempt.
   AAFP should target 70% hole-punch + 20% relay fallback = 90% success.

2. **PQ crypto at scale:** ML-DSA-65 verify = 76-103µs (9.7K-13K/sec per core).
   Add signature verification cache (90% hit rate → 90% CPU reduction).
   Cache MLDsaPublicKey objects (parsing from bytes is expensive).

3. **DHT at scale:** IPFS uses k=20 bucket size, 256-bit keyspace, client/server mode.
   Add undialable peer diagnosis (IPFS v0.5.0 pattern). Optimistic Provide for
   sub-second record storage. Adaptive refresh intervals based on churn.

4. **Kernel bypass:** XDP/AF_XDP gives 2-3x throughput (s2n-quic, Solana Afterburner).
   io_uring zero-copy RX gives 41% improvement over epoll. DPDK gives 21.6x but
   needs dedicated hardware. For now: standard sockets are fine, plan XDP for later.

5. **Congestion control:** BBRv3 is unfair to Cubic (can grab 99% bandwidth).
   For agent-to-agent RPC (small messages): use Cubic (fair, responsive).
   For relay forwarding (bulk transfer): use BBR (high throughput).
   Change default from BBR to Cubic for agent-to-agent.

6. **Resilience patterns:** Circuit breaker (5 failures → open, 30s → half-open).
   Bulkhead (limit concurrent requests per peer to 10). Per-operation timeouts.
   Retry with exponential backoff + jitter (max 3 retries).

7. **World-scale architecture:** Separate Gateway (connection plane) from Router
   (coordination) from Agent (app logic). Discord pattern: 15K sessions per relay.
   WhatsApp pattern: 2M connections per server. Kafka for decoupling. Redis for
   ephemeral state. ScyllaDB for persistence (p99 read: 15ms, write: 5ms).

These findings are documented in detail in `implementation-plans/WORLD_SCALE_RESEARCH.md`.
