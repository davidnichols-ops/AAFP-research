# AAFP Go-To-Market Strategy — The HTTP of AI Agents

**Author:** AAFP Project
**Date:** 2026-07-05
**Status:** Strategic plan
**Companion documents:**
- [`../STRATEGIC_VISION.md`](../STRATEGIC_VISION.md) — the agent operating system vision
- [`../NORTH_STAR.md`](../NORTH_STAR.md) — current state and roadmap

---

## 0. The One-Line Pitch

> **AAFP is the HTTP of AI agents: an open, post-quantum protocol that lets any
> agent discover, trust, and execute work with any other agent — across NATs,
> clouds, and vendors — in three lines of code.**

Everything in this document is in service of that sentence. If a tactic does
not make that sentence more true, more credible, or more widely believed, it
does not belong in the next 12 months.

The pitch works because it is **analogy-driven, not feature-driven**. Engineers
already understand what HTTP did for documents and gRPC did for services. AAFP
does the same thing for autonomous software: it removes the integration tax
that every agent team currently pays to a closed vendor bus. The analogy is
load-bearing — it sets expectations (open, stable, ubiquitous, boring) and
implies the business model (free protocol, paid infrastructure around it).

---

## 1. Target Developer Personas

AAFP is not for everyone. It is for the people who are already feeling the
pain that closed agent buses create. Four personas, in priority order.

### 1.1 The AI Engineer (primary, 60% of early adopters)

- **Who:** Builds LLM-powered applications. Has shipped at least one agent to
  production. Uses LangChain, LlamaIndex, or a hand-rolled orchestrator.
  Comfortable in Python and TypeScript, occasionally Rust.
- **Pain today:** Every agent integration is a bespoke HTTP client. Tool calls
  are brittle. Multi-agent coordination means wiring together N vendor SDKs
  with N different auth schemes. Switching model vendors breaks the whole
  graph. There is no way to call an agent that lives in another company's
  infrastructure without a VPN or a public REST API.
- **What they want from AAFP:** "I write `agent.discover('pdf-ocr').call(req)`
  and it just works, regardless of where the OCR agent runs." They want to
  stop writing integration glue and start composing capabilities.
- **Where they live:** GitHub, Hugging Face, r/LocalLLaMA, AI Engineer Summit
  audience, LangChain Discord, X/Twitter.
- **Activation signal:** They clone a quickstart, run it, and within an hour
  have two of their own agents talking to each other over AAFP.

### 1.2 The Platform Engineer (secondary, 25% of early adopters)

- **Who:** Runs infrastructure for a team that ships AI features. Thinks in
  terms of reliability, observability, cost, and security. Lives in Kubernetes,
  Terraform, OpenTelemetry. Has been asked to "make the agents production-grade."
- **Pain today:** Agent workloads are opaque. There is no service mesh for
  agents. mTLS terminates at the pod, not at the agent identity. They cannot
  answer "which agent called which agent, and did it succeed?" They are
  expected to operate a graph they cannot see.
- **What they want from AAFP:** Cryptographic agent identity (UCAN tokens),
  structured metrics (AgentMetrics), a relay they can self-host behind their
  own firewall, and a deployment story that fits their existing K8s patterns.
- **Where they live:** KubeCon, CNCF Slack, SRE communities, HashiCorp forums.
- **Activation signal:** They deploy the AAFP relay via Helm, wire it into
  Prometheus, and see agent-to-agent traffic in Grafana within a day.

### 1.3 The ML Researcher (tertiary, 10% of early adopters)

- **Who:** Publishes on multi-agent systems, RL, agent benchmarks, or
  distributed inference. Cares about reproducibility, open protocols, and
  not being locked into a vendor's internal bus. Writes Python, sometimes
  JAX/PyTorch with custom orchestration.
- **Pain today:** Every multi-agent paper ships its own ad-hoc communication
  layer. Experiments are not reproducible across labs. There is no shared
  substrate to benchmark against. Reviewers cannot run the agent graph.
- **What they want from AAFP:** A stable, citable protocol they can reference
  in a paper. A reference implementation they can fork. The ability to spin
  up a heterogeneous agent swarm on a cluster without writing custom RPC.
- **Where they live:** arXiv, NeurIPS/ICML/ICLR workshops, EleutherAI Discord,
  Hugging Face spaces.
- **Activation signal:** They cite AAFP in a paper, or publish a benchmark
  that runs on top of it.

### 1.4 The Startup CTO (tertiary, 5% of early adopters, but highest LTV)

- **Who:** Founded an AI agent company. Has 5-50 engineers. Is building a
  product that is fundamentally multi-agent and does not want to build the
  transport layer themselves. Cares about time-to-market, defensibility, and
  not depending on a single model vendor.
- **Pain today:** Building agent-to-agent communication is a distraction from
  their core product. They fear that OpenAI or Anthropic will ship a closed
  bus that makes their orchestration layer obsolete. They want an open
  standard so their investment is portable.
- **What they want from AAFP:** A production-grade protocol they can build on
  without owning the transport. A managed relay network so they do not run
  NAT traversal infrastructure. An enterprise support contract so their
  board feels safe.
- **Where they live:** YC demo days, AI startup Slacks, founder Twitter.
- **Activation signal:** They sign a design-partner agreement and put AAFP
  in their architecture diagram.

### 1.5 Persona priority and sequencing

| Phase | Primary persona | Why |
|-------|-----------------|-----|
| Launch (M0-M3) | AI Engineer | Lowest friction, highest word-of-mouth, writes the blog posts |
| Growth (M3-M6) | Platform Engineer | Needs reliability + observability, brings teams |
| Scale (M6-M9) | Startup CTO | Brings budget, needs support contracts |
| Maturity (M9-M12) | ML Researcher | Brings credibility and citations, slowest cycle |

The AI Engineer is the wedge. The Platform Engineer is the multiplier (one
platform engineer brings 20 AI engineers). The Startup CTO is the revenue.
The ML Researcher is the moat (citations make the protocol a standard).

---

## 2. Positioning: "The HTTP of AI Agents"

### 2.1 The positioning statement

**For** AI engineers and platform teams building multi-agent systems **who**
are tired of bespoke agent-to-agent integration glue and vendor-locked agent
buses, **AAFP** is the open, post-quantum agent networking protocol **that**
lets any agent discover, trust, and execute work with any other agent across
NATs, clouds, and vendors in three lines of code. **Unlike** MCP (which is
tool-calling, not agent-to-agent), A2A (which is a vendor-led spec without a
reference network), and AutoGen (which is an orchestrator, not a protocol),
**AAFP** is a frozen wire format with a running reference network — the same
combination that made HTTP win.

### 2.2 The three positioning pillars

1. **Open, not open-core.** The protocol is frozen and permissively licensed.
  The reference implementation is Apache-2.0. There is no "enterprise edition"
  of the protocol. We monetize infrastructure around the protocol, not the
  protocol itself. This is the HTTP/NGINX model, not the MongoDB model.

2. **A network, not a library.** AAFP is not just a SDK. It is a running
  network of relays, a discovery substrate (DHT), and a trust root (the
  attestation CA). The value compounds with every agent that joins. A library
  does not compound; a network does.

3. **Boring on purpose.** The wire format is frozen (Rev 6). The crypto is
  FIPS 204. The transport is QUIC. We are not competing on novel cryptography
  or clever framing. We are competing on **ubiquity and interoperability**.
  The highest compliment is "I forgot I was using AAFP."

### 2.3 The anti-positioning (what we are NOT)

- **Not an orchestrator.** We do not tell you how to structure your agent
  graph. We carry the messages. AutoGen, CrewAI, LangGraph are orchestration;
  AAFP is the wire underneath them.
- **Not a model vendor.** We do not host models. We are transport-agnostic
  to OpenAI, Anthropic, local Llama, vLLM. We are the glue, not the inference.
- **Not a blockchain.** There is no token. There is no consensus. There is a
  resource accounting model (future) but it is not a cryptocurrency.
- **Not Kubernetes for agents.** Kubernetes manages machines. AAFP manages
  capabilities. We do not schedule pods; we route work to capable agents.

---

## 3. Launch Strategy: Open Source → Hosted Relay → Enterprise

The launch is a three-act play. Each act has a different audience, a
different revenue model, and a different success metric. The acts overlap but
never reverse order — you cannot sell enterprise before the open-source
network exists, because the network is the credibility.

### 3.1 Act I: Open source first (Month 0-3)

**Goal:** Prove the protocol is real and earn the right to be cited.

- Apache-2.0 release of the Rust reference implementation, Python SDK, and
  CLI. TypeScript SDK follows within 60 days.
- Publish all 11 RFCs as a versioned spec site (mdbook). The spec is the
  product; the code is the proof.
- Ship 5 reference apps: echo, translation pipeline, weather agent, relay
  setup, multi-agent chat. Each must run in under 5 minutes from clone.
- Launch the documentation site with a quickstart that never mentions QUIC,
  UCAN, DHT, or CBOR. If a reader has to learn those terms, the quickstart
  failed.
- Announce on HN, r/LocalLLaMA, X, the Rust community, and AI engineering
  Discords. The announcement post leads with the one-line pitch and a GIF of
  two agents talking in 3 lines of code.

**Success metric:** 2,000 GitHub stars, 500 npm/cargo installs, 50 agents
running on the public bootstrap DHT that are not ours.

**Revenue:** $0. This act is pure adoption. Monetizing now would poison the
network effect.

### 3.2 Act II: Hosted relay network (Month 4-8)

**Goal:** Remove the last reason to not use AAFP — running your own relay.

- Launch a global anycast relay network (the AAFP Relay Network). Developers
  point their agent at `relay.aafp.dev` and get NAT traversal for free. This
  is the Twilio moment: the protocol is free, the infrastructure is paid.
- Launch a hosted discovery service (managed DHT bootstrap + capability
  directory). Self-hosted DHT still works; the hosted version is faster and
  has a searchable web UI.
- Launch a managed attestation CA. Agents get free identity tokens signed by
  the AAFP root. Self-signed WoT still works; the CA is for teams that need
  a chain of trust they can point an auditor at.
- Pricing is usage-based with a generous free tier (see §11). The free tier
  is not a trial; it is permanently free for low volume, because free agents
  on the network increase its value for paying agents.

**Success metric:** 500 developers on the hosted relay, 50 paying orgs, 10K
agents traversing the relay network monthly.

**Revenue:** First revenue. Target $20K MRR by end of Month 8.

### 3.3 Act III: Enterprise (Month 9-12)

**Goal:** Convert design partners into reference customers.

- Self-hosted enterprise distribution: the full relay + discovery + CA stack
  packaged as a Helm chart and a Terraform module, deployable in an air-gapped
  VPC. This is for regulated industries that cannot use a hosted relay.
- Enterprise support contracts: 24/7 SLA, CVE response, on-call escalation,
  architecture review. Sold per agent or per cluster, not per seat.
- Design-partner program: 5-10 companies get a dedicated engineer, early
  access to Track T (Adaptive Routing), and co-marketing in exchange for a
  public case study.

**Success metric:** 5 named enterprise reference customers, 2 public case
studies, $100K ARR.

**Revenue:** $100K ARR by end of Month 12. The enterprise motion is slow and
high-touch; do not expect it to scale before Month 12.

### 3.4 Why the order matters

Open source first, because the network effect requires free participation.
Hosted relay second, because it removes operational friction without removing
the open option. Enterprise third, because enterprise buyers need to see
community validation before signing — they buy adoption, not features. If you
reverse the order, you become a vendor with a closed product and a community
that does not trust you.

---

## 4. Community Building

A protocol without a community is a PDF. The community is the product.

### 4.1 Discord + Matrix (dual-homing)

- **Discord** is the public front door. Channels: `#quickstart`,
  `#rust-sdk`, `#python-sdk`, `#typescript-sdk`, `#relay-network`,
  `#show-and-tell`, `#help`. Discord is where newcomers land.
- **Matrix** is the protocol-native channel. We run an AAFP-native bridge
  bot so that Discord messages appear in Matrix and vice versa. This is both
  a community tool and a dogfooding demo: "our community chat runs over the
  protocol we built." It is a marketing asset disguised as infrastructure.
- **Governance:** Discord moderators are drawn from the first 50 contributors.
  Matrix is federated; we run the homeserver but anyone can join from their
  own. No single point of control.

### 4.2 GitHub Discussions + Issues

- **GitHub Discussions** is the Q&A and design-proposal surface. Every RFC
  change starts as a Discussion. We commit to responding to every Discussion
  within 48 hours for the first 6 months. Responsiveness is the cheapest,
  most effective community signal.
- **Issues** are for bugs and concrete feature requests. We tag issues with
  `good-first-issue` and `help-wanted` and maintain a minimum of 10 open
  good-first-issues at all times. A repo with no on-ramp issues signals
  "we do not want your help."
- **RFCs** live in the repo as markdown. Every RFC has a linked Discussion.
  Proposals are merged only after at least one non-core-team reviewer
  approves. This is the IETF model, shrunk to fit.

### 4.3 Weekly office hours

- Every Friday, 60 minutes, on a public video call (Jitsi or Zoom with
  public link). Two core team members on camera. Agenda: 10 min demo,
  10 min roadmap update, 40 min open Q&A and live debugging.
- Recordings go to YouTube. The archive becomes a searchable knowledge base
  and a recruiting tool — watching someone debug live is more trustworthy
  than a polished tutorial.
- Rotate time zones weekly (one week US-friendly, one week EU/APAC-friendly)
  so the community is not US-centric.

### 4.4 Ambassador program (Month 6+)

- Identify 10-20 community members who answer questions, ship examples, and
  write about AAFP. Give them: a private channel with the core team, early
  access to unreleased features, swag, and public credit.
- Ambassadors are not paid. They are recognized. Recognition scales further
  than money in open source.

---

## 5. Conference Strategy

Conferences are where the positioning becomes real. The rule: **one talk per
quarter, each tuned to a different persona.**

### 5.1 AI Engineer Summit (primary)

- **Audience:** AI Engineer persona. This is the highest-signal venue.
- **Talk:** "The HTTP of AI Agents: building a multi-agent system in 3 lines
  of code." Live demo: two agents on different laptops, different networks,
  talking through the public relay. No slides about QUIC.
- **Goal:** 200 attendees see the demo, 50 star the repo within a week.

### 5.2 KubeCon / CloudNativeCon (platform engineer)

- **Audience:** Platform Engineer persona. They own the clusters.
- **Talk:** "A service mesh for agents: cryptographic identity, NAT
  traversal, and observability for multi-agent workloads on Kubernetes."
  Focus on the Helm chart, Prometheus integration, and the relay as a
  first-class K8s workload.
- **Goal:** 10 platform teams evaluate the Helm chart within 30 days.

### 5.3 RustConf (credibility + hiring)

- **Audience:** Rust community. AAFP is Rust-native; this is where
  contributors come from.
- **Talk:** "Building a post-quantum agent transport in Rust: zero-copy,
  lock-free, 1.25M msg/s." Technical depth. This talk exists to prove the
  implementation is serious, not to recruit users.
- **Goal:** 5 Rust contributors join the project.

### 5.4 Strange Loop / local meetups (thought leadership)

- **Audience:** Polyglot senior engineers who set technical direction at
  their companies. Strange Loop is where future design partners form
  opinions.
- **Talk:** "Why agents need their own protocol (and why it should be
  boring)." The philosophical talk. Argue that the agent internet should
  be as boring as HTTP, and that AAFP is the boring choice.
- **Goal:** 3-5 CTOs reach out for a design-partner conversation.

### 5.5 Conference cadence

| Month | Event | Persona | Format |
|-------|-------|---------|--------|
| M2 | AI Engineer Summit | AI Engineer | Live demo |
| M5 | KubeCon EU | Platform Engineer | Technical talk |
| M7 | RustConf | Contributors | Deep-dive |
| M9 | Strange Loop | CTO/Thought leaders | Vision talk |
| M11 | AI Engineer Summit (return) | AI Engineer | Case study |

Do not over-speak. One talk per quarter keeps the material fresh and avoids
the "they're everywhere" fatigue that kills credibility.

---

## 6. Content Strategy

Content is the compounding asset. Every post, video, and podcast is a
permanent inbound channel.

### 6.1 Blog posts (cadence: 2 per month)

The blog lives at `aafp.dev/blog`. Each post targets a stage of the adoption
funnel (see §8).

| Post | Funnel stage | Topic |
|------|--------------|-------|
| "AAFP: the HTTP of AI agents" | Discover | The launch announcement + pitch |
| "Build your first agent in 3 lines" | Quickstart | Tutorial, copy-paste |
| "How AAFP does NAT traversal" | First agent | Technical, builds trust |
| "AAFP vs MCP vs A2A: a comparison" | Discover | Honest, links to competitors |
| "Running 100 agents on a laptop" | Production | Performance + observability |
| "Post-quantum identity for agents" | Production | Security deep-dive |
| "From LangChain to AAFP: a migration" | First agent | Reduces switching fear |
| "The relay network is live" | Production | Act II launch |
| "Case study: [design partner]" | Advocate | Social proof |
| "Why we froze the wire format" | Discover | Philosophy / trust |

### 6.2 YouTube tutorials (cadence: 1 per month)

- 10-20 minute screencasts. No talking head; screen + voice.
- Series: "AAFP in 10 minutes" (quickstart), "AAFP deep dive" (internals),
  "Building a real agent" (end-to-end app).
- Each video ends with a link to a runnable repo. The repo is the call to
  action, not a subscribe button.
- Office hours recordings (§4.3) are also published here, creating a second
  content stream at zero marginal cost.

### 6.3 Podcast appearances (cadence: 1 per month, Month 3+)

- Target podcasts: Latent Space, AI Engineer, Practical AI, Software
  Engineering Daily, Rustacean Station, Changelog.
- Format: 45-60 min interview. Lead with the one-line pitch. Never say
  "post-quantum" without immediately saying "so your agents still work in
  10 years." Translate every technical term into a user benefit.
- Prep: write 5 likely questions and crisp answers before each appearance.
  The host will ask their own questions, but the prep forces clarity.

### 6.4 Content principles

1. **Show code, not slides.** Every post includes a runnable snippet.
2. **Never mention QUIC, UCAN, DHT, or CBOR in top-of-funnel content.**
   Those are implementation details. They belong in deep-dive posts for the
   platform engineer, not in the launch announcement.
3. **Link to competitors honestly.** A comparison page that links to MCP
   and A2A is more trustworthy than one that pretends they do not exist.
4. **Write for the person who will reject you.** The skeptical senior
   engineer is the audience. If the post survives them, it survives everyone.

---

## 7. Partnership Targets

Partnerships are not press releases. A partnership is an integration that
makes the one-line pitch more true. The test: does the partner's docs link
to AAFP as a supported transport?

### 7.1 OpenAI

- **Why:** OpenAI's function-calling and Agents SDK are the most widely
  deployed agent runtime. If AAFP is a supported transport for OpenAI
  agents, the entire OpenAI developer base becomes a reachable audience.
- **Ask:** An AAFP binding in the OpenAI Agents SDK (or a community-maintained
  adapter that OpenAI links to). Not a formal partnership — an integration.
- **Approach:** Contribute the adapter ourselves, get it merged, then ask for
  a docs link. Do not ask for permission first; ship the code first.

### 7.2 Anthropic

- **Why:** Anthropic's MCP is the dominant tool-calling protocol. AAFP
  already has a verified MCP transport binding (Track B/D). The positioning
  is complementary: MCP is tools → agent; AAFP is agent → agent.
- **Ask:** Co-author a blog post: "MCP for tools, AAFP for agents." This
  frames the relationship as complementary, not competitive, and gives
  Anthropic a reason to amplify it.
- **Approach:** Reach out to the MCP team directly. We already have spec
  conformance; the conversation starts from a position of technical respect.

### 7.3 Hugging Face

- **Why:** HF is where the open-source model community lives. If AAFP agents
  can be published as HF Spaces with one click, we get distribution to the
  exact audience that builds agents but does not want to use a closed bus.
- **Ask:** An `aafp` space template on HF Spaces. A "Deploy as AAFP agent"
  button on model pages.
- **Approach:** Build the template ourselves, submit it to HF, then ask for
  featuring in the templates gallery.

### 7.4 LangChain (and LangGraph)

- **Why:** LangChain is the most-used agent framework. A LangChain
  integration makes AAFP reachable from the code that AI engineers already
  have.
- **Ask:** An `aafp` LangGraph provider (like their existing provider
  abstractions for models). A docs page in the LangChain docs.
- **Approach:** Contribute a community provider package, get it listed in
  the LangChain integrations registry.

### 7.5 Vercel

- **Why:** Vercel is where TypeScript-first developers deploy. If AAFP has a
  Vercel-native deployment story (edge relay client, serverless agent
  functions), we reach the TypeScript persona at the moment of deployment.
- **Ask:** An AAFP template in the Vercel templates gallery. Ideally, a
  first-class `aafp-edge` runtime adapter.
- **Approach:** Build a Next.js + AAFP example, deploy it on Vercel, submit
  to the templates gallery.

### 7.6 Partnership cadence

| Month | Partner | Deliverable |
|-------|---------|-------------|
| M2 | LangChain | Community provider package merged |
| M3 | Hugging Face | Space template submitted |
| M4 | Anthropic | Co-authored blog post |
| M5 | OpenAI | Adapter merged + docs link |
| M6 | Vercel | Template in gallery |

Partnerships are ranked by reach, not by prestige. LangChain first because
it has the most agent developers, not because it is the most famous name.

---

## 8. Adoption Funnel

```
Discover → Quickstart → First Agent → Production → Advocate
```

Each stage has one metric, one friction point, and one intervention.

### 8.1 Discover

- **What:** Developer hears about AAFP (blog, HN, podcast, conference, friend).
- **Metric:** Unique visitors to `aafp.dev`.
- **Friction:** "Is this real or vaporware?" → Intervention: the homepage
  shows a 30-second GIF of two agents talking, plus a link to the runnable
  quickstart repo. No marketing copy above the GIF.
- **Target:** 20K unique visitors in Month 1, 10K/month sustained.

### 8.2 Quickstart

- **What:** Developer clones the quickstart and runs it.
- **Metric:** Quickstart repo clones / `aafp quickstart` CLI runs.
- **Friction:** "It doesn't run on my machine." → Intervention: the
  quickstart is a single `docker compose up` or `cargo run` with zero
  config. We test it on macOS, Linux, and WSL2 on every PR.
- **Target:** 20% of discoverers reach quickstart (4K in Month 1).

### 8.3 First Agent

- **What:** Developer builds their own agent (not the example) and gets it
  talking to another agent.
- **Metric:** Agents registered on the public bootstrap DHT (excluding our
  own test agents).
- **Friction:** "I don't know what capability to publish." → Intervention:
  the docs ship 10 copy-paste capability examples (echo, translate, search,
  ocr, code-run, weather, summarize, classify, embed, chat). The developer
  copies one and modifies it.
- **Target:** 30% of quickstarters reach first agent (1.2K in Month 3).

### 8.4 Production

- **What:** Developer runs an AAFP agent in a real system (not a demo),
  serving real traffic.
- **Metric:** Agents with >100 AAFP messages/day sustained for >7 days.
- **Friction:** "Is this safe to depend on?" → Intervention: the security
  audit report is public, the RFCs are frozen, and the enterprise support
  contract exists. Production readiness is a trust problem, not a feature
  problem.
- **Target:** 10% of first-agent developers reach production (120 by Month 9).

### 8.5 Advocate

- **What:** Developer writes about AAFP, speaks about it, or recruits
  another team.
- **Metric:** External blog posts, talks, and GitHub stars attributable to
  advocacy (tracked via referral links and star attribution).
- **Friction:** "I don't have anything novel to say." → Intervention: we
  provide a "talk kit" (slides, demo script, talking points) so any
  advocate can give a 10-minute talk at their local meetup.
- **Target:** 20 advocates by Month 12, each generating 50+ stars.

### 8.6 Funnel conversion targets (12 months)

| Stage | Month 1 | Month 6 | Month 12 |
|-------|---------|---------|----------|
| Discover | 20K | 60K cumulative | 150K cumulative |
| Quickstart | 4K | 15K | 40K |
| First agent | 200 | 3K | 10K |
| Production | 0 | 100 | 1,000 |
| Advocate | 0 | 5 | 50 |

The funnel is intentionally wide at the top and narrow at the bottom. The
protocol wins by having a large pool of experimenters, not by converting
everyone to production on day one.

---

## 9. Metrics

What we measure, in priority order. The order matters — the first metric is
the one we optimize for; the last is the one we report to investors.

### 9.1 Primary (health of the network)

| Metric | Target (M12) | Why it matters |
|--------|-------------|----------------|
| Agents in production (>100 msg/day, >7 days) | 1,000 | This is the only metric that proves real usage |
| External agents on the DHT (not ours) | 10,000 | Network size = network value |
| Relay network monthly active agents | 5,000 | Proves the hosted product is used |

### 9.2 Secondary (funnel health)

| Metric | Target (M12) | Why it matters |
|--------|-------------|----------------|
| GitHub stars | 15,000 | Top-of-funnel signal, not success |
| npm + cargo + pip downloads | 50K/month | Sustained install rate |
| Discord members | 5,000 | Community size |
| Discord weekly active | 500 | Community health (not just size) |
| Quickstart completion rate | 60% | Friction in the first 5 minutes |

### 9.3 Tertiary (business)

| Metric | Target (M12) | Why it matters |
|--------|-------------|----------------|
| Paying orgs on hosted relay | 50 | Revenue traction |
| Enterprise support contracts | 5 | Enterprise motion viability |
| ARR | $150K | Financial sustainability |
| Design partners | 8 | Pipeline for Year 2 enterprise |

### 9.4 Anti-metrics (what we do NOT optimize for)

- **GitHub stars alone.** Stars are vanity. We track them but do not
  optimize for them. A star without an agent in production is noise.
- **Total downloads.** Downloads without production usage are curiosity, not
  adoption. We track the ratio of downloads-to-production-agents, not raw
  downloads.
- **Discord member count.** A Discord with 10K members and 10 active is
  dead. We track weekly active, not total.

### 9.5 Instrumentation

- The CLI phones home (opt-out) with anonymous install + capability-publish
  events. This is how we count "first agent" and "production" without
  tracking identity.
- The relay network reports aggregate message counts (not content) for
  capacity planning and the public network dashboard.
- A public stats page at `aafp.dev/stats` shows agents online, messages/day,
  and relay regions. Transparency is a marketing asset: a live network
  dashboard is more convincing than any blog post.

---

## 10. Competitive Positioning

### 10.1 MCP (Model Context Protocol, Anthropic)

- **What it is:** A protocol for connecting LLMs to tools and data sources.
  Tool-calling, not agent-to-agent.
- **Relationship:** Complementary. AAFP already has a verified MCP transport
  binding. MCP is the "tools" layer; AAFP is the "agents" layer. An agent
  can expose MCP tools and be discovered/called over AAFP.
- **Positioning:** "MCP connects your agent to tools. AAFP connects your
  agent to other agents. Use both." Never position as either/or.
- **Risk:** MCP could expand into agent-to-agent. Mitigation: ship the AAFP
  network first; a spec without a running network is a PDF.

### 10.2 A2A (Agent-to-Agent, Google)

- **What it is:** A vendor-led agent-to-agent protocol spec. JSON-RPC over
  HTTP, agent cards, task lifecycle.
- **Relationship:** Competitor at the spec level, but AAFP already has A2A
  v1.0 spec conformance (40 tests). AAFP can carry A2A messages.
- **Positioning:** "A2A is a spec. AAFP is a spec and a running network with
  NAT traversal, post-quantum identity, and a relay infrastructure. A spec
  does not connect agents; a network does." The network is the moat.
- **Risk:** Google's distribution. Mitigation: be the open, community-driven
  alternative. Google specs have a history of abandonment; AAFP is
  Apache-2.0 with a committed core team.

### 10.3 AutoGen / CrewAI / LangGraph (orchestrators)

- **What they are:** Frameworks for structuring multi-agent workflows. They
  decide which agent calls which, when, and with what prompt.
- **Relationship:** Complementary. AAFP is the transport underneath them.
  An AutoGen workflow can run its agent-to-agent calls over AAFP instead of
  in-process function calls.
- **Positioning:** "AutoGen decides what your agents do. AAFP carries the
  messages between them. Use AAFP as the transport for any orchestrator."
- **Risk:** An orchestrator could build its own transport and bundle it.
  Mitigation: integrate with the orchestrator (LangChain provider, AutoGen
  adapter) so that using AAFP is easier than building a transport.

### 10.4 The competitive matrix

| Feature | AAFP | MCP | A2A | AutoGen |
|---------|------|-----|-----|---------|
| Agent-to-agent transport | Yes | No | Spec only | In-process only |
| Post-quantum identity | Yes | No | No | No |
| NAT traversal (relay + hole punch) | Yes | No | No | No |
| Running reference network | Yes | No | No | No |
| Open source (Apache-2.0) | Yes | Yes | Yes | Yes (MIT) |
| Orchestrator (workflow logic) | No | No | No | Yes |
| Tool-calling (LLM → tool) | Via MCP | Yes | No | Yes |
| Wire format frozen | Yes (Rev 6) | Evolving | Evolving | N/A |

The matrix tells the story: AAFP is the only row with a running network and
a frozen wire format. That combination is what made HTTP win.

---

## 11. Enterprise Sales Motion

Enterprise sales for an open-source protocol is a different motion than SaaS.
You are not selling the protocol (it is free). You are selling **insurance,
infrastructure, and expertise** around the protocol.

### 11.1 The three products

1. **Self-hosted enterprise distribution** (air-gapped, Helm + Terraform).
   - For regulated industries (finance, healthcare, government) that cannot
     use a hosted relay. Includes the full relay + discovery + CA stack.
   - Price: $50K/year per cluster (unlimited agents), includes updates and
     CVE patches. Source-available under a commercial license for the
     management plane; the protocol and agent SDKs remain Apache-2.0.

2. **Managed relay network** (hosted, usage-based).
   - For teams that want NAT traversal without operating it. Global anycast,
     multi-region, 99.9% SLA.
   - Price: free tier (10K messages/day), then $0.001/message or $500/month
     per 1M messages, whichever is lower. See §12.

3. **Enterprise support contracts** (the actual sales motion).
   - 24/7 SLA, CVE response within 72 hours, dedicated solutions engineer,
     quarterly architecture review, on-call escalation.
   - Price: $100K/year for orgs up to 500 agents; $250K/year for unlimited.
   - This is where the enterprise revenue lives. The self-hosted distro and
     managed relay are the entry points; the support contract is the close.

### 11.2 The sales process

```
Design partner (free, 3 months)
    → Self-hosted pilot (paid, 3 months)
    → Enterprise support contract (annual)
```

- **Design partner:** 5-10 companies. Free. They get a dedicated engineer,
  early access to unreleased features, and commit to a public case study.
  This is the top of the enterprise funnel.
- **Self-hosted pilot:** The design partner deploys the enterprise distro in
  their own VPC. We help them integrate. They pay a reduced pilot fee
  ($15K for 3 months). The pilot succeeds when AAFP carries real production
  agent traffic.
- **Enterprise support contract:** The pilot converts to an annual support
  contract. The close is driven by the case study — once one design partner
  publishes, the next one's procurement process is 10x faster.

### 11.3 Who we sell to

- **Buyer:** VP Engineering / Head of AI Platform. They own the budget and
  the reliability mandate.
- **Champion:** Senior AI engineer or platform engineer who has already used
  the open-source version and wants the company to standardize on it.
- **Blocker:** Security/Compliance. Mitigation: the public security audit
  report, the FIPS 204 crypto, and the air-gapped deployment option address
  the top 3 security objections before they are raised.

### 11.4 Sales enablement

- One-pager: "AAFP for enterprise" (the one-line pitch + the three products).
- Security dossier: audit report, crypto specs, threat model, SBOM.
- Reference architecture: a diagram of AAFP in a regulated VPC with
  self-hosted relay, self-hosted CA, and Prometheus/Grafana.
- ROI calculator: "building your own agent transport costs N engineer-years;
  AAFP support costs $100K/year." The math is the close.

---

## 12. Pricing Model for Managed Services

Pricing follows the Twilio/AWS model: usage-based with a permanent free tier.
The free tier is not a trial; it is a permanent subsidy for small agents,
because free agents increase network value for paying agents.

### 12.1 Managed relay network

| Tier | Price | Includes |
|------|-------|----------|
| Free | $0 | 10K messages/day, 1 relay region, community support |
| Starter | $49/month | 100K messages/day, 3 regions, email support |
| Growth | $499/month | 1M messages/day, all regions, Slack support |
| Scale | $0.0005/message over 1M | Volume pricing, priority routing, 99.9% SLA |

- **Why usage-based:** Agent traffic is bursty and unpredictable. Seat-based
  pricing punishes experimentation. Usage-based aligns our revenue with
  their success.
- **Why a permanent free tier:** The free agents on the relay are not a cost;
  they are the network. A relay with only paying agents is a smaller, less
  valuable network. The free tier is a network-effect investment.

### 12.2 Managed discovery service

| Tier | Price | Includes |
|------|-------|----------|
| Free | $0 | DHT bootstrap, basic capability directory |
| Pro | $99/month | Searchable web UI, capability graph API, saved searches |
| Enterprise | $499/month | Private capability directories, SSO, audit log |

- The free DHT bootstrap is required for the protocol to function; it will
  always be free. The paid tiers are for the management UI and private
  directories.

### 12.3 Managed attestation CA

| Tier | Price | Includes |
|------|-------|----------|
| Free | $0 | 10 agent identities, standard chain |
| Pro | $199/month | 1,000 identities, custom policies, revocation API |
| Enterprise | $999/month | Unlimited identities, HSM-backed root, private CA, audit log |

- Agent identity is free at low volume because the network needs identifiable
  agents to be valuable. The paid tiers are for orgs that need a private
  trust root or custom revocation policies.

### 12.4 Enterprise support contracts

| Tier | Price | Includes |
|------|-------|----------|
| Standard | $100K/year | 24/7 SLA, 72h CVE, 1 solutions engineer, quarterly review |
| Enterprise | $250K/year | 24/7 SLA, 24h CVE, dedicated team, on-site review, air-gapped distro |

### 12.5 Pricing principles

1. **The protocol is always free.** We never charge for the wire format, the
  RFCs, or the reference SDKs. This is non-negotiable. Charging for the
  protocol kills the network effect.
2. **Infrastructure is usage-based.** Relay, discovery, CA. Aligns revenue
  with usage; no seat licenses.
3. **Support is the enterprise revenue.** The support contract is where the
  margin is. Infrastructure is low-margin, high-volume; support is
  high-margin, low-volume.
4. **Free tiers are permanent, not trials.** A 30-day trial creates a cliff
  where agents drop off. A permanent free tier keeps agents on the network
  forever, growing its value for paying customers.

---

## 13. 12-Month Roadmap to 1,000 Developers, 100 Production Deployments

This is the operational plan. Each quarter has one theme, one primary metric,
and a definition of done.

### 13.1 Q1 (Month 1-3): Launch — "Prove it's real"

**Theme:** Open-source launch. Earn the right to be cited.
**Primary metric:** GitHub stars → 5,000. External agents on DHT → 500.

| Week | Deliverable |
|------|-------------|
| W1 | Apache-2.0 release of Rust impl + Python SDK + CLI |
| W2 | Documentation site live (mdbook), quickstart < 5 min |
| W3 | 5 reference apps in `examples/` |
| W4 | Launch announcement: HN, r/LocalLLaMA, X, Rust community |
| W5 | Discord + Matrix live, bridge bot running |
| W6 | First weekly office hours |
| W8 | LangChain community provider package merged |
| W10 | AI Engineer Summit talk delivered |
| W12 | Q1 retrospective: what broke, what worked |

**Definition of done for Q1:** 5,000 stars, 500 external agents on the DHT,
50 Discord members, 2 blog posts published, 1 conference talk delivered.

### 13.2 Q2 (Month 4-6): Hosted relay — "Remove the last friction"

**Theme:** Launch the managed relay network. First revenue.
**Primary metric:** Paying orgs → 20. Agents on relay → 2,000.

| Week | Deliverable |
|------|-------------|
| W13 | Relay network beta (single region) |
| W14 | Usage-based billing system live |
| W16 | Relay network GA (3 regions) |
| W18 | Managed discovery service beta |
| W20 | Hugging Face Space template submitted |
| W21 | KubeCon EU talk delivered |
| W22 | Managed attestation CA beta |
| W24 | Q2 retrospective |

**Definition of done for Q2:** 20 paying orgs on the relay, $20K MRR, 2,000
agents traversing the relay monthly, 3 blog posts, 1 conference talk.

### 13.3 Q3 (Month 7-9): Enterprise — "Convert design partners"

**Theme:** Enterprise sales motion. First reference customers.
**Primary metric:** Enterprise contracts → 3. Production deployments → 100.

| Week | Deliverable |
|------|-------------|
| W25 | Enterprise distro (Helm + Terraform) beta |
| W26 | Design partner program launched (5 partners signed) |
| W28 | RustConf talk delivered |
| W30 | First self-hosted enterprise pilot live |
| W32 | First public case study published |
| W34 | Enterprise support contract GA |
| W36 | Q3 retrospective |

**Definition of done for Q3:** 3 enterprise support contracts signed, 1
public case study, 100 agents in production (>100 msg/day, >7 days),
$60K ARR.

### 13.4 Q4 (Month 10-12): Scale — "1,000 developers, 100 production"

**Theme:** Scale the funnel and the network.
**Primary metric:** Developers → 1,000. Production deployments → 100.

| Week | Deliverable |
|------|-------------|
| W37 | TypeScript SDK GA |
| W38 | Strange Loop talk delivered |
| W40 | Ambassador program launched |
| W42 | Second case study published |
| W44 | Public stats dashboard live (`aafp.dev/stats`) |
| W46 | AI Engineer Summit return talk (case study) |
| W48 | Year 1 retrospective + Year 2 plan |

**Definition of done for Q4:** 1,000 developers (built + ran an agent),
100 production deployments, 15,000 stars, 5,000 Discord members, $150K ARR,
50 paying orgs.

### 13.5 The 12-month scoreboard

| Metric | Q1 target | Q2 target | Q3 target | Q4 target |
|--------|-----------|-----------|-----------|-----------|
| GitHub stars | 5,000 | 8,000 | 12,000 | 15,000 |
| External DHT agents | 500 | 2,000 | 5,000 | 10,000 |
| Developers (built an agent) | 200 | 1,000 | 3,000 | 1,000 (active) |
| Production deployments | 5 | 25 | 100 | 100 |
| Paying orgs | 0 | 20 | 30 | 50 |
| ARR | $0 | $20K MRR | $60K ARR | $150K ARR |
| Discord members | 500 | 2,000 | 3,500 | 5,000 |
| Conference talks | 1 | 1 | 1 | 2 |
| Blog posts | 2 | 3 | 3 | 4 |
| YouTube tutorials | 1 | 3 | 3 | 5 |

Note on the "developers" row: Q3 targets cumulative developers (3,000 have
tried it), Q4 targets active developers (1,000 built something in the last
30 days). The shift from cumulative to active is intentional — by Q4 we
care about retention, not just acquisition.

### 13.6 What has to be true for this roadmap to work

1. **The quickstart runs in under 5 minutes on a clean machine.** If this
   breaks, the entire funnel collapses. We test this on every PR.
2. **The relay network is reliable.** If the hosted relay is down, paying
   orgs churn. 99.9% SLA from day one of GA.
3. **The core team responds to community within 48 hours.** Responsiveness
   is the cheapest community-building action and the easiest to lose.
4. **We ship one talk per quarter.** Conferences are the highest-trust
   channel. Missing a committed talk destroys credibility.
5. **We do not monetize the protocol.** The moment we charge for the wire
   format, the network effect dies and a fork appears within 30 days.

---

## 14. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| MCP expands into agent-to-agent | Medium | High | Ship the network first; integrate with MCP, do not fight it |
| Google pushes A2A with massive distribution | Medium | High | Be the open, community-driven alternative; A2A-over-AAFP interop |
| A major cloud launches a closed agent bus | High | High | This is the core competitor (per STRATEGIC_VISION.md). The open network is the defense. |
| Relay network reliability < 99.9% | Medium | Critical | Over-provision, multi-region from day one, on-call rotation from Q2 |
| Core team burnout | Medium | Critical | Hire 2nd engineer by Q2; ambassador program reduces support load |
| Enterprise sales cycle > 6 months | High | Medium | Design partner program de-risks procurement; case studies accelerate |
| TypeScript SDK slips | Medium | Medium | It is on the Q4 critical path; start in Q2, not Q4 |
| "It's just a protocol" perception | Medium | High | The relay network + stats dashboard make the network visible and tangible |

---

## 15. The One Question This Document Must Answer

If a skeptical senior engineer reads only one section, it should be this:

**Why will AAFP succeed where other agent protocols have not?**

Because AAFP is the only agent protocol that ships **a frozen wire format and
a running network at the same time.** MCP is a spec without a network. A2A
is a spec without a reference implementation that crosses NATs. AutoGen is
an orchestrator without a transport. The combination that made HTTP win — a
boring, stable spec plus a ubiquitous, working network — is the combination
no agent protocol has yet shipped. AAFP has both, today, in 76,000 lines of
Rust with 1,718 passing tests.

The go-to-market strategy is not clever. It is the same strategy that every
successful open protocol has used: give the protocol away, build
infrastructure around it, sell support to the people who depend on it. The
execution is the differentiator, not the idea.

**The one-line pitch, restated:** AAFP is the HTTP of AI agents. Everything
in this document exists to make that sentence true.
