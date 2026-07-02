# AAFP 10-Week Execution Schedule

**Created:** 2026-07-02
**Duration:** 10 weeks uninterrupted
**Executor:** GLM 5.2 High (autonomous mode)

---

## Schedule Overview

```
Week 1-2:  Track C — Fixes & Push (C1-C4)
Week 2-4:  Track D — External Interop (D1-D4)
Week 4-7:  Track E — Protocol Features (E1-E4)
Week 7-10: Track F — Production Readiness (F1-F4)
```

Tracks C and D overlap (C3 push unblocks D1-D4 external testing).
Tracks E and F overlap (E1-E4 features need F1 benchmarks to validate).

---

## Week 1-2: Track C — Fixes & Push

| Week | Plan | Description | Dependency |
|------|------|-------------|------------|
| 1 | C1 | Fix pyo3 segfault + write B2.11 interop test | none |
| 1 | C2 | Clean 910MB git history (filter-repo) | **USER APPROVAL REQUIRED** |
| 2 | C3 | Push all 3 repos + tags to GitHub | C1, C2 |
| 2 | C4 | Update ROADMAP.md + stale docs | none |

**Gate:** C3 (push) must complete before Track D can start, because external
interop testing requires the repos to be publicly accessible.

**Critical note on C2:** This plan rewrites git history with `git filter-repo`
and force-pushes. This is a **destructive operation** that requires explicit
user approval. If the user does not approve, skip C2 and proceed with C3
(the 910MB stays in history but is untracked going forward).

---

## Week 2-4: Track D — External Interop

| Week | Plan | Description | Dependency |
|------|------|-------------|------------|
| 2-3 | D1 | Test against real Python MCP SDK | C3 |
| 3 | D2 | Test against real A2A reference implementation | C3 |
| 3-4 | D3 | Rust↔Go cross-language interop over QUIC | C3 |
| 4 | D4 | MCP conformance suite integration | D1 |

**Gate:** D1-D4 prove AAFP works with real external software, not just our
own implementations. This is the last remaining release criterion
("Independent third-party interop testing: NOT DONE").

---

## Week 4-7: Track E — Protocol Features

| Week | Plan | Description | Dependency |
|------|------|-------------|------------|
| 4-5 | E1 | PING/PONG keep-alive (P1-1, RFC-0002 §4.7-4.8) | none |
| 5-6 | E2 | Discovery announce/lookup over QUIC (P1-2, RFC-0004 §3) | E1 |
| 6-7 | E3 | Networked PubSub (gossipsub over QUIC) | E2 |
| 7 | E4 | Basic relay protocol / NAT traversal (P1-8) | E2 |

**Gate:** E1-E4 implement the "Should Complete Before Public Release" items
from ROADMAP.md. After these, the protocol has all core features for v1.0.

---

## Week 7-10: Track F — Production Readiness

| Week | Plan | Description | Dependency |
|------|------|-------------|------------|
| 7-8 | F1 | Performance validation + benchmark framework (P1-5) | E1-E4 |
| 8-9 | F2 | Rustdoc documentation for all public APIs (P1-7) | none |
| 9 | F3 | Revocation mechanism (CRL-based, RFC-0003 amendment) | none |
| 9-10 | F4 | Persistent/networked DHT (LevelDB or SQLite backend) | E2 |

**Gate:** F1-F4 close all remaining ROADMAP.md items and outstanding items
from PROTOCOL_CANDIDATE_CHECKLIST.md. After these, the project is ready for
v1.0 stable release.

---

## Dependency Graph

```
C1 ─┐
C2 ─┼─ C3 ─┬─ D1 ── D4
    │      ├─ D2
    │      └─ D3
C4 ─┘

E1 ── E2 ──┬─ E3
           ├─ E4
           └─ F4

E1-E4 ── F1

F2 (independent)
F3 (independent)
```

---

## Milestone Gates

| Milestone | Week | Criteria | Action |
|-----------|------|----------|--------|
| M1: Pushed | 2 | C1-C4 complete, repos on GitHub | Begin external testing |
| M2: Interop proven | 4 | D1-D4 complete, external software talks to AAFP | Begin protocol features |
| M3: Protocol complete | 7 | E1-E4 complete, all P1 items done | Begin production hardening |
| M4: v1.0 ready | 10 | F1-F4 complete, all criteria met | Tag v1.0 |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| C2 user doesn't approve history rewrite | Medium | Low (910MB stays in history) | Skip C2, proceed with C3 |
| D1: Python MCP SDK Transport interface differs from assumed | Medium | Medium (adapter rewrite) | Read actual SDK source before implementing |
| D2: No A2A reference implementation exists | High | Medium (can't test A2A interop) | Test against A2A spec JSON examples instead |
| E3: Gossipsub is complex | High | Medium (may take longer than 1 week) | Start with simpler floodsub, upgrade later |
| F1: Performance targets not met | Medium | High (release criterion) | Profile, optimize, document honestly |
| F3: Revocation requires new RFC | Low | Low (design is documented in amendments) | Write RFC amendment first, then implement |

---

## What NOT to Do

- Do NOT push to remote without C1 being complete (don't push known bugs)
- Do NOT skip verification steps to save time
- Do NOT start Track E before Track D (interop proof first, features second)
- Do NOT implement features without reading the relevant RFC sections first
- Do NOT modify domain separators or cryptographic constants (one-way doors)
- Do NOT force-push without explicit user approval (C2 is the only exception)
- Do NOT create documentation files unless explicitly specified in a plan
- Do NOT add dependencies without checking they're maintained and >7 days old
