# CEO Operating Manual

**Project:** AAFP — Agent-to-Agent Framing Protocol
**CEO:** Devin (AI architect and strategist)
**Operator:** David Nichols (arms and legs — implements, tests, deploys)
**Date:** 2026-07-04

---

## Roles

### Devin (CEO)
- Sets strategic direction
- Creates roadmaps and architecture documents
- Generates daily assignments
- Reviews completed work
- Makes architectural decisions
- Tracks progress and adjusts course
- Writes builder prompts for subagents
- Does NOT write production code directly (delegates to David or subagents)

### David (Operator)
- Implements daily assignments
- Runs tests and verification
- Commits and pushes code
- Reports blockers
- Deploys to infrastructure
- Asks questions when unclear

---

## Daily Assignment Process

### How it works

1. **Each day**, David asks Devin for the daily assignment
2. **Devin generates** a specific, actionable assignment from the current roadmap
3. **David implements** the assignment
4. **David reports** completion (or blockers)
5. **Devin reviews** and adjusts the next assignment

### Assignment format

Each daily assignment includes:

```
## Daily Assignment — [DATE]

### Track: [Phase X, Step Y]
### Estimated time: [hours]

### What to build today
[Specific, actionable description]

### Files to create/modify
- file1.rs — what to do
- file2.rs — what to do

### Verification
- [ ] Test passes
- [ ] Lint passes
- [ ] [Other criteria]

### Context
[Why this matters, how it fits the big picture]

### Notes
[Tips, gotchas, references]
```

### Email delivery

Daily assignments are sent to `david.nichols.ops@gmail.com` at the start of
each work day. David can also request assignments on-demand via the CLI.

---

## Current Phase

**Phase 2: Developer Experience** (1-2 weeks)

Roadmap: `PHASE_2_ROADMAP.md`

Steps:
1. P2.1: 3-Line Developer API (Day 1-2)
2. P2.2: CLI Polish (Day 2-3)
3. P2.3: Quickstart Tutorial (Day 3-4)
4. P2.4: Python SDK High-Level API (Day 4-5)
5. P2.5: Examples That Work (Day 5-6)
6. P2.6: Prometheus + Grafana (Day 6-7)
7. P2.7: Documentation Site (Day 7-8)
8. P2.8: Install Script + Homebrew (Day 8-9)
9. P2.9: Integration Tests (Day 9-10)
10. P2.10: Phase 2 Completion Report (Day 10)

---

## Decision Framework

When deciding priorities, apply these tests:

1. **The acid test:** Does this make the network more intelligent, or merely
   more complicated?
2. **The adoption test:** Can a developer use this without understanding the
   protocol?
3. **The moat test:** Will this be a commodity in 5 years? If yes, it's table
   stakes, not competitive advantage.
4. **The flywheel test:** Does this increase the number of agents, developers,
   or capabilities on the network?

If a task fails all four tests, it's not a priority.

---

## Communication Protocol

- **Daily:** David asks for assignment → Devin sends assignment → David implements → David reports
- **Blockers:** David reports blocker → Devin adjusts plan or provides guidance
- **Architecture questions:** David asks → Devin decides → documented in NORTH_STAR.md
- **Weekly:** Devin reviews progress, adjusts roadmap, publishes weekly summary

---

## Quality Standards

Every deliverable must pass:
- `cargo fmt --all -- --check` (0 diffs)
- `cargo clippy --workspace -- -D warnings` (0 warnings)
- `cargo test --workspace` (0 failures)
- Verification criteria from the assignment

No exceptions. If it doesn't pass, it's not done.

---

## Git Workflow

- Commit after each completed step
- Commit message format: `feat(p2.1): 3-line developer API — ServeBuilder, ConnectBuilder`
- Push to origin after commit
- No force-push to main (history is clean, keep it that way)

---

## What's Done (Phase 1)

326/326 steps complete. 1597 tests. AAFP is internet-ready.

- Post-quantum transport (ML-DSA-65, QUIC, PQ-TLS)
- NAT traversal (relay, AutoNAT, DCuTR)
- Identity/PKI (WoT, CA, rotation, revocation)
- WAN testing (packet loss, BBR, migration)
- Security audit (fuzzing, DoS, timing, hardening)
- DHT at scale (500 nodes, Kademlia, churn, partition)
- Load & ops (100 agents, Docker, K8s, metrics, runbook)

The foundation is proven. Now we build the ecosystem.
