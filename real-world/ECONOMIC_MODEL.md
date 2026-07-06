# AAFP Economic Model & Agent Marketplace

**Status:** Design Document
**Track:** Economics (real-world deployment analysis)
**Date:** 2025-01-20
**Depends on:** `AGENT_RECORD_EXTENSIONS.md` (§5.3 CostExtension), `ADAPTIVE_ROUTING_PLANE.md` (§4 cost-aware scoring), `STRATEGIC_VISION.md` (§5 "Don't become the blockchain of AI")
**Affects:** `crates/aafp-identity/src/extensions/cost.rs`, `crates/aafp-routing/src/dynamic_score.rs`, future `crates/aafp-payments/` crate

---

## 1. Executive Summary

AAFP is a protocol for agent-to-agent communication: discovery, transport,
identity, trust. It is not a payment network. But agents have real costs —
GPU compute, API calls, electricity, operator time — and the protocol must
carry enough economic metadata for agents to make *cost-aware routing
decisions* without becoming a settlement layer itself.

This document covers:

1. **Agent pricing models** — how agents advertise what they charge
   (per-call, per-token, per-second, subscription, freemium).
2. **Cost advertising** — the `CostExtension` in `AgentRecord` (key 11,
   namespace `"aafp.cost.v1"`), with concrete CBOR encoding.
3. **Payment protocols** — how agents settle: crypto micropayments, credit
   accounts, barter, reputation credits. AAFP carries payment *instructions*,
   not payments themselves.
4. **Micropayment channels** — Lightning Network integration for sub-cent
   agent-to-agent payments, with BOLT-11 invoice exchange over AAFP RPC.
5. **Agent marketplace** — discovery, comparison, and hiring of agents based
   on cost + quality + trust, using the existing DHT and extension index.
6. **Price negotiation** — a pre-RPC handshake where agents agree on price
   before execution. Three modes: take-it-or-leave-it, bounded negotiation,
   auction.
7. **Budget enforcement** — the client agent has a budget; it refuses or
   aborts calls that would exceed it. Budgets propagate through agent chains.
8. **Cost optimization** — routing to the cheapest agent that meets a quality
   threshold, integrated with the existing `dynamic_score()` function.
9. **Free agent federation** — open-source model operators that provide
   inference for free, funded by grants, hardware sponsors, or goodwill.
10. **Enterprise billing** — monthly invoicing for organizations running
    fleets of agents, with aggregation and cost allocation.
11. **Economic sustainability** — how agent operators cover costs: margin on
    inference, value-added services, data sales, compute arbitrage.
12. **Token-based economics** — whether AAFP should have a token. Short
    answer: **no.** Long answer: §12.
13. **Concrete example** — an LLM agent charging $0.001/1K tokens via AAFP,
    end-to-end from discovery to settlement.

**Design principle:** AAFP carries economic *signals* (prices, budgets,
payment instructions) but does not *settle* payments. Settlement happens
out-of-band via Lightning, credit networks, fiat invoicing, or barter. This
keeps the protocol focused on its core mission (identity, transport,
discovery, trust) and avoids the "blockchain of AI" trap identified in
`STRATEGIC_VISION.md` §5.

---

## 2. Agent Pricing Models

Agents charge for their services in different ways depending on what they
do. A code execution agent charges per-second (compute time). An LLM
inference agent charges per-token (output length). A web scraping agent
charges per-invocation (each page fetch). A monitoring agent charges by
subscription (always-on service). Some agents are free.

### 2.1 Per-Invocation Pricing

The simplest model: a fixed cost per RPC call, regardless of input size or
duration. Suitable for:

- Web scraping / page fetch (cost is the HTTP request, not the content)
- API gateway agents (proxying a fixed-cost upstream API)
- Image classification (fixed input size, predictable compute)
- Database lookup agents (constant-time query)

**CostExtension field:** `per_invocation_micro_usd`

```
Example: $0.00005 per invocation
  per_invocation_micro_usd = 50
  per_token_micro_usd = None
  per_second_micro_usd = None
```

**Pros:** Predictable cost for the client. Easy budget enforcement (count
calls × price). Simple to reason about.

**Cons:** Doesn't account for variable work. A 10-token response and a
10,000-token response cost the same. Agents may overcharge for short
responses or undercharge for long ones.

### 2.2 Per-Token Pricing

Used by LLM inference agents. Cost is proportional to the number of tokens
processed (input + output, or output only). This is the dominant pricing
model for language model APIs today (OpenAI, Anthropic, Google).

**CostExtension field:** `per_token_micro_usd`

```
Example: $0.002 / 1K tokens = $0.000002 per token
  per_invocation_micro_usd = None
  per_token_micro_usd = 2
  per_second_micro_usd = None
```

**Pros:** Fair — cost tracks actual compute. Clients can estimate cost from
prompt length. Standard model in the LLM industry.

**Cons:** Hard to budget precisely (output length is unknown until
generation completes). Requires the agent to report token counts in the
response for settlement. Input and output tokens may have different prices
(see §2.2.1).

### 2.2.1 Split Input/Output Token Pricing

Many LLM providers charge different rates for input (prompt) and output
(generated) tokens. The current `CostExtension` has a single
`per_token_micro_usd` field. For split pricing, we recommend:

- Use `per_token_micro_usd` for **output** tokens (the dominant cost).
- Use `CapabilityDescriptor.metadata` with keys `"input_token_micro_usd"`
  and `"output_token_micro_usd"` for per-capability split pricing.

This avoids extending the `CostExtension` struct for a pricing detail that
only applies to LLM capabilities. The metadata approach is already
supported by `CapabilityDescriptor` (§2.2 of `AGENT_RECORD_EXTENSIONS.md`).

```
CapabilityDescriptor {
    name: "llm.inference",
    metadata: {
        "input_token_micro_usd": Int(1),    // $0.001/1K input
        "output_token_micro_usd": Int(2),   // $0.002/1K output
        "max_context_tokens": Int(128000),
        "model": Text("llama-3.1-70b"),
    }
}
```

### 2.3 Per-Second Pricing

Used by compute-intensive agents where the dominant cost is wall-clock time
on expensive hardware (GPU, TPU). Suitable for:

- Code execution sandboxes (per-second container runtime)
- Model fine-tuning agents (GPU-hours)
- Video transcoding / rendering
- Scientific simulation agents

**CostExtension field:** `per_second_micro_usd`

```
Example: $0.0001 per second ($0.36/hour)
  per_invocation_micro_usd = None
  per_token_micro_usd = None
  per_second_micro_usd = 100
```

**Pros:** Directly tracks compute cost. Fair for variable-duration tasks.

**Cons:** Client cannot predict total cost before execution. Requires
trusted time measurement (agent reports duration; client can cross-check
with its own clock for the RPC round-trip). Vulnerable to slow agents
overcharging (mitigated by circuit breakers and reputation).

### 2.4 Subscription Pricing

A fixed recurring fee for unlimited (or capped) access. Suitable for
always-on services:

- Monitoring / alerting agents
- Data feed agents (market data, news streams)
- Knowledge base agents (RAG over a fixed corpus)
- Managed inference endpoints (flat-rate LLM access)

**CostExtension does not directly model subscriptions.** Subscriptions are
a *billing relationship*, not a per-call price. The recommended approach:

1. The agent advertises `per_invocation_micro_usd = 0` (free at point of
   use) and `has_free_tier = false`.
2. The agent's `CapabilityDescriptor.metadata` includes:
   - `"subscription_required": Bool(true)`
   - `"subscription_url": Text("https://agent.example.com/subscribe")`
   - `"subscription_monthly_usd": Int(500)` ($5.00/month)
3. The client checks subscription status out-of-band (API key, OAuth token)
   and passes a credential in the RPC header.

AAFP does not manage subscriptions. It only carries the metadata that tells
the client "this agent requires a subscription, here's where to get one."

### 2.5 Freemium Pricing

A free tier with limits, plus a paid tier for higher usage. Common in
developer-facing APIs.

**CostExtension fields:** `has_free_tier`, `free_tier_daily_limit`

```
Example: 1,000 free calls/day, then $0.00005/call
  has_free_tier = true
  free_tier_daily_limit = 1000
  per_invocation_micro_usd = 50
```

**How it works in practice:**

1. Client discovers agent, sees `has_free_tier = true`,
   `free_tier_daily_limit = 1000`.
2. Client calls the agent. The agent checks the client's AgentId against its
   own usage tracker (the agent maintains its own free-tier counter — AAFP
   does not track this).
3. If under the limit: the agent processes the request for free.
4. If over the limit: the agent returns a `PaymentRequired` error (see §5.2)
   with the paid price and payment instructions.

**Design note:** The free tier is enforced by the *provider* agent, not by
AAFP. The `CostExtension` merely *advertises* that a free tier exists so
clients can discover and prefer free-tier agents when budget-constrained.

### 2.6 Hybrid Pricing

Agents can combine multiple pricing models. The `CostExtension` supports
this by allowing multiple cost fields to be set simultaneously:

```
Example: $0.00002/token + $0.0001/second (LLM with GPU time billing)
  per_token_micro_usd = 20
  per_second_micro_usd = 100
  per_invocation_micro_usd = None
```

The total cost of a call is:

```
total = per_invocation + (per_token × token_count) + (per_second × duration_seconds)
```

Only fields that are `Some` contribute. Fields that are `None` are zero.

### 2.7 Pricing Model Summary

| Model | CostExtension Field | Best For | Budget Difficulty |
|-------|-------------------|----------|-------------------|
| Per-invocation | `per_invocation_micro_usd` | Fixed-cost APIs, lookups | Easy (count × price) |
| Per-token | `per_token_micro_usd` | LLM inference | Medium (estimate output) |
| Per-second | `per_second_micro_usd` | Compute, sandboxes | Hard (unknown duration) |
| Subscription | metadata + `per_invocation = 0` | Always-on services | Easy (fixed monthly) |
| Freemium | `has_free_tier` + `free_tier_daily_limit` | Developer APIs | Easy (free under limit) |
| Hybrid | Multiple fields set | Complex services | Hard (multi-variable) |

---

## 3. Cost Advertising via CostExtension

### 3.1 The Extension

The `CostExtension` is defined in `AGENT_RECORD_EXTENSIONS.md` §5.3 and
implemented in `crates/aafp-identity/src/extensions/cost.rs`. It lives in
the `AgentRecord` extension map (key 11) under the namespace
`"aafp.cost.v1"`.

```rust
pub struct CostExtension {
    pub version: u64,
    pub per_invocation_micro_usd: Option<u64>,
    pub per_token_micro_usd: Option<u64>,
    pub per_second_micro_usd: Option<u64>,
    pub has_free_tier: bool,
    pub free_tier_daily_limit: Option<u32>,
    pub currency: String,       // ISO 4217, default "USD"
    pub updated_at: u64,
}
```

All monetary values are in **micro-USD** (1 USD = 1,000,000 micro-USD).
This avoids floating point on the wire and provides sub-cent precision
needed for per-token micropayments.

### 3.2 CBOR Encoding

```
CostExtensionData = {
    ? 1: uint,    // per_invocation_micro_usd
    ? 2: uint,    // per_token_micro_usd
    ? 3: uint,    // per_second_micro_usd
    ? 4: bool,    // has_free_tier
    ? 5: uint,    // free_tier_daily_limit
    ? 6: tstr,    // currency (default "USD", omitted if "USD")
    7: uint,      // updated_at (unix seconds)
}
```

Fields 1-3 are optional (`None` = not applicable). Field 4 is always
encoded (bool). Field 6 is omitted when currency is "USD" (the default) to
save bytes — most agents will price in USD.

### 3.3 Why Micro-USD?

| Unit | Precision | Smallest representable | Use case |
|------|-----------|----------------------|----------|
| USD (float) | $0.01 | $0.01 | Too coarse for per-token |
| Centi-USD (int) | $0.01 | $0.01 | Still too coarse |
| Milli-USD (int) | $0.001 | $0.001 | OK for per-call, too coarse for per-token |
| **Micro-USD (int)** | **$0.000001** | **$0.000001** | **Sufficient for per-token** |
| Nano-USD (int) | $0.000000001 | $0.000000001 | Overkill; u64 overflow at $18B |

A typical LLM token costs $0.000002 (2 micro-USD). Micro-USD captures this
exactly. Using `u64` gives a maximum value of ~$18 trillion — more than
enough for any conceivable agent transaction.

### 3.4 Price Freshness

The `updated_at` field tells clients when the price was last set. Agents
SHOULD republish their `AgentRecord` (with a new `record_version`) whenever
they change pricing. Clients SHOULD treat prices older than 7 days as
potentially stale and MAY re-query the agent for current pricing before
committing to a large spend.

### 3.5 Price Discovery vs. Price Advertising

`CostExtension` is **price advertising**: the agent publishes its price in
the DHT, and clients read it. This is sufficient for most use cases.

For agents with dynamic pricing (surge pricing, spot markets, capacity-based
pricing), the advertised price is a *ceiling* or *indicative price*. The
actual price is negotiated at call time (see §6). The `CostExtension` tells
clients "this agent typically charges around X" — the negotiation protocol
determines the exact price.

### 3.6 Multi-Currency Support

The `currency` field supports ISO 4217 codes. While most agents will price
in USD (the default, omitted from CBOR), some agents may price in:

- **EUR** (`"EUR"`) — European compute providers
- **JPY** (`"JPY"`) — Japanese inference operators
- **BTC** (`"BTC"`) — Bitcoin-denominated agents ( Lightning-native)
- **SATS** (`"SATS"`) — Bitcoin satoshis (1 SAT = 0.00000001 BTC)

When currency is not USD, the client must convert to compare prices across
agents. AAFP does not provide exchange rates — the client uses its own
oracle or exchange rate source.

---

## 4. Payment Protocols

AAFP does not settle payments. It carries *payment instructions* — enough
information for the client and provider to settle out-of-band. Four
settlement mechanisms are supported:

### 4.1 Crypto Micropayments (Lightning Network)

The primary mechanism for trustless agent-to-agent payments. The Lightning
Network enables instant, sub-cent Bitcoin payments via payment channels.

**Flow:**

1. Client discovers agent, sees `CostExtension` with `currency = "SATS"`.
2. Client sends RPC request with a `PaymentRequest` header indicating
   willingness to pay via Lightning.
3. Agent processes the request (or requires prepayment — see §5.1).
4. Agent generates a BOLT-11 Lightning invoice for the exact amount.
5. Agent includes the invoice in the RPC response (or in a
   `PaymentRequired` error if prepayment is required).
6. Client pays the invoice via its Lightning node.
7. Agent verifies payment (via its Lightning node) before releasing results
   (if postpaid) or acknowledges receipt (if prepaid).

See §5 for detailed micropayment channel design.

### 4.2 Credit Accounts

For trusted agent pairs or enterprise setups. The client has a pre-funded
credit account with the provider. Each call debits the account.

**Flow:**

1. Client and provider establish a credit account out-of-band (web signup,
   contract, etc.).
2. Client includes an `Authorization` header in the RPC with a bearer token
   or API key.
3. Provider verifies the token, checks the account balance, processes the
   request, and debits the account.
4. If the account is exhausted, the provider returns `PaymentRequired`.

**AAFP's role:** Carry the `Authorization` header. The credit account
itself is managed by the provider's billing system. AAFP is agnostic to the
account infrastructure.

### 4.3 Barter / Reciprocal Service

Agents exchange services without money. "I'll translate your document if
you summarize my research." This is common in federated networks of
open-source agents.

**Flow:**

1. Client sends RPC with a `BarterOffer` header: "I can provide
   `code.execute` in exchange for `llm.inference`."
2. Provider checks if it needs the offered service.
3. If yes: provider processes the request and issues a `ServiceCredit` — a
   signed token redeemable for the offered service later.
4. If no: provider declines or requests a different offer.

**AAFP's role:** Carry the `BarterOffer` and `ServiceCredit` as opaque
headers. The credit token is a UCAN-style signed capability (see
`crates/aafp-identity/src/ucan.rs`) — the client signs a token granting the
provider a future `code.execute` invocation.

Barter is trust-based: the client must honor the service credit when the
provider redeems it. AAFP's Web of Trust helps establish whether a barter
partner is reliable.

### 4.4 Reputation Credits

In some networks, agents provide services to build reputation, which
translates to future business. A "reputation credit" is not money — it's
social capital.

**Flow:**

1. New agent with no reputation offers free services to build a track
   record.
2. Satisfied clients issue attestations (see `AGENT_RECORD_EXTENSIONS.md`
   §7) vouching for the agent's quality.
3. As the agent's reputation score rises, it begins charging.
4. High-reputation agents can charge premium prices.

**AAFP's role:** The attestation system (§7 of `AGENT_RECORD_EXTENSIONS.md`)
is the infrastructure for reputation credits. The `ReputationExtension`
links an agent's record to its attestations. The `compute_reputation()`
function aggregates attestations into a trust-weighted score.

### 4.5 Payment Protocol Summary

| Mechanism | Trust Model | Latency | AAFP Role | Best For |
|-----------|------------|---------|-----------|----------|
| Lightning | Trustless | ~1s | Carry BOLT-11 invoices | Anonymous agent pairs |
| Credit | Pre-trusted | Instant | Carry auth tokens | Enterprise, regular partners |
| Barter | Web of Trust | Instant | Carry offer/credit tokens | Federated open-source agents |
| Reputation | Social trust | N/A | Attestation system | New agents building trust |

---

## 5. Micropayment Channel Design (Lightning Network)

### 5.1 Prepaid vs. Postpaid

Two payment timing models:

**Prepaid (pay-before-execute):**
1. Client requests a quote from the agent (see §6).
2. Agent returns a BOLT-11 invoice with the quoted amount.
3. Client pays the invoice.
4. Client sends the RPC request with the Lightning preimage hash as proof
   of payment.
5. Agent verifies the payment (checks its Lightning node for the settled
   invoice) and executes the request.
6. Agent returns the result.

**Postpaid (execute-then-pay):**
1. Client sends the RPC request with a payment promise.
2. Agent executes the request.
3. Agent returns the result *plus* a BOLT-11 invoice.
4. Client pays the invoice.

**Prepaid is recommended** for most agent interactions because:
- The agent is protected from non-payment.
- The client knows the exact cost before committing.
- It works for stateless agents (no need to hold results pending payment).

**Postpaid** is suitable for:
- Per-token LLM pricing (cost is unknown until generation completes).
- Per-second compute (duration is unknown until execution finishes).
- Trusted agent pairs with existing credit relationships.

### 5.2 PaymentRequired Error

When an agent requires payment and the client hasn't paid (or hasn't
provided valid payment credentials), the agent returns a
`PaymentRequired` error:

```rust
/// Payment-required error payload, carried in the RPC error body.
pub struct PaymentRequired {
    /// Human-readable reason.
    pub message: String,
    /// Amount owed in micro-USD (or the agent's currency).
    pub amount_micro_usd: u64,
    /// Currency code (ISO 4217 or "SATS" / "BTC").
    pub currency: String,
    /// BOLT-11 Lightning invoice (if Lightning payment is accepted).
    pub lightning_invoice: Option<String>,
    /// URL for credit account top-up (if credit payment is accepted).
    pub credit_topup_url: Option<String>,
    /// Barter offers the agent would accept (if barter is accepted).
    pub accepted_barter: Vec<String>,
}
```

The client receives this error and chooses how to proceed: pay the invoice,
top up credit, offer barter, or try a different agent.

### 5.3 Lightning Invoice Exchange Over AAFP RPC

The BOLT-11 invoice is a string (~200-500 bytes) that encodes the payment
amount, destination, expiry, and routing hints. It's carried as a text
field in the RPC response or error body.

```
RPC Request:
  header: "Payment-Method: lightning"
  header: "Payment-Preimage-Hash: <hex>"  (for prepaid)
  body: <request payload>

RPC Response (prepaid, payment verified):
  header: "Payment-Settled: true"
  body: <result payload>

RPC Error (payment required):
  code: PaymentRequired
  body: PaymentRequired { lightning_invoice: "lnbc100n1p..." }
```

### 5.4 Channel Management

Lightning payment channels must be funded and maintained. For agent-to-
agent payments, two approaches:

**1. Custodial Lightning (recommended for most agents):**
- Agents use a Lightning Service Provider (LSP) like Wallet of Satoshi,
  Voltage, or Alby.
- The LSP manages channel liquidity, routing, and fee estimation.
- Agents only need to generate and pay invoices via an API.
- Trade-off: the LSP is a trusted third party (custody risk).

**2. Self-hosted Lightning (for high-volume agents):**
- Agent operator runs their own Lightning node (CLN, Eclair, LND).
- Direct channel management, no custody risk.
- Requires operational expertise and channel liquidity management.
- Trade-off: higher complexity, capital lockup in channels.

AAFP does not manage Lightning channels. It only carries invoices. The
Lightning infrastructure is entirely external.

### 5.5 Micropayment Economics

Lightning routing fees are typically 0.01% to 1% of the payment amount,
with a minimum base fee of ~1 satoshi (~$0.0006). For agent micropayments:

| Payment amount | Lightning fee | Fee % | Viable? |
|---------------|---------------|-------|---------|
| $0.001 (1K tokens) | ~$0.0006 | 60% | Marginal |
| $0.01 (10K tokens) | ~$0.0006 | 6% | Yes |
| $0.10 (100K tokens) | ~$0.001 | 1% | Yes |
| $1.00 (1M tokens) | ~$0.003 | 0.3% | Yes |

For sub-cent payments, Lightning routing fees can exceed 50% of the
payment. Mitigations:

1. **Batch payments:** Accumulate charges and settle periodically (e.g.,
   every $0.10 or every 10 minutes). The agent holds an in-memory balance
   for the client and issues a single Lightning invoice for the batch.
2. **Direct channels:** Open a direct Lightning channel between frequent
   agent pairs. No routing fees; only the channel funding cost.
3. **Credit accounts:** For high-frequency pairs, use credit accounts (§4.2)
   and settle via Lightning weekly/monthly.

### 5.6 Payment Channel Design (Future: `aafp-payments` crate)

A future `crates/aafp-payments/` crate could provide:

```rust
pub trait PaymentChannel {
    /// Request a quote for an upcoming RPC.
    fn request_quote(&self, capability: &str, estimate: &WorkEstimate)
        -> Result<Quote, PaymentError>;

    /// Pay a quote (settles via Lightning or credit).
    fn pay_quote(&self, quote: &Quote) -> Result<PaymentProof, PaymentError>;

    /// Verify a payment proof (for prepaid mode).
    fn verify_payment(&self, proof: &PaymentProof) -> Result<(), PaymentError>;

    /// Batch-settle accumulated charges.
    fn settle_batch(&self, charges: &[Charge]) -> Result<Settlement, PaymentError>;
}

pub struct Quote {
    pub quote_id: String,
    pub amount_micro_usd: u64,
    pub currency: String,
    pub lightning_invoice: Option<String>,
    pub expires_at: u64,
}
```

This is a *future* design. The current protocol carries payment metadata as
opaque RPC headers — the `aafp-payments` crate would provide a typed
abstraction over those headers.

---

## 6. Agent Marketplace

### 6.1 Concept

The AAFP DHT *is* the agent marketplace. Every agent that publishes an
`AgentRecord` with a `CostExtension` is listing itself in the marketplace.
Clients query the DHT for capabilities, filter by cost/quality/trust, and
"hire" (call) the best match.

There is no separate marketplace service. The DHT provides:

- **Discovery:** Find agents by capability name (existing `CapabilityDht`).
- **Comparison:** Compare agents by cost, performance, reputation (via
  extension index, §10.2 of `AGENT_RECORD_EXTENSIONS.md`).
- **Hiring:** Call the selected agent via RPC (existing transport).

### 6.2 Discovery

Clients discover agents using `CapabilityQuery` (Track U):

```rust
let query = CapabilityQuery {
    capability: "llm.inference",
    constraints: vec![
        Constraint::MinQuality(0.8),        // reputation >= 0.8
        Constraint::MaxCostMicroUsd(100),   // <= $0.0001/invocation
        Constraint::Country("US"),          // data residency
        Constraint::MaxLatencyMs(100),      // p99 < 100ms
    ],
};
let candidates = dht.query(&query).await?;
```

The DHT returns all agents matching the capability name. The client filters
locally using the extension index (built from `CostExtension`,
`PerformanceExtension`, `GeoExtension`, and `ReputationExtension`).

### 6.3 Comparison

The `ExtensionIndex` (§10.2 of `AGENT_RECORD_EXTENSIONS.md`) provides local
secondary indexes:

```rust
pub struct ExtensionIndex {
    by_country: HashMap<String, Vec<AgentId>>,
    by_latency: BTreeMap<u16, Vec<AgentId>>,
    by_cost: BTreeMap<u64, Vec<AgentId>>,
}
```

Clients build this index from discovered records and query it to find the
cheapest, fastest, or highest-reputation agent for a given capability.

### 6.4 Hiring

Once the client selects an agent, "hiring" is simply an RPC call:

1. Client resolves the agent's endpoint from the `AgentRecord`.
2. Client opens a QUIC connection (or reuses a pooled one).
3. Client sends the RPC request, including payment instructions if needed.
4. Agent processes the request and returns the result.
5. Payment is settled (Lightning, credit, barter, or free).

### 6.5 Marketplace UI (External)

While AAFP provides the *protocol* for the marketplace, user-facing
marketplace UIs are external applications. A marketplace website or app
would:

1. Run an AAFP node and crawl the DHT for all published `AgentRecord`s.
2. Parse `CostExtension`, `PerformanceExtension`, `SemanticExtension`, and
   `ReputationExtension` from each record.
3. Present a searchable, sortable UI: "Find LLM inference agents under
   $0.002/1K tokens with >99% uptime and US data residency."
4. Let users call agents directly (the UI generates the RPC call) or
   bookmark agents for their own agents to use.

AAFP does not build or host marketplace UIs. The protocol makes them
*possible*; the ecosystem builds them.

### 6.6 Quality Signals

The marketplace uses three quality signal layers:

| Signal | Source | Trustworthiness | Use |
|--------|--------|-----------------|-----|
| Self-reported perf | `PerformanceExtension` | Low (self-claim) | Initial filter |
| Attested reputation | Third-party `Attestation`s | Medium (WoT-weighted) | Ranking |
| Direct experience | Client's own `PeerMetrics` | High (first-hand) | Final selection |

The `dynamic_score()` function in `ADAPTIVE_ROUTING_PLANE.md` §4.2 combines
these signals with configurable weights. The default weight for cost is
0.05 (5%) — cost matters but is secondary to latency and success rate.
Cost-sensitive workloads increase `weight_cost` to 0.30 or higher.

---

## 7. Price Negotiation Protocol

### 7.1 Why Negotiate?

The advertised `CostExtension` price is the *list price*. For many calls,
the client simply pays the list price (take-it-or-leave-it). But some
scenarios require negotiation:

- **Bulk calls:** "I need 10,000 translations. Can you give me a volume
  discount?"
- **Off-peak pricing:** "It's 3 AM your time. Can you charge less?"
- **Quality trade-off:** "I don't need your best model. Can you use a
  cheaper one for half the price?"
- **Barter:** "I'll provide you with code execution credits in exchange."

### 7.2 Three Negotiation Modes

#### 7.2.1 Take-It-Or-Leave-It (Default)

No negotiation. The client pays the advertised price or finds another
agent. This is the default and covers 90%+ of agent interactions.

```
Client → Agent: RPC request (implicit acceptance of advertised price)
Agent → Client: RPC response + invoice
```

#### 7.2.2 Bounded Negotiation

The client sends a `PriceOffer` with the RPC request. The agent can accept,
reject, or counter-offer. Negotiation is bounded by a max-rounds parameter
to prevent infinite haggling.

```rust
pub struct PriceOffer {
    /// Client's offered price (micro-USD).
    pub offered_micro_usd: u64,
    /// Currency.
    pub currency: String,
    /// Maximum negotiation rounds (default 1, max 3).
    pub max_rounds: u8,
    /// Justification for the offer (e.g., "bulk", "off-peak").
    pub reason: Option<String>,
    /// Payment method preference.
    pub payment_method: PaymentMethod,
}

pub enum PriceResponse {
    /// Agent accepts the offered price.
    Accept { invoice: Option<String> },
    /// Agent rejects and states the minimum acceptable price.
    Reject { min_acceptable_micro_usd: u64 },
    /// Agent counter-offers.
    Counter {
        counter_micro_usd: u64,
        currency: String,
        expires_at: u64,
    },
}
```

**Flow (bounded negotiation, 2 rounds):**

```
Round 0:
  Client → Agent: PriceOffer { offered: 30, max_rounds: 2, reason: "bulk" }
  Agent → Client: PriceResponse::Counter { counter: 40 }

Round 1:
  Client → Agent: PriceOffer { offered: 40, max_rounds: 1 }
  Agent → Client: PriceResponse::Accept { invoice: "lnbc40n1p..." }

  Client pays invoice, sends RPC with payment proof.
  Agent executes, returns result.
```

#### 7.2.3 Auction (Reverse Auction)

The client broadcasts a request for bids to multiple agents simultaneously.
Agents submit bids (price + estimated quality). The client selects the
best bid and proceeds.

```rust
pub struct BidRequest {
    pub capability: String,
    pub input_description: String,
    pub max_budget_micro_usd: u64,
    pub deadline: u64,  // unix seconds
    pub quality_threshold: Option<f64>,
}

pub struct Bid {
    pub agent_id: AgentId,
    pub price_micro_usd: u64,
    pub currency: String,
    pub estimated_quality: f64,
    pub estimated_latency_ms: u16,
    pub expires_at: u64,
}
```

**Flow:**

1. Client discovers N agents with the target capability.
2. Client sends `BidRequest` to all N agents (parallel RPCs).
3. Each agent responds with a `Bid` (or declines).
4. Client evaluates bids: `score = quality / price` (or weighted variant).
5. Client accepts the best bid and proceeds with the RPC.
6. Losing agents are notified (or simply time out).

Auctions are expensive (N round-trips) and should be reserved for
high-value or bulk calls where the savings justify the overhead.

### 7.3 Negotiation as Extension Header

Price negotiation is carried as RPC headers, not as a separate protocol
phase. This keeps the transport layer simple — negotiation is just metadata
on the first RPC call. If the agent returns `PriceResponse::Counter`, the
client retries with a new `PriceOffer` header. The RPC body is not sent
until a price is agreed.

### 7.4 Anti-Gaming

Negotiation can be abused:

- **Lowballing:** Client offers absurdly low prices to waste agent time.
  Mitigation: agents reject offers below a floor price without responding
  with a counter.
- **Stalling:** Agent counter-offers repeatedly to delay.
  Mitigation: `max_rounds` limits negotiation. Client can walk away.
- **Bid shopping:** Client uses one agent's bid to negotiate down another.
  This is legitimate market behavior. Agents set their prices based on
  their own costs, not on competitors' bids.

---

## 8. Budget Enforcement

### 8.1 Client-Side Budget

A client agent has a budget — the maximum it's willing to spend on a task.
The budget is enforced client-side: the client refuses to make calls that
would exceed the budget.

```rust
pub struct Budget {
    /// Total budget in micro-USD.
    pub total_micro_usd: u64,
    /// Amount spent so far.
    pub spent_micro_usd: u64,
    /// Per-call limit (refuse calls that would cost more than this).
    pub per_call_limit_micro_usd: Option<u64>,
}

impl Budget {
    /// Check if a call with the given estimated cost is affordable.
    pub fn can_afford(&self, estimated_cost_micro_usd: u64) -> bool {
        self.spent_micro_usd + estimated_cost_micro_usd <= self.total_micro_usd
            && self.per_call_limit.map_or(true, |limit| {
                estimated_cost_micro_usd <= limit
            })
    }

    /// Record a spend.
    pub fn record_spend(&mut self, actual_cost_micro_usd: u64) {
        self.spent_micro_usd += actual_cost_micro_usd;
    }

    /// Remaining budget.
    pub fn remaining(&self) -> u64 {
        self.total_micro_usd.saturating_sub(self.spent_micro_usd)
    }
}
```

### 8.2 Budget Propagation in Agent Chains

When Agent A calls Agent B, which calls Agent C, the budget must propagate.
Agent A gives Agent B a *sub-budget* — the portion of A's budget that B is
allowed to spend (including B's own fee and any downstream calls B makes).

```rust
/// Budget delegation header, carried in the RPC request.
pub struct BudgetDelegation {
    /// Total budget delegated to the callee (micro-USD).
    pub budget_micro_usd: u64,
    /// Amount already spent by the caller on this call (for transparency).
    pub caller_spent_micro_usd: u64,
    /// Deadline for budget validity (unix seconds).
    pub deadline: u64,
    /// Signature: caller signs the budget delegation so the callee can
    /// prove to third parties that the budget was authorized.
    pub signature: Vec<u8>,
}
```

**Example:**

1. User gives Agent A a budget of $1.00 (1,000,000 micro-USD) to "research
   this topic and write a report."
2. Agent A plans to:
   - Call Agent B (search) at $0.00005/call × 20 calls = $0.001
   - Call Agent C (LLM) at $0.002/1K tokens × 50K tokens = $0.10
   - Call Agent D (formatting) at $0.0001/call × 5 calls = $0.0005
   - Agent A's own margin: $0.05
   - Total estimated: ~$0.15
3. Agent A delegates a sub-budget of $0.15 to Agent B, $0.80 to Agent C,
   $0.01 to Agent D, keeping $0.04 as margin and $0.79 as contingency.
4. Agent B, in turn, might call Agent E (web fetch) and delegates a
   sub-budget from its $0.15.

If any agent in the chain exceeds its sub-budget, it MUST either:
- Stop and return a partial result with a `BudgetExceeded` error.
- Negotiate a lower price with its downstream agents.
- Absorb the overrun (if it has its own margin to cover it).

### 8.3 Budget Exceeded Error

```rust
pub struct BudgetExceeded {
    pub message: String,
    /// Amount spent so far.
    pub spent_micro_usd: u64,
    /// Budget that was allocated.
    pub budget_micro_usd: u64,
    /// Partial results (if any were produced before the budget ran out).
    pub partial_result: Option<Vec<u8>>,
}
```

The caller receives this error and can decide: increase the budget, accept
the partial result, or try a cheaper agent.

### 8.4 Budget Estimation

Before making a call, the client estimates the cost:

```rust
pub fn estimate_cost(
    cost_ext: &CostExtension,
    input_tokens: Option<u64>,
    estimated_output_tokens: Option<u64>,
    estimated_duration_secs: Option<u64>,
) -> u64 {
    let mut total = 0u64;
    if let Some(c) = cost_ext.per_invocation_micro_usd {
        total += c;
    }
    if let Some(c) = cost_ext.per_token_micro_usd {
        let tokens = input_tokens.unwrap_or(0) + estimated_output_tokens.unwrap_or(0);
        total += c * tokens;
    }
    if let Some(c) = cost_ext.per_second_micro_usd {
        total += c * estimated_duration_secs.unwrap_or(0);
    }
    total
}
```

For per-token pricing, the client must estimate output length. For
per-second pricing, the client must estimate duration. These estimates are
imperfect — the client should add a safety margin (e.g., 2x the estimate)
when checking `can_afford()`.

---

## 9. Cost Optimization

### 9.1 Cheapest-Acceptable-Agent Routing

The goal: route to the cheapest agent that meets a quality threshold. This
is a constrained optimization:

```
minimize: cost(agent)
subject to:
    quality(agent) >= quality_threshold
    latency(agent) <= latency_threshold
    trust(agent) >= trust_threshold
    circuit(agent) == Closed
```

### 9.2 Integration with dynamic_score()

The existing `dynamic_score()` function (`ADAPTIVE_ROUTING_PLANE.md` §4.2)
already includes a cost component:

```rust
let cost_score = match metrics.cost_micro_usd {
    Some(c) => {
        (1.0 - (c as f64 / (5.0 * config.cost_ref_micro_usd as f64))).max(0.0)
    }
    None => 0.8, // no cost data: assume moderate
};
```

The default `weight_cost` is 0.05 (5%). For cost-optimized routing, the
client increases `weight_cost`:

```rust
// Cost-sensitive configuration
let config = DynamicScoreConfig {
    weight_latency: 0.15,
    weight_success: 0.25,
    weight_load: 0.05,
    weight_availability: 0.05,
    weight_cost: 0.50,  // 50% weight on cost
    latency_ref_ms: 200.0,  // relaxed latency
    cost_ref_micro_usd: 50,  // $0.00005 reference
};
```

### 9.3 Quality-Gated Cost Minimization

For strict cost optimization with a quality floor, use a two-phase
approach:

**Phase 1: Filter by quality threshold.**
```rust
let acceptable: Vec<&AgentRecord> = candidates.iter()
    .filter(|r| {
        let rep = compute_reputation(&r.attestations, &trust_manager, now);
        rep.map_or(false, |score| score >= quality_threshold)
    })
    .collect();
```

**Phase 2: Select cheapest from acceptable set.**
```rust
let cheapest = acceptable.iter()
    .filter_map(|r| {
        r.get_extension::<CostExtension>()
            .and_then(|c| c.per_invocation_micro_usd)
            .map(|cost| (r.agent_id, cost))
    })
    .min_by_key(|(_, cost)| *cost);
```

This is simpler than weighted scoring and guarantees the quality floor.
Use it when quality is a hard constraint (e.g., medical, legal) and cost
is the primary variable.

### 9.4 Cost-Aware Hedging

Request hedging (§6 of `ADAPTIVE_ROUTING_PLANE.md`) sends the same request
to two agents and uses the first response. With cost awareness:

- **Hedge with a cheap and an expensive agent:** If the cheap one responds
  first, you save money. If the expensive (presumably faster) one responds
  first, you pay more but get lower latency.
- **Cancel the loser:** The cancelled agent's work is wasted, but if it
  hasn't started (or if it's free-tier), there's no cost.

For paid agents, hedging doubles cost on the fast path. Only hedge with
agents that are free-tier or that don't charge for cancelled requests.

### 9.5 Spot Pricing and Capacity-Based Routing

Agents with dynamic pricing may offer "spot" pricing when they have idle
capacity. The `CostExtension.updated_at` field helps clients detect price
changes. A future extension (`"aafp.pricing.v2"`) could carry:

```rust
pub struct DynamicPricingExtension {
    pub current_load_pct: u8,        // 0-100
    pub spot_price_micro_usd: u64,   // current price (may be lower than list)
    pub next_price_change_at: u64,   // when price is expected to change
}
```

Clients could route to agents with low `current_load_pct` and favorable
`spot_price_micro_usd`, similar to AWS Spot Instances.

---

## 10. Free Agent Federation

### 10.1 Concept

Not all agents charge money. A federation of free agents provides services
at zero cost, funded by:

- **Open-source model operators:** Volunteers running Llama, Mistral, or
  other open-weight models on donated GPU time.
- **Grant-funded providers:** Organizations (e.g., academic labs, AI
  safety institutes) providing free inference for research.
- **Hardware sponsors:** GPU manufacturers or cloud providers offering free
  compute as a marketing/community benefit.
- **Reciprocal agents:** Agents that provide free services in exchange for
  reputation, data, or reciprocal service (barter, §4.3).

### 10.2 Advertising Free Service

Free agents set `CostExtension` as follows:

```rust
CostExtension {
    version: 1,
    per_invocation_micro_usd: Some(0),  // free
    per_token_micro_usd: Some(0),       // free
    per_second_micro_usd: Some(0),      // free
    has_free_tier: true,
    free_tier_daily_limit: None,        // unlimited
    currency: "USD".into(),
    updated_at: now,
}
```

Or simply omit the `CostExtension` entirely — no cost extension means "cost
not disclosed," which clients may interpret as "likely free" but should
confirm via the negotiation protocol (§7).

### 10.3 Free Federation Discovery

Free agents can be discovered by filtering for `per_invocation_micro_usd ==
Some(0)`:

```rust
let free_agents: Vec<_> = candidates.iter()
    .filter(|r| {
        r.get_extension::<CostExtension>()
            .map_or(false, |c| {
                c.per_invocation_micro_usd == Some(0)
                    || c.has_free_tier
            })
    })
    .collect();
```

A "free federation" is not a formal organization — it's an emergent
property of the DHT. Any agent that advertises zero cost is part of it.

### 10.4 Sustainability of Free Agents

Free agents face sustainability challenges:

| Funding Model | Sustainability | Risk |
|---------------|---------------|------|
| Volunteer GPU | Low | Operator burns out; service disappears |
| Grant-funded | Medium | Grant expires; need renewal |
| Hardware sponsor | Medium-High | Sponsor changes strategy |
| Freemium upsell | High | Free tier is loss-leader for paid tier |
| Reputation building | Medium | Agent transitions to paid once trusted |

The protocol should not *rely* on free agents existing. They're a bonus,
not infrastructure. Production systems should always have paid fallbacks.

### 10.5 Rate Limiting for Free Agents

Free agents typically impose rate limits to prevent abuse. These are
enforced by the agent, not by AAFP. The agent returns a `RateLimited` error:

```rust
pub struct RateLimited {
    pub message: String,
    pub retry_after_secs: u64,
    pub daily_limit: u32,
    pub daily_remaining: u32,
}
```

The client backs off and either waits or switches to a paid agent.

---

## 11. Enterprise Billing

### 11.1 Scenario

A company runs 500 internal agents that collectively make millions of
external AAFP calls per month. The company needs:

- **Aggregated billing:** One invoice per month, not millions of
  micropayments.
- **Cost allocation:** Attribute costs to teams, projects, or departments.
- **Budget controls:** Per-team budgets with alerts and hard limits.
- **Procurement:** Pre-negotiated rates with preferred agent providers.

### 11.2 Enterprise Billing Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Enterprise Network                     │
│                                                           │
│  Team A Agents    Team B Agents    Team C Agents          │
│      │                │                │                  │
│      └────────┬───────┴────────┬───────┘                  │
│               │                │                          │
│         ┌─────▼─────┐   ┌─────▼─────┐                     │
│         │ AAFP Proxy │   │ Cost Audit │                    │
│         │  (Gateway) │   │  (Logger)  │                    │
│         └─────┬─────┘   └─────┬─────┘                     │
│               │                │                          │
│      ┌────────┴────────────────┘                          │
│      │                                                   │
└──────┼───────────────────────────────────────────────────┘
       │
       │ AAFP RPC (with enterprise auth headers)
       │
   ┌───▼──────────────────┐
   │  External Agent       │
   │  (Provider)           │
   └───────────────────────┘
```

### 11.3 Enterprise Agent Gateway

An enterprise gateway sits between internal agents and the external AAFP
network:

```rust
pub struct EnterpriseGateway {
    /// Organization's enterprise account credentials.
    enterprise_id: String,
    /// API key for each external provider.
    provider_keys: HashMap<AgentId, String>,
    /// Per-team budgets.
    team_budgets: HashMap<TeamId, Budget>,
    /// Call log for billing reconciliation.
    call_log: CallLog,
}

impl EnterpriseGateway {
    /// Intercept and proxy an RPC call.
    pub async fn proxy_call(
        &self,
        team_id: TeamId,
        target: AgentId,
        request: Request,
    ) -> Result<Response, GatewayError> {
        // 1. Check team budget.
        let budget = self.team_budgets.get(&team_id)
            .ok_or(GatewayError::UnknownTeam)?;
        let cost_est = estimate_cost_for_call(target, &request)?;
        if !budget.can_afford(cost_est) {
            return Err(GatewayError::BudgetExceeded);
        }

        // 2. Inject enterprise auth header.
        let key = self.provider_keys.get(&target)
            .ok_or(GatewayError::NoProviderKey)?;
        let mut request = request;
        request.headers.insert("Authorization", format!("Bearer {}", key));

        // 3. Proxy the call.
        let response = self.aafp_client.call(target, request).await?;

        // 4. Log the call for billing.
        let actual_cost = extract_cost_from_response(&response)?;
        self.call_log.record(CallRecord {
            team_id,
            target_agent: target,
            cost_micro_usd: actual_cost,
            timestamp: now(),
        });

        // 5. Update budget.
        budget.record_spend(actual_cost);

        Ok(response)
    }
}
```

### 11.4 Monthly Invoicing

At the end of each billing period:

1. The gateway aggregates `CallLog` records by provider.
2. The gateway sends an invoice request to each provider's billing API
   (out-of-band, not via AAFP).
3. The provider reconciles the gateway's call log with its own records.
4. The provider issues a single invoice for the month's total.
5. The enterprise pays via wire transfer, ACH, or credit card.

AAFP's role: the call log is built from RPC metadata (agent ID, capability,
cost). The billing reconciliation happens entirely out-of-band.

### 11.5 Cost Allocation

The gateway tags each call with a `team_id` (or `project_id`,
`cost_center`). At the end of the month:

```
Team A: $1,234.56 (1.2M calls to llm.inference, 500 calls to code.execute)
Team B: $   56.78 (  45K calls to search.web)
Team C: $  890.12 ( 670K calls to llm.inference, 2K calls to image.classify)
Total:   $2,181.46
```

This is standard enterprise cost allocation. AAFP provides the per-call
metadata; the gateway does the aggregation.

---

## 12. Economic Sustainability

### 12.1 How Do Agent Operators Cover Their Costs?

An agent operator runs hardware (or rents cloud GPU) and provides services
via AAFP. Their costs include:

| Cost | Typical | Variable/Fixed |
|------|---------|----------------|
| GPU rental / purchase | $0.50-$8.00/GPU-hour | Variable (cloud) / Fixed (owned) |
| Bandwidth | $0.01-$0.10/GB | Variable |
| Electricity | $0.05-$0.30/kWh | Variable |
| Operator time | $20-$200/hour | Fixed |
| Software licenses | Varies | Fixed |

### 12.2 Revenue Models

| Model | How It Works | Margin |
|-------|-------------|--------|
| **Inference margin** | Buy GPU time at $X, sell tokens at $X + margin | 10-50% |
| **Value-added service** | Raw inference at cost; charge for RAG, fine-tuning, tooling | 50-200% |
| **Data sales** | Agent collects data through interactions; sell aggregated data | High (zero marginal cost) |
| **Compute arbitrage** | Buy spot GPU, sell reserved capacity at premium | 5-20% |
| **Subscription** | Flat monthly fee for unlimited (capped) access | Predictable |
| **Freemium upsell** | Free tier attracts users; convert to paid | 2-5% conversion |
| **Enterprise contracts** | Pre-negotiated rates with large consumers | Stable, high volume |

### 12.3 The Inference Margin Example

An operator rents an A100 GPU at $2.00/hour from a cloud provider. The
A100 can generate ~3,000 tokens/second with a 70B model.

```
GPU cost:     $2.00 / hour = $0.000556 / second
Token output: 3,000 tokens / second
Cost/token:   $0.000556 / 3,000 = $0.000000185 = 0.185 micro-USD

If the operator charges 2 micro-USD/token ($0.002/1K tokens):
  Revenue/token: 2.000 micro-USD
  Cost/token:    0.185 micro-USD
  Margin/token:  1.815 micro-USD
  Margin %:      90.8%

But this ignores:
  - Input token processing (prefill): ~30% of compute
  - Bandwidth, electricity, operator time
  - GPU utilization < 100% (idle time between requests)
  - Model loading / warmup overhead

Realistic margin: 40-60% at 70% utilization.
```

### 12.4 The Race to the Bottom

Token pricing is trending toward marginal cost. Open-weight models (Llama,
Mistral) on commodity GPU make it easy to enter the market. Operators
compete on:

1. **Price:** Lower per-token cost.
2. **Latency:** Faster time-to-first-token.
3. **Quality:** Better models, fine-tuning, RAG.
4. **Reliability:** Higher uptime, better SLA.
5. **Specialization:** Domain-specific models (medical, legal, code).
6. **Data residency:** Local computation for compliance.

AAFP's role: make all these differentiators *discoverable* via extensions.
A client can filter by any combination: "cheapest," "fastest," "highest
quality," "in my country," "with medical fine-tuning."

### 12.5 Operator Sustainability Checklist

For an agent operator to be sustainable:

- [ ] Price covers marginal cost (GPU + bandwidth + electricity).
- [ ] Price covers fixed cost (operator time, software licenses) at
      target utilization.
- [ ] Utilization > 50% (idle GPU is pure loss).
- [ ] Reputation score is high enough to attract clients (see §10 of
      `AGENT_RECORD_EXTENSIONS.md`).
- [ ] Circuit breaker is not tripping (reliability is adequate).
- [ ] Cost is advertised accurately in `CostExtension` (stale or wrong
      prices lead to client churn).
- [ ] Payment settlement is working (Lightning channel has liquidity, or
      credit accounts are funded).

---

## 13. Token-Based Economics

### 13.1 The Question

Should AAFP have a native token? Many Web3 projects launch tokens for:

- Governance (token holders vote on protocol changes)
- Staking (operators stake tokens to signal trustworthiness)
- Payment (tokens are the native settlement currency)
- Incentivization (tokens reward early participants, relay operators)

### 13.2 The Answer: No

AAFP should **not** have a native token. Reasons:

**1. AAFP is a protocol, not a platform.**
TCP doesn't have a token. HTTP doesn't have a token. TLS doesn't have a
token. AAFP is infrastructure — a set of rules for how agents communicate.
Infrastructure should be neutral and tokenless. Adding a token makes every
protocol decision a financial decision, which corrupts the technical
process.

**2. Tokens create barriers to entry.**
If AAFP requires tokens for participation, every agent operator must:
- Acquire tokens (via exchange, OTC, or faucet).
- Manage token custody (wallets, key management).
- Pay token-denominated fees (introducing FX risk).
- Understand token economics (vesting, inflation, governance).

This is friction. AAFP's goal is to make agent-to-agent communication
*easier*. Tokens make it harder.

**3. Payment is already solved.**
Agents that want to pay each other can use:
- **Lightning Network** (Bitcoin) for trustless micropayments.
- **Credit accounts** (fiat) for enterprise billing.
- **Stablecoins** (USDC, USDT) for crypto-native but price-stable payments.
- **Barter** for non-monetary exchange.

None of these require an AAFP-specific token. They're general-purpose
payment rails that agents can use independently.

**4. Staking is better served by reputation.**
The `Attestation` system (§7 of `AGENT_RECORD_EXTENSIONS.md`) provides
trust signals through third-party attestations and Web of Trust. This is
richer than a simple stake: an agent's reputation is multi-dimensional
(quality, reliability, timeliness), while a stake is one-dimensional
(money at risk). Reputation also doesn't require capital lockup.

**5. Governance doesn't need a token.**
AAFP governance is via RFCs (like IETF) and reference implementations (like
Linux). Contributors earn influence through code quality and community
trust, not token holdings. Token-based governance tends to favor whales
over builders.

**6. The "blockchain of AI" trap.**
`STRATEGIC_VISION.md` §5 explicitly states: "Don't become the blockchain of
AI." A token would pull AAFP into the blockchain orbit — attracting
speculators, inviting regulatory scrutiny, and distracting from the core
mission of agent communication.

### 13.3 What If the Ecosystem Wants a Token?

Third parties are free to build token-based systems *on top of* AAFP:

- A **reputation token** that agents earn by providing good service and
  burn to boost their ranking. This is an application-layer concern, not a
  protocol concern.
- A **compute token** that specific agent networks use for internal
  settlement. AAFP carries the payment instructions; the token is one
  settlement option among many.
- A **governance token** for a specific agent marketplace UI. The UI can
  have its own governance; AAFP (the protocol) remains neutral.

The protocol's job is to be *token-agnostic*. The `CostExtension.currency`
field supports any currency code, including token codes. If someone builds
a "COMPUTE" token, agents can price in it: `currency = "COMPUTE"`. AAFP
doesn't care.

### 13.4 Summary

| Feature | Token-Based | AAFP Approach |
|---------|------------|---------------|
| Payment | Native token | Lightning, credit, barter (out-of-band) |
| Staking | Stake tokens for trust | Attestations + Web of Trust |
| Governance | Token-weighted voting | RFCs + reference implementation |
| Incentives | Token rewards | None (protocol is neutral) |
| Barriers | Must acquire tokens | None (just publish a record) |

---

## 14. Concrete Example: LLM Agent Charging $0.001/1K Tokens

### 14.1 Setup

**Agent:** "Llama-70B-Inference" operated by "ComputeCo"
**Pricing:** $0.001 per 1K tokens (input + output)
**Payment:** Lightning Network (postpaid with batch settlement)
**Capability:** `llm.inference`

### 14.2 Agent Record Publication

The operator creates an `AgentRecord` with:

```rust
let mut record = AgentRecord::new(
    agent_id,
    public_key,
    vec![CapabilityDescriptor {
        name: "llm.inference".into(),
        metadata: vec![
            ("model".into(), MetadataValue::Text("llama-3.1-70b".into())),
            ("max_context_tokens".into(), MetadataValue::Int(128000)),
            ("input_token_micro_usd".into(), MetadataValue::Int(1)),
            ("output_token_micro_usd".into(), MetadataValue::Int(1)),
        ],
        semantic: None,
    }],
    vec!["/ip4/203.0.113.42/udp/4242/quic-v1".into()],
    now,
    now + 30 * 86400,  // 30-day expiry
);

// Cost extension: $0.001/1K tokens = $0.000001/token = 1 micro-USD/token
record.set_extension(CostExtension {
    version: 1,
    per_invocation_micro_usd: None,
    per_token_micro_usd: Some(1),  // 1 micro-USD per token
    per_second_micro_usd: None,
    has_free_tier: true,
    free_tier_daily_limit: Some(100),  // 100 free calls/day
    currency: "USD".into(),
    updated_at: now,
});

// Performance extension
record.set_extension(PerformanceExtension {
    version: 1,
    avg_latency_ms: Some(120),  // 120ms time-to-first-token
    p99_latency_ms: Some(350),
    throughput_rps: Some(50),
    max_concurrent: Some(100),
    uptime_bps: Some(9990),  // 99.90%
    window_secs: 3600,
    updated_at: now,
});

record.sign(&secret_key);
dht.publish(record).await?;
```

### 14.3 Client Discovery

A client agent needs LLM inference with a budget of $0.50:

```rust
let budget = Budget {
    total_micro_usd: 500_000,  // $0.50
    spent_micro_usd: 0,
    per_call_limit_micro_usd: Some(50_000),  // $0.05 max per call
};

// Discover agents with llm.inference capability
let candidates = dht.query(&CapabilityQuery {
    capability: "llm.inference",
    constraints: vec![],
}).await?;

// Filter by budget: need per_token <= budget.per_call_limit / estimated_tokens
// Estimate: 5K tokens per call → max per_token = $0.05 / 5000 = 10 micro-USD
let affordable: Vec<_> = candidates.iter()
    .filter(|r| {
        let cost = r.get_extension::<CostExtension>()?;
        cost.per_token_micro_usd.map_or(false, |c| c <= 10)
    })
    .filter(|r| {
        // Also check reputation
        let rep = compute_reputation(&r.attestations, &trust, now);
        rep.map_or(false, |s| s >= 0.7)  // quality threshold
    })
    .collect();

// The Llama-70B agent (1 micro-USD/token) passes both filters.
// Select it via P2C or cheapest-acceptable.
let selected = select_cheapest_acceptable(&affordable, 0.7)?;
// selected = Llama-70B agent (1 micro-USD/token, reputation 0.85)
```

### 14.4 RPC Call with Payment

The client calls the agent. Since pricing is per-token and output length
is unknown, the client uses **postpaid with batch settlement**:

```rust
// RPC call
let request = RpcRequest {
    capability: "llm.inference",
    body: encode_prompt("Explain quantum entanglement in simple terms."),
    headers: vec![
        ("Payment-Method", "lightning"),
        ("Payment-Batch-Threshold", "100000"),  // settle after $0.10
        ("Max-Output-Tokens", "2000"),          // cost cap
    ],
};

let response = aafp_client.call(selected, request).await?;

// Response includes token count and accumulated balance
let result: LlmResponse = decode(response.body)?;
// result.tokens_used = 850 (150 input + 700 output)
// result.accumulated_cost_micro_usd = 850  (850 × 1 micro-USD)
// result.balance_micro_usd = 850  (under $0.10 threshold, no invoice yet)

// Budget check
let actual_cost = 850;  // micro-USD
assert!(budget.can_afford(actual_cost));
budget.record_spend(actual_cost);
// budget.spent = 850 micro-USD ($0.00085)
// budget.remaining = 499,150 micro-USD ($0.49915)
```

### 14.5 Batch Settlement

After several calls, the accumulated balance exceeds the batch threshold:

```rust
// Call #120: accumulated balance reaches $0.10 (100,000 micro-USD)
let response = aafp_client.call(selected, request).await?;
let result: LlmResponse = decode(response.body)?;
// result.balance_micro_usd = 102,400  (over $0.10 threshold)
// result.lightning_invoice = "lnbc102400n1p..."  (BOLT-11 invoice)

// Client pays the Lightning invoice
lightning_client.pay_invoice(&result.lightning_invoice.unwrap()).await?;

// Next call starts with fresh balance
let response = aafp_client.call(selected, request).await?;
let result: LlmResponse = decode(response.body)?;
// result.balance_micro_usd = 850  (reset after settlement)
// result.payment_settled = true  (previous batch confirmed)
```

### 14.6 Full Cost Breakdown

```
Calls made:              120
Total tokens:            102,400
Price per token:         1 micro-USD ($0.000001)
Total cost:              102,400 micro-USD ($0.1024)
Lightning routing fee:   ~600 micro-USD ($0.0006, ~0.6%)
Total paid:              ~103,000 micro-USD ($0.103)

Budget:                  500,000 micro-USD ($0.50)
Spent:                   103,000 micro-USD ($0.103)
Remaining:               397,000 micro-USD ($0.397)
```

### 14.7 Free Tier Usage

If the client is within the first 100 calls of the day (free tier):

```rust
// Call #50 (within free tier)
let response = aafp_client.call(selected, request).await?;
let result: LlmResponse = decode(response.body)?;
// result.cost_micro_usd = 0  (free tier)
// result.free_tier_remaining = 50  (50 more free calls today)

// Call #101 (free tier exhausted)
let response = aafp_client.call(selected, request).await?;
// Returns PaymentRequired error:
// { amount: 850, currency: "USD", lightning_invoice: "lnbc850n1p..." }
```

### 14.8 Operator Revenue

For ComputeCo operating the Llama-70B agent:

```
GPU: A100 rented at $2.00/hour
Throughput: 3,000 tokens/second at 70% utilization
Daily token output: 3,000 × 3,600 × 24 × 0.7 = 181,440,000 tokens/day
Daily revenue: 181,440,000 × 1 micro-USD = $181.44/day
Daily GPU cost: $2.00 × 24 = $48.00/day
Daily gross margin: $181.44 - $48.00 = $133.44/day (73.6%)

Minus: bandwidth ($5/day), operator time ($40/day), misc ($7/day)
Daily net margin: $133.44 - $52 = $81.44/day (44.9%)
```

The operator is profitable as long as utilization stays above ~25%
(the break-even point where revenue equals GPU cost).

---

## 15. Security Considerations

### 15.1 Price Manipulation

A malicious agent could advertise a low price to attract traffic, then
charge more at call time. Mitigations:

1. The `CostExtension` is signed as part of the `AgentRecord`. The agent
   cannot change it without republishing with a new `record_version`.
2. Clients SHOULD verify that the call-time price matches the advertised
   price (or is lower). If the agent charges more than advertised without
   negotiation, the client SHOULD issue a negative attestation and route
   elsewhere.
3. The `updated_at` field lets clients detect price changes. Sudden price
   increases after a low-price advertisement are suspicious.

### 15.2 Payment Fraud

- **Non-payment (postpaid):** Client receives service but doesn't pay the
  invoice. Mitigation: use prepaid mode for untrusted clients. Agents
  SHOULD track client AgentIds and refuse service to known non-payers.
- **Fake payment proof:** Client sends a forged Lightning preimage.
  Mitigation: the agent MUST verify payment via its own Lightning node,
  not trust the client's claim.
- **Invoice manipulation:** Agent sends an invoice for more than the agreed
  price. Mitigation: the client verifies the invoice amount matches the
  quote before paying.

### 15.3 Budget Manipulation

A downstream agent could inflate its cost report to exhaust the caller's
budget faster. Mitigations:

1. The caller cross-checks the reported cost against the advertised
   `CostExtension` price.
2. The caller maintains `PeerMetrics` (including cost history) and flags
   agents whose actual costs consistently exceed advertised prices.
3. The circuit breaker trips for agents that repeatedly overcharge.

### 15.4 Free Tier Abuse

A client could create many AgentIds to exploit free tiers. Mitigations:

1. Agents track free-tier usage by AgentId. Creating new identities is
   cheap (key generation), but new identities have no reputation —
   high-quality agents may require a minimum reputation score for free-tier
   access.
2. Agents MAY rate-limit by IP address (for TCP connections) or by
   node ID (for DHT connections), in addition to AgentId.
3. The Web of Trust makes identity farming expensive: new identities have
   no trust path, so they're treated as TOFU (trust on first use) with
   minimal allocation.

### 15.5 Lightning-Specific Risks

- **Channel exhaustion:** The agent's Lightning channel runs out of
  inbound capacity. Mitigation: use an LSP that provides channel
  management, or maintain multiple channels.
- **Routing failures:** The Lightning payment can't find a route.
  Mitigation: the client retries with a higher fee or falls back to a
  direct channel or credit account.
- **Invoice expiry:** BOLT-11 invoices typically expire in 15-60 minutes.
  If the client pays after expiry, the payment fails. Mitigation: the
  client requests a new invoice.

---

## 16. Open Questions

1. **Cost extension v2:** Should a future `CostExtension` v2 include
   tiered pricing (volume discounts), dynamic pricing (load-based), and
   split input/output token rates as first-class fields rather than
   metadata?

2. **Payment escrow:** Should AAFP define an escrow mechanism where a
   third-party agent holds payment in trust until both parties confirm
   satisfaction? This would enable trustless postpaid payments but adds
   complexity and a trusted third party.

3. **Cost oracles:** How do clients get reliable exchange rates for
   non-USD currencies? Should AAFP define a "rate oracle" capability that
   agents can query for current FX rates?

4. **SLA enforcement:** If an agent charges a premium price with an SLA
   (e.g., "p99 < 100ms or money back"), how is the SLA enforced? The
   client's `PeerMetrics` provide latency data, but the agent may dispute
   the measurement. Should AAFP define a third-party SLA attestation
   service?

5. **Negative pricing:** Could agents pay clients to use them? This sounds
   absurd but could apply to data-collection agents that value the
   interaction data more than the compute cost. `per_invocation_micro_usd`
   is `u64` (non-negative). A future extension could use `i64` to allow
   negative prices (agent pays client).

6. **Multi-party payments:** When Agent A calls Agent B which calls Agent
   C, and the user only pays Agent A, how does payment cascade? The
   `BudgetDelegation` (§8.2) handles budget propagation, but the actual
   settlement is a chain of bilateral payments. Should AAFP define a
   "payment chain" protocol for atomic multi-party settlement?

7. **Insurance:** Could agents purchase insurance against non-payment or
   SLA violations? An insurance agent (itself an AAFP agent) could charge
   a premium and pay out on claims. This is an application-layer concern
   but interesting to explore.

8. **Cost anonymization:** Could an agent hide its exact price in the DHT
   and only reveal it during negotiation? This would prevent competitors
   from easily undercutting. The `CostExtension` would be absent; the
   price is discovered via the negotiation protocol (§7). Trade-off:
   clients can't do cost-based filtering at discovery time.

---

## 17. Relationship to Existing AAFP Components

| Component | Role in Economics | Document |
|-----------|------------------|----------|
| `AgentRecord` | Carries `CostExtension` in key 11 | `AGENT_RECORD_EXTENSIONS.md` §5.3 |
| `CostExtension` | Advertises pricing (per-call, per-token, per-second, free tier) | `AGENT_RECORD_EXTENSIONS.md` §5.3, `extensions/cost.rs` |
| `PerformanceExtension` | Advertises latency/throughput (quality signal) | `AGENT_RECORD_EXTENSIONS.md` §5.2 |
| `ReputationExtension` | Links to third-party attestations (trust signal) | `AGENT_RECORD_EXTENSIONS.md` §5.5 |
| `Attestation` | Third-party quality/reputation claims | `AGENT_RECORD_EXTENSIONS.md` §7 |
| `ExtensionIndex` | Local index for cost/latency/country filtering | `AGENT_RECORD_EXTENSIONS.md` §10.2 |
| `dynamic_score()` | Cost-aware routing score (weight_cost) | `ADAPTIVE_ROUTING_PLANE.md` §4.2 |
| `PeerMetrics` | Tracks `cost_micro_usd` per peer | `ADAPTIVE_ROUTING_PLANE.md` §3 |
| `CircuitState` | Trips for overcharging/non-paying agents | `ADAPTIVE_ROUTING_PLANE.md` §5 |
| `CapabilityDht` | Marketplace discovery (query by capability) | `RFCs/0004-discovery.md` |
| `UCAN` | Signed budget delegation, barter credits | `crates/aafp-identity/src/ucan.rs` |
| `WebOfTrust` | Trust weighting for attestations and barter | `crates/aafp-identity/src/web_of_trust.rs` |

---

## 18. Implementation Roadmap

### Phase 1: Cost Advertising (Existing)
- `CostExtension` in `extensions/cost.rs` — **DONE** (Phase E4)
- `ExtensionIndex` with `by_cost` BTreeMap — **DONE**
- `dynamic_score()` with `weight_cost` — **DONE**

### Phase 2: Budget Enforcement
- `Budget` struct with `can_afford()` / `record_spend()` — **TODO**
- `BudgetDelegation` header in RPC — **TODO**
- `BudgetExceeded` error type — **TODO**
- `estimate_cost()` utility function — **TODO**

### Phase 3: Price Negotiation
- `PriceOffer` / `PriceResponse` RPC header types — **TODO**
- Bounded negotiation logic (max 3 rounds) — **TODO**
- `BidRequest` / `Bid` for reverse auctions — **TODO**

### Phase 4: Payment Integration
- `PaymentRequired` error with Lightning invoice — **TODO**
- `PaymentChannel` trait (future `aafp-payments` crate) — **TODO**
- Lightning LSP integration (external library) — **TODO**
- Batch settlement logic — **TODO**

### Phase 5: Enterprise Billing
- `EnterpriseGateway` proxy — **TODO** (application-layer, not core)
- `CallLog` with cost allocation — **TODO** (application-layer)
- Monthly invoice reconciliation — **TODO** (application-layer)

### Phase 6: Free Federation Support
- Free-tier filtering in `ExtensionIndex` — **TODO**
- `RateLimited` error type — **TODO**
- Free-tier usage tracking (agent-side) — **TODO** (application-layer)

---

## 19. Conclusion

AAFP's economic model is deliberately minimal at the protocol layer:

1. **Advertise** prices via `CostExtension` (done).
2. **Route** with cost awareness via `dynamic_score()` (done).
3. **Enforce** budgets client-side (planned).
4. **Negotiate** prices via RPC headers (planned).
5. **Settle** payments out-of-band via Lightning, credit, or barter
   (external).

The protocol carries economic *signals* but does not become a payment
network, a token economy, or a billing system. This keeps AAFP focused on
its core mission — connecting agents — while leaving room for a rich
ecosystem of payment providers, marketplace UIs, and enterprise billing
systems to develop on top.

The agent marketplace emerges naturally from the DHT: every agent that
publishes a `CostExtension` is listed, every client that queries is
shopping, and every RPC call is a transaction. AAFP provides the
discovery and communication infrastructure; the economics happen on top.
