# Plan A3: Release Tags + RFC Headers

**Priority:** MEDIUM
**Track:** A (Hygiene)
**Estimated effort:** 20 minutes
**Blocked by:** A1, A2 (tags should point to clean, CI-green state)
**Blocks:** nothing

---

## Problem

1. **No release tags:** There is no immutable release point for external
   reviewers. The `master` branch can change at any time. External reviewers
   need a stable, immutable snapshot.

2. **RFC headers stale:** RFC headers say "Revision 5" but content includes
   "(Rev 6)" section markers. Rev 6 amendments (A-1 through A-10) were
   incorporated without bumping the header revision number.

3. **Stale paragraph in PROTOCOL_CANDIDATE_CHECKLIST.md:** Lines ~137-141
   still say "3 of 10 Category A items remain pending (A-8 through A-10)"
   but all 10 are DONE. This is an internal contradiction (the table above
   it correctly shows all 10 as DONE).

**Source:** POST_PUSH_AUDIT.md §9, REV6_RC1_READINESS_REPORT.md §5

---

## Prerequisites

- A1 complete (git is clean of build artifacts)
- A2 complete (CI is green, clippy/gofmt fixed)
- Working directory: `/Users/david/projects/AAFP-research`
- All changes from A1 and A2 committed and pushed

---

## Steps

### A3.1: Tag Rust submodule

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git tag -a rev6-rc1 -m "Rev 6 RC-1: 10/10 release criteria met, 1011 tests, 0 failures

- All Category A amendments (A-1 through A-10) implemented
- ML-DSA-65 cross-verification with Go (4/4 matrix)
- 17 golden wire traces, 37 interop fixtures
- MCP transport binding (RFC 0007) implemented
- fips204 + aws-lc-rs (migrated from unmaintained pqcrypto)"
```

### A3.2: Tag Go submodule

```bash
cd /Users/david/projects/AAFP-research/implementations/go
git tag -a rev6-rc1 -m "Rev 6 RC-1: 664 tests, 0 failures

- ML-DSA-65 cross-verification with Rust (A-10)
- All Rev 6 amendments verified
- 17 golden traces verified
- gofmt clean"
```

### A3.3: Tag umbrella repo

**IMPORTANT:** The umbrella submodule pointers MUST point to the tagged
commits from A3.1 and A3.2. Verify this before tagging:

```bash
cd /Users/david/projects/AAFP-research
git submodule status
# Verify the SHAs match the tagged commits in A3.1 and A3.2
```

If the submodule pointers are NOT at the tagged commits, you need to update
them first:
```bash
cd implementations/rust && git checkout rev6-rc1 && cd ..
cd implementations/go && git checkout rev6-rc1 && cd ..
git add implementations/rust implementations/go
git commit -m "chore: align submodule pointers with rev6-rc1 tags"
```

Then tag:
```bash
cd /Users/david/projects/AAFP-research
git tag -a rev6-rc1 -m "Rev 6 RC-1 Release Candidate

Protocol specification complete and validated by two independent
implementations (Rust reference + Go wire-format reference).

- 6 core RFCs (0001-0006) at Revision 6
- 2 extension RFCs (0007 MCP binding, 0008 A2A binding)
- 1011 Rust tests + 664 Go tests, 0 failures
- 10/10 release criteria met
- All Category A amendments (A-1 through A-10) implemented
- Post-quantum: ML-DSA-65 + X25519MLKEM768
- ADRs 0001-0004 accepted

See REV6_RC1_READINESS_REPORT.md for full details."
```

### A3.4: Bump RFC headers to Revision 6

For each of `RFCs/0001-protocol-overview.md` through `RFCs/0006-versioning-compatibility.md`:

1. Read the file header
2. Find the revision marker (likely says "Revision 5" or "Rev 5" or "Freeze Candidate (Rev 5)")
3. Change to "Revision 6"
4. If there's a date, update it to 2026-07-01

**Be precise.** Read each file's header before editing. The exact format may
vary between RFCs. Do NOT change any normative content — only the revision
marker in the header.

### A3.5: Add Rev 6 changelog entry

Read `RFCs/RFC_CHANGELOG.md`. Add a new entry for Revision 6:

```markdown
## Revision 6 (2026-07-01)

**Trigger:** Rev 6 protocol amendments (Category A, items A-1 through A-10)

**Key changes:**
- A-1: RPC params must be canonical CBOR item, not null
- A-2: Optional fields: omit-when-absent (not null)
- A-3: AgentRecord record_version for replay protection
- A-4: Bind session ID to server AgentId
- A-5: Frame extension limits enforced before allocation
- A-6: Normative handshake state machine (RFC-0002 §5.10)
- A-7: Extension processing order (sig before semantics)
- A-8: CLOSE frame semantics (RFC-0002 §6.6)
- A-9: Nonce reuse detection (5-min retention, RFC-0002 §6.7)
- A-10: Go ML-DSA-65 cross-signature verification

**Status:** Freeze Candidate → Release Candidate (rev6-rc1)
```

### A3.6: Fix stale paragraph in PROTOCOL_CANDIDATE_CHECKLIST.md

Read `PROTOCOL_CANDIDATE_CHECKLIST.md`. Find the paragraph around lines
137-141 that says something like:

> "All currently scoped Rev 6 Category A protocol amendments (A-1 through A-7)
> have been implemented and are passing local conformance tests. 3 of 10
> Category A items remain pending (A-8 through A-10)."

Replace with:

> "All 10 Rev 6 Category A protocol amendments (A-1 through A-10) have been
> implemented and verified. All pass local conformance tests and
> cross-language interoperability tests."

### A3.7: Commit doc fixes in umbrella repo

```bash
cd /Users/david/projects/AAFP-research
git add RFCs/ PROTOCOL_CANDIDATE_CHECKLIST.md
git commit -m "$(cat <<'EOF'
docs: bump RFC headers to Revision 6, fix stale checklist

- RFCs 0001-0006: Revision 5 → Revision 6
- RFC_CHANGELOG.md: Add Rev 6 entry (A-1 through A-10)
- PROTOCOL_CANDIDATE_CHECKLIST.md: Fix stale paragraph (all 10 amendments done)

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

If you updated submodule pointers in A3.3, those are already committed.

---

## Verification

### A3.8: Tags exist

```bash
cd /Users/david/projects/AAFP-research
git tag -l rev6-rc1
# Expected: rev6-rc1

cd implementations/rust
git tag -l rev6-rc1
# Expected: rev6-rc1

cd ../go
git tag -l rev6-rc1
# Expected: rev6-rc1
```

### A3.9: No "Revision 5" in RFC headers

```bash
cd /Users/david/projects/AAFP-research
grep -l "Revision 5" RFCs/000[1-6]*.md
# Expected: no output (no files match)
```

Verify "Revision 6" is present:
```bash
grep -l "Revision 6" RFCs/000[1-6]*.md
# Expected: 6 files listed
```

### A3.10: No contradictions in checklist

Read `PROTOCOL_CANDIDATE_CHECKLIST.md` in full. Verify:
- The table shows all 10 amendments as DONE
- The narrative text says all 10 are done (no "3 of 10 remain pending")
- Test counts are consistent (1011 Rust, 664 Go)

---

## Risks & Notes

- Tags are immutable. Once created, they cannot be easily moved. Make sure
  A1 and A2 are fully complete and verified before tagging.
- If you need to push tags to remote: `git push origin rev6-rc1` in each repo.
  **Do NOT push without explicit user approval.**
- The RFC header format may vary. Read each file before editing. Some may say
  "Revision 5" in a metadata block, others in a comment. Be thorough.

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark A3.1 through A3.10 as `[x]`
- Set A3 status to `COMPLETE`
