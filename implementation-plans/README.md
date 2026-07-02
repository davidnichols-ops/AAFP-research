# AAFP Implementation Plans

**Purpose:** This directory contains hyper-detailed, trackable implementation
plans for the AAFP (Agent-Agent First Networking Protocol) project. These plans
are written for execution by an autonomous coding model (GLM 5.2 High).

**How to use this directory:**
1. Read `CONTEXT.md` first — it contains all background knowledge needed.
2. Read `STATUS.md` — it is the single source of truth for what is done.
3. Pick the next incomplete plan (lowest number, highest priority).
4. Follow the plan exactly. Check off steps in `STATUS.md` as you complete them.
5. Run verification commands before marking a plan complete.
6. Update `STATUS.md` after every step.

**Golden rules for the executing model:**
- NEVER skip verification. A plan is not done until verification passes.
- NEVER mark a step complete unless it is actually complete.
- NEVER commit secrets, credentials, or `.env` files.
- NEVER force-push or rewrite git history without explicit user approval.
- ALWAYS follow existing code conventions (see `CONTEXT.md` §"Conventions").
- ALWAYS run `cargo fmt --all -- --check` and `cargo clippy --workspace` before
  committing Rust changes.
- ALWAYS run `gofmt -l .` before committing Go changes.
- ALWAYS write a commit message that explains WHY, not just WHAT.
- ALWAYS update `STATUS.md` in the same commit as the work it tracks.
- If a plan step is blocked, mark it BLOCKED in `STATUS.md` with a note, and
  move to the next unblocked plan. Do not silently skip steps.
- If a plan references a file that does not exist, STOP and report it. Do not
  guess the file's contents.

**Directory structure:**
```
implementation-plans/
├── README.md                          This file
├── BUILDER_PROMPT.md                  Copy-paste prompt to start the Builder
├── CONTEXT.md                         All background knowledge (read first)
├── STATUS.md                          Trackable status board (update continuously)
├── SCHEDULE.md                        10-week execution schedule + dependency graph
├── track-a-hygiene/                   [COMPLETE] Production hygiene fixes
│   ├── A1-remove-build-artifacts.md
│   ├── A2-fix-ci-workflows.md
│   └── A3-release-tags-rfc-headers.md
├── track-b-strategic/                 [COMPLETE] New transport bindings
│   ├── B1-a2a-transport-binding.md
│   ├── B2-python-pyo3-adapter.md
│   └── B3-extract-establish-session.md
├── track-c-fixes/                     [WEEK 1-2] Fixes & push to remote
│   ├── C1-fix-pyo3-segfault.md        Fix pyo3 cleanup crash + B2.11 interop test
│   ├── C2-clean-git-history.md        Remove 910MB from git history (NEEDS APPROVAL)
│   ├── C3-push-to-remote.md           Push all 3 repos + tags to GitHub
│   └── C4-update-stale-docs.md        Update ROADMAP.md, checklist, stale status
├── track-d-interop/                   [WEEK 2-4] External interop testing
│   ├── D1-python-mcp-sdk-interop.md   Test against real Python MCP SDK
│   ├── D2-a2a-reference-interop.md    Test against A2A reference implementation
│   ├── D3-rust-go-cross-interop.md    Rust↔Go cross-language QUIC interop
│   └── D4-mcp-conformance-suite.md    MCP conformance suite integration
├── track-e-protocol/                  [WEEK 4-7] Protocol features (P1 items)
│   ├── E1-ping-pong-keepalive.md      PING/PONG keep-alive (RFC-0002 §4.7-4.8)
│   ├── E2-discovery-over-quic.md      Discovery announce/lookup over QUIC (RFC-0004)
│   ├── E3-networked-pubsub.md         Gossipsub over QUIC streams
│   └── E4-relay-nat-traversal.md      Circuit relay v2 + DCUtR (P1-8)
└── track-f-production/                [WEEK 7-10] Production readiness
    ├── F1-performance-validation.md   Benchmark framework + validate targets (P1-5)
    ├── F2-rustdoc-documentation.md    Document all public APIs (P1-7)
    ├── F3-revocation-mechanism.md     CRL-based revocation (RFC-0003 amendment)
    └── F4-persistent-dht.md           Persistent DHT backend (LevelDB/SQLite)
```

**Track descriptions:**
- **Track A (Hygiene) [COMPLETE]:** Fixed production-blockers from POST_PUSH_AUDIT.md.
- **Track B (Strategic) [COMPLETE]:** Built MCP + A2A transport bindings, Python adapter.
- **Track C (Fixes & Push) [WEEK 1-2]:** Fixes the pyo3 segfault, cleans git history
  (with user approval), pushes all repos to GitHub, updates stale documentation.
  This unblocks external interop testing (Track D).
- **Track D (External Interop) [WEEK 2-4]:** Proves AAFP works with real external
  MCP/A2A software — not just our own implementations. This is the last remaining
  release criterion ("Independent third-party interop testing: NOT DONE").
- **Track E (Protocol Features) [WEEK 4-7]:** Implements the "Should Complete Before
  Public Release" items from ROADMAP.md: PING/PONG keep-alive, discovery over QUIC,
  networked PubSub, and relay/NAT traversal. After these, the protocol has all core
  v1.0 features.
- **Track F (Production Readiness) [WEEK 7-10]:** Closes all remaining ROADMAP.md
  items: performance validation, Rustdoc documentation, revocation mechanism, and
  persistent DHT. After these, the project is ready for v1.0 stable release.

**Execution order:**
```
Tracks A, B: COMPLETE (69/70 steps done)

Week 1-2:  C1 → C2 (optional) → C3 → C4
Week 2-4:  D1, D2, D3, D4 (after C3 push)
Week 4-7:  E1 → E2 → E3, E4 (after E2)
Week 7-10: F1 (after E1-E4), F2, F3, F4 (after E2)
```

See `SCHEDULE.md` for the full 10-week timeline, dependency graph, and risk register.

**Repository layout reminder:**
- Umbrella repo: `/Users/david/projects/AAFP-research` (RFCs, docs, submodules)
- Rust impl: `implementations/rust/` (git submodule → github.com/davidnichols-ops/aafp)
- Go impl: `implementations/go/` (git submodule → github.com/davidnichols-ops/aafp-go)

When you commit in a submodule, you must also update the submodule pointer in
the umbrella repo and commit that separately.
