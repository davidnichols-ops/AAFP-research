# Plan C2: Clean 910MB Git History

**Priority:** MEDIUM
**Track:** C (Fixes & Push)
**Estimated effort:** 1-2 hours
**Blocked by:** nothing
**Blocks:** C3 (clean history before push is ideal, but not required)

---

## ⚠️ REQUIRES EXPLICIT USER APPROVAL

**This plan rewrites git history and force-pushes. This is a DESTRUCTIVE
operation. Do NOT execute this plan without explicit user approval.**

If the user does not approve, skip this plan and proceed to C3. The 910MB
stays in git history but is untracked going forward (A1 already handled this).

---

## Problem

The Rust submodule's git history contains 910MB of build artifacts in
`fuzz/target/`. While A1 removed these from tracking (they're no longer in
the working tree index), the objects remain in the git packfile. Every
`git clone` downloads the full packfile — ~583MB of git objects.

**Verified state:**
- `.git/modules/aafp/objects/` = 583MB
- Two large packfiles: 319MB + 263MB
- `git ls-files fuzz/target/` returns 0 (untracked, good)
- The objects are in history from commits before A1

**Source:** POST_PUSH_AUDIT.md §4, verified during planning

---

## Prerequisites

- Working directory: `/Users/david/projects/AAFP-research`
- `git-filter-repo` installed (`pip install git-filter-repo`)
- **EXPLICIT USER APPROVAL** for history rewrite + force-push
- All work committed (no uncommitted changes in any repo)
- C1 complete (don't rewrite history with uncommitted fixes)

---

## Steps

### C2.1: Backup the Rust submodule

Before rewriting history, create a backup:

```bash
cd /Users/david/projects/AAFP-research
cp -r implementations/rust implementations/rust-backup
```

**Note:** This backup is ~1GB. Delete it after C2 is verified complete.

### C2.2: Run git-filter-repo on the Rust submodule

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git filter-repo --invert-paths --path fuzz/target/ --force
```

This rewrites all commits in history, removing `fuzz/target/` from every
commit. The result is a clean history with no build artifacts.

**Expected output:** Reports how many refs were rewritten and how many
objects were removed.

### C2.3: Run git gc to reclaim space

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git reflog expire --expire=now --all
git gc --aggressive --prune=now
```

**Expected:** The `.git` directory shrinks dramatically. Check:
```bash
du -sh .git/
# or for submodule:
du -sh /Users/david/projects/AAFP-research/.git/modules/aafp/
```
**Expected:** Should be under 50MB (down from 583MB).

### C2.4: Verify history is clean

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git log --oneline --all -- fuzz/target/
# Expected: no output (no commits touch fuzz/target/)

git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize)' | awk '/^blob/ {print $3}' | sort -rn | head -5
# Expected: largest blobs should be source files, not build artifacts
```

### C2.5: Verify all tests still pass

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
cargo build --workspace
cargo test --workspace
```
**Expected:** Build succeeds, all tests pass.

### C2.6: Force-push the Rust submodule

**⚠️ DESTRUCTIVE OPERATION — REQUIRES USER APPROVAL**

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git push --force origin
git push --force origin --tags
```

**Note:** This overwrites the remote history. Anyone who has cloned the
repo will need to re-clone. Since this is a private repo with likely only
one clone (the user's), this is acceptable.

### C2.7: Update umbrella submodule pointer

The Rust submodule's history has been rewritten, so all commit SHAs have
changed. The umbrella repo's submodule pointer is now invalid. Update it:

```bash
cd /Users/david/projects/AAFP-research
git add implementations/rust
git commit -m "chore: update rust submodule pointer after history cleanup

The Rust submodule's git history was rewritten to remove 910MB of
fuzz/target/ build artifacts. All commit SHAs have changed. The
submodule pointer is updated to the new HEAD.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

### C2.8: Clean up backup

```bash
cd /Users/david/projects/AAFP-research
rm -rf implementations/rust-backup
```

---

## Verification

### C2.9: Clone size is small

```bash
cd /tmp
git clone --recurse-submodules https://github.com/davidnichols-ops/AAFP-research.git aafp-test-clone
du -sh aafp-test-clone/
rm -rf aafp-test-clone
```
**Expected:** Under 100MB total (down from ~1GB).

### C2.10: Tags still exist

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git tag -l
# Expected: rev6-rc1, v0.1-mvp-freeze, v0.3-phase3-snapshot
```

**Note:** `git filter-repo` rewrites tags to point to the new (rewritten)
commits. The tag names should be preserved but the SHAs will differ.

---

## Risks & Mitigations

1. **History rewrite breaks collaborators:** Since this is a private repo
   with likely only the user as collaborator, this is low risk. **Mitigation:**
   The backup in C2.1 provides a recovery path.

2. **Tags point to wrong commits:** `git filter-repo` should rewrite tags
   automatically. Verify in C2.10. If tags are broken, recreate them
   manually at the equivalent rewritten commits.

3. **Submodule pointer mismatch:** The umbrella repo's submodule pointer
   will be invalid after the rewrite. C2.7 handles this. If the umbrella
   repo can't find the submodule commit, run:
   ```bash
   cd implementations/rust && git checkout master && cd ..
   git add implementations/rust
   git commit --amend --no-edit
   ```

4. **`git filter-repo` not installed:** Install with `pip install git-filter-repo`.
   It's the recommended replacement for `git filter-branch` (which is deprecated).

---

## If User Does NOT Approve

Skip C2 entirely. Proceed to C3. The 910MB stays in history but:
- Files are untracked (A1 handled this)
- New clones are large but functional
- The issue is documented in POST_PUSH_AUDIT.md and STATUS.md

Mark C2 as `[-]` (skipped) in STATUS.md with note: "User did not approve
history rewrite. 910MB remains in git packfile but is untracked."

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark C2.1 through C2.10 as `[x]` (or `[-]` if skipped)
- Set C2 status to `COMPLETE` or `SKIPPED`
