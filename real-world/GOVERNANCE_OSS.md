# AAFP Governance & Open Source Strategy

**Author:** AAFP Project
**Date:** 2026-07-04
**Status:** Research / Proposed Policy

---

## 0. Purpose

This document defines how the AAFP project is governed as an open source
effort. It covers license selection, governance model, the RFC process,
maintainer structure, contribution pipeline, code of conduct, funding,
intellectual property policy, trademark policy, compatibility policy,
security disclosure, roadmap governance, and a comparison with how
gRPC, Kubernetes, Rust, and Linux handle the same problems.

AAFP's strategic vision (see `STRATEGIC_VISION.md`) is to become the
**decentralized execution substrate for autonomous software** — the
operating system of the agent internet. The wire protocol is frozen at
Revision 6 (RFCs 0001–0011). The durable moat is not cryptography but
**network effects**: the richness of the capability graph, the strength
of the developer ecosystem, and the number of interoperable agents.

Governance is therefore not a bureaucratic afterthought. It is the
mechanism by which the project earns the trust required for adoption.
A protocol that wants to be as foundational as TCP must be governed in
a way that makes it safe to build on for decades. This document is the
blueprint for that governance.

The recurring theme: **the protocol is the primary artifact, not any
single implementation.** Governance must protect the protocol's
stability, neutrality, and openness — even when that is inconvenient
for a particular implementation or sponsor.

---

## 1. Open Source License Selection

### 1.1 The Decision Space

The three serious candidates for an infrastructure protocol are:

| License | Copyleft | Patent Grant | Complexity | Ecosystem Fit |
|---------|----------|--------------|------------|---------------|
| Apache 2.0 | No | Explicit (patent retaliation) | Moderate | Excellent (CNCF, LF, gRPC, Kubernetes) |
| MIT | No | Implicit / none | Minimal | Excellent (Rust, libp2p parts) |
| AGPL-3.0 | Strong (network) | Explicit (GPL family) | High | Poor for infrastructure libraries |

### 1.2 Apache 2.0 — Recommended Primary

Apache 2.0 is the recommended primary license for AAFP. Reasons:

1. **Explicit patent grant.** Apache 2.0 contains a defensive patent
   grant and a patent retaliation clause: if a contributor sues alleging
   that a contribution infringes a patent, their patent grant for that
   contribution terminates. For a protocol that uses post-quantum
   cryptography (ML-DSA-65, X25519MLKEM768) and may touch patented
   algorithms, this matters. MIT provides no explicit patent protection.

2. **Industry standard for infrastructure.** gRPC, Kubernetes, Envoy,
   containerd, etcd, Prometheus, and the vast majority of CNCF
   graduated projects use Apache 2.0. Adopting the same license reduces
   friction for corporate adoption and for joining a foundation (CNCF
   requires Apache 2.0 for graduated projects).

3. **Permissive enough for broad adoption.** Apache 2.0 does not
   require derivative works to be open source. This is critical for
   AAFP: agents built on AAFP may be proprietary (e.g., a commercial
   vision agent). A copyleft license would deter the very adoption the
   network effect depends on.

4. **Compatible with MIT.** Apache 2.0 can include MIT-licensed code
   (with attribution). This allows AAFP to depend on the Rust ecosystem,
   much of which is MIT or Apache-2.0 dual-licensed.

The current repository already declares `MIT OR Apache-2.0` in the
workspace `Cargo.toml`. This dual-license is acceptable and common in
Rust (it is the default for many crates). The recommendation is to
**keep the dual license** for the reference implementation crates (to
maximize compatibility with the Rust ecosystem) but to license the
**RFC specification documents** under Apache 2.0 only, because
specifications benefit from the explicit patent grant and because a
single license simplifies the IP story for implementers.

### 1.3 MIT — Acceptable, Weaker

MIT is permissive and trivially simple. Its weakness for AAFP is the
absence of an explicit patent grant. The MIT license is widely
interpreted to grant an implied patent license, but this is case law,
not statutory text. For a cryptography-heavy protocol, relying on
implied grants is a risk.

If AAFP were a pure application with no novel cryptographic or
algorithmic content, MIT would be sufficient. For infrastructure that
others will implement independently, Apache 2.0's explicit grant is
worth the additional text.

### 1.4 AGPL — Not Recommended

AGPL-3.0 (Affero General Public License) is a strong copyleft license
that triggers source-disclosure obligations on network use, not just
distribution. It is sometimes proposed for protocols to prevent cloud
providers from offering a hosted version without contributing back.

AGPL is **not recommended** for AAFP for these reasons:

1. **It deters adoption.** Many companies have a "no AGPL" policy and
   will not use, link, or depend on AGPL software. For a protocol that
   needs network effects, reducing the pool of potential participants
   is strategically catastrophic. The moat is the network, not the
   license.

2. **It does not protect the protocol.** AGPL protects a specific
   implementation's source code. It does not prevent someone from
   writing a clean-room implementation of the AAFP RFCs under a
   different license. The protocol itself is protected by trademark and
   conformance testing, not by copyleft on a reference implementation.

3. **It complicates the specification license.** Specifications under
   AGPL create ambiguity: does implementing the spec create a derivative
   work? This legal uncertainty deters implementers. Specifications
   should be under a permissive license with an explicit patent grant
   (Apache 2.0 or a dedicated spec license like the W3C's).

4. **The strategic vision is anti-silo.** `STRATEGIC_VISION.md` says
   the competitor is cloud silos, and the winning strategy is to own
   the **open graph**. AGPL's friction works against openness. The
   better anti-cloud-silo strategy is a permissive license plus a
   strong trademark/conformance regime (so only interoperable
   implementations can call themselves "AAFP").

### 1.5 Recommendation Summary

| Artifact | License |
|----------|---------|
| RFC specification documents | Apache 2.0 |
| Rust reference implementation | MIT OR Apache-2.0 (dual, Rust ecosystem convention) |
| Go interop implementation | MIT OR Apache-2.0 |
| Conformance test suite | Apache 2.0 |
| Documentation, tutorials, examples | CC-BY-4.0 (docs) / Apache 2.0 (code examples) |

### 1.6 SPDX Identifiers

Every crate, RFC file, and significant source file should carry an SPDX
license identifier. This enables automated license scanning (which
corporate adopters run before using any dependency) and reduces legal
review friction.

```
SPDX-License-Identifier: Apache-2.0
SPDX-License-Identifier: MIT OR Apache-2.0
```

---

## 2. Governance Model

### 2.1 The Three Archetypes

Open source governance typically falls into one of three archetypes:

1. **BDFL (Benevolent Dictator For Life).** A single individual holds
   final decision authority. Examples: Linux (Linus Torvalds), Python
   (Guido van Rossum, until 2018), Django (originally). Fast, coherent,
   personality-dependent. Works when the dictator is trusted and
   available. Fails on succession, burnout, or capture.

2. **Meritocracy.** Authority is earned through sustained contribution
   and granted by existing maintainers. Decisions are made by consensus
   among maintainers, with voting as a fallback. Examples: Apache
   Software Foundation projects, FreeBSD, early Kubernetes. Slower but
   more durable. Risk: "merit" can be gamed or correlated with
   privilege.

3. **Foundation / Vendor-neutral.** A legal entity (foundation) holds
   the trademark, IP, and infrastructure. A governing board (often
   mixed: technical steering committee + corporate sponsors) sets
   policy. Examples: CNCF (Kubernetes, gRPC, Envoy), LF AI & Data,
   Eclipse Foundation, Rust Foundation. Most durable and credible for
   infrastructure. Highest overhead.

### 2.2 Recommended Model for AAFP: Meritocracy → Foundation

AAFP should adopt a **meritocratic governance model now**, with an
explicit roadmap to **foundation governance** once adoption justifies
it. The rationale:

- **Now (Phase 1–2):** AAFP has a single primary author and a small
  set of contributors. A BDFL model is de facto in effect. Formalizing
  meritocracy early — with documented maintainer roles, a contribution
  pipeline, and a transparent RFC process — builds the habits and
  artifacts that make the later transition to foundation governance
  smooth. It also signals seriousness to potential adopters.

- **Later (Phase 3+):** Once AAFP has multiple independent
  implementations, corporate adopters, and a contributor base beyond
  the original author, it should join a foundation. The two most
  relevant foundations are **CNCF** (Cloud Native Computing Foundation,
  under the Linux Foundation) and **LF AI & Data** (also under the
  Linux Foundation, focused on AI/ML/data projects).

### 2.3 Why CNCF vs LF AI & Data

| Foundation | Focus | Fit for AAFP |
|------------|-------|--------------|
| CNCF | Cloud-native infrastructure (orchestration, networking, observability) | Strong: AAFP is infrastructure; QUIC/transport aligns with CNCF networking projects (gRPC, Envoy, Cilium) |
| LF AI & Data | AI/ML frameworks, data platforms, model interoperability | Strong: AAFP is agent infrastructure; aligns with agent/AI ecosystem projects |

**Recommendation:** CNCF is the better fit for the **transport and
infrastructure** identity of AAFP. AAFP is "the protocol layer," not
"the AI framework." CNCF's experience with gRPC (a protocol), Envoy (a
proxy), and Cilium (a data plane) is directly relevant. LF AI & Data
is a viable alternative if AAFP's identity shifts toward "agent
framework" rather than "protocol."

Joining CNCF as a **Sandbox** project is the entry point. The maturity
ladder is Sandbox → Incubating → Graduated. Each stage has governance,
adoption, and health requirements. AAFP should target Sandbox within
6–12 months of open-sourcing, Incubating once there are multiple
production adopters, and Graduated once AAFP is a widely adopted
standard.

### 2.4 Governance Structure (Meritocratic Phase)

```
                    ┌─────────────────────────┐
                    │   Project Lead (BDFL    │
                    │   during transition)    │
                    └───────────┬─────────────┘
                                │
                    ┌───────────▼─────────────┐
                    │  Technical Steering     │
                    │  Committee (TSC)        │
                    │  (core maintainers)     │
                    └───────────┬─────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            │                   │                   │
   ┌────────▼───────┐  ┌────────▼───────┐  ┌────────▼───────┐
   │  RFC Editors   │  │  Area          │  │  Community     │
   │  (spec group)  │  │  Maintainers   │  │  Working Groups│
   └────────────────┘  └────────────────┘  └────────────────┘
```

**Roles:**

- **Project Lead.** Holds tie-breaking authority during the
  meritocratic phase. Expected to delegate most decisions to the TSC.
  This role is sunset when the project joins a foundation.

- **Technical Steering Committee (TSC).** The set of core maintainers.
  Responsible for architectural decisions, RFC acceptance, maintainer
  appointments, and dispute resolution. Membership is by merit
  (sustained, high-quality contribution). The TSC uses consensus
  seeking; a formal vote (lazy consensus or majority) is the fallback.

- **RFC Editors.** A subset of the TSC responsible for the editorial
  quality of RFCs (formatting, cross-references, lifecycle
  transitions). RFC Editors do not have veto power over technical
  content; they ensure the process is followed.

- **Area Maintainers.** Maintainers responsible for a specific area
  (e.g., transport, DHT, NAT traversal, SDK, conformance). Area
  maintainers have merge authority for their area and a seat on the TSC
  if their area is significant.

- **Contributors.** Anyone who submits a contribution (code, docs, RFC
  draft, issue report, review). Contributors become maintainers through
  sustained, high-quality contribution and nomination by an existing
  maintainer.

### 2.5 Decision Rules

- **Lazy consensus.** For most decisions, a proposal is posted
  publicly. If no maintainer objects within a default period (5
  business days for routine, 10 for significant), the proposal is
  accepted. This avoids vote fatigue.

- **TSC vote.** For contested decisions, the TSC votes. A simple
  majority of participating TSC members is required. The Project Lead
  may break ties during the meritocratic phase.

- **RFC acceptance.** RFCs require TSC approval (see Section 3). A
  Standards-Track RFC requires at least two TSC members to sponsor it.

- **One-way doors.** Per `STRATEGIC_VISION.md` ("Think in decades"),
  decisions that are difficult to reverse (wire format changes, crypto
  algorithm changes, version numbering) require a supermajority (2/3)
  of the TSC and an explicit "one-way door" finding in the decision
  record.

### 2.6 Foundation Transition Checklist

When AAFP joins a foundation:

1. **Trademark transfer.** The AAFP name and logo are assigned to the
   foundation. The foundation's trademark policy governs use.
2. **IP assignment / license.** Contributions are licensed (not
   assigned) to the foundation under the DCO (see Section 8). No CLA
   is required if the foundation accepts DCO-only.
3. **Infrastructure transfer.** GitHub organization, CI, domains, and
   package registries are transferred to the foundation's ownership.
4. **Governance update.** The Project Lead role is sunset. The TSC
   becomes the foundation's technical governing body. A governing
   board (with corporate seats) may be established per the foundation's
   charter.
5. **CLAs / DCO.** If the foundation requires a DCO, it is enforced via
   `git` sign-off (no separate CLA). If the foundation requires a CLA
   (e.g., CNCF's EasyCLA), the project complies but should prefer
   DCO-only where the foundation permits.

---

## 3. RFC Process: How Proposals Become Standards

### 3.1 The RFC-0001 through RFC-0009 Model

AAFP already has 11 RFCs (0001–0011) frozen at Revision 6. The RFC
process is the core governance mechanism for the protocol. This
section formalizes how new RFCs are proposed, reviewed, and accepted.

The numbering model is sequential: RFC-0001, RFC-0002, …, RFC-NNNN.
Once assigned, a number is never reused. An RFC that is superseded is
marked `Obsoleted by: RFC-XXXX` but retains its number. This is the
IETF convention and ensures stable references.

### 3.2 RFC Types

| Type | Purpose | Example |
|------|---------|---------|
| Standards Track | Defines normative protocol behavior | RFC-0002 (Transport), RFC-0003 (Identity) |
| Informational | Provides guidance, no normative requirements | RFC-0001 (Overview) |
| Extension | Adds an optional or negotiated extension | RFC-0009 (Pub/Sub), RFC-0010 (Circuit Relay) |
| Binding | Defines a transport binding for another protocol | RFC-0007 (MCP), RFC-0008 (A2A) |
| Process | Defines governance, process, or policy | This document, if it becomes an RFC |

### 3.3 RFC Lifecycle

The lifecycle is already defined in RFC-0006 Section 2.5 and is
restated here for governance clarity:

```
Draft → Freeze Candidate → Proposed → Stable
                                    ↓
                                 Deprecated → Retired
```

| Transition | Requirement |
|------------|-------------|
| Draft → Freeze Candidate | Internal review complete; no known architectural issues; no new features to be added |
| Freeze Candidate → Proposed | Independent specification review complete; ≥1 implementation in progress |
| Proposed → Stable | ≥2 independent interoperable implementations pass conformance tests |
| Stable → Deprecated | Superseded by a newer RFC; grace period of one major version |
| Deprecated → Retired | Removed; ALPN identifiers may be reassigned |

### 3.4 Proposal Workflow

1. **Pre-proposal (Discussion).** The author opens a GitHub Discussion
   or issue titled "RFC Proposal: <topic>" to gauge interest and gather
   feedback before writing a full RFC. This avoids wasted effort on
   proposals that lack support.

2. **Draft.** The author submits a PR adding a new file
   `RFCs/NNNN-title.md` with `Status: Draft`. The RFC Editor assigns
   the next number. The draft must include:
   - Title, author, type, status header (matching existing RFC format)
   - Overview and motivation
   - Detailed specification (normative sections using RFC 2119 keywords)
   - Backward compatibility analysis
   - Security considerations
   - IANA/registry considerations (if any)
   - Answers to the four architecture questions (see 3.5)

3. **Review.** The TSC reviews the draft. Public comment period is a
   minimum of 14 days. The author iterates on the draft based on
   feedback.

4. **Sponsorship.** For Standards-Track RFCs, at least two TSC members
   must sponsor (agree to shepherd) the RFC.

5. **Freeze Candidate.** When the draft is believed complete, the
   author requests Freeze Candidate status. The TSC votes. If accepted,
   the status header is updated and no new features may be added.

6. **Implementation.** One or more implementations are built against
   the Freeze Candidate. Discrepancies are filed as amendments (see
   RFC-0006 Section 11.2).

7. **Proposed.** When independent specification review is complete and
   ≥1 implementation is in progress, the RFC advances to Proposed.

8. **Stable.** When ≥2 independent implementations pass conformance
   tests, the RFC advances to Stable. Changes now require a new
   revision with explicit justification.

### 3.5 The Four Architecture Questions

Per the existing amendment process (RFC-0006 Section 11.2), every RFC
and amendment must answer four architecture questions. These are the
"acid test" from `STRATEGIC_VISION.md`:

1. **Does this make the network more intelligent, or merely more
   complicated?** (The Acid Test)
2. **Is this a one-way door?** (If this becomes as important as TCP,
   what decision becomes impossible to undo?)
3. **Does this bake an algorithm into the protocol, or an interface?**
   (The protocol should specify interfaces, not algorithms.)
4. **Does this preserve the immutable boundary?** (Wire format stays
   stable; intelligence evolves above it.)

An RFC that fails any of these questions should be deferred or
rejected unless the TSC grants an explicit exception with recorded
justification.

### 3.6 Amendment Process (for Frozen RFCs)

Changes to Stable or Freeze Candidate RFCs follow the amendment
process already defined in RFC-0006 Section 11.2:

1. **Amendment proposal** — Document the issue, proposed change,
   rationale, affected RFCs, wire protocol impact, backward
   compatibility analysis, and answers to the four architecture
   questions.
2. **Approval gate** — Produce an impact matrix (normative/informative
   status, wire changes, crypto changes, backward compatibility,
   version impact, risk of future regret, recommendation). Identify
   one-way doors.
3. **Application** — Apply only approved amendments. Update RFCs,
   `RFC_CHANGELOG.md`, and `AMENDMENT_STATUS.md`.
4. **Revision** — New RFC revision with changelog entry.

### 3.7 RFC Editorial Standards

- All RFCs use the existing header format (Status, Number, Title,
  Author, Created, Revised, Type, Obsoletes, Obsoleted by).
- Normative language follows RFC 2119 (MUST, SHOULD, MAY).
- Cross-references use the form "RFC-0002 Section 3.1".
- Code examples are illustrative, not normative, unless marked
  otherwise.
- Each RFC is a single Markdown file in `RFCs/`.

---

## 4. Maintainer Structure

### 4.1 Tiers

AAFP uses a three-tier maintainer structure:

| Tier | Role | Authority | How Attained |
|------|------|-----------|--------------|
| Core Maintainer | TSC member | Merge anywhere; RFC sponsorship; TSC vote | Nominated by a core maintainer; approved by TSC; demonstrated sustained, high-quality contribution across multiple areas |
| Area Maintainer | Owner of a specific area | Merge within their area; propose RFCs for their area | Nominated by a core maintainer; approved by TSC; demonstrated sustained contribution in the area |
| Contributor | Anyone | Submit PRs, issues, RFC drafts | First contribution |

### 4.2 Core Maintainers

Core maintainers form the TSC. Responsibilities:

- Review and merge PRs across all areas (with deference to area
  maintainers for their areas).
- Sponsor and review RFCs.
- Vote on governance and architectural decisions.
- Mentor contributors and area maintainers.
- Ensure the conformance test suite stays in sync with the RFCs.

Core maintainers are expected to remain active. A core maintainer with
no commits, reviews, or RFC participation for 6 months is moved to
**Emeritus** status (retained in acknowledgments, loses TSC vote, can
return by request). This prevents stale governance.

### 4.3 Area Maintainers

Areas are defined by the architecture. Initial areas:

| Area | Scope |
|------|-------|
| Transport & Framing | RFC-0002, QUIC, CBOR, frame encoding |
| Identity & Crypto | RFC-0003, ML-DSA-65, X25519MLKEM768, UCAN |
| Discovery | RFC-0004, Kademlia DHT, capability routing |
| NAT Traversal | RFC-0010, relay, AutoNAT, DCuTR |
| Bindings | RFC-0007 (MCP), RFC-0008 (A2A) |
| SDK & DX | Rust SDK, Python adapter, TypeScript SDK, CLI |
| Conformance | Test suite, interop harness, Go validation impl |
| Security | Threat model, audits, disclosure process |
| Documentation | Tutorials, examples, deployment guides |

Area maintainers have merge authority for their area. They are expected
to consult the TSC for changes that cross area boundaries or affect the
wire format.

### 4.4 Contributors

Contributors are the pipeline. Anyone can become a contributor by
submitting a PR, issue, RFC draft, or review. The contribution pipeline
(Section 5) is designed to convert contributors into maintainers over
time.

### 4.5 Maintainer Onboarding

When a contributor is nominated for area or core maintainer status:

1. A core maintainer opens a nomination issue with the contributor's
   name, contributions, and rationale.
2. Public comment period of 7 days.
3. TSC vote (lazy consensus; if objected, majority vote).
4. On approval, the new maintainer is added to the GitHub team, given
   merge permissions, and listed in `MAINTAINERS.md`.

### 4.6 Maintainer Offboarding

A maintainer may step down voluntarily at any time (moved to Emeritus).
A maintainer may be removed by a 2/3 TSC vote for violation of the Code
of Conduct, sustained inactivity, or actions harmful to the project.
Offboarding must be documented in the TSC decision record.

---

## 5. Contribution Pipeline

### 5.1 Good First Issues

The project maintains a `good first issue` label on GitHub for issues
that are:

- Self-contained (do not require deep protocol knowledge)
- Well-scoped (clear acceptance criteria)
- Documented (links to relevant RFCs, code, and tests)
- Mentored (an area maintainer is assigned to help)

Good first issues are the entry point for new contributors. The project
should maintain at least 10–20 open good first issues at all times.
When the pool drops low, area maintainers create new ones from their
backlogs.

### 5.2 Mentorship

- **Issue mentorship.** Every good first issue has an assigned mentor
  (an area or core maintainer) who responds to questions, reviews the
  PR, and guides the contributor to merge.
- **RFC mentorship.** Contributors proposing their first RFC are paired
  with an RFC Editor who helps with format, normative language, and
  the four architecture questions.
- **Pair review.** New maintainers-in-training co-review PRs with an
  experienced maintainer before reviewing independently.

### 5.3 Review Process

1. **PR opened.** The contributor opens a PR against the relevant
   repository. CI runs automatically (build, test, fmt, clippy,
   conformance).
2. **Automated checks.** CI must pass before human review. This
   includes: `cargo test --workspace`, `cargo fmt --check`, `cargo
   clippy -- -D warnings`, and the conformance test suite.
3. **Human review.** At least one maintainer reviews. For changes
   affecting the wire format or an RFC, at least two maintainers
   (including one core maintainer) must approve.
4. **RFC-linked PRs.** PRs that implement or change an RFC must
   reference the RFC and, if normative, include an amendment proposal.
5. **Merge.** Once approved and CI is green, an area maintainer (or
   core maintainer) merges. Squash-and-merge is the default to keep
   history clean; the commit message follows Conventional Commits.

### 5.4 Conventional Commits

Commits follow Conventional Commits for changelog generation:

```
feat(transport): add 0-RTT resumption support
fix(dht): correct k-bucket eviction logic
docs(rfc): clarify extension negotiation in RFC-0002
test(conformance): add handshake extension test cases
chore(ci): bump Rust toolchain to 1.82
```

### 5.5 Contribution Ladder

```
First PR (good first issue)
    ↓
Repeat contributor (3+ merged PRs)
    ↓
Area contributor (owns a non-trivial feature in an area)
    ↓
Area maintainer (nominated, TSC-approved)
    ↓
Core maintainer (nominated, TSC-approved, cross-area contribution)
```

Each rung has documented expectations. The ladder is published in
`CONTRIBUTING.md` so contributors know how to advance.

---

## 6. Code of Conduct

### 6.1 Adoption of the Contributor Covenant

AAFP adopts the **Contributor Covenant** (v2.1), the most widely used
code of conduct in open source (used by Kubernetes, Rust, Rails, Swift,
and thousands of others). The full text is included in
`CODE_OF_CONDUCT.md`.

The Contributor Covenant establishes:

- A commitment to a harassment-free experience for everyone regardless
  of age, body size, disability, ethnicity, gender identity and
  expression, level of experience, education, socio-economic status,
  nationality, personal appearance, race, religion, or sexual identity
  and orientation.
- Standards for acceptable and unacceptable behavior.
- Enforcement responsibilities for maintainers.
- A reporting and enforcement process.

### 6.2 Enforcement

- **Reports.** Code of Conduct violations are reported to a dedicated
  committee (initially the TSC; ideally a separate Code of Conduct
  Committee once the project is large enough). Reports are
  confidential.
- **Response.** Acknowledgment within 48 hours. Investigation within
  7 days. The committee communicates its findings and any sanctions to
  the reporter and the accused.
- **Sanctions.** Ranging from a private warning, to a public warning,
  to a temporary ban from project spaces, to a permanent ban and
  removal of maintainer status. Sanctions are proportionate to the
  violation.
- **Transparency.** Aggregate (de-identified) reports of enforcement
  actions are published periodically so the community can see that the
  CoC is enforced, not merely posted.

### 6.3 Why a CoC Matters for a Protocol

For a protocol seeking foundation adoption and broad corporate use, a
Code of Conduct is a prerequisite, not optional. CNCF and most
foundations require a CoC aligned with their own. A project without a
CoC signals that it is not ready for institutional participation.

---

## 7. Funding Model

### 7.1 Funding Channels

AAFP can be funded through a combination of channels, each with
different trade-offs:

| Channel | Best For | Risk |
|---------|----------|------|
| GitHub Sponsors | Individual contributors, small amounts | Low; no governance influence |
| Open Collective | Transparent community treasury | Low; community-controlled |
| Foundation grants | Sustained development, audits | Medium; reporting overhead |
| Corporate sponsorship | Dedicated engineering time | Medium; must not buy governance |

### 7.2 GitHub Sponsors

GitHub Sponsors allows individuals and companies to sponsor
maintainers directly. This is the lowest-friction channel for
small-scale funding. It is appropriate for funding individual
maintainer time (e.g., paying a maintainer to work on AAFP part-time).

**Policy:** GitHub Sponsors funds go to the individual maintainer, not
the project. Sponsorship does not confer any governance influence.
Sponsors are acknowledged but do not get priority on RFCs, PRs, or
roadmap.

### 7.3 Open Collective

Open Collective provides a transparent treasury for open source
projects. Funds are held by a fiscal host (e.g., Open Source
Collective 501(c)(6)) and disbursed against approved expenses. All
income and expenses are public.

**Use cases:** Paying for infrastructure (CI, domains, hosting),
bounties for specific issues, security audits, conference travel for
maintainers, documentation work.

**Policy:** The TSC approves expenses. No single corporate contributor
may fund more than 50% of the annual budget (to prevent capture). All
expenditures are public.

### 7.4 Foundation Grants

Once AAFP joins a foundation, it becomes eligible for foundation
grants. CNCF and LF AI & Data offer grants for security audits,
documentation, and dedicated development. These grants typically
require a proposal and reporting but do not confer governance
influence.

**Target:** Use foundation grants for the first independent security
audit (a prerequisite for CNCF Incubating), conformance test suite
development, and SDK work in the three target languages (Rust, Python,
TypeScript).

### 7.5 Corporate Sponsorship

Companies may sponsor AAFP by employing maintainers to work on the
project (the model used by Google for Kubernetes, by Microsoft for
TypeScript, by AWS for Rust). This is the most powerful funding model
because it provides sustained engineering capacity.

**Policy (critical):**

- Corporate-employed maintainers participate **as individuals**, not as
  representatives of their employer. Their TSC vote is theirs, not
  their employer's.
- No corporate sponsor may hold more than 1/3 of TSC seats. This is a
  hard cap to prevent governance capture.
- Corporate sponsorship is acknowledged publicly but does not appear
  in the protocol, RFCs, or conformance artifacts. There are no
  "sponsor tiers" that buy roadmap influence.
- If a corporate sponsor wants a feature, they follow the normal RFC
  process. Money does not skip the queue.

### 7.6 Funding and the Strategic Vision

`STRATEGIC_VISION.md` warns against becoming "the blockchain of AI" and
emphasizes that the moat is network effects, not a token or paywall.
The funding model must reinforce this: the protocol is free, open, and
neutral. Funding sustains the people who build it; it does not buy
control of the protocol.

---

## 8. IP Policy: DCO vs CLA

### 8.1 The Choice

Open source projects use one of two mechanisms to ensure contributors
have the right to contribute their code:

- **DCO (Developer Certificate of Origin).** The contributor signs off
  on each commit (`git commit -s`), attesting that they have the right
  to submit the code under the project's license. No separate
  agreement. Used by Linux, Kubernetes (post-EasyCLA reform efforts),
  many CNCF projects.

- **CLA (Contributor License Agreement).** The contributor signs a
  separate legal agreement granting the project (or its foundation)
  additional rights, typically including a patent grant and sometimes
  a copyright license or assignment. Used by many corporate-backed
  projects (e.g., Google projects, Apache Software Foundation via
  ICLA/CCLA).

### 8.2 Recommendation: DCO (no CLA)

AAFP should use the **DCO only**, with no CLA. Reasons:

1. **Lower friction.** The DCO requires only `git commit -s` (a
   sign-off line). No separate signing step, no CLA bot gating PRs.
   This reduces contributor drop-off, especially for first-time
   contributors.

2. **No copyright assignment.** The DCO does not assign copyright.
   Contributors retain their copyright; they license the contribution
   under the project's existing license (Apache 2.0 / MIT). This is
   more contributor-friendly and avoids the resentment that CLAs (and
   especially copyright assignment CLAs) generate.

3. **Sufficient for foundations.** CNCF accepts DCO-only projects. The
   Linux Foundation's DCO (developed for the Linux kernel) is the
   industry standard. A CLA is not required for CNCF Sandbox or
   Incubating.

4. **Avoids CLA controversy.** CLAs (especially those with broad
   patent grants or relicense clauses) have been a source of
   controversy in open source. The DCO avoids this entirely.

### 8.3 DCO Enforcement

- Every commit must include a `Signed-off-by: Name <email>` line.
  This is added by `git commit -s`.
- A DCO Pro bot (or equivalent) checks that every commit in a PR is
  signed off. PRs without sign-off fail CI.
- The `CONTRIBUTING.md` file documents the DCO requirement and how to
  sign off.

### 8.4 The DCO Text

The DCO (version 1.1) is short and well understood:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.

Developer's Statement of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I have
    the right to submit it under the open source license indicated in
    the file; or

(b) The contribution is based upon previous work that, to the best of
    my knowledge, is covered under an appropriate open source license
    and I have the right under that license to submit that work with
    modifications, whether created in whole or in part by me, under
    the same open source license (unless I am permitted to submit
    under a different license), as indicated in the file; or

(c) The contribution was provided directly to me by some other person
    who certified (a), (b) or (c) and I have not modified it.

(d) I understand and agree that this project and the contribution are
    public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.

(e) I represent that I am legally entitled to grant the rights
    described in this certificate. I understand that copying,
    modifying, distributing, and/or using this contribution may
    involve patent infringement and I hereby agree to indemnify and
    defend the project against any such claims.
```

### 8.5 If a Foundation Requires a CLA

If AAFP joins a foundation that requires a CLA (e.g., CNCF's EasyCLA
for some projects), the project complies with the foundation's
requirement. However, the project should advocate for DCO-only within
the foundation and prefer foundations that accept DCO-only (the
trend in the Linux Foundation is toward DCO acceptance).

---

## 9. Trademark Policy

### 9.1 Why Trademark Matters

The AAFP name and logo are the project's identity. Trademark policy
determines who can use them and under what conditions. This is the
primary mechanism (more than the license) for preventing
fragmentation and ensuring that anything called "AAFP" is actually
interoperable AAFP.

### 9.2 Ownership

- **Meritocratic phase:** The trademark is held by the project lead (or
  a designated legal entity) in trust for the community.
- **Foundation phase:** The trademark is assigned to the foundation,
  which manages it under the foundation's trademark policy.

### 9.3 Permitted Uses

The following uses of the AAFP name and logo are permitted without
explicit permission:

- **Factual reference.** "This software implements the AAFP protocol"
   or "AAFP-compatible" in documentation, blog posts, and marketing,
   provided the use is factual and does not imply endorsement.
- **Forking for development.** A fork maintained for development or
   experimentation may use the name with a distinguishing suffix
   (e.g., "AAFP-experimental-fork").
- **Community use.** Meetups, tutorials, and educational materials
   that use the AAFP name and logo to discuss the project.

### 9.4 Restricted Uses

The following require explicit permission from the trademark holder:

- **Distributing software under the AAFP name.** A distribution or
   product named "AAFP" (without a distinguishing suffix) requires a
   trademark license, granted only if the software passes the
   conformance test suite.
- **Using the AAFP logo on a product or service.** The logo may not be
   used to imply endorsement or certification without permission.
- **Certification marks.** A "AAFP Certified" or "AAFP Compliant" mark
   requires passing the conformance test suite and a trademark
   license.

### 9.5 Conformance and the Trademark

The trademark is the enforcement mechanism for conformance. Only
implementations that pass the conformance test suite may use the AAFP
name in their product name or claim "AAFP Compliant." This prevents
the protocol from fragmenting into incompatible dialects — the fate
of many protocols that lacked a conformance regime (e.g., early XMPP
implementations).

This is the same model used by Kubernetes (CNCF Certified Kubernetes)
and POSIX (IEEE/The Open Group certification).

### 9.6 Domain and Social Media

The project maintains `aafp.dev` (or equivalent) and the `@aafp`
social handles. These are project assets, not personal assets, and
transfer with the trademark to the foundation.

---

## 10. Compatibility Policy

### 10.1 What Constitutes a Breaking Change

AAFP's compatibility policy is defined in RFC-0006 Section 11.4 and
elaborated here. A change is **breaking** if it causes a conforming
implementation of the prior version to fail to interoperate with a
conforming implementation of the new version.

Specifically, a change is breaking if it:

1. **Changes the wire format** of an existing frame type, extension,
   or field in a way that an old receiver cannot process.
2. **Changes the semantics** of an existing field (e.g., redefining
   what an error code means).
3. **Changes the handshake** in a way that prevents connection
   establishment between old and new implementations.
4. **Changes the identity or crypto algorithms** in a way that old
   implementations cannot verify (e.g., changing the AgentId
   derivation).
5. **Removes a mandatory feature** without a deprecation grace period.

### 10.2 What Is NOT a Breaking Change

- Adding a new optional field to a CBOR structure (old implementations
  skip unknown fields per RFC-0006 Section 6.1).
- Adding a new non-critical extension type (old implementations skip
  it).
- Adding a new non-critical frame type (old implementations skip it).
- Adding a new error code (old implementations use category-based
  handling).
- Changing an algorithm above the wire layer (routing, scheduling,
  trust scoring) — these are implementation concerns, not protocol
  changes.

### 10.3 The Immutable Boundary

Per `STRATEGIC_VISION.md`, the wire protocol is frozen. The immutable
boundary:

```
STABLE (frozen, barely changes):      EVOLVING (changes constantly):
- Frame format (RFC-0002)             - Routing algorithms
- Handshake (RFC-0003)                - Discovery semantics
- Identity (AgentId, ML-DSA-65)       - Scheduling strategies
- CBOR encoding                       - Trust scoring
- QUIC transport                      - Reputation systems
- Version negotiation (RFC-0006)      - Economic models
```

Changes to the stable layer require a new protocol version (e.g.,
v1 → v2) and a supermajority TSC vote. Changes to the evolving layer
do not require RFC changes at all — they are implementation choices.

### 10.4 Versioning and Compatibility

- **Same major version:** Implementations MUST be wire-compatible.
  Changes within a major version MUST be backward compatible (new
  fields optional, existing fields retain semantics).
- **Cross major version:** No compatibility required. Migration paths
  SHOULD be documented. ALPN negotiation (`aafp/1`, `aafp/2`) prevents
  accidental cross-version connections.
- **Extension compatibility:** New extensions MUST NOT break
  implementations that do not support them.

### 10.5 Deprecation Policy

Per RFC-0006 Section 7.4:

1. **Deprecation notice:** An RFC marks the feature as deprecated.
2. **Grace period:** The feature remains for at least one major version
   cycle.
3. **Removal:** The feature is removed in a new major version.

Deprecated features MUST NOT be removed within the same major version.

---

## 11. Security Disclosure Process

### 11.1 Existing Process

RFC-0006 Section 11.3 defines a security disclosure process. This
section formalizes and strengthens it.

### 11.2 Reporting

- **Channel:** GitHub Private Security Advisories (the project's
  primary channel until a dedicated security contact email is
  established).
- **What to report:** Vulnerabilities in the AAFP protocol, the
  reference implementation, or any official implementation that could
  allow an attacker to compromise identity, authorization, transport
  confidentiality, or availability.
- **What NOT to report:** Feature requests, general bugs, or questions
  (use public issues for these).

### 11.3 Response Timeline

| Step | SLA |
|------|-----|
| Acknowledgment of report | 48 hours |
| Initial assessment (severity, impact) | 7 days |
| Fix development | Severity-dependent (see below) |
| Coordinated disclosure | After fix is available + grace period |

### 11.4 Severity and Fix Timelines

| Severity | Description | Target Fix Time | Disclosure Embargo |
|----------|-------------|-----------------|--------------------|
| Critical | Remote code execution, identity forgery, auth bypass | 7 days | 30 days post-fix |
| High | DoS, downgrade attack, data leak | 14 days | 60 days post-fix |
| Medium | Logic errors with limited impact | 30 days | 90 days post-fix |
| Low | Hardening, minor issues | Next release | Coordinated |

### 11.5 Fix Process

1. **Private fix.** The fix is developed in a private branch (GitHub
   security advisory private fork).
2. **Protocol-level fix.** If the vulnerability is in the protocol
   (not just an implementation), an amendment proposal is drafted
   following RFC-0006 Section 11.2. The amendment is reviewed by the
   TSC privately.
3. **Backport.** The fix is backported to all supported versions.
4. **CVE issuance.** A CVE (Common Vulnerabilities and Exposures) is
   requested through GitHub's CVE issuing capability (GitHub is a CVE
   Numbering Authority) or through the foundation's CNA once joined.

### 11.6 Disclosure

- **Coordinated disclosure.** The vulnerability is disclosed publicly
  only after a fix is available and the embargo period has passed (or
  all known affected parties have patched).
- **Security advisory.** A GitHub Security Advisory is published with:
  description, affected versions, CVSS score, CVE ID, fix version, and
  mitigation for users who cannot upgrade immediately.
- **Credit.** The reporter is credited in the advisory unless they
  request anonymity.

### 11.7 Security Team

A security team (subset of core maintainers) is responsible for
triaging reports, developing fixes, and coordinating disclosure.
Security team membership is confidential to prevent targeted social
engineering. The team communicates via a private, encrypted channel.

### 11.8 Bug Bounty (Future)

Once funded, AAFP should participate in a bug bounty program (e.g.,
via the foundation or a platform like HackerOne) to incentivize
responsible disclosure. Bug bounties are particularly important for a
cryptography-heavy protocol where independent review is valuable.

---

## 12. Roadmap Governance

### 12.1 How the Community Influences Priorities

The roadmap is not dictated by a single entity. It is shaped by:

1. **RFC proposals.** Anyone can propose an RFC that, if accepted,
   becomes part of the roadmap. This is the primary mechanism for
   community influence on protocol evolution.
2. **Community discussions.** GitHub Discussions and issues surface
   needs and pain points. The TSC reviews these when planning.
3. **Adopter feedback.** Organizations deploying AAFP in production
   provide feedback on what works and what is missing. This is
   weighted toward production users but does not exclude others.
4. **Working groups.** For large efforts (e.g., the Adaptive Routing
   Plane, Semantic Discovery), a Working Group is formed with a
   charter, a chair, and a deliverable. Working Groups are open to
   anyone.
5. **TSC planning.** The TSC publishes a quarterly roadmap update
   reflecting accepted RFCs, in-flight Working Groups, and priorities
   for the next quarter.

### 12.2 Roadmap Document

A living `ROADMAP.md` documents:

- Current phase and tracks (per `STRATEGIC_VISION.md` phases 1–7)
- Accepted RFCs in flight
- Active Working Groups and their charters
- Priorities for the next quarter
- Deprecation notices

The roadmap is updated quarterly by the TSC based on community input
and project momentum.

### 12.3 The Strategic Vision as Guardrail

`STRATEGIC_VISION.md` serves as the strategic guardrail for the
roadmap. Every roadmap item should be traceable to the vision. The
TSC uses the four architecture questions (Section 3.5) and the Acid
Test ("Does this make the network more intelligent, or merely more
complicated?") to filter roadmap proposals.

Items that do not advance the vision — even if popular — are deferred.
This prevents the roadmap from becoming a wishlist that dilutes
focus.

### 12.4 Phase-Based Prioritization

Per the strategic vision, the phasing is:

| Phase | Focus | Roadmap Priority |
|-------|-------|------------------|
| Phase 1 (done) | Prove the foundation (WAN, security, scale) | Complete |
| Phase 2 (now) | Developer experience (3-line API, CLI, tutorials) | Highest |
| Phase 3 | Ecosystem (SDK in 3 languages, reference apps, plugins) | High |
| Phase 4 | Adaptive routing (capability graphs, execution fabric) | Medium (after ecosystem) |
| Phase 5 | Agent reputation | Lower (after routing) |
| Phase 6 | Economic layer | Lowest (emergent) |

The community can propose work in any phase, but the TSC prioritizes
based on this sequence. Skipping phases (e.g., jumping to the economic
layer before the ecosystem exists) is an anti-pattern the vision
explicitly warns against.

---

## 13. Comparison: How gRPC, Kubernetes, Rust, and Linux Handle Governance

### 13.1 Linux

- **Governance model:** BDFL. Linus Torvalds has final authority on
  what is merged into the mainline kernel. He delegates subsystem
  maintainership (area maintainers) for most of the tree.
- **License:** GPL-2.0 (only). Not permissive. This is unusual for
  infrastructure and reflects the kernel's history (1991) and the
  free software movement's influence.
- **IP policy:** DCO (sign-off). Linux invented the DCO. No CLA, no
  copyright assignment. Contributors retain copyright.
- **Contribution process:** Email-based (LKML), not GitHub PRs. Patches
  are sent to mailing lists, reviewed by subsystem maintainers, and
  pulled by Linus via his merge window cadence.
- **RFC process:** None formal. The kernel evolves through patches and
  discussion, not RFCs. Some subsystems have documentation that acts
  like informal specs.
- **Lessons for AAFP:** The DCO is directly applicable. The BDFL model
  is not — AAFP should not depend on a single individual long-term.
  The subsystem maintainer model maps well to AAFP's area maintainer
  structure.

### 13.2 Kubernetes

- **Governance model:** Foundation (CNCF). A Steering Committee handles
  governance disputes and elections. Technical decisions are made by
  SIGs (Special Interest Groups), each with its own chairs. No BDFL.
- **License:** Apache 2.0.
- **IP policy:** DCO (sign-off). Kubernetes moved away from CLA to
  DCO-only in 2022, a significant and deliberate choice.
- **Contribution process:** GitHub PRs. SIGs own areas (e.g., SIG
  Network, SIG Storage, SIG Auth). Each SIG has chairs and a charter.
- **RFC process:** Kubernetes Enhancement Proposals (KEPs). KEPs are
  the equivalent of RFCs — they propose significant changes, are
  reviewed by the relevant SIG, and must be approved before
  implementation. KEPs include a design doc, graduation criteria, and
  a production readiness review.
- **Trademark:** "Certified Kubernetes" is a CNCF certification mark.
  Only distributions that pass the conformance tests can use it.
- **Lessons for AAFP:** The KEP model is the closest analog to AAFP's
  RFC process. The SIG → area maintainer mapping is direct. The
  Certified Kubernetes conformance + trademark model is exactly what
  AAFP should adopt. Kubernetes' move from CLA to DCO validates the
  DCO recommendation.

### 13.3 Rust

- **Governance model:** Foundation (Rust Foundation) + meritocratic
  teams. The Rust Foundation handles IP, trademark, and funding.
  Technical governance is by teams (Compiler Team, Library Team, Lang
  Team, etc.), each with its own decision-making process. There is no
  BDFL (the original BDFL, Graydon Hoare, stepped away early).
- **License:** MIT OR Apache-2.0 (dual). This is the Rust ecosystem
  convention and is what AAFP's Rust crates already use.
- **IP policy:** DCO-like sign-off is not used; instead, Rust relies on
  the license + the Rust Foundation's IP policy. Contributors retain
  copyright.
- **Contribution process:** GitHub PRs (rust-lang/rust). RFCs for
  language and library changes.
- **RFC process:** Rust RFCs (rust-lang/rfcs). RFCs are proposed,
  reviewed by the relevant team, and accepted or rejected. The RFC
  process is well-documented and includes a comment period, team
  review, and a final comment period (FCP). This is very close to
  AAFP's RFC process.
- **Trademark:** The Rust Foundation owns the Rust trademark and
  logo. Use is governed by a trademark policy that permits factual
  reference and community use but restricts product naming.
- **Lessons for AAFP:** The dual MIT OR Apache-2.0 license is directly
  applicable. The team-based governance (Rust teams → AAFP area
  maintainers) maps well. The RFC process with FCP is a good model for
  AAFP's RFC review. The Foundation + teams separation (foundation
  handles legal/IP, teams handle technical) is the target end state
  for AAFP.

### 13.4 gRPC

- **Governance model:** Foundation (CNCF, graduated). gRPC is a Google
  project donated to CNCF. A small set of maintainers (mostly Google
  employees) holds technical authority, with a governance document
  defining roles. Less formally democratized than Kubernetes.
- **License:** Apache 2.0.
- **IP policy:** DCO (sign-off) for community contributions; Google
  contributions are covered by Google's corporate CLA with CNCF.
- **Contribution process:** GitHub PRs (grpc/grpc). Maintainers review
  and merge. gRPC has a governance document defining maintainers,
  approvers, and the escalation path.
- **RFC process:** gRPC Enhancement Proposals (gRFCs). Similar to
  KEPs. gRPCs propose changes to the protocol, API, or
  implementation. They are reviewed by maintainers and must be
  approved before implementation.
- **Lessons for AAFP:** gRPC is the most directly comparable project —
  it is a protocol (not just an implementation), it is CNCF-graduated,
  and it uses an RFC-like process. The gRFC model is worth studying.
  The risk to avoid: gRPC's heavy Google influence means community
  contributions are harder to land. AAFP should be more open from the
  start, with the corporate-sponsor cap (Section 7.5) preventing the
  single-vendor dynamic.

### 13.5 Summary Comparison

| Dimension | Linux | Kubernetes | Rust | gRPC | AAFP (recommended) |
|-----------|-------|------------|------|------|--------------------|
| Governance | BDFL | Foundation (CNCF) | Foundation + teams | Foundation (CNCF) | Meritocracy → Foundation (CNCF) |
| License | GPL-2.0 | Apache 2.0 | MIT OR Apache-2.0 | Apache 2.0 | Apache 2.0 (specs); MIT OR Apache-2.0 (impl) |
| IP policy | DCO | DCO | License + Foundation IP | DCO + corporate CLA | DCO (no CLA) |
| Proposal process | Patches (no RFC) | KEPs | RFCs | gRFCs | RFCs (existing 0001–0011 model) |
| Trademark | Linus (personal) | CNCF Certified | Rust Foundation | CNCF | Project → Foundation |
| Conformance | None formal | Conformance suite | None (crates.io) | Interop tests | Conformance suite (required) |
| BDFL | Yes (Linus) | No | No | No (Google-influenced) | Transitioning away |

### 13.6 What AAFP Takes from Each

- **From Linux:** The DCO. The subsystem/area maintainer model. The
  lesson that ecosystem must grow before the protocol is "finished."
- **From Kubernetes:** The KEP/RFC process. The Certified Kubernetes
  conformance + trademark model. The SIG → area maintainer mapping.
  The move from CLA to DCO.
- **From Rust:** The dual MIT OR Apache-2.0 license for implementation
  crates. The team-based technical governance. The RFC process with a
  final comment period. The Foundation-handles-legal /
  teams-handle-technical separation.
- **From gRPC:** The gRFC model for a protocol (not just an
  implementation). The CNCF graduation path. The cautionary lesson
  about single-vendor influence.

---

## 14. Implementation Checklist

To operationalize this governance document, the following artifacts
and actions are needed:

### 14.1 Documents to Create

| Document | Purpose | Priority |
|----------|---------|----------|
| `LICENSE` | Apache 2.0 full text (spec repo) | Immediate |
| `LICENSE-MIT` | MIT full text (for dual-licensed impl crates) | Immediate |
| `CODE_OF_CONDUCT.md` | Contributor Covenant v2.1 | Immediate |
| `CONTRIBUTING.md` | Contribution pipeline, DCO, review process, ladder | Immediate |
| `MAINTAINERS.md` | Current maintainers, areas, and roles | Immediate |
| `SECURITY.md` | Security disclosure process, reporting channel | Immediate |
| `TRADEMARK.md` | Trademark policy | Immediate |
| `GOVERNANCE.md` | This document, as a project RFC/governance doc | Immediate |

### 14.2 Tooling to Configure

| Tool | Purpose |
|------|---------|
| DCO Pro bot (or equivalent) | Enforce sign-off on every commit |
| GitHub Security Advisories | Private vulnerability reporting |
| GitHub Discussions | RFC pre-proposals and community discussion |
| `good first issue` / `help wanted` labels | Contribution pipeline entry points |
| Conventional Commits + release-please (or similar) | Automated changelog and versioning |
| Conformance test suite CI | Validate implementations against RFCs |

### 14.3 Process to Establish

| Process | Owner |
|---------|-------|
| RFC proposal workflow (Section 3.4) | RFC Editors |
| Quarterly roadmap update (Section 12.2) | TSC |
| Maintainer nomination / onboarding (Section 4.5) | TSC |
| Security response (Section 11) | Security Team |
| Code of Conduct enforcement (Section 6.2) | CoC Committee |

---

## 15. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Single-vendor capture (one company dominates maintainers) | Corporate-sponsor cap (1/3 TSC seats); foundation governance |
| Protocol fragmentation (incompatible dialects) | Conformance test suite + trademark enforcement |
| RFC process becomes a bottleneck | Lazy consensus; pre-proposal discussion; RFC Editors keep process moving |
| Maintainer burnout | Emeritus status; mentorship pipeline; funded maintainer time |
| Security vulnerability in frozen protocol | Amendment process (RFC-0006 §11.2); private disclosure; CVE issuance |
| Trademark abuse (non-conforming implementations calling themselves AAFP) | Trademark policy + conformance certification |
| CLA controversy deters contributors | DCO-only (no CLA) |
| License incompatibility with dependencies | Dual MIT OR Apache-2.0 for implementation crates; Apache 2.0 for specs |
| Foundation overhead slows the project | Stay meritocratic until adoption justifies foundation; then join, don't build |
| Roadmap drift from strategic vision | Four architecture questions; Acid Test; phase-based prioritization |

---

## 16. Relationship to Existing RFCs

This governance document is consistent with and builds on the
governance provisions already embedded in the RFCs:

- **RFC-0006 Section 11 (Governance)** defines the RFC lifecycle,
  amendment process, security disclosure process, compatibility
  policy, and conformance test suite. This document elaborates and
  extends those provisions into a full open source governance
  framework.
- **RFC-0006 Section 2.5 (Specification Lifecycle)** defines the
  Draft → Freeze Candidate → Proposed → Stable lifecycle. This
  document's RFC process (Section 3) is consistent with that lifecycle.
- **RFC-0006 Section 11.2 (Amendment Process)** defines the amendment
  proposal, approval gate, application, and revision steps. This
  document references and reinforces that process.
- **RFC-0006 Section 11.3 (Security Disclosure)** defines the report →
  acknowledgment → assessment → fix → disclosure flow. This document's
  Section 11 formalizes and strengthens it with SLAs, severity levels,
  and CVE issuance.

Where this document and the RFCs differ in detail, the RFCs are
normative for the protocol; this document is normative for the
project's open source governance. If a conflict arises, an amendment
to the relevant RFC (or to this document) resolves it.

This document may itself be published as an RFC (Process type) to give
it the same lifecycle and amendment protections as the protocol RFCs.

---

## 17. Conclusion

AAFP's strategic vision is to become the operating system of the agent
internet — a foundation as durable as TCP. That ambition requires
governance that is durable, neutral, and trustworthy. The choices in
this document are designed to achieve that:

- **Apache 2.0** for specifications (explicit patent grant, industry
  standard) and **MIT OR Apache-2.0** for implementation crates (Rust
  ecosystem compatibility).
- **Meritocracy now, foundation later** — building the habits and
  artifacts for a smooth transition to CNCF or LF AI & Data governance.
- **RFC process** modeled on the existing RFC-0001–0011 series, with
  the four architecture questions and the Acid Test as guardrails.
- **Three-tier maintainer structure** (core, area, contributor) with a
  documented contribution ladder.
- **Contributor Covenant** code of conduct with enforced sanctions.
- **DCO (no CLA)** for low-friction, contributor-friendly IP policy.
- **Trademark + conformance** to prevent fragmentation — the real
  protection for the protocol, more than the license.
- **Transparent funding** with a corporate-sponsor cap to prevent
  governance capture.
- **Private security disclosure** with SLAs, severity tiers, and CVE
  issuance.
- **Community-influenced roadmap** guided by the strategic vision and
  the four architecture questions.

The protocol is the primary artifact. Governance protects it. If AAFP
governs well, the network effect — the durable moat — will follow.
