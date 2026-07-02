# Builder Continuation Prompt — Resume from D1

Copy everything below the line and paste it as the first message to the Builder model.

---

You are the Builder. You are resuming execution of the AAFP implementation plans. Track C is complete. You are starting Track D (External Interop), beginning with D1.

## Current Progress

- **Tracks A, B:** COMPLETE (69/70 steps)
- **Track C:** COMPLETE (37/37 steps)
  - C1: pyo3 segfault fixed (dedicated tokio runtime + async shutdown draining quinn tasks), B2.11 interop test written
  - C2: Git history cleaned — packfile 583MB → 1.3MB, force-pushed with tags preserved
  - C3: All 3 repos pushed to GitHub, public, fresh clone 12MB
  - C4: 6 documentation files updated
- **Track D:** NOT STARTED — you are starting this now
- **Tracks E, F:** NOT STARTED

**Total: 106/218 steps complete (49%)**

## What Changed Since You Last Ran

1. **Test results infrastructure added.** A `test-results/` directory now exists in the umbrella repo with:
   - `generate_dashboard.py` — generates a modern HTML dashboard from JSON results
   - `run_all_tests.py` — runs all test suites and writes JSON results
   - `dashboards/index.html` — auto-generated dashboard (open in browser)
   - `interop/`, `performance/`, `conformance/`, `unit/` — JSON result subdirectories

2. **D1-D4 plans updated.** Each interop test plan now includes a step to write JSON results to `test-results/interop/` and regenerate the dashboard. Read the updated plans before executing.

3. **F1 plan updated.** Performance benchmarks now write JSON results to `test-results/performance/`.

4. **BUILD.md created.** A comprehensive build guide exists at the repo root with full instructions for building, testing, and benchmarking from a fresh clone. Read it if you need build help.

5. **All repos are public on GitHub.** No authentication needed for cloning. Push access requires the user's credentials.

## Start Here (read these files before doing anything)

1. `implementation-plans/STATUS.md` — Check current state (C1-C4 are COMPLETE, D1 is next)
2. `implementation-plans/CONTEXT.md` — All project background knowledge
3. `implementation-plans/SCHEDULE.md` — 10-week timeline, dependency graph
4. `BUILD.md` — Complete build & test instructions (new — read if you need build help)
5. `test-results/README.md` — Test results infrastructure documentation (new)

Then read the plan files for Track D:
6. `implementation-plans/track-d-interop/D1-python-mcp-sdk-interop.md` — START HERE
7. `implementation-plans/track-d-interop/D2-a2a-reference-interop.md`
8. `implementation-plans/track-d-interop/D3-rust-go-cross-interop.md`
9. `implementation-plans/track-d-interop/D4-mcp-conformance-suite.md`

## Execution Order

```
NOW:       D1 — Test against real Python MCP SDK
THEN:      D2 — Test against A2A reference implementation (can run parallel with D3)
THEN:      D3 — Rust ↔ Go cross-language interop (can run parallel with D2)
THEN:      D4 — MCP conformance suite (after D1)

Week 4-7:  Track E — Protocol Features
             E1 → E2 → E3, E4 (after E2)

Week 7-10: Track F — Production Readiness
             F1 (after E1-E4), F2 (independent), F3 (independent), F4 (after E2)
```

Start with D1. Read `implementation-plans/track-d-interop/D1-python-mcp-sdk-interop.md` and execute it step by step.

## Golden Rules (non-negotiable)

1. **NEVER skip verification.** A plan is not done until the VERIFY steps pass.
2. **NEVER mark a step complete unless it is actually complete.** Update `STATUS.md` after every step.
3. **NEVER commit secrets, credentials, or `.env` files.**
4. **NEVER force-push or rewrite git history.** (C2 was already done with user approval — no more history rewrites needed.)
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

## Test Results Workflow (NEW — important)

Every test plan (D1-D4, F1) now includes a step to write JSON results to the `test-results/` directory. The workflow is:

1. **Run the test** (as described in the plan)
2. **Write a JSON result file** to the appropriate subdirectory:
   - Interop tests → `test-results/interop/<test-name>.json`
   - Performance benchmarks → `test-results/performance/<bench-name>.json`
   - Conformance tests → `test-results/conformance/<suite-name>.json`
   - Unit tests → `test-results/unit/<suite-name>.json`
3. **Regenerate the dashboard:**
   ```bash
   cd /Users/david/projects/AAFP-research
   python3 test-results/generate_dashboard.py
   ```
4. **Commit the results:**
   ```bash
   git add test-results/
   git commit -m "test: update test results dashboard — <test name>"
   ```

The JSON schema is documented in `test-results/README.md`. Each result file must include:
- `test_name`, `test_category`, `timestamp`
- `environment` (os, cpu, rust_version, aafp_version, commit)
- `status` ("pass", "fail", "skip", "error")
- `duration_ms`
- `summary`
- `details` (array of step-by-step results)
- `metrics` (object with numeric metrics)

The dashboard at `test-results/dashboards/index.html` is a modern, dark-themed single-page app that shows:
- Summary cards per category (interop, performance, conformance, unit)
- Interop test matrix with pass/fail icons
- Performance benchmark bar charts
- Conformance test tables
- Unit test tables with pass/fail/ignored counts
- Environment info and commit SHAs for reproducibility

**Anyone should be able to run the tests and see results.** After you finish all tests, the dashboard should give a complete picture of AAFP's test coverage.

## Submodule Workflow Reminder

```
/Users/david/projects/AAFP-research/              ← umbrella repo
├── implementations/rust/                         ← submodule (github.com/davidnichols-ops/aafp)
└── implementations/go/                           ← submodule (github.com/davidnichols-ops/aafp-go)
```

When you commit in a submodule:
```bash
cd implementations/rust
git add -A
git commit -m "..."
# Then update the umbrella:
cd /Users/david/projects/AAFP-research
git add implementations/rust
git commit -m "chore: update rust submodule — <brief description>"
```

**All repos are now pushed to GitHub and public.** When you commit, you CAN push (unlike before C3). Push after each plan completes:
```bash
# Push submodules first
cd implementations/rust && git push origin master
cd implementations/go && git push origin master
# Then push umbrella
cd /Users/david/projects/AAFP-research && git push origin master
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
cd /Users/david/projects/AAFP-research/implementations/rust
cargo fmt --all -- --check
cargo build --workspace
cargo clippy --workspace
cargo test --workspace
```

Before committing Go changes:
```bash
cd /Users/david/projects/AAFP-research/implementations/go
gofmt -l .
go vet ./...
go test ./...
```

Run all tests + generate dashboard:
```bash
cd /Users/david/projects/AAFP-research
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

For everything else, make a decision and proceed. You have full autonomy.

## What "Done" Looks Like for Track D

- [ ] D1: Python MCP SDK interop test passes, JSON result written to test-results/interop/
- [ ] D2: A2A transport tested against spec/external impl, JSON result written
- [ ] D3: Rust ↔ Go cross-language interop verified, JSON result written
- [ ] D4: MCP conformance tests pass, JSON result written to test-results/conformance/
- [ ] Dashboard regenerated and shows all interop/conformance results
- [ ] STATUS.md: All D1-D4 steps marked [x]
- [ ] All changes pushed to GitHub

## Begin

Start now. Read `implementation-plans/STATUS.md` to confirm current state. Then read `implementation-plans/track-d-interop/D1-python-mcp-sdk-interop.md` and begin executing D1.1.

The first thing D1 asks you to do is install and inspect the real Python MCP SDK's Transport interface. Do that before writing any adapter code. The adapter must match the real SDK, not assumptions.
