# Plan C3: Push All Repos + Tags to GitHub

**Priority:** HIGH
**Track:** C (Fixes & Push)
**Estimated effort:** 30 minutes
**Blocked by:** C1 (don't push known bugs)
**Blocks:** D1, D2, D3, D4 (external testing needs public repos)

---

## Objective

Push all three repositories (umbrella + Rust submodule + Go submodule) and
all tags to their GitHub remotes. This makes the code publicly accessible
for external interop testing (Track D) and external review.

**Remote URLs (verified):**
- Umbrella: `https://github.com/davidnichols-ops/AAFP-research.git`
- Rust: `https://github.com/davidnichols-ops/aafp.git`
- Go: `https://github.com/davidnichols-ops/aafp-go.git`

---

## Prerequisites

- C1 complete (pyo3 segfault fixed, no known bugs)
- C2 either complete or skipped (history clean or documented as-is)
- Working directory: `/Users/david/projects/AAFP-research`
- GitHub authentication configured (SSH key or HTTPS token)
- All work committed (no uncommitted changes)

---

## Steps

### C3.1: Verify clean working state

```bash
cd /Users/david/projects/AAFP-research
echo "=== Umbrella ===" && git status --short
echo "=== Rust ===" && git -C implementations/rust status --short
echo "=== Go ===" && git -C implementations/go status --short
```
**Expected:** All three show clean working trees (no uncommitted changes).

If any repo has uncommitted changes, commit them before proceeding.

### C3.2: Push the Rust submodule

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git push origin master
git push origin --tags
```

**Expected:** All commits and tags pushed successfully.

If C2 was completed (history rewrite), use `git push --force origin master`
instead. **Only use --force if C2 was completed.**

### C3.3: Push the Go submodule

```bash
cd /Users/david/projects/AAFP-research/implementations/go
git push origin master
git push origin --tags
```

### C3.4: Push the umbrella repo

```bash
cd /Users/david/projects/AAFP-research
git push origin master
git push origin --tags
```

**Note:** The umbrella repo's submodule pointers must point to commits that
exist in the submodule remotes (pushed in C3.2 and C3.3). If the push fails
with "remote: submodule pointer references commit not found", ensure the
submodule pushes completed successfully first.

### C3.5: Verify pushes succeeded

```bash
# Check that the remote has the latest commits
cd /Users/david/projects/AAFP-research
git log --oneline origin/master -3
echo "---"
git -C implementations/rust log --oneline origin/master -3
echo "---"
git -C implementations/go log --oneline origin/master -3
```

**Expected:** The remote `origin/master` matches local `master` in all three repos.

### C3.6: Verify tags on remote

```bash
git ls-remote --tags origin
echo "---"
git -C implementations/rust ls-remote --tags origin
echo "---"
git -C implementations/go ls-remote --tags origin
```

**Expected:** `rev6-rc1`, `v0.1-mvp-freeze`, `v0.3-phase3-snapshot` visible
on the appropriate remotes.

### C3.7: Verify GitHub repo is accessible

Open a browser or use `curl`:
```bash
curl -s -o /dev/null -w "%{http_code}" https://github.com/davidnichols-ops/AAFP-research
# Expected: 200
curl -s -o /dev/null -w "%{http_code}" https://github.com/davidnichols-ops/aafp
# Expected: 200
curl -s -o /dev/null -w "%{http_code}" https://github.com/davidnichols-ops/aafp-go
# Expected: 200
```

If any return 404, the repo may be private. That's fine for now — external
interop testing (Track D) can be done with local clones. But if the goal
is public review, the repos need to be made public in GitHub settings.

### C3.8: Make repos public (if desired)

This is a manual step the user must do in GitHub:
1. Go to https://github.com/davidnichols-ops/AAFP-research/settings
2. Scroll to "Danger Zone" at the bottom
3. Click "Change visibility" → "Public"
4. Repeat for `aafp` and `aafp-go`

**Do NOT attempt to change repo visibility via the API without user approval.**

---

## Verification

### C3.9: Fresh clone works

```bash
cd /tmp
git clone --recurse-submodules https://github.com/davidnichols-ops/AAFP-research.git aafp-fresh-clone
cd aafp-fresh-clone
cargo build --workspace  # verify Rust builds from fresh clone
ls implementations/rust/crates/aafp-transport-a2a/src/  # verify A2A crate is there
ls implementations/rust/crates/aafp-py/src/  # verify pyo3 crate is there
cd ..
rm -rf aafp-fresh-clone
```

**Expected:** Clone succeeds, build succeeds, all crates present.

---

## Risks & Mitigations

1. **Authentication failure:** If `git push` fails with permission denied,
   the user needs to configure GitHub authentication. **Do NOT attempt to
   configure credentials yourself** — ask the user.

2. **Submodule pointer mismatch:** If the umbrella push fails because the
   submodule remote doesn't have the referenced commit, push the submodules
   first (C3.2, C3.3) before the umbrella (C3.4).

3. **Large push:** If C2 was skipped, the Rust push will be ~583MB. This
   may take a while. Be patient. If it times out, retry with
   `git config http.postBuffer 524288000` to increase the buffer size.

4. **Force-push warning:** If C2 was completed and you use `--force`, GitHub
   will accept it (it's not a protected branch). If branch protection is
   enabled, the user needs to disable it temporarily.

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark C3.1 through C3.9 as `[x]`
- Set C3 status to `COMPLETE`
