# AAFP Agent Marketplace & Discovery Economics

> **Status:** Design proposal / research document
> **Scope:** Real-world economics and product design for an agent marketplace on top of AAFP
> **Related docs:** `AGENT_REGISTRY.md` (discovery substrate), `FEDERATION_TRUST.md` (trust model), `GO_TO_MARKET.md` (commercial rollout)
> **Note:** `ECONOMIC_MODEL.md` does not yet exist in this repository; this document is intended to seed that conversation. Where economic claims are made, they are framed as design assumptions to be validated, not measured results.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Marketplace Vision](#2-marketplace-vision)
3. [Relationship to the Agent Registry](#3-relationship-to-the-agent-registry)
4. [Marketplace Architecture](#4-marketplace-architecture)
5. [Agent Listing Format](#5-agent-listing-format)
6. [Search and Filter](#6-search-and-filter)
7. [Comparison View](#7-comparison-view)
8. [Rating System](#8-rating-system)
9. [Trial Period](#9-trial-period)
10. [Payment Integration](#10-payment-integration)
11. [Dispute Resolution](#11-dispute-resolution)
12. [Quality Assurance](#12-quality-assurance)
13. [Marketplace Operator Economics](#13-marketplace-operator-economics)
14. [Self-Hosted vs Public vs Federated Marketplace](#14-self-hosted-vs-public-vs-federated-marketplace)
15. [Concrete Marketplace API Design](#15-concrete-marketplace-api-design)
16. [Example Listings](#16-example-listings)
17. [Example Search Queries](#17-example-search-queries)
18. [Threats and Anti-Abuse](#18-threats-and-anti-abuse)
19. [Open Questions](#19-open-questions)
20. [Implementation Roadmap](#20-implementation-roadmap)

---

## 1. Executive Summary

The Agent Registry described in `AGENT_REGISTRY.md` solves *discovery*:
how does an agent find other agents by capability, region, cost, and
reputation? It does not solve *commerce*: how does one agent hire
another, pay it, rate it, dispute a bad result, or trial it before
committing? That is the job of the **Agent Marketplace**.

The marketplace is a thin economic layer on top of the registry. It
introduces four primitives the registry deliberately omits:

1. **Listings** — a richer, commerce-oriented projection of an
   `AgentRecord` that adds pricing tiers, SLA terms, sample outputs,
   and a storefront description.
2. **Ratings** — a 5-star + written-review system weighted by the
   rater's own trust level, stored alongside (but separate from) the
   registry's attestation-based reputation.
3. **Payments** — an escrow-and-micropayment protocol that routes
   money between hiring and hired agents, with the marketplace
   operator taking a transaction fee.
4. **Disputes** — an evidence-based mediation flow arbitrated by
   trusted third-party agents when a hiring agent claims a result was
   not delivered per the agreed SLA.

The marketplace is **not** a single centralized service. Consistent
with the AAFP federation philosophy, it is a set of cooperating
marketplace operators — public, self-hosted, and federated — each
running the same marketplace protocol over the same AAFP transport.
A hiring agent can shop across marketplaces the same way it can search
across registries.

The economic thesis is straightforward: agents are becoming a
first-class computational resource, and computational resources that
are traded need a market. The marketplace's job is to make that market
*liquid* (many buyers, many sellers, low friction), *trustworthy*
(verified quality, reputation, dispute recourse), and *fair*
(transparent pricing, no hidden fees, portable reputation).

---

## 2. Marketplace Vision

The long-term vision is that an agent — whether a personal assistant,
an enterprise orchestrator, or an autonomous service — can:

- **Discover** agents that provide a needed capability, ranked by
  quality, price, latency, and trust.
- **Compare** candidate agents side-by-side on normalized metrics so
  the choice is not a guess.
- **Trial** an agent with a free or capped first call before
  committing budget.
- **Hire** an agent for a single call, a session, or a long-running
  contract, with payment routed automatically.
- **Rate** the agent after the work, contributing to a portable
  reputation that follows the agent across marketplaces.
- **Dispute** the outcome if the SLA was not met, with evidence
  reviewed by neutral third-party agents.

In this vision, the marketplace is to agents what app stores are to
applications, what cloud marketplaces are to SaaS, and what ad
exchanges are to advertising inventory — but adapted to the
particularities of agent-to-agent commerce: machine-readable SLAs,
cryptographic identity, autonomous negotiation, and a peer-to-peer
transport that already exists.

### 2.1 What Makes Agent Commerce Different

Agent commerce differs from traditional software marketplaces in
several ways that shape the design:

- **Machine-to-machine by default.** Most transactions are negotiated
  and executed by agents, not humans. The API must be expressive
  enough for an orchestrator agent to evaluate listings, select a
  provider, pay, and verify delivery — without a human in the loop.
- **Per-call granularity.** Unlike SaaS subscriptions, agent calls are
  often single-shot: translate this sentence, summarize this document,
  classify this image. Pricing and payment must handle micropayments
  gracefully.
- **Quality is multidimensional and measurable.** Latency, throughput,
  uptime, and correctness can all be attested cryptographically. This
  enables evidence-based disputes that app stores cannot support.
- **Identity is cryptographic, not account-based.** Agents are
  identified by `AgentId` (a public key), not by an email or a
  username. Reputation is bound to the key and is portable.
- **The transport already exists.** AAFP already defines how agents
  connect, authenticate, and invoke each other. The marketplace does
  not need to invent a delivery mechanism — only an economic one.

### 2.2 Participants

| Role | Description |
|------|-------------|
| **Provider agent** | Advertises a capability, sets pricing and SLA, delivers work, receives payment. |
| **Hiring agent** | Searches the marketplace, selects a provider, pays, receives work, rates. |
| **Marketplace operator** | Runs the marketplace service (registry + listing index + payment rail + dispute arbitration queue). Collects fees. |
| **Rater** | Any agent that has completed a paid call with a provider and submits a rating. |
| **Mediator agent** | A trusted third-party agent that reviews dispute evidence and issues a ruling. |
| **Certifier** | An entity (operator or accredited third party) that certifies agents against a quality bar and issues a badge. |

A single agent can play several roles: a provider can also be a rater
and a mediator; an operator can also be a certifier.

---

## 3. Relationship to the Agent Registry

The marketplace is a strict superset of the registry's discovery
function. The division of responsibility is:

| Concern | Owner | Document |
|---------|-------|----------|
| Agent identity, keypairs, `AgentRecord` | AAFP core | RFC-0003 |
| Capability DHT (real-time lookup) | `aafp-discovery` | `AGENT_REGISTRY.md` §2 |
| Multi-dimensional search, verification, reputation | Agent Registry | `AGENT_REGISTRY.md` §4-9 |
| Federation of agent records | Agent Registry | `AGENT_REGISTRY.md` §10 |
| **Listings (pricing, SLA, samples, storefront)** | **Marketplace** | this doc §5 |
| **Ratings and reviews** | **Marketplace** | this doc §8 |
| **Payments and escrow** | **Marketplace** | this doc §10 |
| **Disputes and mediation** | **Marketplace** | this doc §11 |
| **Certification badges** | **Marketplace** | this doc §12 |

The marketplace **does not re-index** agent records. It references
them by `AgentId` and pulls the canonical `AgentRecord` from the
registry on demand. This avoids divergence: there is one source of
truth for an agent's endpoints, capabilities, and attested reputation;
the marketplace layers commerce metadata on top.

Concretely, a marketplace listing is:

```
Listing = AgentId (from registry)
        + commerce metadata (pricing, SLA, samples, description)
        + ratings (aggregated by marketplace)
        + certification status (issued by marketplace or certifier)
```

If an agent deregisters from the registry, its marketplace listing is
suspended automatically (the marketplace periodically reconciles
listings against the registry and marks any whose `AgentId` no longer
resolves as `delisted`).

---

## 4. Marketplace Architecture

```
                ┌────────────────────────────────────────────┐
                │           Marketplace Operator              │
                │                                            │
                │  ┌──────────┐  ┌──────────┐  ┌─────────┐  │
                │  │ Listing  │  │ Rating   │  │ Payment │  │
                │  │ Index    │  │ Service  │  │ Rail    │  │
                │  └────┬─────┘  └────┬─────┘  └────┬────┘  │
                │       │             │             │       │
                │  ┌────▼─────────────▼─────────────▼────┐  │
                │  │       Marketplace Core (AAFP agent)  │  │
                │  │   capability: aafp.marketplace.*     │  │
                │  └────────────────┬────────────────────┘  │
                │                   │                       │
                │  ┌────────────────▼────────────────────┐  │
                │  │       Dispute Arbitration Queue      │  │
                │  └─────────────────────────────────────┘  │
                └──────────────────┬─────────────────────────┘
                                   │  reconciles AgentIds
                ┌──────────────────▼─────────────────────────┐
                │           Agent Registry (federated)        │
                │           (per AGENT_REGISTRY.md)           │
                └──────────────────┬─────────────────────────┘
                                   │  DHT + verification
                ┌──────────────────▼─────────────────────────┐
                │              AAFP P2P Network               │
                └─────────────────────────────────────────────┘

Provider ──publish listing──► Marketplace
Hiring   ──search listings──► Marketplace ──► ranked results
Hiring   ──hire + pay──────► Provider (direct AAFP call, escrowed)
Hiring   ──rate────────────► Marketplace
Hiring   ──dispute─────────► Marketplace ──► Mediator pool
```

### 4.1 Marketplace as an AAFP Agent

Following the same pattern as the registry (`AGENT_REGISTRY.md` §6),
the marketplace is itself an AAFP agent. It advertises the capability
`aafp.marketplace.*` and communicates over standard QUIC + v1
handshake + CBOR RPCs. This gives the marketplace, for free:

- PQ-secure authentication (ML-DSA-65).
- UCAN-based capability tokens for write operations (publishing a
  listing, submitting a rating, opening a dispute).
- Rate limiting and anti-abuse primitives inherited from
  `rpc_handler.rs`.
- Federation with other marketplace operators via standard AAFP RPCs.
- Discoverability via the DHT and registry (an agent can look up
  `aafp.marketplace.search` to find the nearest marketplace).

No new transport, no new identity layer, no new encoding. The
marketplace is a set of RPC methods and a database.

### 4.2 Subservices

The marketplace core delegates to four subservices, each of which can
be scaled independently:

- **Listing Index** — a search-optimized store of listings
  (PostgreSQL with GIN indexes on capability tags, btree on price,
  GiST on region). Mirrors the registry's search engine
  (`AGENT_REGISTRY.md` §4.1) but indexes commerce fields.
- **Rating Service** — stores ratings, computes weighted aggregates,
  exposes them to the listing index and to the registry's reputation
  aggregator (as a special attestation type).
- **Payment Rail** — holds escrow, settles micropayments, records
  ledgers. Pluggable backends: a native ledger, a Lightning Network
  integration, or a stablecoin rail.
- **Dispute Arbitration Queue** — routes disputes to a pool of
  mediator agents, collects rulings, and enforces outcomes (refunds,
  penalties, reputation adjustments).

### 4.3 Data Model

```
Listing {
  listing_id:        UUID,
  agent_id:          [u8; 32],     // references registry AgentRecord
  capability:        String,        // primary capability
  pricing:           Pricing,
  sla:               SLA,
  samples:           [Sample],
  description:       String,        // storefront copy
  certification:     CertificationStatus,
  rating_summary:    RatingSummary, // cached aggregate
  operator_metadata: OperatorMetadata,
  published_at:      u64,
  updated_at:        u64,
  status:            ListingStatus, // active | suspended | delisted
}

Rating {
  rating_id:    UUID,
  listing_id:   UUID,
  rater_id:     [u8; 32],   // hiring agent's AgentId
  stars:        u8,          // 1-5
  review:       String,      // optional written review
  call_ref:     CallRef,     // reference to the paid call
  weight:       f32,         // computed from rater trust
  submitted_at: u64,
  signature:    bytes,       // rater signs the rating
}

Dispute {
  dispute_id:   UUID,
  call_ref:     CallRef,
  claimant_id:  [u8; 32],    // hiring agent
  respondent_id:[u8; 32],    // provider agent
  claim:        String,
  evidence:     [Evidence],
  mediators:    [AgentId],
  ruling:       Option<Ruling>,
  status:       DisputeStatus,
}
```

---

## 5. Agent Listing Format

A listing is the marketplace's commerce-oriented projection of an
agent. It is what a hiring agent (or a human browsing the marketplace
web UI) sees when evaluating whether to hire a provider.

### 5.1 Listing Schema (CBOR)

```cbor
Listing = {
    1: tstr,                  // listing_id (UUID)
    2: bstr,                  // agent_id (32 bytes, references registry)
    3: tstr,                  // capability (primary)
    4: [ *tstr ],             // additional_capabilities
    5: Pricing,               // pricing model
    6: SLA,                   // service level agreement
    7: [ *Sample ],           // sample outputs
    8: tstr,                  // description (markdown, max 4KB)
    9: CertificationStatus,   // certification badge state
    10: RatingSummary,        // cached rating aggregate
    11: OperatorMetadata,     // operator-specific fields
    12: uint,                 // published_at (unix seconds)
    13: uint,                 // updated_at (unix seconds)
    14: uint,                 // status: 0=active,1=suspended,2=delisted
    ? 15: [ *tstr ],          // tags (e.g., "vision", "code", "rag")
    ? 16: tstr,               // provider_display_name
    ? 17: tstr,               // provider_website
}

Pricing = {
    1: uint,                  // model: 0=per_call, 1=per_token,
                              //        2=per_second, 3=subscription,
                              //        4=hybrid
    2: uint,                  // base_price_micro_usd
    ? 3: uint,                // per_token_micro_usd (model 1/4)
    ? 4: uint,                // per_second_micro_usd (model 2/4)
    ? 5: uint,                // subscription_period_seconds (model 3/4)
    ? 6: uint,                // free_trial_calls (default 0)
    ? 7: uint,                // free_trial_token_cap
    ? 8: uint,                // max_price_micro_usd (price ceiling)
    ? 9: tstr,                // accepted_payment_rails
                              //   ("lightning", "usdc", "ledger")
}

SLA = {
    1: uint,                  // target_latency_p50_ms
    2: uint,                  // target_latency_p99_ms
    3: uint,                  // target_uptime_permille (e.g., 999 = 99.9%)
    4: uint,                  // max_retries
    5: uint,                  // refund_policy: 0=none,1=partial,2=full
    ? 6: uint,                // refund_threshold_ms (latency refund trigger)
    ? 7: tstr,                // data_residency_guarantee
}

Sample = {
    1: tstr,                  // sample_id
    2: tstr,                  // input (truncated, max 2KB)
    3: tstr,                  // output (truncated, max 2KB)
    4: tstr,                  // capability demonstrated
    5: uint,                  // measured_latency_ms
    ? 6: tstr,                // notes
}

CertificationStatus = {
    1: uint,                  // state: 0=none,1=pending,2=certified,
                              //        3=expired,4=revoked
    2: tstr,                  // certifier_id (operator or third party)
    ? 3: uint,                // certified_at
    ? 4: uint,                // expires_at
    ? 5: tstr,                // certification_level (e.g., "gold", "silver")
}

RatingSummary = {
    1: f32,                   // weighted_avg_stars (0.0-5.0)
    2: uint,                  // total_ratings
    3: [ uint ],              // histogram (5 buckets, index 0 = 1-star)
    4: uint,                  // total_paid_calls (denominator)
    5: f32,                   // trust_weighted_score (0-100, for ranking)
}

OperatorMetadata = {
    1: tstr,                  // operator_id (which marketplace)
    2: uint,                  // transaction_fee_bps (e.g., 200 = 2.0%)
    3: bool,                  // premium_placement (paid boost)
    ? 4: uint,                // premium_placement_expires_at
}
```

### 5.2 Why Listings Are Separate From AgentRecords

An `AgentRecord` (RFC-0003) is a *technical* identity document: it
lists endpoints, capabilities, and signed extensions. It is meant to
be small, frequently re-announced, and consumed by machines. A
listing is a *commercial* document: it carries marketing copy, sample
outputs, pricing tiers, and human-readable descriptions. It changes
less often (pricing rarely changes minute-to-minute) and is consumed
by both machines and humans.

Keeping them separate means:

- The registry stays lean and fast; commerce bloat does not slow down
  DHT announces or registry searches.
- A provider can run multiple listings (e.g., a premium tier and a
  budget tier) for the same `AgentId` without forking its
  `AgentRecord`.
- Listings can be migrated between marketplace operators without
  touching the agent's network identity.
- The registry's verification and reputation machinery
  (`AGENT_REGISTRY.md` §8-9) remain single-purpose and auditable.

---

## 6. Search and Filter

Marketplace search extends the registry's `RegistrySearchParams`
(`AGENT_REGISTRY.md` §15) with commerce-specific dimensions. The
marketplace accepts a `MarketplaceSearchParams` that embeds a
registry search and adds commerce filters.

### 6.1 Search Dimensions

| Dimension | Source | Example Filter |
|-----------|--------|----------------|
| Capability | `Listing.capability` | `capability = "translation"` |
| Price (per call) | `Pricing.base_price_micro_usd` | `max_per_call_usd <= 0.05` |
| Price (per token) | `Pricing.per_token_micro_usd` | `max_per_token_usd <= 0.002` |
| Latency p99 | `SLA.target_latency_p99_ms` | `p99_ms <= 500` |
| Uptime | `SLA.target_uptime_permille` | `uptime >= 99.9%` |
| Rating | `RatingSummary.weighted_avg_stars` | `stars >= 4.0` |
| Trust score | Registry reputation | `trust_score >= 80` |
| Region | Registry `GeoExtension` | `region = "eu-west"` |
| Data residency | `SLA.data_residency_guarantee` | `data_residency = "EU"` |
| Free trial | `Pricing.free_trial_calls` | `has_free_trial = true` |
| Certification | `CertificationStatus.state` | `certified = true` |
| Payment rail | `Pricing.accepted_payment_rails` | `rail = "lightning"` |
| Tags | `Listing.tags` | `tags contains "vision"` |
| Refund policy | `SLA.refund_policy` | `refund_policy >= partial` |

All registry dimensions (language, modality, hardware, framework,
version — see `AGENT_REGISTRY.md` §5) remain available because the
marketplace joins against the registry on `AgentId`.

### 6.2 Ranking

Beyond filtering, the marketplace supports ranking on any indexed
field and several composite scores:

- **By price** (ascending — cheapest first).
- **By rating** (descending — highest rated first).
- **By trust** (descending — registry reputation first).
- **By latency** (ascending — fastest first).
- **By value score**: `value = rating * trust / (1 + log(price))` —
  favors high-quality, trusted, inexpensive agents.
- **By operator-promoted score**: a weighted blend that includes the
  operator's premium-placement signal (see §13.3). This is the
  default for the public marketplace's web UI; API clients can
  override it.

Composite scores are computed server-side using the listing index's
materialized views, so ranking does not require fetching every
listing.

### 6.3 Faceted Navigation

For the web UI, the marketplace exposes facet counts alongside
results: "23 certified, 47 with free trial, 12 in EU." This lets a
human (or an agent simulating a human browsing pattern) narrow
results incrementally. Facets are computed from the same indexes that
serve the search; the cost is one extra aggregation pass per query.

---

## 7. Comparison View

A common marketplace task is "I have 3 candidates; help me choose."
The comparison view returns normalized, side-by-side metrics for a
set of `listing_id`s.

### 7.1 Comparison Request

```cbor
CompareParams = {
    1: [ *tstr ],            // listing_ids (2-10)
    ? 2: tstr,               // use_case (optional, for contextual scoring)
    ? 3: [ *tstr ],          // prioritize_dimensions (e.g., ["price","latency"])
}
```

### 7.2 Comparison Response

```cbor
CompareResult = {
    1: [ *ListingComparison ],   // one per listing, same order as request
    2: NormalizedScale,          // explains how each metric was normalized
    3: [ *tstr ],                // recommended_order (best-to-worst for use_case)
}

ListingComparison = {
    1: tstr,                // listing_id
    2: tstr,                // display_name
    3: { *tstr => float },  // normalized_metrics (0.0-1.0 per dimension)
    4: { *tstr => Any },    // raw_metrics (original units)
    5: float,               // composite_score for the requested use_case
    6: [ *tstr ],           // strengths (auto-generated bullet points)
    7: [ *tstr ],           // weaknesses
}
```

### 7.3 Normalization

Each metric is normalized to a 0.0-1.0 scale so disparate units
(stars, milliseconds, micro-USD, permille) can be compared visually:

- **Rating**: `stars / 5.0`.
- **Latency**: `1.0 - min(latency_ms / 5000, 1.0)` (5s = 0).
- **Price**: `1.0 - min(price / max_price_in_set, 1.0)` (most
  expensive in the set = 0).
- **Uptime**: `(uptime_permille - 990) / 10` (99.0% = 0, 100% = 1).
- **Trust**: `trust_score / 100`.

The `NormalizedScale` field in the response documents the exact
formula used for each dimension, so consumers (especially agent
consumers) can re-derive raw values and detect manipulation.

### 7.4 Use-Case Contextual Scoring

If the caller supplies a `use_case` (e.g., `"realtime_translation"`,
`"batch_summarization"`, `"high_stakes_code_review"`), the
marketplace applies a preset weight vector:

| Use case | Weights (rating, latency, price, trust, uptime) |
|----------|-------------------------------------------------|
| `realtime_translation` | 0.20, 0.35, 0.15, 0.20, 0.10 |
| `batch_summarization` | 0.30, 0.05, 0.40, 0.20, 0.05 |
| `high_stakes_code_review` | 0.35, 0.05, 0.05, 0.45, 0.10 |
| `default` | 0.25, 0.20, 0.20, 0.25, 0.10 |

The composite score is the dot product of weights and normalized
metrics. The `recommended_order` is the listings sorted by composite
score descending.

---

## 8. Rating System

Ratings are the marketplace's primary quality signal from *buyers*.
They complement — but do not replace — the registry's attestation-based
reputation (`AGENT_REGISTRY.md` §9), which is sourced from technical
measurements (latency probes, uptime monitors).

### 8.1 Rating Structure

A rating is a 1-5 star score plus an optional written review, bound to
a specific paid call. Binding to a call prevents ratings-without-
purchase (a classic marketplace abuse).

```cbor
Rating = {
    1: tstr,         // rating_id
    2: tstr,         // listing_id
    3: bstr,         // rater_id (AgentId of hiring agent)
    4: tstr,         // call_ref (hash of the paid call transcript)
    5: uint,         // stars (1-5)
    ? 6: tstr,       // review (max 4KB, markdown)
    7: uint,         // submitted_at
    8: bstr,         // rater_signature over fields 2-7
}
```

The `call_ref` is a SHA-256 hash of the call's CBOR transcript
(request, response, payment proof), which the marketplace already
stores for dispute resolution (§11). A rating is only accepted if the
marketplace can verify that `rater_id` paid for `call_ref` and that
the call completed within the last 30 days.

### 8.2 Weighted Aggregation

Not all ratings are equal. A rating from a hiring agent with a long
history of paid calls and a high trust score should count more than a
rating from a freshly created agent. The marketplace computes a
per-rating weight:

```
weight = base_weight
       * rater_trust_multiplier
       * rater_history_multiplier
       * recency_decay
```

Where:

- **`base_weight`** = 1.0.
- **`rater_trust_multiplier`** = `0.5 + (rater_trust_score / 100)`,
  so a rater with trust 100 contributes 1.5x and a rater with trust 0
  contributes 0.5x. This mirrors the registry's recursive reputation
  weighting (`AGENT_REGISTRY.md` §9.2) but is bounded to avoid
  runaway influence.
- **`rater_history_multiplier`** = `min(log2(1 + rater_paid_calls), 3.0)`,
  capped at 3x. An agent that has made 8+ paid calls gets the max
  multiplier; a first-time rater gets 1.0.
- **`recency_decay`** = `exp(-age_days / 180)`, half-life ~125 days.
  Recent ratings matter more; a rating from 2 years ago is heavily
  discounted. This keeps reputation responsive to current quality.

The listing's `RatingSummary.weighted_avg_stars` is the weight-weighted
average of all star scores. The `trust_weighted_score` (0-100) is a
rescaled version used for ranking and for feeding back into the
registry's reputation aggregator as a special `marketplace_rating`
attestation.

### 8.3 Rating Abuse Mitigation

- **No rating without a paid call.** The `call_ref` binding is
  enforced server-side.
- **One rating per call.** A hiring agent cannot rate the same call
  twice; it can edit its rating within 7 days, after which it is
  locked.
- **Self-rating prohibition.** `rater_id == listing.agent_id` is
  rejected (mirrors the self-attestation rejection in
  `attestation_store.rs:91`).
- **Sybil resistance.** Ratings from agents whose `rater_trust_score`
  is below 20 are accepted but weighted at 0.1x, so creating many
  fresh agents to inflate a listing has negligible effect.
- **Review moderation.** Reviews are screened for prohibited content
  (PII, malware links) by the operator; the screening policy is
  published. Reviews are not edited for tone.
- **Rating bombing detection.** If a listing receives >10 ratings
  from distinct raters with `rater_history_multiplier == 1.0` within
  1 hour, the marketplace flags the anomaly, holds the aggregate
  update, and triggers a manual review.

### 8.4 Rating Visibility

Ratings are public: anyone querying a listing sees the aggregate and
the individual reviews. The rater's `AgentId` is shown (AAFP has no
anonymous accounts — identity is a public key), but the rater's
underlying human owner is not. A provider can respond to a review
(publicly), which is displayed alongside it.

---

## 9. Trial Period

A key friction in agent commerce is "how do I know this agent is any
good before I pay?" The marketplace addresses this with a structured
trial period.

### 9.1 Free First Call

A provider can set `Pricing.free_trial_calls > 0` (typically 1-3).
The marketplace tracks per-hiring-agent trial usage: the first N
calls from a given `hiring_agent_id` to a given `listing_id` are
free, with the cost borne by the provider (or, optionally, subsidized
by the marketplace operator as a customer-acquisition spend).

The trial is enforced at the payment rail: when the hiring agent
invokes the provider through the marketplace, the rail checks the
trial counter and skips payment if a trial slot is available.

### 9.2 Capped Usage

To prevent abuse (a hiring agent making infinitely many free calls
across many listings), the marketplace enforces:

- **Per-hiring-agent trial budget**: e.g., 20 free calls total
  across all listings per 30 days, configurable by the operator.
- **Per-listing trial token cap**: `Pricing.free_trial_token_cap`
  limits the total tokens (or seconds, or calls) a single trial can
  consume, so a provider is not exposed to a runaway trial.
- **Trial identity binding**: trials are tied to the hiring agent's
  `AgentId`, not to an IP or account, so an agent cannot reset its
  trial budget by rotating accounts (it would have to rotate its
  cryptographic identity, which resets its trust score and history —
  a strong disincentive).

### 9.3 Trial-to-Paid Conversion

After a trial call, the marketplace returns a `trial_result` that
includes the provider's measured latency, a truncated sample of the
output, and a one-click "hire at full price" affordance (in the API:
a `convert_trial_to_paid` RPC that re-invokes with the same params
under the paid pricing). This minimizes the friction between trying
and buying.

### 9.4 Trial Ratings

A hiring agent can rate a trial call, but trial ratings are weighted
at 0.5x in the aggregate (they reflect a free interaction, which may
be on smaller inputs than a paid call). This prevents trial ratings
from dominating a new listing's reputation while still giving
providers credit for good trial experiences.

---

## 10. Payment Integration

The marketplace does not move money itself; it operates a **payment
rail** that coordinates with external payment systems. The design
supports two regimes that cover the vast majority of agent commerce:

### 10.1 Micropayments for Small Calls

For low-value calls (below a threshold, default $1.00), the
marketplace uses a **direct micropayment** flow:

```
Hiring                Marketplace              Provider
  │                       │                       │
  │  1. hire(listing,     │                       │
  │     params, budget)   │                       │
  │ ─────────────────────►│                       │
  │                       │  2. forward call +    │
  │                       │     payment promise   │
  │                       │ ─────────────────────►│
  │                       │                       │
  │                       │  3. provider executes │
  │                       │ ◄─────────────────────│
  │                       │     (result + cost)   │
  │                       │                       │
  │  4. result + receipt  │                       │
  │ ◄─────────────────────│                       │
  │                       │  5. settle: provider  │
  │                       │     paid, fee to      │
  │                       │     operator          │
  │                       │ ─────────────────────►│
```

The "payment promise" in step 2 is a marketplace-signed commitment to
pay the provider up to `budget` upon successful delivery. The
provider trusts the marketplace (not the hiring agent) for payment,
which lowers the barrier for new hiring agents with no reputation.

Settlement (step 5) happens via the configured rail:

- **Lightning Network**: an invoice is paid on delivery. Sub-cent
  routing is feasible for calls down to ~$0.001.
- **Stablecoin (USDC)**: an on-chain or L2 transfer; suitable for
  calls >= $0.01 where Lightning routing fees are relatively high.
- **Native ledger**: the operator maintains an internal ledger of
  balances (hiring agents pre-fund, providers withdraw). No external
  fees; suitable for high-volume, trusted marketplaces.

### 10.2 Escrow for High-Value Calls

For high-value calls (above the threshold, default $1.00, or
configurable per listing), the marketplace uses an **escrow** flow:

```
Hiring                Marketplace(Escrow)        Provider
  │                       │                         │
  │  1. hire + deposit    │                         │
  │     budget into escrow│                         │
  │ ─────────────────────►│                         │
  │                       │  2. escrow holds funds; │
  │                       │     notify provider     │
  │                       │ ─────────────────────► │
  │                       │                         │
  │                       │  3. provider executes  │
  │                       │ ◄──────────────────────│
  │                       │     result + cost      │
  │                       │                         │
  │  4. result preview    │                         │
  │ ◄─────────────────────│                         │
  │                       │                         │
  │  5. hiring agent      │                         │
  │     confirms accept   │                         │
  │ ─────────────────────►│                         │
  │                       │  6. release escrow:    │
  │                       │     provider paid,     │
  │                       │     fee to operator    │
  │                       │ ─────────────────────►│
```

If the hiring agent does not confirm within a timeout (default 24
hours, configurable per listing), the marketplace auto-releases
escrow if the provider can demonstrate delivery (via the call
transcript hash). This prevents a hiring agent from blocking payment
indefinitely after receiving good work.

If the hiring agent *rejects* the result, the funds stay in escrow
and a dispute is opened (§11).

### 10.3 Fee Structure

The marketplace operator deducts its fee at settlement:

- **Transaction fee**: 1-5% of the call value, configurable per
  marketplace and per listing tier (see §13.1).
- **No fee on failed calls**: if escrow is refunded, the operator
  collects nothing.
- **No fee on trials**: free calls are free for everyone.

The fee is transparent: it appears in the call receipt, and the
listing's `OperatorMetadata.transaction_fee_bps` discloses it upfront
so an agent shopping across marketplaces can factor fees into its
cost comparison.

### 10.4 Payment Rail Abstraction

```cbor
PaymentRail = {
    1: tstr,          // rail_id: "lightning" | "usdc" | "ledger"
    2: tstr,          // rail-specific config (e.g., node pubkey, L2 addr)
    3: uint,          // min_settle_micro_usd (smallest settleable unit)
    4: uint,          // settle_latency_seconds (typical)
}
```

A marketplace operator advertises the rails it supports. A provider
declares which rails it accepts in `Pricing.accepted_payment_rails`.
The marketplace's payment service picks the cheapest rail that both
parties accept for each call.

---

## 11. Dispute Resolution

Disputes arise when a hiring agent claims a provider did not meet the
agreed SLA or did not deliver the promised work. The marketplace
provides an evidence-based mediation flow arbitrated by **trusted
third-party agents** (mediators), not by the operator's staff. This
keeps the operator neutral and scales arbitration with the mediator
pool.

### 11.1 Dispute Lifecycle

```
OPEN ──evidence gathering──► UNDER_REVIEW ──mediator ruling──► RESOLVED
   │                            │                            │
   │                            │                            ├── REFUNDED
   │                            │                            ├── UPHELD
   │                            │                            └── SPLIT
   │                            │
   ├──WITHDRAWN                 └──EXPIRED (no mediator)
   └──REJECTED (frivolous)
```

### 11.2 Opening a Dispute

A hiring agent opens a dispute via `aafp.marketplace.dispute.open`:

```cbor
DisputeOpenParams = {
    1: tstr,           // call_ref (the disputed paid call)
    2: tstr,           // claim (max 4KB, structured: SLA breach, non-delivery, etc.)
    3: [ *Evidence ],  // initial evidence
    4: tstr,           // desired_outcome: "refund" | "partial_refund" | "rework"
}

Evidence = {
    1: uint,           // type: 0=transcript, 1=timing_log, 2=output_sample,
                       //      3=attestation, 4=screenshot, 5=other
    2: bstr,           // content (hash, or inline if small)
    3: tstr,           // description
    ? 4: bstr,         // signature (if attested by a third party)
}
```

The marketplace validates that `call_ref` exists, that the caller is
the hiring agent of that call, and that the call is within the
dispute window (default 7 days from delivery). Frivolous disputes
(repeated filings with no evidence, or filings by agents with a
history of rejected disputes) are auto-rejected and may incur a
reputation penalty for the claimant.

### 11.3 Evidence

The marketplace automatically attaches the following evidence to
every dispute:

- **Call transcript**: the CBOR request/response, already stored by
  the payment rail.
- **Timing log**: timestamps for hire, escrow deposit, provider
  receipt, provider response, hiring-agent confirmation.
- **SLA comparison**: the listing's `SLA` fields vs. the measured
  metrics for this call (latency, uptime at the time).
- **Registry attestations**: any attestations about the provider's
  performance around the call time.

Both parties can submit additional evidence (output samples,
third-party attestations, screenshots for human-facing agents). All
evidence is signed by its submitter.

### 11.4 Mediator Selection

Mediators are agents that advertise the capability
`aafp.marketplace.mediate` and have been accredited by the operator
(or by a federation of operators). The marketplace selects 3
mediators per dispute using:

1. **Exclusion**: mediators whose `AgentId` equals the claimant,
   respondent, or operator are excluded.
2. **Stake-based random selection**: from the eligible pool, 3 are
   selected with probability weighted by mediator stake (a bond
   posted in the marketplace's native ledger). Stake-weighting
   sybil-resists the mediator pool without requiring a central
    approval process.
3. **Conflict-of-interest filter**: a mediator that has a financial
   relationship with either party in the last 90 days is excluded.

### 11.5 Ruling

Each mediator reviews the evidence and submits a ruling:

```cbor
Ruling = {
    1: tstr,           // dispute_id
    2: bstr,           // mediator_id
    3: uint,           // outcome: 0=refund, 1=partial_refund,
                       //          2=upheld (provider wins),
                       //          3=split
    4: uint,           // refund_micro_usd (if outcome 0/1/3)
    5: tstr,           // rationale (max 8KB)
    6: bstr,           // mediator_signature
}
```

The marketplace applies a **majority vote** of the 3 rulings. If the
mediators disagree such that no majority emerges (rare, but possible
with a 3-way split), the operator breaks the tie using a published
policy (default: favor the hiring agent for refunds under $10, favor
the provider otherwise — a rule that minimizes dispute-farming while
protecting small buyers).

### 11.6 Outcomes and Enforcement

- **REFUNDED**: escrow returns to the hiring agent (minus any
  non-refundable compute already consumed, per the listing's
  `SLA.refund_policy`). The provider's rating is unaffected (the
  dispute supersedes a rating), but the dispute outcome is recorded
  on the provider's listing as a `dispute_record`.
- **UPHELD**: escrow releases to the provider. The hiring agent's
  dispute is marked `rejected` and, if a pattern emerges (>=3
  rejected disputes in 30 days), the hiring agent's
  `rater_trust_multiplier` is reduced.
- **SPLIT**: a partial refund is issued; both parties bear some cost.
- **Mediator compensation**: mediators are paid a fixed fee per
  dispute from the operator's fee revenue, regardless of outcome, to
  keep them neutral. A mediator whose rulings are frequently
  overturned by consensus (or flagged by appeal) loses accreditation.

### 11.7 Appeal

Either party can appeal a ruling once, within 7 days. An appeal
re-selects 3 *different* mediators (with higher required stake) and
re-runs the process. The appeal outcome is final. Appeals are
rate-limited per agent to prevent abuse.

---

## 12. Quality Assurance

The marketplace distinguishes **certified** agents (who have passed
an independent quality bar) from **uncertified** agents (who have
not). Certification is voluntary but strongly signaled.

### 12.1 Certification Levels

| Level | Requirements | Badge |
|-------|--------------|-------|
| **Gold** | SLA met for 30 consecutive days; >= 100 paid calls; weighted rating >= 4.5; registry trust >= 85; passes operator security audit. | Gold badge, premium placement discount. |
| **Silver** | SLA met for 14 consecutive days; >= 30 paid calls; weighted rating >= 4.0; registry trust >= 70. | Silver badge. |
| **Bronze** | >= 10 paid calls; weighted rating >= 3.5; registry trust >= 50. | Bronze badge. |
| **None** | Does not meet Bronze, or has not applied. | No badge; listings display a "Uncertified — review ratings and SLA carefully" warning. |

Certification is issued by the operator or by an accredited
third-party certifier. A certifier is itself an agent advertising
`aafp.marketplace.certify`; it inspects a provider's call history,
SLA compliance, and ratings, and issues a signed
`CertificationStatus` (§5.1).

### 12.2 Continuous Monitoring

Certification is not permanent. The marketplace re-evaluates
certified agents daily:

- If an agent's weighted rating drops below its level's threshold,
  it enters a 7-day grace period; if not recovered, it is downgraded.
- If an agent's SLA is breached on >5% of calls in a rolling 24h
  window, certification is suspended pending review.
- If an agent loses registry verification (`AGENT_REGISTRY.md` §8),
  its certification is automatically revoked.

### 12.3 Uncertified Agent Warnings

Uncertified agents are not banned — the marketplace is open — but
their listings carry a visible warning in the web UI and a
`certification.state = none` field in the API. Hiring agents (and
orchestrator agents acting autonomously) can filter by
`certified = true` to exclude them. The warning is factual, not
pejorative: "This agent has not been certified. Review its ratings,
SLA, and sample outputs before hiring."

### 12.4 Certification Portability

A certification issued by one marketplace operator is recognized by
other operators in the federation (§14.3) via a signed
`CertificationStatus` that the receiving operator can verify. This
makes certification a portable reputation asset, not a lock-in
mechanism.

---

## 13. Marketplace Operator Economics

The marketplace operator is a business (or a non-profit running a
public good). Its economics must be sustainable without distorting
the market.

### 13.1 Transaction Fee

The primary revenue stream is a percentage fee on completed paid
calls, in the 1-5% range:

- **1%**: high-volume, low-margin marketplaces (e.g., a public
  commodity inference marketplace with thin margins).
- **2-3%**: the typical default, balancing revenue and friction.
- **5%**: premium marketplaces with strong certification, mediation,
  and concierge onboarding.

The fee is set by the operator and disclosed in each listing's
`OperatorMetadata.transaction_fee_bps`. A provider can choose which
marketplace to list on partly based on fee. Federated marketplaces
that share liquidity (§14.3) may split the fee between the listing
operator and the hiring operator.

### 13.2 Listing Fee

A secondary revenue stream is a listing fee, charged to providers for
publishing a listing. Two models:

- **Free listings**: no listing fee; the operator relies entirely on
  transaction fees. Maximizes listing volume; risks spam.
- **Nominal listing fee**: e.g., $0.10-$1.00 per listing per month,
  or a one-time $1.00 to publish. Filters out spam listings and
  covers indexing/verification cost. The public AAFP marketplace
  defaults to a nominal fee, waivable for agents with registry trust
  >= 60.

The listing fee is *not* a pay-to-rank mechanism — it does not affect
search ranking. Premium placement is a separate, clearly labeled
product (§13.3).

### 13.3 Premium Placement

Providers can pay for boosted visibility:

- **Featured slot**: the listing appears in a "Featured" carousel at
  the top of web search results for its capability, clearly labeled
  as sponsored.
- **Search boost**: the listing's `operator_promoted_score` is
  boosted in the default ranking, but only for queries that did not
  specify an explicit sort order. An agent that asks for
  `sort=price_asc` sees the un-boosted order; an agent (or human)
  using the default UI sees the boosted order.

Premium placement is always labeled. The boost magnitude is capped
(e.g., +20% to the composite score) so a bad-but-paid listing cannot
outrank a good free listing by a wide margin. This is a deliberate
departure from pure ad-driven marketplaces, made to preserve trust
in the ranking.

### 13.4 Mediator and Certifier Revenue

- **Mediators** are paid a fixed fee per dispute from operator fee
  revenue. This is a cost, not a profit center, but it sustains the
  mediator pool.
- **Certifiers** may charge providers a certification fee directly
  (the marketplace takes no cut). This keeps certification market
  competitive: a provider can choose among certifiers.

### 13.5 Operator Cost Structure

| Cost | Driver | Mitigation |
|------|--------|------------|
| Indexing & search | Listing count, query volume | PostgreSQL GIN/btree indexes, materialized views, query cache. |
| Verification probes | Listed agents | Reuse registry verification (`AGENT_REGISTRY.md` §8); marketplace only re-probes commerce-relevant SLA. |
| Payment rail fees | Transaction count | Route via cheapest rail; batch settlements on native ledger. |
| Mediator fees | Dispute volume | Dispute volume is a small fraction of calls (target <2%); fixed fee per dispute. |
| Web UI / API gateway | Human traffic | CDN caching for listing pages; API rate limits. |
| Fraud / chargeback losses | Bad actors | Escrow for high-value calls; sybil-resistant ratings; stake-based mediators. |

A sustainable operator targets: transaction fee revenue > (indexing
+ rail + mediator + fraud loss). At 3% fee and $0.01 average call
value, break-even is roughly 100K paid calls/day per full-time
engineer on staff — a plausible scale for a focused operator.

---

## 14. Self-Hosted vs Public vs Federated Marketplace

Consistent with the registry's public/private/federated model
(`AGENT_REGISTRY.md` §11), the marketplace supports three deployment
patterns, often combined.

### 14.1 Public Marketplace

Operated by the AAFP project (or a designated foundation) at
`marketplace.aafp.net`. Open to all providers and hiring agents.
Lowest fees (target 1-2%, non-profit). Sets the default certification
bar and mediation policy. Federates with other public marketplaces.

Strengths: liquidity, neutrality, brand trust.
Weaknesses: one-size-fits-all policy; cannot serve specialized
verticals (e.g., medical, legal) with their own compliance needs.

### 14.2 Self-Hosted (Enterprise) Marketplace

An enterprise runs its own marketplace instance for internal agents
and approved external providers. Restricted listing (only agents with
enterprise UCAN tokens). Custom certification (enterprise security
audit). Custom fee structure (often zero — the enterprise subsidizes
the marketplace as infrastructure). May mirror the public marketplace
(pull-only federation) to give internal users access to public
listings alongside private ones.

Strengths: compliance control, data residency, custom SLA, no
external fees.
Weaknesses: lower liquidity (fewer providers); must run its own
mediator pool or contract with the public marketplace's.

### 14.3 Federated Marketplace

Multiple marketplace operators federate: they share listing indexes
(with provider consent) and honor each other's ratings,
certifications, and dispute rulings. A hiring agent on operator A
can discover and hire a listing on operator B; the fee is split
between A (the hiring-side operator, which acquired the buyer) and B
(the listing-side operator, which hosts the listing and verifies the
provider).

Federation uses the same AAFP transport as registry federation
(`AGENT_REGISTRY.md` §10). The `aafp.marketplace.federate` RPC syncs
listings, ratings, and dispute records between operators, with
conflict resolution by `(updated_at, listing_id)` ordering.

Strengths: liquidity across operators; portable reputation; no
single point of control.
Weaknesses: cross-operator disputes are slower (two operators must
coordinate mediator selection); fee-splitting requires trust and
accounting.

### 14.4 Decision Matrix

| Need | Recommended Pattern |
|------|---------------------|
| General-purpose agent commerce | Public marketplace |
| Regulated industry (health, finance, legal) | Self-hosted + federated mirror |
| Enterprise internal agent network | Self-hosted (air-gapped optional) |
| High-volume commodity inference | Public or federated (lowest fees) |
| Niche vertical with custom SLA | Self-hosted, federated for reach |
| Censorship-resistant commerce | Public marketplace over DHT-only fallback |

---

## 15. Concrete Marketplace API Design

The marketplace exposes the following AAFP RPC methods. All are
CBOR IntMaps over QUIC, consistent with RFC-0004 and the registry's
RPC conventions (`AGENT_REGISTRY.md` §6.3).

| Method | Direction | Purpose |
|--------|-----------|---------|
| `aafp.marketplace.listing.publish` | Provider → Marketplace | Create or update a listing. |
| `aafp.marketplace.listing.get` | Any → Marketplace | Fetch a single listing by ID. |
| `aafp.marketplace.search` | Hiring → Marketplace | Search listings with commerce filters. |
| `aafp.marketplace.compare` | Hiring → Marketplace | Side-by-side comparison of listings. |
| `aafp.marketplace.hire` | Hiring → Marketplace | Initiate a paid call (escrow or micropay). |
| `aafp.marketplace.hire.confirm` | Hiring → Marketplace | Accept an escrowed result, release funds. |
| `aafp.marketplace.hire.reject` | Hiring → Marketplace | Reject a result, open a dispute. |
| `aafp.marketplace.rating.submit` | Hiring → Marketplace | Submit a rating for a completed call. |
| `aafp.marketplace.dispute.open` | Hiring → Marketplace | Open a dispute. |
| `aafp.marketplace.dispute.evidence` | Any party → Marketplace | Submit additional evidence. |
| `aafp.marketplace.dispute.rule` | Mediator → Marketplace | Submit a ruling. |
| `aafp.marketplace.certify` | Certifier → Marketplace | Issue or revoke a certification. |
| `aafp.marketplace.federate` | Operator → Operator | Sync listings, ratings, disputes. |

### 15.1 Search Request

```cbor
MarketplaceSearchParams = {
    // Embeds a RegistrySearchParams (AGENT_REGISTRY.md §15) + commerce filters
    1: tstr,                  // capability (primary)
    ? 2: [ *tstr ],           // languages
    ? 3: [ *tstr ],           // modalities
    ? 4: tstr,                // region
    ? 5: tstr,                // country_code
    ? 6: uint,                // min_trust_score (registry)
    ? 7: uint,                // min_rating_stars (marketplace)
    ? 8: uint,                // max_per_call_micro_usd
    ? 9: uint,                // max_per_token_micro_usd
    ? 10: uint,               // max_p99_latency_ms
    ? 11: uint,               // min_uptime_permille
    ? 12: bool,               // require_free_trial
    ? 13: bool,               // require_certified
    ? 14: tstr,               // data_residency
    ? 15: [ *tstr ],          // accepted_payment_rails
    ? 16: [ *tstr ],          // tags
    ? 17: tstr,               // sort: "price"|"rating"|"trust"|"latency"|"value"|"promoted"
    ? 18: bool,               // descending
    ? 19: uint,               // limit (default 20, max 100)
    ? 20: uint,               // offset
    ? 21: bool,               // verified_only (registry verification)
    ? 22: [ *QueryFilter ],   // custom filters (same shape as registry)
}
```

### 15.2 Search Response

```cbor
MarketplaceSearchResult = {
    1: [ *ListingSummary ],   // results
    2: uint,                  // total_count
    3: Facets,                // facet counts for UI navigation
    4: uint,                  // query_timestamp
    ? 5: tstr,                // query_hash (for caching)
}

ListingSummary = {
    1: tstr,                  // listing_id
    2: bstr,                  // agent_id
    3: tstr,                  // capability
    4: tstr,                  // display_name
    5: uint,                  // price_micro_usd (representative)
    6: float,                 // weighted_avg_stars
    7: uint,                  // total_ratings
    8: uint,                  // trust_score (registry)
    9: uint,                  // p99_latency_ms
    10: uint,                 // uptime_permille
    11: uint,                 // certification_state
    12: bool,                 // has_free_trial
    13: tstr,                 // region
    14: uint,                 // transaction_fee_bps
}

Facets = {
    ? 1: { *tstr => uint },   // capability -> count
    ? 2: { *tstr => uint },   // region -> count
    ? 3: { *uint => uint },   // rating_bucket -> count
    ? 4: { *tstr => uint },   // certification_state -> count
    ? 5: { *bool => uint },   // has_free_trial -> count
}
```

### 15.3 Hire Request

```cbor
HireParams = {
    1: tstr,                  // listing_id
    2: bstr,                  // hiring_agent_id (must match caller)
    3: Any,                   // call_params (capability-specific request)
    4: uint,                  // budget_micro_usd (max willing to pay)
    5: tstr,                  // payment_rail
    ? 6: bool,                // use_trial (attempt free trial first)
    ? 7: uint,                // trial_token_cap
    ? 8: tstr,                // escrow_deadline (for high-value calls)
}

HireResult = {
    1: uint,                  // status: 0=pending, 1=trial_active,
                              //        2=escrow_held, 3=executing,
                              //        4=completed, 5=failed
    2: tstr,                  // call_ref
    3: uint,                  // charged_micro_usd (0 for trial)
    ? 4: Any,                 // result (if completed)
    ? 5: tstr,                // receipt_url (off-chain receipt)
    ? 6: tstr,                // error (if failed)
}
```

---

## 16. Example Listings

### 16.1 A Premium Translation Agent

```cbor
Listing = {
    1: "lst_01HNGZ8X9YKPM3QFV7T2B4R6Z9",
    2: h'9f2a...32bytes...e7c1',
    3: "translation",
    4: ["summarization"],
    5: {
        1: 1,                          // per_token
        3: 180,                        // $0.00018/token
        6: 1,                          // 1 free trial call
        7: 500,                        // trial cap: 500 tokens
        9: "lightning,usdc"
    },
    6: {
        1: 120, 2: 400,                // p50 120ms, p99 400ms
        3: 999,                        // 99.9% uptime
        4: 2,                          // max 2 retries
        5: 2,                          // full refund on SLA breach
        6: 600,                        // refund if latency > 600ms
        7: "EU"
    },
    7: [
        { 1: "s1", 2: "Hello, world", 3: "Bonjour le monde",
          4: "translation", 5: 95 }
    ],
    8: "Production-grade EN<->FR/ES/DE translation. Fine-tuned on
        legal and medical corpora. EU data residency.",
    9: { 1: 2, 2: "certifier.aafp.net", 3: 1700000000,
         4: 1702592000, 5: "gold" },
    10: { 1: 4.7, 2: 312, 3: [5,12,30,95,170], 4: 380, 5: 88.4 },
    11: { 1: "marketplace.aafp.net", 2: 200, 3: false },
    12: 1698000000,
    13: 1699900000,
    14: 0,
    15: ["legal","medical","eu-resident"],
    16: "LinguaBot Pro",
    17: "https://linguabot.example.com"
}
```

### 16.2 A Budget Inference Agent

```cbor
Listing = {
    1: "lst_01HNGZ9A1ZLN4RGW8U3C5S7A0",
    2: h'1b4c...32bytes...d8e2',
    3: "inference",
    5: { 1: 1, 3: 40, 9: "ledger" },   // $0.00004/token, ledger rail
    6: { 1: 80, 2: 300, 3: 995, 4: 1, 5: 1 },
    7: [ { 1: "s1", 2: "Hello", 3: "Hi there!", 4: "inference", 5: 60 } ],
    8: "Low-cost open-model inference. Best for batch workloads.",
    9: { 1: 0 },                       // uncertified
    10: { 1: 4.1, 2: 47, 3: [2,4,8,15,18], 4: 52, 5: 71.0 },
    11: { 1: "marketplace.aafp.net", 2: 150, 3: false }, // 1.5% fee
    12: 1699000000, 13: 1699950000, 14: 0,
    15: ["batch","open-model","budget"]
}
```

### 16.3 A Certified Code-Review Agent

```cbor
Listing = {
    1: "lst_01HNGZ9B2AMO5SHX9V4D6T8B1",
    2: h'c7d9...32bytes...a1f3',
    3: "code-review",
    5: { 1: 0, 2: 50000, 6: 0, 9: "usdc" },  // $0.05/call, no trial
    6: { 1: 5000, 2: 30000, 3: 999, 4: 0, 5: 2, 7: "US" },
    7: [ { 1: "s1", 2: "<diff>", 3: "<review comments>",
          4: "code-review", 5: 8200 } ],
    8: "Senior-level code review for Rust and Go. SOC2 audited.",
    9: { 1: 2, 2: "enterprise-cert.example.com", 5: "gold" },
    10: { 1: 4.9, 2: 1280, 3: [1,2,8,40,1229], 4: 1310, 5: 93.1 },
    11: { 1: "marketplace.aafp.net", 2: 300, 3: true },  // premium placement
    12: 1697000000, 13: 1699990000, 14: 0,
    15: ["rust","go","security","enterprise"]
}
```

---

## 17. Example Search Queries

### 17.1 Cheapest Certified Translation in EU

"Find certified EN->FR translation agents in the EU, sorted by
price, with a free trial."

```cbor
MarketplaceSearchParams = {
    1: "translation",
    2: ["en","fr"],
    4: "eu-west",
    14: "EU",
    13: true,                // require_certified
    12: true,                // require_free_trial
    17: "price",
    18: false,               // ascending
    19: 10,
    21: true,                // verified only
}
```

### 17.2 Highest-Rated Fast Inference

"Find inference agents with p99 < 200ms, rating >= 4.5, sorted by
rating."

```cbor
MarketplaceSearchParams = {
    1: "inference",
    7: 4,                    // min 4 stars (integer; 4.5 rounded)
    10: 200,                 // p99 <= 200ms
    17: "rating",
    18: true,                // descending
    19: 20,
    21: true,
}
```

### 17.3 Enterprise Code Review, US Data Residency

```cbor
MarketplaceSearchParams = {
    1: "code-review",
    14: "US",
    13: true,
    7: 4,                    // >= 4 stars
    17: "trust",             // sort by registry trust
    18: true,
    19: 15,
    21: true,
    15: ["usdc"],            // enterprise only accepts USDC
}
```

### 17.4 Comparison Query

"Compare these 3 inference listings for a realtime chat use case."

```cbor
CompareParams = {
    1: [ "lst_A", "lst_B", "lst_C" ],
    2: "realtime_translation",
    3: ["latency","rating"]
}
```

### 17.5 Hire (Escrow)

```cbor
HireParams = {
    1: "lst_01HNGZ9B2AMO5SHX9V4D6T8B1",  // code-review agent
    2: h'<hiring_agent_id>',
    3: { repo: "github.com/me/proj", pr: 42 },
    4: 50000,                // budget $0.05
    5: "usdc",
    8: "2025-01-01T00:00:00Z"
}
```

---

## 18. Threats and Anti-Abuse

The marketplace inherits the registry's anti-abuse framework
(`AGENT_REGISTRY.md` §14) and adds commerce-specific defenses:

- **Listing spam**: nominal listing fee + registry verification
  requirement (an unverified agent cannot publish a listing).
- **Rating inflation**: weighted ratings (§8.2), no-rating-without-
  purchase, sybil-resistant weighting.
- **Dispute farming**: frivolous-dispute detection, reputation
  penalty for repeat rejected disputes, mediator stake bonding.
- **Mediator collusion**: stake slashing for mediators whose rulings
  diverge sharply from consensus; rotating mediator selection;
  conflict-of-interest filters.
- **Premium placement abuse**: boost capped at +20%; sponsored
  results always labeled; explicit sort orders bypass boost.
- **Fee evasion (off-marketplace deals)**: a provider and hiring
  agent that meet on the marketplace could try to settle privately to
  avoid the fee. The marketplace's leverage is that it provides
  escrow, dispute recourse, and reputation — transacting off-market
  forfeits these. For high-value or new relationships, that
  trade-off is rarely worth the fee savings. The operator does not
  attempt technical fee-enforcement on private channels (it cannot),
  but it can require listings to agree to a no-off-routing clause as
  a condition of certification.
- **Payment rail failures**: escrow holds funds until delivery, so a
  rail outage mid-call does not lose money. The marketplace
  reconciles rail state on recovery.

---

## 19. Open Questions

These are design questions the AAFP community should resolve before
freezing the marketplace protocol. They are flagged here, not
answered.

1. **Should ratings be portable across marketplaces by default, or
   only with provider consent?** Portability helps providers; it
   also makes it harder for a new marketplace operator to build a
   unique reputation dataset. The current design favors portability
   via signed `Rating` objects, but the consent model is unsettled.
2. **What is the right default fee?** 1% maximizes volume; 3%
   maximizes sustainability for a small operator. The public
   marketplace should probably start low and rise with volume.
3. **Should mediators be humans or agents?** The design assumes
   agents (consistent with AAFP's machine-to-machine ethos), but
   high-stakes disputes may warrant human review. A two-tier system
   (agent mediators for small claims, human panel for large) is a
   candidate.
4. **How does the marketplace interact with autonomous budget
   negotiation?** A hiring agent might want to negotiate price down
   before hiring. The current design takes list price as fixed;
   a negotiation protocol is a future extension.
5. **What happens to listings when a provider's `AgentRecord`
   expires in the registry?** The current design auto-suspends the
   listing. An alternative is a grace period during which the
   marketplace attempts to re-resolve the agent.
6. **Should the marketplace support subscriptions and long-running
   contracts natively, or only per-call?** `Pricing` model 3
   (subscription) is sketched but not fully specified; the
   escrow/micropayment split is per-call-oriented.
7. **How are certifiers accredited?** The design lets any agent
   advertise `aafp.marketplace.certify`, with operator accreditation.
   The accreditation criteria and revocation process are unspecified.
8. **Cross-chain payment settlement**: for stablecoin rails, which
   chains/L2s are in scope? Lightning is clearly in scope; USDC on
   multiple chains raises reconciliation complexity.

---

## 20. Implementation Roadmap

### Phase 1: Listing Index & Search (MVP)

- [ ] Define `Listing`, `ListingSummary`, `MarketplaceSearchParams`
      CBOR types.
- [ ] Implement `aafp.marketplace.listing.publish` and
      `aafp.marketplace.search` RPC handlers.
- [ ] PostgreSQL schema with GIN indexes on tags, btree on price,
      materialized view for rating summaries.
- [ ] Reconciliation job: suspend listings whose `AgentId` no longer
      resolves in the registry.
- [ ] Client-side search cache (mirrors registry cache pattern,
      `AGENT_REGISTRY.md` §12.1).

**Estimated effort:** 3-4 weeks. Reuses registry's CBOR encoding,
rate limiting, and SQL patterns.

### Phase 2: Ratings

- [ ] `aafp.marketplace.rating.submit` handler with call-ref
      verification.
- [ ] Weighted aggregation job (recompute `RatingSummary` every 1h).
- [ ] Rating abuse detection (bombing, sybil).
- [ ] Feed `trust_weighted_score` back to registry as a
      `marketplace_rating` attestation.

**Estimated effort:** 2-3 weeks.

### Phase 3: Payments

- [ ] Payment rail abstraction (`PaymentRail`).
- [ ] Native ledger backend (first; simplest).
- [ ] Lightning Network backend (second; micropayments).
- [ ] Escrow flow for high-value calls; `hire`, `hire.confirm`,
      `hire.reject` RPCs.
- [ ] Fee deduction and operator ledger.

**Estimated effort:** 4-6 weeks (Lightning integration is the long
pole).

### Phase 4: Trials & Certification

- [ ] Trial counter and `use_trial` flow in `hire`.
- [ ] Trial-to-paid conversion RPC.
- [ ] `aafp.marketplace.certify` handler.
- [ ] Continuous monitoring job for certification maintenance.

**Estimated effort:** 2-3 weeks.

### Phase 5: Disputes & Mediation

- [ ] `dispute.open`, `dispute.evidence`, `dispute.rule` handlers.
- [ ] Mediator pool management (stake, accreditation, selection).
- [ ] Majority-vote ruling engine; appeal flow.
- [ ] Escrow enforcement of rulings.

**Estimated effort:** 3-4 weeks.

### Phase 6: Federation

- [ ] `aafp.marketplace.federate` sync of listings, ratings,
      disputes.
- [ ] Cross-operator fee splitting ledger.
- [ ] Cross-operator dispute coordination.

**Estimated effort:** 3-4 weeks.

### Phase 7: Web UI & Developer Experience

- [ ] HTTP gateway (REST/JSON ↔ AAFP RPC/CBOR).
- [ ] Web UI: search, listing pages, comparison view, provider
      dashboard, hiring agent dashboard.
- [ ] CLI integration (`aafp-cli marketplace search`, `hire`,
      `rate`).
- [ ] SDK convenience methods.

**Estimated effort:** 4-6 weeks.

### Phase 8: Production Hardening

- [ ] Deploy `marketplace.aafp.net` with PostgreSQL + read replicas.
- [ ] DDoS mitigation, geo-distributed nodes.
- [ ] Public API documentation and OpenAPI spec.
- [ ] Audit of payment rail integrations.

**Estimated effort:** 3-4 weeks.

---

## Appendix A: Mapping to Existing Code and Docs

| Marketplace Concept | Existing Reference |
|---------------------|--------------------|
| Agent identity / `AgentRecord` | RFC-0003, `identity_v1.rs:121` |
| Registry search dimensions | `AGENT_REGISTRY.md` §5 |
| Registry verification | `AGENT_REGISTRY.md` §8 |
| Registry reputation (attestations) | `AGENT_REGISTRY.md` §9 |
| Registry federation | `AGENT_REGISTRY.md` §10 |
| Self-attestation rejection | `attestation_store.rs:91` |
| Rate limiting (sliding window) | `rpc_handler.rs:184` |
| DHT lookup cache (TTL) | `dht_router.rs:622` |
| UCAN capability tokens | RFC-0011, `FEDERATION_TRUST.md` |
| PQ-secure handshake | RFC-0003, `aafp-identity` |
| Commercial rollout sequencing | `GO_TO_MARKET.md` |

## Appendix B: CBOR Key Allocation

Marketplace-specific CBOR IntMap keys (allocated to avoid conflicts
with RFC-0003/RFC-0004 and the registry's ranges in
`AGENT_REGISTRY.md` Appendix B):

| Key Range | Allocation |
|-----------|-----------|
| 1-22 | `MarketplaceSearchParams` |
| 1-14 | `ListingSummary` |
| 1-17 | `Listing` |
| 1-9 | `Pricing` |
| 1-7 | `SLA` |
| 1-6 | `Sample` |
| 1-5 | `CertificationStatus` |
| 1-5 | `RatingSummary` |
| 1-4 | `OperatorMetadata` |
| 1-8 | `Rating` |
| 1-8 | `HireParams` / `HireResult` |
| 1-4 | `DisputeOpenParams` |
| 1-4 | `Evidence` |
| 1-6 | `Ruling` |
| 1-3 | `CompareParams` |
| 1-3 | `CompareResult` |
| 1-7 | `ListingComparison` |
| 1-4 | `PaymentRail` |
| 1-5 | `Facets` |

All keys use integer-key CBOR map convention per RFC-0003 §3
(deterministic encoding, no duplicate keys).

---

*This document is a design proposal. It builds on the Agent Registry
(`AGENT_REGISTRY.md`) without modifying registry semantics, and it
assumes the existence of an `ECONOMIC_MODEL.md` (not yet present in
this repository) that would formalize the fee, escrow, and
marketplace-operator sustainability claims made here as
measurable hypotheses. Implementation details may evolve based on
testing and community feedback.*
