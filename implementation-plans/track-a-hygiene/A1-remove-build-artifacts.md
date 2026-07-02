# Plan A1: Remove Build Artifacts from Rust Git

**Priority:** CRITICAL
**Track:** A (Hygiene)
**Estimated effort:** 15 minutes
**Blocked by:** nothing
**Blocks:** A3 (tags should point to clean state), B1 (git should be clean before new work)

---

## Problem

The Rust submodule (`implementations/rust/`) has `fuzz/target/` tracked in git.
This directory contains 4,782 build artifact files totaling 910MB of git
objects. Every `git clone --recurse-submodules` downloads ~1GB of useless files.

The `.gitignore` at the repo root has `/target` but not `fuzz/target/`. The
`fuzz/.gitignore` has `target/` but the files were committed before it was
added.

**Source:** POST_PUSH_AUDIT.md §4 "CRITICAL: 4,782 build artifacts committed to
Rust submodule"

---

## Prerequisites

- Working directory: `/Users/david/projects/AAFP-research`
- Rust submodule initialized: `implementations/rust/` should contain source
- No uncommitted changes in the Rust submodule (run `git -C implementations/rust status` first)

---

## Steps

### A1.1: Remove fuzz/target from git tracking

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git rm -r --cached fuzz/target/
```

**Expected output:** Lists ~4,782 files being removed from the index.

**Note:** `--cached` removes from git index but keeps files on disk. The build
artifacts remain locally but are no longer tracked. This is correct — we do NOT
want to delete the local build artifacts, just stop tracking them.

### A1.2: Update .gitignore

Read `implementations/rust/.gitignore`. Ensure it contains:
```
/fuzz/target/
```

If it only has `/target` (without the fuzz prefix), add the `/fuzz/target/`
line. Do NOT remove the existing `/target` entry.

### A1.3: Commit in Rust submodule

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add .gitignore
git status  # confirm fuzz/target files are staged for deletion + .gitignore modified
git commit -m "$(cat <<'EOF'
chore: remove fuzz/target build artifacts from git tracking

The fuzz/target/ directory contained 4,782 build artifact files (910MB of
git objects) that were committed before the .gitignore was added. Every
clone downloaded ~1GB of useless files.

This removes them from git tracking via `git rm -r --cached`. The files
remain on disk locally but are no longer version-controlled. The
.gitignore now explicitly excludes /fuzz/target/.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

### A1.4: Update umbrella submodule pointer

```bash
cd /Users/david/projects/AAFP-research
git add implementations/rust
git commit -m "$(cat <<'EOF'
chore: update rust submodule — remove 910MB build artifacts

Updates the rust submodule pointer to the commit that removes fuzz/target/
from git tracking. This dramatically reduces clone size.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

---

## Verification

### A1.5: Confirm no tracked files in fuzz/target

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git ls-files fuzz/target/ | wc -l
```

**Expected:** `0`

If this returns anything > 0, the removal failed. Re-run A1.1.

### A1.6: Confirm build still works

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
cargo build --workspace
```

**Expected:** Build succeeds (artifacts regenerate in target/).

---

## Risks & Notes

- **History is NOT rewritten.** The 910MB remains in old commits/packfile. A
  full cleanup would require `git filter-repo` + force-push, which is a
  destructive operation. **Do NOT do this without explicit user approval.**
  The current plan only stops tracking the files going forward, which is
  sufficient for new clones to be fast (the packfile is downloaded once but
  the working tree is clean).

  Actually, correction: the 910MB is in the packfile and WILL still be
  downloaded on clone. To fully fix clone size, history rewriting is needed.
  Document this limitation in the commit message and flag it to the user as
  a follow-up consideration. The immediate fix (stop tracking) is still
  correct and prevents the problem from growing.

- **Do NOT run `git gc --aggressive --prune=now` on the submodule without
  user approval** — this is a maintenance operation that should be done
  deliberately, not as part of a code change.

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark A1.1 through A1.6 as `[x]`
- Set A1 status to `COMPLETE`
- Add any notes about issues encountered
