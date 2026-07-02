# Plan C4: Update Stale Documentation

**Priority:** MEDIUM
**Track:** C (Fixes & Push)
**Estimated effort:** 1-2 hours
**Blocked by:** nothing
**Blocks:** nothing

---

## Problem

Several documentation files are stale — they reflect the state before
Tracks A and B were completed:

1. **ROADMAP.md** — Still shows P1-4 (Go ML-DSA-65) as "Pending" but it's
   DONE (A-10). Shows P1-3 (CI) as "Pending" but workflows exist (A2 fixed
   them). Shows MCP/A2A transport as "Pending"/"Designed" but both are
   implemented. Shows 8/10 release criteria but all 10 are met.

2. **PROTOCOL_CANDIDATE_CHECKLIST.md** — May still have stale text (A3
   checked this but verify again).

3. **README.md** — May not mention the A2A transport crate, the Python
   adapter, or the `establish_session()` refactor.

4. **INTEROPERABILITY_PLAN.md** — Phase 1 (Rust-only CI) should be marked
   complete. Phase 2 (Python interop) is partially done (B2).

5. **TRANSPORT_ARCHITECTURE_REVIEW.md** — §5.1 (raw() leak) and §5.3
   (duplicated handshake) are now resolved by B3. Should be updated.

6. **RELEASE_READINESS.md** — May not reflect the current state with A2A
   transport and Python adapter.

---

## Prerequisites

- Working directory: `/Users/david/projects/AAFP-research`
- Read each file before modifying it

---

## Steps

### C4.1: Update ROADMAP.md

Read `ROADMAP.md`. Update:

1. **P1-3 (CI pipeline):** Change from "Pending" to **DONE** — GitHub
   Actions workflows exist and were fixed in A2.

2. **P1-4 (Go ML-DSA-65):** Change from "Pending" to **DONE** — completed
   as A-10 in Rev 6.

3. **P1-8 (Basic relay protocol):** Keep as "Pending" — this is Track E4.

4. **Item 10 (MCP transport binding):** Already marked **DONE** — verify.

5. **Item 11 (A2A transport binding):** Change from "DESIGNED" to
   **DONE** — implemented in B1.

6. **Release Criteria table:** Update to show 10/10 met (all criteria met
   after Rev 6 amendments). The only outstanding item is "Independent
   third-party interop testing" which Track D addresses.

7. **Outstanding Items table:** Update:
   - "Go ML-DSA-65 cross-signature verification" → **DONE** (A-10)
   - "Independent third-party interop testing" → In progress (Track D)
   - Others remain as-is

8. **Category B table:** B-1 (Go ML-DSA-65) → **DONE** (A-10)

9. Add a note at the top: "Updated 2026-07-02: Tracks A and B complete.
   See `implementation-plans/STATUS.md` for current state."

### C4.2: Verify PROTOCOL_CANDIDATE_CHECKLIST.md

Read `PROTOCOL_CANDIDATE_CHECKLIST.md`. A3.6 already verified this, but
check again:
- All 10 amendments show DONE
- No "3 of 10 remain pending" text
- Test counts are current (1011 Rust, 664 Go)

If anything is stale, fix it.

### C4.3: Update README.md

Read `README.md`. Update:

1. **Current Status section:** Verify it mentions:
   - `aafp-transport-a2a` crate (A2A transport, RFC 0008)
   - `aafp-py` crate (Python PyO3 adapter)
   - `establish_session()` shared handshake function
   - 15 Rust crates (was 14, now 15 with aafp-transport-a2a)

2. **Repository layout:** Add `aafp-transport-a2a` and `aafp-py` to the
   crate listing if not already there.

3. **RFC table:** RFC 0008 should show "Implemented" (B1.12 updated this,
   verify).

4. **Status table:** A2A Transport should show "Implemented" (B1.13
   updated this, verify).

### C4.4: Update INTEROPERABILITY_PLAN.md

Read `INTEROPERABILITY_PLAN.md`. Update:

1. **Phase 1 (Rust-only CI):** Mark as **DONE** — CI workflows exist (A2).

2. **Phase 2 (Protocol-level conformance):** Mark as **PARTIAL** —
   conformance tests exist for MCP and A2A transports.

3. **Phase 3 (Cross-SDK interop):** Mark as **IN PROGRESS** — Python
   adapter built (B2), Rust↔Python interop verified (B2.10), external
   SDK testing pending (Track D).

4. **Phase 4 (Full conformance suite):** Still pending (Track D4).

5. **Target SDKs table:** Update "Not integrated" to "Integrated (B2)"
   for the Python SDK. Others remain "Not integrated" (Track D).

### C4.5: Update TRANSPORT_ARCHITECTURE_REVIEW.md

Read `TRANSPORT_ARCHITECTURE_REVIEW.md`. Update:

1. **§5.1 (raw() leak):** Add a note: "**RESOLVED** (B3): Added
   `QuicConnection::export_tls_binding()`. Transport crates no longer
   call `raw()`."

2. **§5.3 (duplicated handshake):** Add a note: "**RESOLVED** (B3):
   Extracted `establish_session()` to `aafp-sdk::transport_binding`.
   All 4 call sites now use the shared function."

3. **§6.3 (premature abstraction):** Add a note: "**RESOLVED** (B1+B3):
   Second transport binding (A2A) implemented, then shared code extracted."

### C4.6: Update or create RELEASE_READINESS.md

Read `RELEASE_READINESS.md` if it exists. Update to reflect:
- MCP transport: Implemented (RFC 0007)
- A2A transport: Implemented (RFC 0008)
- Python adapter: Implemented (B2)
- Shared handshake: Extracted (B3)
- All 10 release criteria met
- Remaining: External interop testing (Track D), protocol features (Track E)

If the file doesn't exist, skip this step.

### C4.7: Commit documentation updates

```bash
cd /Users/david/projects/AAFP-research
git add ROADMAP.md README.md INTEROPERABILITY_PLAN.md TRANSPORT_ARCHITECTURE_REVIEW.md PROTOCOL_CANDIDATE_CHECKLIST.md RELEASE_READINESS.md
git commit -m "$(cat <<'EOF'
docs: update stale documentation after Tracks A and B

- ROADMAP.md: P1-3 (CI) and P1-4 (Go ML-DSA-65) now DONE,
  A2A transport now Implemented, 10/10 release criteria met
- INTEROPERABILITY_PLAN.md: Phase 1 done, Phase 3 in progress
- TRANSPORT_ARCHITECTURE_REVIEW.md: §5.1 and §5.3 resolved by B3
- README.md: Added aafp-transport-a2a and aafp-py crates
- Verified PROTOCOL_CANDIDATE_CHECKLIST.md is current

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

---

## Verification

### C4.8: No stale "Pending" for done items

```bash
cd /Users/david/projects/AAFP-research
grep -n "P1-3.*Pending\|P1-4.*Pending\|A2A.*Designed\|A2A.*pending" ROADMAP.md
# Expected: no output
```

### C4.9: README mentions new crates

```bash
grep "aafp-transport-a2a\|aafp-py" README.md
# Expected: both appear
```

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark C4.1 through C4.9 as `[x]`
- Set C4 status to `COMPLETE`
