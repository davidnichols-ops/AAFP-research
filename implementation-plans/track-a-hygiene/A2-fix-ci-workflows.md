# Plan A2: Fix CI Workflows

**Priority:** CRITICAL
**Track:** A (Hygiene)
**Estimated effort:** 30 minutes
**Blocked by:** nothing (can run parallel to A1)
**Blocks:** A3 (CI should be green before tagging)

---

## Problem

Both CI workflows (`.github/workflows/rust-ci.yml` and `.github/workflows/go-ci.yml`)
will fail on first run due to three issues:

1. **Submodule not initialized:** `actions/checkout@v4` does not init submodules
   by default. `implementations/rust` and `implementations/go` will be empty
   directories. Every job that uses `working-directory: implementations/rust`
   or `implementations/go` will fail.

2. **Clippy will fail:** `cargo clippy --workspace -- -D warnings` fails on 2
   pre-existing warnings in `aafp-messaging/src/pipeline.rs`:
   - "this if has identical blocks" (line ~551)
   - "this if statement can be collapsed"

3. **gofmt will fail:** 15 Go files need formatting (Go 1.19+ gofmt reformats
   comment indentation). The files are:
   - `cbor/cbor.go`
   - `closemanager/differential_test.go`
   - `closemanager/property_test.go`
   - `errors/errors.go`
   - `frame/frame.go`
   - `frame/frame_test.go`
   - `frameext/frameext.go`
   - `goldentrace/goldentrace_test.go`
   - `identity/identity.go`
   - `interop/interop_test.go`
   - `pipeline/differential_test.go`
   - `pipeline/pipeline.go`
   - `pipeline/pipeline_test.go`
   - `racestress/racestress_test.go`
   - `versionneg/versionneg_test.go`

**Source:** POST_PUSH_AUDIT.md §8 "CI Assessment"

---

## Prerequisites

- Working directory: `/Users/david/projects/AAFP-research`
- Both submodules initialized
- Read the current workflow files before modifying:
  - `.github/workflows/rust-ci.yml`
  - `.github/workflows/go-ci.yml`

---

## Steps

### A2.1: Fix submodule init in rust-ci.yml

Read `.github/workflows/rust-ci.yml`. Find every `actions/checkout@v4` step.
Add `with: submodules: true` to each:

```yaml
- uses: actions/checkout@v4
  with:
    submodules: true
```

If there are multiple checkout steps (e.g., one per job), add it to ALL of them.

### A2.2: Fix submodule init in go-ci.yml

Read `.github/workflows/go-ci.yml`. Same fix as A2.1 — add `with: submodules: true`
to every `actions/checkout@v4` step.

### A2.3: Fix clippy warnings in pipeline.rs

Read `implementations/rust/crates/aafp-messaging/src/pipeline.rs` around line 551.

The two warnings are:
1. `clippy::if_same_then_else` — "this if has identical blocks"
2. `clippy::collapsible_if` — "this if statement can be collapsed"

**Preferred fix:** Examine the code. If the identical blocks are genuinely
identical (copy-paste error), merge them. If the if can be collapsed, collapse it.

**Fallback fix:** If the duplication is intentional (e.g., for clarity or
future divergence), add a targeted allow attribute with a comment:
```rust
#[allow(clippy::if_same_then_else, clippy::collapsible_if)]  // intentional: <reason>
```

**Do NOT add a crate-wide `#![allow(clippy::...)]`** — that silences the lint
everywhere. Use targeted allows only.

After fixing, verify locally:
```bash
cd /Users/david/projects/AAFP-research/implementations/rust
cargo clippy --workspace -- -D warnings
```
**Expected:** 0 warnings.

If other warnings appear (beyond these 2), fix them too. The goal is
`cargo clippy --workspace -- -D warnings` exits 0.

### A2.4: Fix gofmt in Go submodule

```bash
cd /Users/david/projects/AAFP-research/implementations/go
gofmt -w .
```

This reformats all Go files. Verify:
```bash
gofmt -l .
```
**Expected:** No files listed (empty output).

Commit in the Go submodule:
```bash
git add -A
git commit -m "$(cat <<'EOF'
style: gofmt all Go files

Go 1.19+ gofmt reformats comment indentation. 15 files needed formatting
to pass the gofmt CI check.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

### A2.5: Update umbrella Go submodule pointer

```bash
cd /Users/david/projects/AAFP-research
git add implementations/go
git commit -m "$(cat <<'EOF'
chore: update go submodule — gofmt all files

Updates the go submodule pointer to the gofmt commit. Required for the
gofmt CI check to pass.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

### A2.6: Add Go module caching to go-ci.yml

Read `.github/workflows/go-ci.yml`. Add a cache step before the build/test jobs:

```yaml
- uses: actions/cache@v4
  with:
    path: |
      ~/.cache/go-build
      ~/go/pkg/mod
    key: ${{ runner.os }}-go-${{ hashFiles('**/go.sum') }}
    restore-keys: |
      ${{ runner.os }}-go-
```

Place this after the checkout step but before any `go build` or `go test` step.

### A2.7: Commit CI fixes in umbrella repo

The rust-ci.yml and go-ci.yml changes (A2.1, A2.2, A2.6) plus the pipeline.rs
fix (A2.3) need to be committed. The pipeline.rs fix is in the Rust submodule,
so commit there first:

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add crates/aafp-messaging/src/pipeline.rs
git commit -m "$(cat <<'EOF'
fix: resolve clippy warnings in pipeline.rs

Fixes two pre-existing clippy warnings that would fail CI with -D warnings:
- if_same_then_else (identical blocks)
- collapsible_if (collapsible if statement)

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

Update umbrella submodule pointer + commit CI workflow changes:
```bash
cd /Users/david/projects/AAFP-research
git add implementations/rust .github/workflows/rust-ci.yml .github/workflows/go-ci.yml
git commit -m "$(cat <<'EOF'
ci: fix submodule init, add Go module cache, resolve clippy

- Add submodules: true to all checkout steps (both workflows)
- Add Go module caching to go-ci.yml
- Update rust submodule for clippy fixes in pipeline.rs

These fixes are required for CI to pass on first run.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

---

## Verification

### A2.8: Clippy clean

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
cargo clippy --workspace -- -D warnings
```
**Expected:** Exit code 0, 0 warnings.

### A2.9: gofmt clean

```bash
cd /Users/david/projects/AAFP-research/implementations/go
gofmt -l .
```
**Expected:** Empty output (no files need formatting).

### A2.10: CI reaches test step

Push to a branch (do NOT push to master):
```bash
cd /Users/david/projects/AAFP-research
git push origin master:ci-test-branch
```
Or create a PR. Check GitHub Actions — the jobs should reach the test step
rather than failing on checkout. If you cannot push or check GitHub Actions,
verify locally that the YAML is valid:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/rust-ci.yml')); print('rust-ci.yml valid')"
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/go-ci.yml')); print('go-ci.yml valid')"
```

---

## Risks & Notes

- The clippy fix in pipeline.rs requires reading the code to understand the
  intent. Do not blindly merge if blocks — verify the logic is equivalent.
- If there are MORE than 2 clippy warnings (the audit found 2, but new ones
  may have appeared), fix all of them. The goal is zero warnings with `-D warnings`.
- Do NOT change CI to `-W warnings` as a workaround. Fix the actual warnings.
- The `git push origin master:ci-test-branch` in A2.10 is for verification only.
  Do NOT merge this branch. Delete it after verification if possible.

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark A2.1 through A2.10 as `[x]`
- Set A2 status to `COMPLETE`
- Note any additional clippy warnings found and fixed
