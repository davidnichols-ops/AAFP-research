# Post-Push Audit Report

**Date**: 2026-06-30
**Auditor**: Independent verification from fresh clone
**Method**: All verification performed from `git clone` of remote state, not local working tree

---

## 1. Commit Verification

### All 9 commits verified present on `origin/master`

#### Rust (`davidnichols-ops/aafp`)

| SHA | Message | Files | Status |
|-----|---------|-------|--------|
| `fda2cd5` | feat: A-7 through A-10 protocol amendments and ML-DSA-65 interop | 102 files, +14608/-1075 | ✅ On origin/master |
| `773bb94` | chore: remove .DS_Store, duplicate rfcs/, add AGENTS.md and golden traces | 47 files, +1393/-11040 | ✅ On origin/master |

- No accidental changes detected in `fda2cd5` — all added files are `.rs`, `.toml`, or `.json`
- `773bb94` deletes 4 `.DS_Store` files, 15 duplicate RFC files, adds 8 golden trace directories (trace.bin files 48 bytes to 14 KB), adds `AGENTS.md`
- No large binary additions

#### Go (`davidnichols-ops/aafp-go`)

| SHA | Message | Files | Status |
|-----|---------|-------|--------|
| `89ae475` | feat: A-6 through A-10 protocol amendments and ML-DSA-65 interop | 119 files, +9488/-33 | ✅ On origin/master |
| `e6e4af6` | fix: remove hardcoded path from goldentrace test | 1 file, +64/-10 | ✅ On origin/master |
| `5b4bd01` | feat: add ML-DSA-65 Go package for cross-language interop (A-10) | 10 files, +1973 | ✅ On origin/master |

- `89ae475` adds 100+ binary fixture files (`.bin`) — these are intentional test fixtures for interop testing (each <6 KB)
- `e6e4af6` is a targeted fix removing a hardcoded `/Users/david/` path
- `5b4bd01` adds the `mldsa/` package (10 Go files)

#### Main (`davidnichols-ops/AAFP-research`)

| SHA | Message | Files | Status |
|-----|---------|-------|--------|
| `33e62c1` | ci: add GitHub Actions workflows for Rust and Go | 2 files, +170 | ✅ On origin/master |
| `989fd28` | docs: fix test counts, amendment status, and byte count | 4 files, +196/-79 | ✅ On origin/master |
| `e6ff121` | docs: add RC-1 readiness report, completion reports, and test vectors | 17 files, +6279/-4 | ✅ On origin/master |
| `12f9a8f` | chore: update submodules for A-7 through A-10 | 2 files (submodule refs) | ✅ On origin/master |

- All main repo commits are documentation, CI config, or submodule pointer updates — no code changes
- Test vector files in `e6ff121` are JSON (491 KB, 285 KB, 1 MB, 1 MB) — intentional artifacts

### Commit Audit Summary

All 9 commits are present on their expected branches. No accidental changes, no unexpected binary additions, no secrets. Commit messages are descriptive and follow conventional commit format.

---

## 2. Fresh Clone Verification

### Clone with `--recurse-submodules`

```
git clone --recurse-submodules https://github.com/davidnichols-ops/AAFP-research.git
```

**Result: SUCCESS**

- Main repo checked out at `12f9a8f`
- Rust submodule checked out at `773bb94`
- Go submodule checked out at `5b4bd01`
- No missing objects
- No manual intervention required

### Clone without `--recurse-submodules` + manual init

```
git clone https://github.com/davidnichols-ops/AAFP-research.git
git submodule update --init --recursive
```

**Result: SUCCESS**

Both methods produce identical state.

---

## 3. Build Verification

### Environment

| Component | Version |
|-----------|---------|
| OS | macOS 26.5.1 (Darwin 25.5.0) |
| Arch | arm64 (Apple M4) |
| Rust | 1.96.0 (2026-05-25) |
| Cargo | 1.96.0 (2026-05-25) |
| Go | 1.26.4 darwin/arm64 |

### Rust (from fresh clone)

| Check | Result | Time |
|-------|--------|------|
| `cargo fmt --all -- --check` | ✅ PASS (0 diffs) | <1s |
| `cargo build --workspace` | ✅ PASS | 21.65s |
| `cargo test --workspace` | ✅ PASS — 995 tests, 0 failures | ~300s |
| `cargo clippy --workspace` | ⚠️ 2 warnings in `aafp-messaging/src/pipeline.rs` | ~15s |

**Clippy warnings (pre-existing):**
1. `this if has identical blocks` — pipeline.rs:551
2. `this if statement can be collapsed` — pipeline.rs

These are pre-existing and not introduced by the pushed commits.

### Go (from fresh clone)

| Check | Result | Time |
|-------|--------|------|
| `go vet ./...` | ✅ PASS | <1s |
| `go build ./...` | ✅ PASS | <1s |
| `go test ./... -count=1` | ✅ PASS — 664 tests, 0 failures, 13 packages | ~30s |
| `gofmt -l .` | ❌ **FAIL — 15 files need formatting** | <1s |

**Go formatting failure — 15 files need `gofmt`:**
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

The formatting differences are comment indentation style changes (Go 1.19+ gofmt reformats comment lists). These files were likely written with a different gofmt version or without gofmt applied.

---

## 4. Repository Health

### Clean

| Check | Result |
|-------|--------|
| `.DS_Store` files | ✅ None found in fresh clone |
| Merge markers (`<<<<<<<`, `>>>>>>>`) | ✅ None found |
| Secrets/API keys | ✅ None found |
| Conflict remnants | ✅ None found |

### Issues Found

#### CRITICAL: 4,782 build artifacts committed to Rust submodule

**`fuzz/target/` directory is tracked in git** despite being a build artifact directory.

- **4,782 tracked files** in `fuzz/target/`
- **910 MB** of git objects for this directory alone
- The `.gitignore` at repo root has `/target` but not `fuzz/target/`
- The `fuzz/.gitignore` has `target/` but the files were committed before it was added
- This bloats the repository significantly and will slow down every clone

**Impact**: Every `git clone` of the Rust submodule downloads 910 MB of build artifacts that are completely useless. A fresh clone of the full repo with submodules takes significantly longer than necessary.

#### MEDIUM: User-specific paths in committed files

| File | Path | Severity |
|------|------|----------|
| `architecture/AAFP_Implementation_Prompt.md` | 8 instances of `/Users/david/AAFP-research/...` | LOW (historical design doc) |
| `implementations/rust/PHASE3_STATE.md` | 3 instances | LOW (historical status doc) |
| `implementations/rust/INTEROP-0001.md` | 2 instances | LOW (historical status doc) |
| `implementations/rust/supply_chain/cargo-audit.txt` | 1 instance (`/Users/david/.cargo/advisory-db`) | LOW (generated artifact) |
| `implementations/rust/fuzz/target/` | Multiple instances in build artifacts | MOOT (should not be tracked at all) |

These are all in historical documentation or generated artifacts, not in active code. The Go test hardcoded path was already fixed in commit `e6e4af6`.

#### LOW: `target/` directory exists on disk after build

The root `target/` is correctly in `.gitignore` and not tracked. Only `fuzz/target/` is the problem.

---

## 5. Submodule Integrity

### Gitlink Verification

| Submodule | Gitlink SHA | Actual HEAD | Match |
|-----------|-------------|-------------|-------|
| `implementations/rust` | `773bb942c147b776a319caaa9bf876995b662ae4` | `773bb942c147b776a319caaa9bf876995b662ae4` | ✅ |
| `implementations/go` | `5b4bd01c08788b434baf1c6e18fc0b3504337396` | `5b4bd01c08788b434baf1c6e18fc0b3504337396` | ✅ |

### `.gitmodules` Configuration

```ini
[submodule "aafp"]
    path = implementations/rust
    url = https://github.com/davidnichols-ops/aafp.git
[submodule "aafp-go"]
    path = implementations/go
    url = https://github.com/davidnichols-ops/aafp-go.git
```

- URLs are public HTTPS — accessible without authentication
- Paths are correct
- Both submodules initialize and clone successfully

### Clone Instructions

Both methods work:
1. `git clone --recurse-submodules <url>` — one command, fully automated
2. `git clone <url>` + `git submodule update --init --recursive` — two steps, same result

---

## 6. Documentation Consistency

### Consistent

| Document | Test Count | Amendment Status | Verified |
|----------|-----------|-----------------|----------|
| README.md | 995 Rust, 13 Go packages | 10 of 10 met | ✅ |
| PROTOCOL_CANDIDATE_CHECKLIST.md (table) | 995 tests | A-1 through A-10: DONE | ✅ |
| ROADMAP.md | — | A-10: DONE | ✅ |
| REV6_RC1_READINESS_REPORT.md | 995 Rust, 664 Go | 10 of 10 | ✅ |

### Inconsistencies Found

#### ISSUE 1: Stale text in PROTOCOL_CANDIDATE_CHECKLIST.md (line 137-141)

The table (lines 116-125) correctly shows all 10 amendments as DONE, but the narrative text below it still says:

> "All currently scoped Rev 6 Category A protocol amendments (A-1 through A-7) have been implemented and are passing local conformance tests. 3 of 10 Category A items remain pending (A-8 through A-10)."

**This is an internal contradiction within the same document.** The table was updated but the narrative paragraph was not.

#### ISSUE 2: RFC revision headers (known, documented)

RFC headers say "Revision 5" but content includes "(Rev 6)" section markers. This was documented in the RC-1 readiness report as a known issue.

#### ISSUE 3: Go test count discrepancy in REV6_RC1_READINESS_REPORT.md

The report says "664 Go tests" which matches the `=== RUN` count. However, the `--- PASS` count is 535 (some tests are subtests counted differently). The 664 figure is correct for total test functions including subtests.

---

## 7. Release Artifact Review

### Test Vectors (`test-vectors/mldsa65/`)

| File | Size | Purpose | Present |
|------|------|---------|---------|
| `vectors.json` | 491 KB | 19 Rust ML-DSA-65 test vectors | ✅ |
| `go_vectors.json` | 285 KB | 15 Go ML-DSA-65 test vectors | ✅ |
| `diff_traces.json` | 1 MB | 100 Rust differential traces | ✅ |
| `go_diff_traces.json` | 1 MB | 100 Go differential traces | ✅ |

### Golden Traces (`implementations/rust/golden_traces/`)

17 trace directories (01-17), each with `meta.json`, `trace.bin`, `trace.hex`. Plus `README.md`. All present and accounted for.

### CI Workflows (`.github/workflows/`)

| File | Present | YAML Valid |
|------|---------|-----------|
| `rust-ci.yml` | ✅ | ✅ |
| `go-ci.yml` | ✅ | ✅ |

### Reports

All referenced report files exist:
- `REV6_RC1_READINESS_REPORT.md` ✅
- `A8_COMPLETION_REPORT.md`, `A9_COMPLETION_REPORT.md`, `A10_COMPLETION_REPORT.md` ✅
- `docs/status/A7_COMPLETION_REPORT.md` ✅
- `ARCHITECTURAL_RED_TEAM_REVIEW.md`, `RED_TEAM_EXECUTIVE_SUMMARY.md`, `RED_TEAM_FINDINGS_RANKED.md` ✅

---

## 8. CI Assessment

### Rust CI (`rust-ci.yml`)

| Aspect | Status | Notes |
|--------|--------|-------|
| YAML syntax | ✅ Valid | |
| Triggers | push + PR to main/master | ✅ |
| Jobs | fmt, clippy, build (2 OS), test (2 OS) | ✅ |
| Toolchain | stable | ✅ |
| Caching | cargo registry + git + target | ✅ |

**Likely failures on first CI run:**

1. **CRITICAL — Submodule not initialized**: `actions/checkout@v4` does not initialize submodules by default. The `working-directory: implementations/rust` will be an empty directory. **Every job will fail.**
   - Fix: Add `with: submodules: true` to each `actions/checkout@v4` step

2. **HIGH — Clippy will fail**: `cargo clippy --workspace -- -D warnings` will fail due to 2 pre-existing warnings in `aafp-messaging/src/pipeline.rs`
   - Fix: Either fix the warnings, add `#[allow]` annotations, or change to `-W warnings`

3. **MEDIUM — Test timeout**: The conformance test suite alone takes ~268s on M4. On GitHub-hosted runners (slower), the 15-minute timeout may be tight for the full workspace test suite. The ML-DSA differential tests run 10K iterations and take 60+ seconds each.

### Go CI (`go-ci.yml`)

| Aspect | Status | Notes |
|--------|--------|-------|
| YAML syntax | ✅ Valid | |
| Triggers | push + PR to main/master | ✅ |
| Jobs | gofmt, vet, build (2 OS), test (2 OS) | ✅ |
| Go version | 1.24 | ✅ Matches go.mod |
| Caching | None | ⚠️ Will re-download deps every run |

**Likely failures on first CI run:**

1. **CRITICAL — Submodule not initialized**: Same issue as Rust CI. `implementations/go` will be empty.
   - Fix: Add `with: submodules: true` to each `actions/checkout@v4` step

2. **HIGH — gofmt will fail**: 15 Go files need formatting (confirmed by `gofmt -l .` on fresh clone). The gofmt check will list these files and exit 1.
   - Fix: Run `gofmt -w .` on all Go files and commit

3. **LOW — No dependency caching**: Go module downloads will happen on every run. Not a failure but inefficient.

### CI Summary

**Neither CI workflow will pass on first run.** Both have the submodule initialization bug (affects every job), and each has at least one additional failure (clippy warnings, gofmt failures).

---

## 9. Production Readiness Review

| Area | Rating | Justification |
|------|--------|---------------|
| **Repository structure** | Good | Clean separation: RFCs, implementations (submodules), test vectors, docs. Main repo is documentation-only with submodule pointers. |
| **Versioning** | Needs Work | No git tags exist. RFC headers say "Revision 5" but content is Rev 6. No semver versioning on implementations. |
| **Documentation** | Adequate | Core docs are consistent (README, ROADMAP, checklist table). But narrative text in checklist has stale paragraph. Historical docs contain absolute paths. |
| **Submodules** | Good | Gitlinks match actual commits. Both clone methods work. URLs are public. |
| **Release process** | Needs Work | No release tags. No release notes beyond the RC-1 report. CI not functional yet. 910 MB of build artifacts in Rust repo. |
| **Build reproducibility** | Good | Clean builds succeed from scratch. Test vectors are deterministic. 995 Rust + 664 Go tests pass with 0 failures. |
| **Independent implementability** | Adequate | RFCs are complete with known caveats (replay retention, extension order). No full handshake transcript vectors. External implementer rated it 7.5/10. |
| **CI readiness** | Poor | Both workflows have submodule initialization bug. Clippy will fail. gofmt will fail. No CI has ever run. |
| **Repository hygiene** | Poor | 4,782 build artifacts (910 MB) committed to Rust submodule. 15 Go files need formatting. Stale documentation paragraph. |

---

## 10. Remaining Risks

| Risk | Severity | Impact |
|------|----------|--------|
| 910 MB build artifacts in Rust repo | HIGH | Every clone downloads ~1 GB of useless files. Severely impacts CI time, contributor experience, and repository growth. |
| CI workflows will fail on first run | HIGH | No automated validation until submodule init is fixed, clippy warnings resolved, and gofmt applied. |
| No release tags | MEDIUM | No immutable release point for external reviewers. `master` branch can change at any time. |
| Stale documentation paragraph | MEDIUM | Internal contradiction in PROTOCOL_CANDIDATE_CHECKLIST.md could confuse reviewers. |
| RFC revision header mismatch | MEDIUM | RFCs say "Revision 5" but contain Rev 6 content. Could confuse implementers. |
| No Windows CI | LOW | Only Linux + macOS in CI matrix. Windows portability untested. |
| No dependency caching in Go CI | LOW | Inefficient but not a failure. |
| Clippy warnings in pipeline.rs | LOW | Pre-existing, not introduced by this push. But will block CI. |

---

## 11. Recommendation

### **Needs minor corrections**

The pushed work is fundamentally sound — all 9 commits are present, builds succeed, 1659 tests pass with 0 failures, submodules resolve correctly, and the protocol implementation is complete. However, three issues must be fixed before this is ready for external review:

**Must fix before external review:**

1. **Remove `fuzz/target/` from Rust git tracking** — `git rm -r --cached fuzz/target/` and add `fuzz/target/` to `.gitignore`. This removes 910 MB of build artifacts. (Requires a new commit in the Rust submodule + main repo submodule update.)

2. **Fix CI submodule initialization** — Add `with: submodules: true` to every `actions/checkout@v4` step in both `.github/workflows/rust-ci.yml` and `.github/workflows/go-ci.yml`. Without this, every CI job will fail.

3. **Run `gofmt -w .` on Go code** — 15 files need formatting. Run `gofmt -w .` in `implementations/go/` and commit. (Requires a new commit in the Go submodule + main repo submodule update.)

**Should fix before external review:**

4. **Fix stale paragraph in PROTOCOL_CANDIDATE_CHECKLIST.md** (lines 137-141) — Update to reflect that all 10 Category A amendments are implemented.

5. **Resolve clippy warnings** or change CI to `-W warnings` instead of `-D warnings`.

6. **Create release tags** — Tag all three repositories with `rev6-rc1` and ensure the main repo points to the tagged submodule commits. This gives external reviewers a stable, immutable snapshot.

**Nice to have:**

7. Bump RFC headers from "Revision 5" to "Revision 6".
8. Add Go module caching to `go-ci.yml`.
9. Add Windows to CI matrix (or document it as unsupported).

---

## Appendix A: Verification Commands Used

```bash
# Fresh clone with submodules
git clone --recurse-submodules https://github.com/davidnichols-ops/AAFP-research.git

# Verify submodule pointers
git submodule status
git ls-tree HEAD implementations/

# Rust build + test
cd implementations/rust
cargo fmt --all -- --check
cargo build --workspace
cargo test --workspace
cargo clippy --workspace

# Go build + test
cd implementations/go
gofmt -l .
go vet ./...
go build ./...
go test ./... -count=1 -timeout 300s

# Repository health
find . -name ".DS_Store" -not -path "./.git/*"
grep -rn "/Users/david" --include="*.rs" --include="*.go" --include="*.md" .
grep -rn "<<<<<<<\|>>>>>>>" --include="*.rs" --include="*.go" --include="*.md" .

# CI YAML validation
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/rust-ci.yml'))"
```

## Appendix B: Test Counts (from fresh clone)

| Implementation | Test Count | Method | Failures |
|----------------|-----------|--------|----------|
| Rust | 995 | `cargo test --workspace` → sum of "test result" lines | 0 |
| Go | 664 | `go test -v` → count of `=== RUN` lines | 0 |
| **Total** | **1659** | | **0** |
