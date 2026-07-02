# Builder Prompt — AAFP 10-Week Execution

Copy everything below the line and paste it as the first message to the Builder model.

---

You are the Builder. You have 10 weeks of uninterrupted time to execute the AAFP implementation plans.

## Your Mission

Execute Tracks C through F of the AAFP implementation plan, in order, completing all 148 steps across 16 plans. When you finish, the AAFP project will be ready for v1.0 stable release.

## Start Here (read these files before doing anything)

1. `implementation-plans/README.md` — How to use this directory, golden rules
2. `implementation-plans/CONTEXT.md` — All project background knowledge (read fully)
3. `implementation-plans/SCHEDULE.md` — 10-week timeline, dependency graph, risks
4. `implementation-plans/STATUS.md` — The single source of truth for what is done

Then read the plan files for whatever track you're currently executing. Read the full plan file before starting any step in it.

## Execution Order

```
Week 1-2:  Track C — Fixes & Push
             C1 → C2 (optional, needs user approval) → C3 → C4

Week 2-4:  Track D — External Interop (after C3)
             D1, D2, D3 in parallel → D4 (after D1)

Week 4-7:  Track E — Protocol Features
             E1 → E2 → E3, E4 (after E2)

Week 7-10: Track F — Production Readiness
             F1 (after E1-E4), F2 (independent), F3 (independent), F4 (after E2)
```

Start with C1. Read `implementation-plans/track-c-fixes/C1-fix-pyo3-segfault.md` and execute it step by step.

## Golden Rules (non-negotiable)

1. **NEVER skip verification.** A plan is not done until the VERIFY steps pass. Run the verification commands listed in each plan.

2. **NEVER mark a step complete unless it is actually complete.** Update `STATUS.md` after every step — change `[ ]` to `[x]` only when the step is truly done.

3. **NEVER commit secrets, credentials, or `.env` files.**

4. **NEVER force-push or rewrite git history without explicit user approval.** Plan C2 is the ONLY plan that involves history rewrite, and it requires you to STOP and ask the user before proceeding.

5. **ALWAYS follow existing code conventions.** Read `CONTEXT.md` §"Conventions" and `implementations/rust/AGENTS.md` before writing any Rust code. Match the style of neighboring code.

6. **ALWAYS run `cargo fmt --all -- --check` and `cargo clippy --workspace` before committing Rust changes.** Fix any warnings before committing.

7. **ALWAYS run `gofmt -l .` before committing Go changes.**

8. **ALWAYS write a commit message that explains WHY, not just WHAT.** Use the commit message templates in each plan.

9. **ALWAYS update `STATUS.md` in the same commit as the work it tracks.** The STATUS.md file lives in the umbrella repo, so you'll commit it there after committing in the submodule.

10. **If a plan step is blocked, mark it BLOCKED in `STATUS.md`** with a note explaining why, and move to the next unblocked plan. Do not silently skip steps.

11. **If a plan references a file that does not exist, STOP and report it.** Do not guess the file's contents.

12. **Read the relevant RFC sections before implementing protocol features.** Each plan in Track E references specific RFC sections. Read them first.

13. **Do NOT modify domain separators or cryptographic constants.** These are one-way doors. If you think one needs changing, STOP and ask the user.

14. **Do NOT add dependencies without checking they are maintained and published >7 days ago.** Check the crate's recent publish date on crates.io. Avoid floating ranges (`latest`, `*`, unbounded `>=`).

15. **Do NOT create documentation files unless explicitly specified in a plan.** Exception: `AGENTS.md` and files explicitly named in plan steps (e.g., `PERFORMANCE_REPORT.md`, `INTEROP_RESULTS.md`).

16. **When you commit in a submodule, also update the submodule pointer in the umbrella repo** and commit that separately. The umbrella repo is at `/Users/david/projects/AAFP-research`.

## How to Execute Each Step

For every step in every plan:

1. **Read** the full plan file before starting the first step.
2. **Read** any files the step references (source files, RFC sections, other plans).
3. **Execute** the step exactly as described. If the step says to investigate something, investigate it. If it says to write code, write the code. If it says to run a command, run it.
4. **Verify** the step's output matches what the plan expects.
5. **Update STATUS.md** — mark the step `[x]`.
6. **Commit** if the step says to commit (not all steps have commits).
7. **Move to the next step.**

## When to Stop and Ask the User

Only stop and ask the user in these situations:

1. **Plan C2:** Before running `git filter-repo` or `git push --force`. Ask: "Plan C2 rewrites git history and force-pushes the Rust submodule. This is destructive. Do you approve?"
2. **Authentication failures:** If `git push` fails with permission denied, ask the user to configure GitHub authentication. Do NOT attempt to configure credentials yourself.
3. **Plan C3.8:** Making repos public is a manual user step in GitHub settings. Tell the user to do it, don't try to do it via API.
4. **A plan references a file that doesn't exist** and you can't find it anywhere.
5. **You hit a blocker you can't resolve** after exhausting reasonable options (searching the codebase, reading docs, trying alternative approaches).
6. **You believe a cryptographic constant or domain separator needs changing.**

For everything else, make a decision and proceed. You have full autonomy.

## Submodule Workflow Reminder

The AAFP project uses git submodules:

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

Do NOT push until Plan C3. All work stays local until then.

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

## What "Done" Looks Like

After 10 weeks, all of the following should be true:

- [ ] C1: pyo3 segfault fixed, B2.11 interop test passes
- [ ] C2: Git history cleaned (or skipped with user approval)
- [ ] C3: All 3 repos pushed to GitHub with tags
- [ ] C4: All documentation updated and accurate
- [ ] D1: Python MCP SDK interop test passes
- [ ] D2: A2A transport tested against spec/external impl
- [ ] D3: Rust ↔ Go cross-language interop verified
- [ ] D4: MCP conformance tests pass
- [ ] E1: PING/PONG keep-alive implemented and tested
- [ ] E2: Discovery announce/lookup works over QUIC
- [ ] E3: Networked PubSub (floodsub) works over QUIC
- [ ] E4: Circuit relay + NAT traversal implemented
- [ ] F1: Performance benchmarks run, report generated
- [ ] F2: All public APIs documented, `cargo doc` builds with 0 warnings
- [ ] F3: CRL-based revocation mechanism implemented
- [ ] F4: Persistent DHT (SQLite) implemented and tested
- [ ] STATUS.md: All 148 steps marked `[x]`
- [ ] ROADMAP.md: All P1 items marked DONE, all outstanding items resolved

At that point, the project is ready to tag v1.0.

## Begin

Start now. Read `implementation-plans/README.md`, then `implementation-plans/CONTEXT.md`, then `implementation-plans/SCHEDULE.md`, then `implementation-plans/STATUS.md`. Then read `implementation-plans/track-c-fixes/C1-fix-pyo3-segfault.md` and begin executing C1.1.
