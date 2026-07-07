# AAFP Community & Ecosystem Building

**Author:** Research Team
**Date:** 2026-07-04
**Status:** Strategic plan — Phase 2/3 ecosystem activation

---

## Executive Summary

AAFP's wire protocol is frozen (Rev 6, RFCs 0001-0011). The Rust reference
implementation is production-grade (2857 tests, 500-node DHT, 4h stability,
post-quantum TLS). The technology is ready. The question now is: **how does an
open protocol become a movement?**

This document is the community and ecosystem playbook. It covers every surface
through which developers, researchers, companies, and educators encounter
AAFP — from the first GitHub star to a contributed agent on the marketplace,
from a Discord question to a keynote at a major conference.

The strategic thesis, drawn from `STRATEGIC_VISION.md`, is unambiguous:

> **Network effects, not cryptography, become the durable moat.**
>
> In five years almost everyone will have QUIC, post-quantum cryptography,
> CBOR, capability tokens, NAT traversal. Those features will become
> commodities. The lasting advantage will be the network itself: the quality
> of its routing, the richness of its capability graph, the strength of its
> developer ecosystem, the number of interoperable agents already
> participating.

Cryptography got AAFP to v1. Community gets AAFP to ubiquity. This document
is the plan for the latter.

---

## Table of Contents

1. [Community Platforms](#1-community-platforms)
2. [Developer Advocacy Program](#2-developer-advocacy-program)
3. [Educational Content](#3-educational-content)
4. [Hackathon Strategy](#4-hackathon-strategy)
5. [Example Agent Marketplace](#5-example-agent-marketplace)
6. [Plugin Ecosystem](#6-plugin-ecosystem)
7. [Integration Partners](#7-integration-partners)
8. [Academic Outreach](#8-academic-outreach)
9. [Documentation Contribution](#9-documentation-contribution)
10. [Localization](#10-localization)
11. [Community Metrics](#11-community-metrics)
12. [Year 1 Community Goals](#12-year-1-community-goals)
13. [Comparison: How gRPC, Kubernetes, and Rust Built Communities](#13-comparison-how-grpc-kubernetes-and-rust-built-communities)
14. [Phased Rollout Plan](#14-phased-rollout-plan)
15. [Risks and Mitigations](#15-risks-and-mitigations)

---

## 1. Community Platforms

A protocol without a gathering place is a specification nobody reads. AAFP
needs presence on every platform where its target developers already live.
The goal is not to be everywhere — it is to be **excellent** in a small number
of high-leverage places and merely **present** in the rest.

### 1.1 GitHub Discussions

**Role:** The canonical long-form discussion venue. GitHub Discussions is the
primary community surface because it lives next to the code, the RFCs, and the
issues. Developers do not need a separate account or a context switch.

**Structure — categories:**

| Category | Purpose |
|----------|---------|
| `announcements` | Releases, RFC amendments, roadmap updates (read-mostly) |
| `q-and-a` | "How do I…" questions, marked answered when resolved |
| `ideas` | Proposals for new capabilities, plugins, agents — pre-RFC |
| `show-and-tell` | Community projects, demos, blog posts built on AAFP |
| `rfc-discussion` | Public review of draft RFCs before freezing |
| `interop` | Cross-implementation questions (Rust ↔ Go ↔ Python) |
| `community` | Meetups, events, jobs, off-topic-but-relevant |

**Operational rules:**

- Every question gets a response within 24 hours in the first 6 months —
  even if the response is "we're looking into it." Silence kills nascent
  communities.
- Maintain a `FAQ.md` and a pinned "Start Here" discussion. The most common
  questions (key generation, relay setup, Python interop, NAT traversal
  debugging) get canonical answers that are updated, not re-answered.
- Use the `Answered` mechanic. Mark answers. This makes Discussions
  searchable and builds a knowledge base passively.
- Tag maintainers on discussions in their area of expertise. The Rust
  transport maintainer gets pinged on QUIC questions; the crypto maintainer
  on ML-DSA-65 questions. This routes expertise efficiently.

**Why GitHub Discussions and not a forum:** The target audience is
protocol-level developers and systems engineers. They are already on GitHub.
A Discourse forum fragments attention. GitHub Discussions has lower friction
(sign-in with the GitHub account they already have) and ties threads to the
repository that contains the code and RFCs under discussion.

### 1.2 Discord / Matrix

**Role:** Real-time chat — the "hallway track" of the community. This is where
quick questions, pairing, and informal coordination happen. It is also where
new contributors often make first contact before opening a PR.

**Platform decision — run both, bridge them:**

- **Discord** is where the majority of AI/ML and Rust developers already
  congregate. It has the lowest onboarding friction for the target audience.
  Voice channels support office hours and live debugging.
- **Matrix** is the decentralized, end-to-end-encrypted alternative that
  aligns philosophically with AAFP's values (open, federated, no corporate
  owner). A subset of the community — particularly the cryptography and
  decentralization crowd — will insist on it.
- **Bridge them.** Use `matrix-appservice-discord` or a similar bridge so
  that messages flow between the two. No one should be excluded for choosing
  the platform that matches their values. This is itself a demonstration of
  AAFP's interoperability ethos.

**Channel structure (mirrored on both):**

| Channel | Purpose |
|---------|---------|
| `#welcome` | Onboarding, rules, role assignment |
| `#general` | General AAFP discussion |
| `#help` | Quick questions (deeper ones → GitHub Discussions) |
| `#rust` | Rust implementation discussion |
| `#go` | Go implementation discussion |
| `#python` | PyO3 adapter and Python SDK |
| `#rfc-review` | Live discussion of open RFC drafts |
| `#interop` | Cross-implementation and MCP/A2A binding questions |
| `#show-and-tell` | Demos, screenshots, "I built this" |
| `#events` | Meetups, hackathons, conference CFPs |
| `#jobs` | Hiring and gig posts (moderated, AAFP-relevant only) |
| `#random` | Off-topic, but keep it technical and respectful |

**Office hours:** Weekly 1-hour voice session where maintainers are present
and anyone can ask anything. Record the first 10 minutes (announcements) and
post it. The unrecorded Q&A is the real value — it lowers the barrier to
asking "dumb" questions.

**Moderation policy:** A code of conduct (Contributor Covenant 2.1) is
non-negotiable. Two community moderators (not just maintainers) are recruited
by month 3. Discord's built-in AutoMod handles spam; humans handle tone.

### 1.3 Reddit — r/aafp

**Role:** The discovery and broadcast layer. Reddit reaches developers who
are not yet in the GitHub/Discord orbit. It is where release announcements,
blog posts, and major demos get shared to a broader audience.

**Strategy:**

- Create `r/aafp` early, even before there is traffic, to prevent squatting.
- Post major releases, RFC freezes, and conference talks as link posts.
- Write one high-effort "explainer" post per month (e.g., "How AAFP's
  Kademlia DHT handles 500 nodes with churn," "Why we chose ML-DSA-65 over
  Dilithium," "What post-quantum TLS 1.3 means for agent transport").
- Do not cross-post every Discord message. Reddit rewards signal, not
  volume. A single great post per month outperforms weekly noise.
- Engage honestly in comments. The maintainer who says "you're right, that's
  a real limitation, here's the issue I opened" builds more trust than any
  marketing.

**Cross-pollination:** When an `r/aafp` post generates a substantive
discussion, link it in Discord `#general` and summarize in GitHub
Discussions. Funnel the best Reddit questions into the canonical Q&A so the
knowledge persists beyond Reddit's 24-hour half-life.

### 1.4 Stack Overflow — `aafp` tag

**Role:** The durable Q&A surface. Stack Overflow questions are the gift that
keeps giving — a great answer is read for years and ranks in Google. This is
where the long tail of "how do I do X in AAFP" lives.

**Strategy:**

- Create the `aafp` tag and write 10-15 seed questions with comprehensive
  answers covering the most common tasks: generating an identity, connecting
  two agents, setting up a relay, using the Python adapter, debugging NAT
  traversal failures, understanding UCAN capability chains.
- Monitor the tag via RSS. Answer new questions within 24 hours for the first
  year. Unanswered questions on a young tag signal a dead project.
- When answering, always link back to the relevant RFC section and the
  relevant code. This creates a web of references that elevates both the
  documentation's SEO and the protocol's credibility.
- Encourage community members to answer too. The goal is not for maintainers
  to be the only answerers — it is to build a base of knowledgeable
  contributors whose answers earn reputation and authority.

**Tag taxonomy:** `aafp` (umbrella), `aafp-rust`, `aafp-go`, `aafp-python`,
`aafp-dht`, `aafp-nat`, `aafp-crypto`. Sub-tags help searchers find
implementation-specific answers without wading through unrelated content.

### 1.5 Platform Priority and Effort Allocation

| Platform | Priority | Effort | Primary Owner |
|----------|----------|--------|---------------|
| GitHub Discussions | P0 | High | Maintainer team |
| Discord (bridged to Matrix) | P0 | High | Developer advocates |
| Reddit (r/aafp) | P1 | Medium | Developer advocate |
| Stack Overflow | P1 | Medium | Developer advocate + community |
| Matrix | P2 | Low (bridged) | Community moderator |
| Twitter/X, LinkedIn, Mastodon | P2 | Low | Developer advocate (broadcast only) |
| YouTube | P1 | High (content production) | See §3 |
| Hacker News | P1 | Low (major releases only) | Maintainer |

The P0 platforms are where community is **built**. The P1 platforms are
where community is **discovered**. The P2 platforms are where community is
**broadcast**. Do not invert this priority — a community is not built on
Twitter.

---

## 2. Developer Advocacy Program

Developer advocacy is the human bridge between the protocol and the people
who adopt it. AAFP's advocacy program is structured to scale from the
founding team to a global network of ambassadors.

### 2.1 Developer Advocates

**Role:** Full-time or significant-part-time roles within the project.
Developer advocates are not marketers — they are senior engineers who can
build, debug, and teach, and whose advocacy is credible because it is
technical.

**Responsibilities:**

- Write and maintain example applications, tutorials, and blog posts.
- Give conference talks and workshop sessions.
- Staff the Discord `#help` channel and GitHub Discussions `q-and-a`.
- Build relationships with integration partners (LangChain, LlamaIndex,
  Vercel AI SDK — see §7).
- Represent community needs back to the maintainers. The advocate is the
  voice of the user inside the project.
- Identify and recruit ambassadors (§2.2).

**Hiring profile:**

- Deep systems knowledge (Rust or Go, networking, distributed systems).
- Strong writing ability — the advocate's output is primarily written.
- Public speaking comfort — talks are a core deliverable.
- Empathy for beginners. The advocate must remember what it was like to not
  know what a DHT is.

**Year 1 staffing target:** 2 developer advocates. One focused on the
Rust/systems audience, one focused on the Python/AI-application audience.
This split reflects AAFP's two primary developer personas: the infrastructure
engineer building agents and the AI engineer consuming agent capabilities.

### 2.2 Ambassador Program

**Role:** Community members who are not employees but who are recognized,
supported, and amplified by the project. Ambassadors are the local
presence — they run meetups, answer questions in their region or language,
and represent AAFP at events the core team cannot attend.

**Ambassador tiers:**

| Tier | Recognition | Requirements | Benefits |
|------|-------------|--------------|----------|
| **Contributor** | Listed on website | 5+ merged PRs or 20+ accepted answers | AAFP sticker pack, Discord role |
| **Advocate** | Listed + bio on website | 1 talk, 1 blog post, sustained help | AAFP swag, early access to releases |
| **Ambassador** | Featured on website | Run a meetup, 3+ talks, ongoing contribution | Travel funding for 1 conference/year, direct maintainer access, "AAFP Ambassador" title |
| **Senior Ambassador** | Co-maintainer track | Multi-year sustained leadership | Nomination to maintainer/maintainer-emeritus role |

**Selection criteria:** Ambassadors are selected by the maintainers based on
sustained, high-quality contribution — not self-nomination alone. The bar is
not volume; it is impact and reliability. An ambassador who answers 200
questions poorly is less valuable than one who answers 50 excellently.

**Geographic distribution:** Actively recruit ambassadors in regions with
strong developer communities: North America (SF, NYC, Toronto), Europe
(Berlin, London, Paris, Amsterdam), Asia (Tokyo, Seoul, Bangalore,
Singapore), and Latin America (São Paulo, Mexico City). Regional ambassadors
make AAFP a global project, not a Bay Area project.

### 2.3 Meetup Kits

**Role:** A boxed set of resources that lets any ambassador run a high-quality
AAFP meetup without starting from scratch. The kit removes the activation
energy barrier.

**Contents:**

- **Slide deck template** (Keynote + PowerPoint + Google Slides) —
  30-minute intro talk covering: what AAFP is, why agent transport matters,
  the 3-line API, a live demo, how to get involved. Speaker notes included.
- **Live demo script** — a reproducible demo: spin up 3 agents in Docker,
  discover capabilities, send a message, show the DHT. The demo must work on
  a fresh laptop with only Docker installed. Include a fallback
  pre-recorded video for when live demos fail (they will).
- **Hands-on workshop guide** — a 90-minute guided lab where attendees build
  their first AAFP agent. Includes setup instructions for macOS, Linux, and
  WSL2.
- **Cheat sheet handout** (printable PDF) — the 20 most common commands and
  code snippets on one page.
- **Swag** — stickers, laptop decals, a few t-shirts for the organizer and
  active participants. Physical swag disproportionately increases
  engagement.
- **Feedback form** — a short survey for attendees, results fed back to the
  advocacy team to improve future events.
- **Event guide** — how to find a venue, how to structure the evening
  (networking → talk → workshop → social), how to handle sponsorship if
  needed, how to post the event on Meetup.com and Luma.

**Logistics:** The kit lives in the repository under
`community/meetup-kit/`. Ambassadors request physical swag via a form; the
project ships it. Digital materials are freely downloadable by anyone.

---

## 3. Educational Content

Education is the highest-leverage community investment. A developer who
understands AAFP becomes an advocate; a developer who is confused becomes a
critic. The content strategy covers every format developers consume.

### 3.1 YouTube Channel

**Role:** The visual learning surface. YouTube is where developers go to see
something work before they read the docs. It is also the second-largest
search engine in the world — AAFP videos rank in Google search results.

**Content series:**

| Series | Format | Cadence | Audience |
|--------|--------|---------|----------|
| `AAFP in 3 Minutes` | Short demo, one concept | Biweekly | Newcomers |
| `Deep Dive` | 20-40 min technical talk on one subsystem | Monthly | Systems engineers |
| `Building Agents` | Step-by-step tutorial, code-along | Monthly | Application developers |
| `RFC Walkthrough` | Read-through of an RFC with the author | Per RFC | Protocol implementers |
| `Community Showcase` | Interview with someone who built on AAFP | Monthly | Everyone |

**Production standards:**

- Audio quality matters more than video quality. A $200 microphone and a
  1080p webcam outperform a 4K camera with a laptop mic.
- Screen recording at 1080p minimum, 30fps. Use a dark theme with
  high-contrast syntax highlighting.
- Every video has a description with: timestamps, links to relevant
  RFCs/code, a "try it yourself" command, and a link to GitHub Discussions.
- Videos are captioned (auto-generated then corrected). Accessibility is
  non-negotiable and also improves SEO.

**Year 1 target:** 24 videos (2/month), 10,000 cumulative views.

### 3.2 Blog

**Role:** The written thought-leadership and tutorial surface. The blog is
where Google sends people searching for "agent transport protocol,"
"post-quantum QUIC," "Kademlia DHT tutorial," and "MCP transport binding."

**Content mix:**

- **Technical tutorials** (60%) — "Build your first AAFP agent," "Setting up
  a relay for NAT traversal," "Using UCAN capability chains for
  authorization." These are evergreen and drive organic search traffic.
- **Architecture deep dives** (20%) — "Why we chose CBOR over Protobuf,"
  "How DCuTR hole punching works," "The design of ML-DSA-65 identity." These
  establish technical credibility and attract systems engineers.
- **Ecosystem and vision** (10%) — "The agent operating system," "Why the
  competitor is cloud silos, not HTTP," "Network effects as the durable
  moat." These are the strategic pieces that attract investors, partners,
  and thought leaders.
- **Release notes and community updates** (10%) — what shipped, what's next,
  community highlights.

**Hosting:** The blog lives at `blog.aafp.dev` (or
`aafp.dev/blog`) and is built from Markdown in the repository. This keeps the
blog open-source — community members can submit posts via PR. Every blog
post is reviewed by a maintainer for technical accuracy.

**SEO discipline:** Every post targets a specific search intent. The
headline answers a question someone would type into Google. Internal links
connect related posts. External links cite primary sources (RFCs, papers,
specs). This is not gaming SEO — it is making good content findable.

**Year 1 target:** 36 posts (3/month), 50,000 monthly page views by month 12.

### 3.3 Podcast Appearances

**Role:** Reach the audience that consumes content during commutes and
workouts. Podcasts are also a relationship-building tool — hosts become
allies.

**Target podcasts (Year 1):**

| Podcast | Audience | Angle |
|---------|----------|-------|
| Software Engineering Daily | Senior engineers | Agent transport as infrastructure |
| The Changelog | Open source community | AAFP's open-protocol story |
| Rustacean Station / Rust in Motion | Rust developers | The Rust implementation story |
| Latent Space | AI engineers | Agent-to-agent communication |
| Practical AI | AI practitioners | How agents discover and trust each other |
| InfoQ Podcast | Engineering leaders | Strategic vision, protocol design |
| Kubernetes Podcast | Cloud-native engineers | Why AAFP is not Kubernetes (and what that means) |

**Approach:** Do not wait for invites. Pitch proactively with a specific
topic and a clear "why now" (e.g., "AAFP just froze its wire protocol with
post-quantum security — this is the first agent transport protocol to do
so"). Prepare 3-5 talking points in advance. Send the host a one-pager with
links they can include in show notes.

**Year 1 target:** 8 podcast appearances.

### 3.4 Conference Talks

**Role:** The highest-trust channel. A talk at a major conference is an
endorsement by that conference's program committee and a signal to the
industry that AAFP is serious.

**Target conferences (Year 1):**

| Conference | Audience | Submission focus |
|------------|----------|------------------|
| RustConf / Rust Nation | Rust developers | The 17-crate architecture, QUIC transport |
| KubeCon + CloudNativeCon | Cloud-native engineers | Agent transport vs. service mesh |
| QCon | Senior engineers | The agent operating system vision |
| Strange Loop / Recurse | Systems hackers | Post-quantum TLS, CBOR, DHT design |
| AI Engineer Summit / ODSC | AI engineers | Agent-to-agent communication at scale |
| FOSDEM | Open source community | Open protocol, open graph |
| DEF CON / Black Hat | Security community | Post-quantum identity, threat model |
| GopherCon | Go developers | The Go wire-format interop implementation |

**Talk strategy:**

- Submit to 10+ conferences; expect 2-3 acceptances. Rejection is normal.
- Do not give the same talk everywhere. Tailor to the audience. The RustConf
  talk dives into the transport crate; the AI Engineer Summit talk stays at
  the application layer.
- Every talk ends with a live demo and a clear call to action: "Star the
  repo, join the Discord, run `cargo install aafp`."
- Record every talk (if the conference allows) and post to the YouTube
  channel.
- Open-source the slides. Put them in `community/talks/` so others can
  reuse and adapt them.

**Year 1 target:** 5 accepted conference talks (per the goals in §12).

---

## 4. Hackathon Strategy

Hackathons are the highest-intensity community activation. In 48 hours, a
participant goes from "never heard of AAFP" to "built a working agent." Many
open-source contributors are recruited at hackathons.

### 4.1 AAFP-Themed Hackathons

**Format options:**

1. **Standalone AAFP Hackathon** — a dedicated 48-hour event, either
   in-person (one city, 100-200 participants) or virtual (global, 500+).
   Theme: "Build the agent internet." Tracks: infrastructure, applications,
   and "wildcard" (anything AAFP-related).

2. **Sponsored track at an existing hackathon** — partner with Major League
   Hacking (MLH), TreeHacks, PennApps, or similar. AAFP sponsors a specific
   prize track. This is lower-effort and reaches an audience that is already
   in hackathon mode.

3. **Online hackathon** — a 1-week async event hosted on the AAFP platform.
   Lower barrier to entry (no travel), global participation, but lower
   intensity. Good for the long tail of developers who cannot attend
   in-person events.

**Year 1 plan:** 1 in-person or MLH-sponsored hackathon + 2 online
hackathons.

### 4.2 Hackathon Tracks and Themes

| Track | Theme | Example Projects |
|-------|-------|------------------|
| **Infrastructure** | Build a transport, relay, or discovery tool | A WebSocket transport adapter, a relay with geographic routing, a DHT visualizer |
| **Applications** | Build a multi-agent application on AAFP | A research agent that discovers and calls an OCR agent, a code-review agent swarm, a distributed data pipeline |
| **AI Integration** | Connect AAFP to an AI framework | LangChain transport, LlamaIndex agent adapter, Hugging Face agent binding |
| **DevTools** | Build tooling for AAFP developers | A TUI dashboard for agent monitoring, a CLI plugin, a VS Code extension |
| **Wildcard** | Anything AAFP-related | Creative, experimental, or artistic uses of agent communication |

### 4.3 Prizes

Prizes should be meaningful but not so large that they attract mercenaries
who never return. The goal is to convert participants into community
members, not to buy one-off projects.

| Place | Prize | Notes |
|-------|-------|-------|
| 1st (per track) | $2,000 + AAFP swag + featured on website + blog post | Cash + recognition |
| 2nd (per track) | $500 + AAFP swag | |
| 3rd (per track) | $250 + AAFP swag | |
| Best newcomer | $500 + mentorship session with a maintainer | For the best project by someone new to AAFP |
| Best open-source contribution | $500 + "Contributor" ambassador status | Projects that are production-quality and merged |

**Non-cash incentives:**

- Every participant gets a digital badge (shareable, verifiable).
- Winning projects get a blog post and YouTube showcase.
- Winners get fast-tracked into the ambassador program.
- Top projects may be invited to become official examples in the repository.

### 4.4 Judging Criteria

| Criterion | Weight | Description |
|-----------|--------|-------------|
| **Technical depth** | 25% | Does the project engage meaningfully with AAFP's core features (DHT, capabilities, NAT traversal, UCAN)? |
| **Creativity and originality** | 20% | Is this a novel use of agent-to-agent communication? |
| **Working demo** | 20% | Does it work? A polished demo of a simple idea beats a broken demo of a grand one. |
| **Impact and usefulness** | 15% | Would real people use this? Does it solve a real problem? |
| **Code quality** | 10% | Is the code readable, tested, and open-source? |
| **Documentation** | 10% | Can someone else understand and extend the project? |

**Judges:** 3-5 judges per hackathon. Mix of maintainers, developer
advocates, and external partners (e.g., a LangChain engineer for the AI
Integration track). External judges add credibility and cross-pollinate
communities.

**Rubric transparency:** Publish the rubric before the hackathon starts.
Participants should know what is being judged before they build.

### 4.5 Hackathon Operations

- **Mentors:** 1 mentor per 15 participants. Mentors are community members
  or ambassadors who can answer AAFP questions and unblock participants.
- **Starter kit:** A pre-built project template (`cargo generate
  aafp/hackathon-template`) that includes a working agent, a Dockerfile, and
  a test harness. Participants start from this, not from zero.
- **Office hours:** 2 scheduled mentor sessions during the hackathon where
  anyone can ask questions in a shared voice/video channel.
- **Post-hackathon:** Follow up with every team within 1 week. Invite them
  to Discord. Offer to help open-source their project. The hackathon is the
  beginning of a relationship, not the end.

---

## 5. Example Agent Marketplace

The marketplace is AAFP's "app store" — a registry where community members
publish and discover reusable agents. This is the ecosystem's flywheel: more
agents → more capability → more developers → more agents.

### 5.1 Concept

The marketplace is to agents what npm is to JavaScript packages, what crates.io
is to Rust crates, or what PyPI is to Python packages. A developer who needs
an OCR capability does not build one from scratch — they install a
community-contributed OCR agent:

```bash
aafp install @community/ocr-agent
aafp run @community/ocr-agent
```

Or in code:

```rust
let ocr = Agent::discover("ocr")
    .prefer("community/ocr-agent")
    .connect()
    .await?;
```

### 5.2 Marketplace Structure

**Registry model:** A federated registry (not a single centralized server,
aligning with AAFP's decentralized ethos). The reference registry runs at
`registry.aafp.dev`, but anyone can run their own. Agents are identified by
a scoped name: `@publisher/agent-name`.

**Agent package format:**

```
aafp-agent.toml          # Manifest (name, version, capabilities, deps)
src/                     # Agent source or binary
README.md                # Documentation
examples/                # Usage examples
tests/                   # Conformance tests
CAPABILITIES.md          # Declared capability descriptors
LICENSE
```

**Manifest fields:**

```toml
[package]
name = "@community/ocr-agent"
version = "0.3.1"
description = "Tesseract-based OCR agent with GPU support"
license = "MIT"
repository = "github.com/community/aafp-ocr-agent"

[capabilities]
provides = ["ocr", "image-text-extraction"]
requires = ["image-input"]

[runtime]
language = "rust"           # or "python", "go"
min_aafp_version = "1.0"
resources = { gpu = "optional", memory = "512MB" }

[dependencies]
aafp = "1.0"
```

### 5.3 Quality and Trust

A marketplace without quality control becomes a graveyard of abandoned
packages. AAFP's marketplace uses a layered trust model:

| Layer | Mechanism |
|-------|-----------|
| **Verified publisher** | Publishers verify their AgentId; verified publishers get a badge |
| **Conformance tested** | Every published agent must pass the AAFP conformance test suite |
| **Community ratings** | Star ratings + reviews (like crates.io) |
| **Download counts** | Transparency — popular agents are discoverable |
| **Capability signatures** | Agents cryptographically sign their declared capabilities |
| **Reputation integration** | (Phase 5) Agent reputation scores from live network performance feed into marketplace ranking |

**Curation:** The marketplace has a "featured" section curated by the
advocacy team. Featured agents are production-quality, well-documented, and
actively maintained. This is not a ranking algorithm — it is human judgment,
which is more trustworthy for a young ecosystem.

### 5.4 Launch Strategy

- **Seed the marketplace.** Before opening it to the public, the core team
  publishes 10-15 high-quality reference agents: web-browse, pdf-read,
  image-ocr, code-execute, search, translator, summarizer, data-fetch,
  shell-exec, file-read. These demonstrate the format and give developers
  something to use immediately.
- **Dogfood.** Every AAFP example and tutorial uses marketplace agents, not
  hand-rolled ones. If the marketplace is not good enough for the core
  team's examples, it is not good enough for the community.
- **Hackathon pipeline.** The best hackathon projects are invited to publish
  on the marketplace. This creates a steady stream of new agents and
  converts hackathon participants into published authors.

---

## 6. Plugin Ecosystem

The plugin system is how AAFP stays small at the core while growing
infinitely at the edges. Plugins extend AAFP without modifying the protocol
or the reference implementation.

### 6.1 Plugin Architecture

AAFP defines stable extension points (interfaces, per the strategic
principle "bake interfaces, not algorithms"). Plugins implement these
interfaces:

| Extension Point | Interface | Example Plugins |
|-----------------|-----------|-----------------|
| **Transport** | `Transport` trait | WebSocket, TCP, Tor, I2P, Bluetooth LE, LoRa |
| **Crypto backend** | `CryptoProvider` trait | ML-DSA-65 (default), Dilithium, Falcon, Ed25519 (legacy), HSM-backed |
| **Discovery** | `DiscoveryProvider` trait | Kademlia (default), DNS-SD, mDNS (LAN), Consul, etcd |
| **Relay** | `RelayStrategy` trait | Geographic routing, cost-optimized, trust-weighted |
| **Monitoring** | `MetricsSink` trait | Prometheus, OpenTelemetry, Datadog, Grafana Cloud, statsd |
| **Logging** | `LogSink` trait | structured JSON, syslog, Loki, Elasticsearch |
| **Capability provider** | `Capability` trait | web-browse, pdf-read, code-execute, search, OCR |
| **Scheduler** | `SchedulerStrategy` trait | round-robin, latency-optimized, cost-optimized, reputation-weighted |
| **Trust scoring** | `TrustModel` trait | WoT (default), performance-based, stake-based, manual |

### 6.2 Plugin Discovery and Installation

```bash
# Install a plugin
aafp plugin install aafp-transport-websocket
aafp plugin install aafp-monitoring-prometheus
aafp plugin install aafp-crypto-hsm

# List installed plugins
aafp plugin list

# Enable/disable
aafp plugin enable aafp-monitoring-prometheus
```

Plugins are distributed via the same registry as agents (§5). A plugin is
just a package that implements one of the extension-point traits.

### 6.3 Third-Party Plugin Categories

**Transports:**
- `aafp-transport-websocket` — for environments where QUIC is blocked
- `aafp-transport-tcp` — legacy compatibility
- `aafp-transport-tor` — anonymity-preserving agent communication
- `aafp-transport-bluetooth` — IoT and edge agents
- `aafp-transport-serial` — embedded and robotics use cases

**Crypto backends:**
- `aafp-crypto-hsm` — hardware security module integration (YubiHSM, AWS
  CloudHSM) for production key management
- `aafp-crypto-tpm` — Trusted Platform Module integration
- `aafp-crypto-ed25519` — legacy Ed25519 for backward compatibility
- `aafp-crypto-falcon` — alternative PQ signature scheme

**Monitoring integrations:**
- `aafp-monitoring-prometheus` — Prometheus metrics exporter (first-party)
- `aafp-monitoring-opentelemetry` — OpenTelemetry traces and metrics
- `aafp-monitoring-datadog` — Datadog integration
- `aafp-monitoring-grafana` — Grafana dashboard provisioning
- `aafp-monitoring-jaeger` — distributed tracing for agent pipelines

**Discovery providers:**
- `aafp-discovery-mdns` — zero-config LAN discovery (great for development
  and IoT)
- `aafp-discovery-consul` — HashiCorp Consul integration for enterprise
- `aafp-discovery-k8s` — Kubernetes-native service discovery
- `aafp-discovery-dns-sd` — DNS-based service discovery

### 6.4 Plugin Quality Standards

- Every plugin must implement the relevant trait and pass the trait's
  conformance test suite.
- Plugins declare their AAFP version compatibility in their manifest.
- The registry runs automated compatibility checks on submission.
- Plugins are versioned independently of AAFP core (semantic versioning).
- A "compatibility matrix" on the marketplace shows which plugin versions
  work with which AAFP versions.

### 6.5 Incentivizing Third-Party Plugins

- **Plugin grants:** Small stipends ($500-$2,000) for developers who build
  and maintain high-value plugins (e.g., a production-quality OpenTelemetry
  integration). Funded from project sponsorship or grants programs.
- **Featured plugins:** High-quality third-party plugins are featured on the
  website and in the newsletter. Recognition drives contribution.
- **Plugin tutorials:** The advocacy team writes tutorials that use
  third-party plugins, driving adoption and demonstrating the ecosystem's
  breadth.

---

## 7. Integration Partners

AAFP does not exist in isolation. The agent ecosystem already has major
frameworks, and AAFP must interoperate with them — not compete. Integration
partnerships are the fastest path to relevance.

### 7.1 Target Partners and Integration Strategy

| Partner | Integration | Value to AAFP | Value to Partner |
|---------|-------------|---------------|------------------|
| **LangChain** | AAFP as a transport and agent-discovery backend | Access to the largest agent framework community | LangChain agents gain decentralized discovery and peer-to-peer transport |
| **LlamaIndex** | AAFP transport binding for LlamaIndex agents | Access to the RAG/data-agent community | LlamaIndex agents become network-addressable |
| **Vercel AI SDK** | AAFP as a streaming transport for AI SDK agents | Access to the web/edge developer community | AI SDK agents communicate peer-to-peer without a central server |
| **Hugging Face** | AAFP transport for HF agents and model serving | Access to the open-source ML community | HF agents become discoverable and callable on the open graph |
| **OpenAI** | AAFP transport binding for OpenAI agents (if/when open-sourced) | Credibility and reach | OpenAI agents gain decentralized communication |
| **Anthropic** | AAFP transport for Claude agents | Credibility and reach | Claude agents gain decentralized communication |
| **CrewAI** | AAFP as the transport layer for crew communication | Access to the multi-agent orchestration community | CrewAI gains a real transport protocol instead of ad-hoc HTTP |
| **AutoGen** | AAFP transport for AutoGen conversational agents | Access to the Microsoft Research community | AutoGen gains decentralized, NAT-traversing transport |

### 7.2 Partnership Tiers

| Tier | Relationship | Example |
|------|-------------|---------|
| **Core integration** | First-party binding maintained by AAFP team | MCP transport binding (RFC 0007), A2A binding (RFC 0008) |
| **Co-maintained** | Binding maintained jointly with the partner | LangChain AAFP adapter (AAFP team + LangChain team) |
| **Community-maintained** | Binding maintained by community, endorsed by both projects | Hugging Face AAFP adapter (community contributor, HF endorses) |
| **Documented** | AAFP provides docs; partner integrates independently | Vercel AI SDK uses AAFP docs to add support |

### 7.3 Partnership Playbook

1. **Identify a technical champion** at the partner organization. Partnerships
   are person-to-person, not org-to-org.
2. **Build a proof-of-concept integration** before asking. Show, don't
   propose. A working LangChain + AAFP demo is worth more than a 10-page
   partnership proposal.
3. **Co-author a blog post** announcing the integration. Both projects
   publish, both communities see it.
4. **Co-present at a conference.** A joint talk ("Building decentralized
   agents with LangChain and AAFP") reaches both audiences.
5. **Maintain the integration.** The biggest risk is bit-rot. Assign an
   owner. Run integration tests in CI on every AAFP release.

### 7.4 MCP and A2A — The Existing Integrations

AAFP already has transport bindings for MCP (RFC 0007) and A2A (RFC 0008),
verified with Python interop and Go wire-format tests. These are the
foundation. Every integration partnership builds on the principle that AAFP
is a **transport substrate** — it carries MCP and A2A messages, it does not
replace them.

This is a critical positioning point: AAFP is not competing with MCP or A2A.
It is the **pipe** through which they flow. Partners who might see AAFP as
a competitor need to understand it is infrastructure underneath them, not a
rival beside them.

---

## 8. Academic Outreach

Academic adoption gives AAFP credibility, generates peer-reviewed validation,
and trains the next generation of distributed-systems engineers. Universities
are also where long-term research on adaptive routing, reputation systems,
and economic layers (Phases 2-7 of the strategic vision) will happen.

### 8.1 Research Papers Using AAFP

**Goal:** Make AAFP the default experimental platform for research on
multi-agent systems, decentralized AI, and agent transport.

**Strategy:**

- **Publish a "research-friendly" positioning.** AAFP is open-source, has a
  frozen wire protocol (reproducibility), a reference implementation (Rust),
  and a DHT that scales to 500 nodes (realistic experimental scale). This is
  an attractive testbed for distributed-systems researchers.
- **Maintain a `research/` directory** in the repository with:
  - Benchmark suites (already exist from performance tracks G-M)
  - Network topology generators
  - Churn and failure injection tools
  - Data collection hooks for experiments
  - A "research license" FAQ clarifying that AAFP's MIT/Apache-2.0 license
    permits unrestricted academic use
- **Track citations.** Maintain a `CITATIONS.md` file listing every paper
  that uses or cites AAFP. This is both a metric and a recruitment tool —
  cited researchers are candidates for the advisory board.
- **Offer co-authorship.** When a researcher's work leads to a protocol
  improvement (e.g., a better routing algorithm), offer co-authorship on the
  resulting RFC. This incentivizes research that improves AAFP.

**Target research areas:**

| Area | AAFP Relevance | Why Researchers Care |
|------|---------------|---------------------|
| Multi-agent coordination | Core use case | AAFP provides the communication substrate |
| Decentralized AI | Core vision | AAFP is the open alternative to cloud-silo AI |
| Post-quantum cryptography | Already implemented | Real-world PQ-TLS deployment data |
| Kademlia DHT optimization | Already implemented | 500-node DHT with churn is a real testbed |
| Capability-based security | UCAN implementation | Novel application of UCAN to agent auth |
| Agent reputation and trust | Phase 5 vision | Open problem, AAFP provides the platform |
| Economic mechanisms for compute | Phase 7 vision | Open problem, AAFP provides the platform |
| NAT traversal at scale | Already implemented | DCuTR + AutoNAT + relay is a real testbed |

### 8.2 University Course Materials

**Goal:** AAFP is taught in distributed systems, networking, and AI courses.

**Strategy:**

- **Course module pack** — a ready-to-use teaching unit (2-4 lectures) that
  professors can drop into an existing course:
  - Slide decks (editable)
  - Lab assignments with autograder support
  - A virtualized lab environment (Docker-based, no setup required)
  - Sample exam questions
  - A "what students should learn" guide for instructors
- **Target courses:**
  - Distributed Systems (AAFP as a case study in protocol design, DHTs, NAT
    traversal)
  - Computer Networks (QUIC, post-quantum TLS, CBOR framing)
  - AI/ML (agent communication, multi-agent systems, decentralized AI)
  - Cryptography (ML-DSA-65, FIPS 204, post-quantum signatures in practice)
  - Security (UCAN capability chains, threat modeling, WoT)
- **Professor outreach:**
  - Email 50 professors in distributed systems and AI with the course module
    pack. Personalize each email. Do not mass-send.
  - Offer to guest-lecture (remotely or in person) for the first 10
    professors who adopt.
  - Sponsor a "best student project" award at universities that adopt AAFP.
- **Student pipeline:** Students who learn AAFP in school become the
  engineers who adopt it at work. This is a 2-5 year investment with
  compounding returns.

### 8.3 Academic Advisory Board

Recruit 3-5 academic advisors from top institutions (MIT, Stanford, UC
Berkeley, ETH Zurich, University of Cambridge, Tsinghua, IIT) with expertise
in distributed systems, cryptography, and AI. The board:

- Meets quarterly to review the research roadmap
- Connects AAFP to PhD students looking for thesis topics
- Provides credibility for grant applications and research partnerships
- Is not a governance body — it is an advisory and network-expansion body

---

## 9. Documentation Contribution

Documentation is the first thing a new developer encounters and the last
thing they remember. AAFP's docs must be excellent, and the community must
be able to improve them.

### 9.1 Documentation Architecture

| Doc Type | Location | Audience |
|----------|----------|----------|
| RFCs | `RFCs/` | Protocol implementers |
| API reference | `docs/api/` (auto-generated from rustdoc) | Developers using the Rust API |
| Tutorials | `docs/tutorials/` | New developers |
| Guides | `docs/guides/` | Developers building real applications |
| Deployment | `docs/DEPLOYMENT.md` | Operators |
| Operations | `docs/OPERATIONS.md` | Operators |
| Troubleshooting | `docs/TROUBLESHOOTING.md` | Everyone |
| Threat model | `docs/THREAT_MODEL.md` | Security engineers |

### 9.2 How Community Members Can Improve Docs

**The docs are in the repository.** This is the single most important
decision. Documentation improvements are PRs, reviewed like code. This
means:

- Anyone can fix a typo, clarify a confusing paragraph, or add an example.
- Documentation changes go through the same review process as code, ensuring
  accuracy.
- Documentation is versioned with the code — the docs always match the
  release.
- Contributors get credit (their commits appear in the git history and the
  release notes).

**Contribution workflow:**

1. Read the [documentation style guide](#92-style-guide) (below).
2. Open a PR with the change. Small changes (typos, clarifications) can be
   single-commit PRs. Large changes (new guides, restructured sections)
   should be discussed in a GitHub Discussion first.
3. A maintainer reviews. Documentation review checks for: accuracy (does
   this match the code?), clarity (would a newcomer understand this?),
   completeness (are there missing steps?), and style (does it follow the
   guide?).
4. Merge. The contributor is credited in the next release notes.

**"Good first issue" labels:** Tag documentation improvements as
`good first issue` and `docs`. These are the lowest-barrier entry points for
new contributors. A developer's first PR to AAFP is often a doc fix — and
that first PR is the gateway to deeper contribution.

### 9.3 Style Guide

- **Voice:** Direct, technical, no marketing language. "AAFP does X" not
  "AAFP empowers you to X."
- **Structure:** Every guide starts with a 2-sentence summary of what the
  reader will learn. Every section starts with the "why" before the "how."
- **Code examples:** Every code block is runnable. Every command is
  copy-pasteable. Include expected output for the first run of each command.
- **Diagrams:** Use ASCII art or Mermaid diagrams (rendered in GitHub).
  Avoid external image dependencies that can break.
- **Linking:** Link to RFCs by section number. Link to code by permalink.
  Link to related docs by relative path.
- **Assumptions:** State them. "This guide assumes you have Rust 1.75+ and
  Docker installed."

### 9.4 Documentation Metrics

- Coverage: every public API function has a doc comment with an example.
- Freshness: no doc is more than 2 releases stale (checked by CI).
- Findability: every doc is reachable from the index in ≤2 clicks.
- Feedback: every doc page has a "Was this helpful?" widget and a "Edit this
  page on GitHub" link.

---

## 10. Localization

AAFP is a global protocol. Its documentation must reach developers in their
own language. Localization is not a courtesy — it is an adoption strategy.
A developer who can read the docs in Japanese is a developer who adopts
AAFP in Japan.

### 10.1 Target Languages (Year 1)

| Language | Rationale | Priority |
|----------|-----------|----------|
| **English** | Default, source of truth | P0 (maintained by core team) |
| **Japanese** | Strong Rust and systems community; high AI interest | P1 |
| **Chinese (Simplified)** | Largest developer population; strong AI investment | P1 |
| **Spanish** | Fast-growing developer community in LATAM and Spain | P1 |
| **German** | Strong engineering culture; enterprise adoption potential | P2 |

### 10.2 Localization Strategy

- **English is the source of truth.** All docs are written in English first.
  Translations are derived. This prevents divergence between language
  versions.
- **Translation workflow:**
  1. English doc is finalized and tagged with a version.
  2. The translation system (Crowdin, Weblate, or a GitHub-based workflow)
     flags the doc as needing translation.
  3. Community translators submit translations.
  4. A language lead (native speaker, trusted contributor) reviews and
     approves.
  5. The translated doc is published alongside the English version.
- **Staleness tracking:** Each translated doc is tagged with the English
  version it was translated from. If the English doc is updated, the
  translation is flagged as stale. Stale translations show a banner: "This
  translation may be outdated. The English version is current."
- **RFCs are English-only.** The protocol specification is a precise legal
  document. Translating RFCs risks introducing ambiguity. RFCs stay in
  English; tutorials, guides, and blog posts are translated.

### 10.3 Recruiting Translators

- Language leads are ambassador-tier contributors (§2.2).
- Translation is an excellent "first contribution" for non-developers
  (technical writers, bilingual community members).
- Recognize translators in release notes and on a "contributors" page.
- Translation hackathons: a weekend event where the community translates a
  major doc set into a target language. This is social, productive, and
  builds local community.

### 10.4 Localization Pitfalls to Avoid

- **Do not machine-translate and publish.** Machine translation is a
  starting point, not a finished product. Unreviewed MT is worse than no
  translation — it erodes trust.
- **Do not translate idioms literally.** "NAT traversal" has an established
  technical translation in each language; use it, not a word-for-word
  rendering.
- **Do not let translations lag by more than one release.** A stale
  translation is worse than a missing one, because it misleads.

---

## 11. Community Metrics

What gets measured gets managed. AAFP tracks community health through a
small set of meaningful metrics — not vanity metrics.

### 11.1 Metric Dashboard

| Metric | Source | Target (Year 1) | Frequency |
|--------|--------|-----------------|-----------|
| GitHub stars | GitHub API | 1,000 | Weekly |
| GitHub forks | GitHub API | 150 | Weekly |
| Contributors (merged PRs) | GitHub API | 100 | Monthly |
| Discord members | Discord API | 3,000 | Weekly |
| Discord active members (weekly) | Discord API | 500 | Weekly |
| GitHub Discussions threads | GitHub API | 500 | Monthly |
| GitHub Discussions answer rate | GitHub API | >80% | Monthly |
| Stack Overflow questions (tagged `aafp`) | Stack Exchange API | 100 | Monthly |
| Stack Overflow answer rate | Stack Exchange API | >90% | Monthly |
| YouTube subscribers | YouTube API | 2,000 | Weekly |
| YouTube total views | YouTube API | 10,000 | Monthly |
| Blog monthly page views | Analytics | 50,000 | Monthly |
| Newsletter subscribers | Email provider | 5,000 | Monthly |
| Meetup count | Community events | 10 | Quarterly |
| Meetup cumulative attendance | Community events | 1,000 | Quarterly |
| Conference talks delivered | Manual | 5 | Quarterly |
| Podcast appearances | Manual | 8 | Quarterly |
| Marketplace agents published | Registry API | 50 | Monthly |
| Plugins published | Registry API | 20 | Monthly |
| Integration partners (active) | Manual | 5 | Quarterly |
| Academic papers citing AAFP | Google Scholar / manual | 5 | Quarterly |
| University courses using AAFP | Manual | 3 | Annually |

### 11.2 Leading vs. Lagging Indicators

**Leading indicators** (predict future growth):
- Discord new-member rate (are people arriving?)
- GitHub Discussions new-thread rate (are people engaging?)
- "Good first issue" completion rate (are newcomers becoming contributors?)
- Tutorial completion rate (are people successfully learning?)

**Lagging indicators** (confirm past success):
- GitHub stars (accumulated over time)
- Contributors (accumulated over time)
- Marketplace agents (accumulated over time)
- Conference talks (accumulated over time)

The advocacy team monitors leading indicators weekly and investigates
immediately when a leading indicator drops. A drop in Discord new-member
rate is a leading signal that discovery (Reddit, Twitter, conferences) is
underperforming — fix it before it shows up in the lagging star count.

### 11.3 Health Metrics (Not Just Growth)

Growth metrics measure size. Health metrics measure sustainability:

| Health Metric | Healthy Range | Action if Unhealthy |
|---------------|---------------|---------------------|
| Bus factor (maintainers who can review PRs) | ≥5 | Recruit maintainers from ambassador pool |
| PR time-to-first-review | <48 hours | Assign more reviewers |
| Issue time-to-first-response | <24 hours | Recruit community moderators |
| Answer rate (Discussions + Stack Overflow) | >80% | Staff help channels more |
| Contributor retention (3-month) | >50% | Improve onboarding, mentorship |
| Community sentiment (Discord/Reddit tone) | Positive | Investigate negative trends |

---

## 12. Year 1 Community Goals

Specific, measurable, time-bounded. These are the targets the advocacy team
is accountable for.

### 12.1 The Numbers

| Goal | Target | Quarter |
|------|--------|---------|
| GitHub stars | 1,000 | Q4 |
| Contributors (merged PRs) | 100 | Q4 |
| Discord members | 3,000 | Q4 |
| Meetups held | 10 | Q4 |
| Conference talks delivered | 5 | Q4 |
| Marketplace agents | 50 | Q4 |
| Plugins published | 20 | Q4 |
| YouTube subscribers | 2,000 | Q4 |
| Blog monthly page views | 50,000 | Q4 |
| Newsletter subscribers | 5,000 | Q4 |
| Integration partners (active) | 5 | Q4 |
| Academic papers citing AAFP | 5 | Q4 |
| Podcast appearances | 8 | Q4 |
| Hackathons | 3 (1 in-person, 2 online) | Q4 |

### 12.2 Quarterly Milestones

**Q1 — Foundation:**
- Launch GitHub Discussions, Discord (bridged to Matrix), r/aafp
- Publish 10 seed Stack Overflow Q&A
- Publish first 6 blog posts and 6 YouTube videos
- Recruit 2 community moderators
- Ship meetup kit v1
- Seed marketplace with 10 reference agents
- Submit 5 conference CFPs

**Q2 — Activation:**
- First in-person hackathon (or MLH-sponsored track)
- First conference talk delivered
- First 3 meetups held (SF, Berlin, Tokyo — one per region)
- 500 GitHub stars, 1,000 Discord members
- First integration partner live (LangChain or LlamaIndex)
- Launch ambassador program, recruit first 5 ambassadors
- Localization: Japanese and Chinese translation teams formed

**Q3 — Acceleration:**
- 750 GitHub stars, 2,000 Discord members
- 6 meetups cumulative, 3 conference talks delivered
- First online hackathon
- 25 marketplace agents, 10 plugins
- First academic paper citing AAFP
- First university course adopting AAFP course materials
- 3 integration partners live

**Q4 — Consolidation:**
- 1,000 GitHub stars, 3,000 Discord members, 100 contributors
- 10 meetups cumulative, 5 conference talks, 8 podcast appearances
- 50 marketplace agents, 20 plugins
- 5 academic papers, 3 university courses
- 5 integration partners
- Year 1 retrospective and Year 2 planning

### 12.3 The 1,000-Star Path

1,000 GitHub stars in Year 1 is ambitious but achievable. The path:

1. **Launch day (Q1):** The existing network (the team's professional
   contacts, the Rust community, AI Twitter) generates the first 200-300
   stars. A well-crafted launch post on Hacker News, r/programming,
   r/rust, and r/MachineLearning drives this.
2. **Content engine (Q1-Q4):** Each blog post and YouTube video brings in
   20-50 stars from organic search and social sharing. 36 posts + 24 videos
   → ~300-500 incremental stars.
3. **Conference talks (Q2-Q4):** Each talk at a major conference drives
   50-100 stars from attendees and post-talk social sharing. 5 talks →
   ~250-500 stars.
4. **Integration partnerships (Q2-Q4):** Each partner announcement (co-
   authored blog post) drives 50-100 stars from the partner's community.
   5 partners → ~250-500 stars.
5. **Hackathons (Q2-Q4):** Each hackathon drives 50-100 stars from
   participants. 3 hackathons → ~150-300 stars.

These overlap and compound. The total comfortably reaches 1,000.

---

## 13. Comparison: How gRPC, Kubernetes, and Rust Built Communities

AAFP is not the first infrastructure project that needed to build a
community around a protocol. Three of the most successful — gRPC, Kubernetes,
and Rust — offer directly applicable lessons.

### 13.1 gRPC

**What gRPC did:**

- **Multi-language from day one.** gRPC launched with first-class support
  for C++, Java, Python, Go, Node.js, Ruby, C#, Objective-C, and PHP. This
  meant every developer could use it in their language. AAFP's parallel is
  the Phase 3 SDK in Rust, Python, and TypeScript.
- **Corporate backing with open governance.** Google created gRPC but
  governed it openly. The CNCF eventually adopted it. Corporate backing gave
  it resources; open governance gave it trust. AAFP should seek a similar
  balance — strong founding team, open governance from the start.
- **Interoperability testing.** gRPC maintained an interop test suite that
  every implementation had to pass. This ensured that "gRPC" meant the same
  thing across languages. AAFP already has this (the Go wire-format interop
  harness, 664 tests).
- **Clear positioning against a competitor.** gRPC was "better than REST for
  internal services." AAFP's positioning is "the open graph vs. cloud
  silos." Both define themselves against an incumbent.
- **Developer experience investment.** gRPC invested heavily in tooling:
  protocol buffers compiler, code generation, streaming. AAFP's parallel is
  the 3-line API and CLI (Phase 2).

**Lesson for AAFP:** Multi-language SDKs and interop testing are not
optional — they are the price of entry. AAFP's Rust + Go + Python presence
is a good start; TypeScript must follow.

### 13.2 Kubernetes

**What Kubernetes did:**

- **Ecosystem before completeness.** Kubernetes launched with an incomplete
  but extensible platform. The CRI, CNI, CSI, and device plugin interfaces
  let the community fill the gaps. AAFP's parallel is the plugin system
  (§6) — bake interfaces, let the community build implementations.
- **SIGs (Special Interest Groups).** Kubernetes organized its community
  into SIGs: SIG-Network, SIG-Storage, SIG-Scheduling, SIG-Auth, etc. Each
  SIG had ownership of a domain and its own meeting cadence. This scaled
  governance to thousands of contributors. AAFP should adopt SIG-like
  structure once contributor count exceeds ~50: SIG-Transport, SIG-Crypto,
  SIG-Discovery, SIG-NAT, SIG-SDK, SIG-Docs, SIG-Community.
- **KubeCon as a forcing function.** Kubernetes created its own conference
  (KubeCon, now KubeCon + CloudNativeCon). This became the annual gathering
  that unified the ecosystem. AAFP is too young for its own conference, but
  should co-locate events or workshops at existing conferences in Year 1,
  and consider a dedicated "AAFP Summit" in Year 2-3.
- **Documentation as a first-class citizen.** Kubernetes docs are
  comprehensive, versioned, and community-maintained. The docs SIG is one
  of the largest. AAFP must treat docs with the same seriousness.
- **The CNCF ecosystem effect.** Kubernetes did not succeed alone — it
  succeeded as the center of an ecosystem (Prometheus, Envoy, Istio, Helm,
  etc.). AAFP's parallel is the plugin and agent marketplace. The protocol
  is the center; the ecosystem is the gravity.

**Lesson for AAFP:** Extensibility and SIG-style governance scale
communities. Do not wait for completeness before opening the ecosystem.
Kubernetes was adopted while still incomplete because it was extensible.

### 13.3 Rust

**What Rust did:**

- **RustConf and community events from early on.** Rust held its first
  conference (RustCamp) in 2015, the same year 1.0 was released. Events
  created a sense of movement. AAFP should aim for a presence at RustConf
  in Year 1 and a dedicated AAFP event by Year 2.
- **The "Rust ethos."** Rust cultivated a distinct culture: zero-cost
  abstractions, "fearless concurrency," no GC, memory safety without
  compromise. This identity attracted developers who identified with these
  values. AAFP needs its own ethos: "the open graph," "agents that own
  their identity," "no cloud silo owns your agent." Identity attracts
  loyalty.
- **This Week in Rust.** A weekly newsletter that aggregated blog posts,
  new crates, and community news. It kept the community informed and drove
  engagement. AAFP should launch "This Week in AAFP" by Q2.
- **Excellent error messages and tooling.** Rust's compiler errors are
  famous. `cargo`, `rustup`, `clippy`, `rustfmt` — the tooling made Rust
  pleasant to use despite its complexity. AAFP's parallel: the CLI must be
  excellent. `aafp init`, `aafp discover`, `aafp connect`, `aafp serve`
  must be as smooth as `cargo`.
- **The RFC process.** Rust's RFC process (which AAFP has adopted) gave the
  community a voice in the language's evolution. Public RFC review built
  trust and attracted contributors who wanted to shape the future. AAFP's
  RFCs are frozen at Rev 6, but new RFCs (for Phases 2-7) should go through
  public review in GitHub Discussions `rfc-discussion`.
- **Patience and stability.** Rust took years to reach 1.0 and years more
  to reach mainstream adoption. The team resisted rushing. AAFP's frozen
  wire protocol is a similar discipline — stability over speed.

**Lesson for AAFP:** Culture and identity matter as much as technology.
Rust developers are loyal because they identify with Rust's values. AAFP
must articulate its values clearly and consistently.

### 13.4 Cross-Cutting Lessons

| Lesson | gRPC | Kubernetes | Rust | AAFP Application |
|--------|------|------------|------|------------------|
| Multi-language from day one | ✅ | N/A | ✅ | SDK in 3+ languages |
| Open governance | ✅ | ✅ | ✅ | Open RFC review, SIGs at scale |
| Extensibility over completeness | — | ✅ | ✅ | Plugin system, marketplace |
| Interop testing | ✅ | — | — | Go interop harness (already exists) |
| Community events | ✅ | ✅ | ✅ | Meetups, hackathons, conference presence |
| Distinct cultural identity | — | ✅ | ✅ | "The open graph" ethos |
| Excellent developer tooling | ✅ | ✅ | ✅ | CLI, 3-line API, conformance tests |
| Documentation as first-class | ✅ | ✅ | ✅ | Docs in repo, community-editable |
| Newsletter / regular cadence | — | ✅ | ✅ | "This Week in AAFP" |
| Patience and stability | ✅ | ✅ | ✅ | Frozen wire protocol (already done) |

---

## 14. Phased Rollout Plan

The community plan is sequenced to match the protocol's phase plan (from
`STRATEGIC_VISION.md`).

### Phase 2 — Developer Experience (Weeks 1-2 of community effort)

- Launch GitHub Discussions, Discord/Matrix, r/aafp
- Publish 3-line API, CLI, first tutorials
- Seed Stack Overflow with 10 Q&A
- Publish first 3 blog posts and 3 YouTube videos
- Recruit 2 community moderators

### Phase 3 — Ecosystem (Months 2-6)

- SDK in 3 languages (Rust, Python, TypeScript)
- Reference apps published
- Plugin system live
- Marketplace launched with 10 seed agents
- First integration partner (LangChain or LlamaIndex)
- First hackathon
- Meetup kit shipped
- Ambassador program launched
- Localization teams formed (Japanese, Chinese)

### Phase 4 — Adaptive Routing (Months 6-12)

- SIG structure adopted (SIG-Transport, SIG-Discovery, etc.)
- "This Week in AAFP" newsletter launched
- First academic papers published
- First university courses adopted
- 5 conference talks delivered
- 1,000 GitHub stars, 100 contributors
- Year 1 retrospective → Year 2 plan

### Phase 5+ — Reputation, Economic Layer (Year 2+)

- Agent reputation feeds into marketplace ranking
- Economic layer (resource accounting) opens new research collaborations
- AAFP Summit (dedicated conference) considered
- Academic advisory board active
- 10,000+ GitHub stars, 500+ contributors

---

## 15. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Community growth outpaces maintainer capacity | Medium | High | Recruit maintainers from ambassador pool; SIG structure distributes load |
| Toxic community culture drives away contributors | Low | High | Code of Conduct from day 1; active moderation; recruit community moderators early |
| Integration partner loses interest | Medium | Medium | Maintain integration in AAFP's repo, not partner's; keep it co-maintained |
| Marketplace fills with low-quality agents | Medium | Medium | Conformance tests required; curation; community ratings |
| Documentation lags behind code | High | Medium | CI checks for doc freshness; docs in same PR as code changes |
| Localization becomes a maintenance burden | Medium | Medium | English is source of truth; staleness tracking; language leads own their language |
| "Vaporware" perception if community grows before features | Medium | High | Ship real features (3-line API, CLI) before broad community outreach |
| Competitor (OpenAI, Anthropic) opens their own protocol | Medium | High | AAFP's open governance and frozen protocol are the differentiator; emphasize "open graph" vs. "closed bus" |
| Burnout of founding team | Medium | High | Distribute work via SIGs and ambassadors; the community plan is designed to reduce founder load over time |

---

## Summary

AAFP's technology is ready. The wire protocol is frozen, the reference
implementation is production-grade, and the architecture is designed for
decades. What remains is the human work: building the community, the
ecosystem, and the network effects that make AAFP the default substrate for
agent communication.

The plan in this document is concrete: specific platforms, specific
metrics, specific goals, and a phased rollout that matches the protocol's
evolution. The Year 1 goals — 1,000 stars, 100 contributors, 10 meetups, 5
conference talks — are ambitious but achievable, and they are the foundation
for Year 2's larger ambitions.

The strategic vision is clear:

> **Network effects, not cryptography, become the durable moat.**

Cryptography built the foundation. Community builds the moat. This document
is the plan for building it.
