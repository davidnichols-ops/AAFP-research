# AAFP Cost Optimization & Resource Management

> Status: Research / Planning
> Scope: Agent cost model, budget enforcement, cost-aware routing, cost
> aggregation/reporting, free-tier economics, cost optimization strategies,
> and multi-currency support for the AAFP agent mesh protocol.
> Related: `ARE_E3_E4_COST_SEMANTIC_REPUTATION.md` (CostExtension),
> `AR_T5_T7_INTEGRATION_API.md` (cost-aware routing), `PERFORMANCE_SCALABILITY.md`
> (connection pooling, batching), `FEDERATION_TRUST.md` (reputation-weighted
> selection).

---

## Table of Contents

1. [Agent Cost Model](#1-agent-cost-model)
2. [Cost Tracking via CostExtension](#2-cost-tracking-via-costextension)
3. [Budget Enforcement](#3-budget-enforcement)
4. [Cost-Aware Routing](#4-cost-aware-routing)
5. [Cost Aggregation](#5-cost-aggregation)
6. [Cost Reporting & Alerts](#6-cost-reporting--alerts)
7. [Free Tier Economics](#7-free-tier-economics)
8. [Cost Optimization Strategies](#8-cost-optimization-strategies)
9. [Multi-Currency Support](#9-multi-currency-support)
10. [Concrete Cost Tracking Implementation](#10-concrete-cost-tracking-implementation)
11. [Threats & Mitigations](#11-threats--mitigations)
12. [Roadmap](#12-roadmap)

---

## 1. Agent Cost Model

AAFP agents are not free to operate. Each agent incurs costs from multiple
sources, and the protocol must expose these costs in a machine-readable,
verifiable, and comparable form so that discovering agents can make
economically rational routing decisions. The cost model distinguishes four
orthogonal cost categories.

### 1.1 Fixed Costs (Infrastructure)

Fixed costs do not vary with request volume. They are borne by the agent
operator regardless of whether the agent handles zero or ten thousand RPCs
per day.

| Cost Source | Description | Typical Magnitude |
|-------------|-------------|-------------------|
| Compute host | VM / bare metal / edge device | $20–$2000/month |
| GPU rental | Dedicated GPU (A100, H100, RTX 5090) | $0.50–$12/hour |
| Storage | Model weights, vector DB, cache | $0.02–$0.23/GB/month |
| Network egress | Outbound bandwidth | $0.05–$0.12/GB |
| DHT participation | Routing table maintenance, gossip | Negligible per-agent |
| Key management | ML-DSA-65 key storage, rotation | Negligible |

Fixed costs are **not** encoded in `CostExtension` directly — they are
recovered through the variable and usage-based pricing that the extension
*does* expose. An agent operator sets `per_invocation_micro_usd` and
`per_token_micro_usd` high enough to amortize fixed costs over expected
volume. This keeps the on-wire cost model simple: only marginal costs
appear, and the operator's break-even analysis happens offline.

**Implication for free-tier agents:** An agent with `has_free_tier: true`
absorbs fixed costs as a loss leader or is subsidized (see §7). The
protocol does not enforce cost recovery — it only makes costs transparent.

### 1.2 Variable Costs (Per-RPC)

Variable costs scale linearly with the number of remote procedure calls.
Each RPC consumes:

- A QUIC stream (connection pool amortizes the handshake — see §8.4).
- Server-side compute time for request parsing, routing, and response framing.
- Potentially a model inference (the dominant cost for LLM agents).

`CostExtension.per_invocation_micro_usd` captures the per-RPC charge. This
is a flat fee per call, independent of token count or duration. Examples:

- An OCR agent: `per_invocation_micro_usd: 500` ($0.0005/page).
- A translation agent: `per_invocation_micro_usd: 50` ($0.00005/call) plus
  `per_token_micro_usd: 2` ($0.000002/token) for the usage-based component.

### 1.3 Usage-Based Costs (Per-Token / Per-Second)

Usage-based costs scale with the *amount of work* done in a single RPC,
not just the fact that a call happened. Two sub-models:

**Per-token (LLM agents):** `per_token_micro_usd` charges per input +
output token. This is the dominant cost for language model agents and
reflects the underlying GPU inference cost. Token counts are measured
server-side and reported back in the response (see §10.3 for the
`CostBreakdown` receipt).

**Per-second (compute agents):** `per_second_micro_usd` charges per second
of wall-clock compute time. This applies to agents doing batch rendering,
video transcoding, or long-running simulations where token count is
meaningless but GPU-seconds are the real cost driver.

The total cost of a single invocation is:

```
total_micro_usd = per_invocation_micro_usd
                + per_token_micro_usd * token_count
                + per_second_micro_usd * elapsed_seconds
```

`CostExtension::estimate_cost(token_count)` computes the invocation +
token components; the per-second component is added post-hoc because the
caller cannot predict elapsed time before the call.

### 1.4 Subscription Costs

Some agents prefer a subscription model: a flat monthly fee for unlimited
or capped usage. AAFP does not encode subscription terms in
`CostExtension` v1 — subscriptions are negotiated out-of-band and
enforced by the agent's authorization layer (UCAN capabilities with
`exp` claims). However, the extension's `has_free_tier` and
`free_tier_daily_limit` fields support a degenerate subscription: a free
tier with a daily cap, which is the most common "freemium" pattern.

Future `CostExtension` v2 may add:

```
? 8: uint,    // subscription_monthly_micro_usd
? 9: uint,    // subscription_monthly_call_limit
```

For now, subscription agents set `per_invocation_micro_usd: 0` and rely on
UCAN-based access control to gate subscribers. Cost-aware routing treats
a zero-cost agent as free *for authorized callers*; unauthorized callers
receive a `PERMISSION_DENIED` error and the router falls back.

### 1.5 Cost Model Summary Table

| Category | Field in CostExtension | Unit | Scales with |
|----------|------------------------|------|-------------|
| Fixed | (not on-wire) | USD/month | Time |
| Variable | `per_invocation_micro_usd` | micro-USD | RPC count |
| Usage (token) | `per_token_micro_usd` | micro-USD/token | Token count |
| Usage (time) | `per_second_micro_usd` | micro-USD/sec | Wall-clock seconds |
| Subscription | (out-of-band, UCAN) | USD/month | Time |
| Free tier | `has_free_tier`, `free_tier_daily_limit` | bool + calls/day | Daily call count |

---

## 2. Cost Tracking via CostExtension

The `CostExtension` (namespace `"aafp.cost.v1"`) is the canonical on-wire
representation of an agent's pricing. It lives in the AgentRecord
extension map (key 11) and is signed as part of the record. This makes
pricing **self-certifying**: an agent cannot silently raise prices after
a discovery query has cached its record — the signed record's
`updated_at` field lets callers detect stale pricing.

### 2.1 CBOR Encoding

```
CostExtensionData = {
    ? 1: uint,    // per_invocation_micro_usd
    ? 2: uint,    // per_token_micro_usd
    ? 3: uint,    // per_second_micro_usd
    ? 4: bool,    // has_free_tier
    ? 5: uint,    // free_tier_daily_limit
    ? 6: tstr,    // currency (ISO 4217, default "USD")
    7: uint,      // updated_at (unix seconds)
}
```

All monetary values are in **micro-USD** (1 USD = 1,000,000 micro-USD).
This avoids floating point on the wire — CBOR integers are exact, and
integer arithmetic in the budget tracker (§3) has no rounding error.
The smallest representable charge is $0.000001, which is finer than any
realistic per-token or per-RPC price.

### 2.2 Field Semantics

- **`per_invocation_micro_usd`** — Optional. `None` means "pricing not
  applicable or not disclosed." An agent that discloses no pricing is
  treated by cost-aware routing as having unknown cost (scored neutrally,
  not as free).
- **`per_token_micro_usd`** — Optional. Applies to LLM capabilities. The
  token count is the sum of input and output tokens, measured server-side.
- **`per_second_micro_usd`** — Optional. Applies to compute-heavy
  capabilities. Measured as wall-clock seconds from request receipt to
  response send.
- **`has_free_tier`** — Always encoded (bool, not optional). `true` means
  the agent offers some free usage. The exact limit is in
  `free_tier_daily_limit`.
- **`free_tier_daily_limit`** — Optional. `None` means unlimited free
  tier (rare; usually community-run agents — see §7.2). A `u32` value is
  the maximum free invocations per UTC day per caller (identified by
  `AgentId`).
- **`currency`** — ISO 4217 code. Defaults to `"USD"` if absent. See §9
  for multi-currency handling.
- **`updated_at`** — Unix timestamp of the last pricing change. Callers
  compare this against their cached copy to detect stale pricing.

### 2.3 Cost Estimation API

```rust
impl CostExtension {
    /// Compute the cost of a single invocation given a token count.
    /// Returns micro-USD. If all components are zero/None, returns None
    /// (pricing not applicable).
    pub fn estimate_cost(&self, token_count: u64) -> Option<u64> {
        let inv = self.per_invocation_micro_usd.unwrap_or(0);
        let tok = self.per_token_micro_usd.unwrap_or(0)
            .saturating_mul(token_count);
        let sec = self.per_second_micro_usd.unwrap_or(0);
        if inv == 0 && tok == 0 && sec == 0 {
            return None;
        }
        Some(inv.saturating_add(tok).saturating_add(sec))
    }

    /// Check if a request would fall within the free tier.
    pub fn is_free_eligible(&self, daily_usage: u32) -> bool {
        if !self.has_free_tier {
            return false;
        }
        match self.free_tier_daily_limit {
            Some(limit) => daily_usage < limit,
            None => true, // unlimited free tier
        }
    }
}
```

### 2.4 Per-Capability Cost Model

The agent-level `CostExtension` gives a default price for all
capabilities. For agents with heterogeneous capabilities (e.g., a cheap
summarization endpoint and an expensive code-generation endpoint), the
per-capability `SemanticCapabilityData.cost` field
(`CapabilityCostModel`) overrides the agent-level price for that specific
capability:

```rust
pub struct CapabilityCostModel {
    pub per_invocation_micro_usd: Option<u64>,
    pub per_token_micro_usd: Option<u64>,
    pub has_free_tier: bool,
}
```

Cost-aware routing (§4) uses the per-capability model when available,
falling back to the agent-level `CostExtension` otherwise.

### 2.5 Pricing Integrity

Because `CostExtension` is part of the signed `AgentRecord`, an agent
cannot retroactively change its advertised price for a given record
version. To raise prices, the agent publishes a new `AgentRecord` with a
new `updated_at` and re-signs. Callers that cached the old record will
see the stale `updated_at` and can re-fetch. This prevents
bait-and-switch pricing attacks where an agent advertises a low price to
win routing decisions, then charges a higher price at invoicing time.

The actual charge is enforced server-side and reported in the response
receipt (§10.3). If the charged amount exceeds the advertised
`estimate_cost` by more than a configurable tolerance (default 10%, to
account for token-count estimation error), the caller's budget tracker
flags the agent as **price-gouging** and reduces its routing score.

---

## 3. Budget Enforcement

Budget enforcement is **client-side**. The AAFP protocol has no central
billing authority — each caller tracks its own spend and refuses to
initiate calls that would exceed its remaining budget. This is the only
secure model in a decentralized mesh: a server-side budget would require
trusting every agent with the caller's wallet.

### 3.1 Budget Tracker

```rust
use std::collections::HashMap;
use aafp_identity::AgentId;
use std::time::{Duration, Instant};

/// A client-side budget tracker. Thread-safe, lock-free reads via
/// atomic counters; writes take a short mutex.
pub struct BudgetTracker {
    /// Total budget for the current period, in micro-USD.
    total_budget_micro_usd: u64,
    /// Amount spent so far in the current period.
    spent_micro_usd: std::sync::atomic::AtomicU64,
    /// Per-agent spend breakdown (for reporting — §5).
    per_agent: parking_lot::Mutex<HashMap<AgentId, u64>>,
    /// Per-capability spend breakdown.
    per_capability: parking_lot::Mutex<HashMap<String, u64>>,
    /// Period start time; budget resets every `period`.
    period_start: parking_lot::Mutex<Instant>,
    /// Budget period duration.
    period: Duration,
    /// Tolerance for overcharge detection (in basis points, 1000 = 10%).
    overcharge_tolerance_bps: u16,
}

impl BudgetTracker {
    pub fn new(total_budget_micro_usd: u64, period: Duration) -> Self {
        Self {
            total_budget_micro_usd,
            spent_micro_usd: std::sync::atomic::AtomicU64::new(0),
            per_agent: parking_lot::Mutex::new(HashMap::new()),
            per_capability: parking_lot::Mutex::new(HashMap::new()),
            period_start: parking_lot::Mutex::new(Instant::now()),
            period,
            overcharge_tolerance_bps: 1000, // 10%
        }
    }

    /// Remaining budget in micro-USD. Returns 0 if exhausted.
    pub fn remaining(&self) -> u64 {
        let spent = self.spent_micro_usd.load(std::sync::atomic::Ordering::Relaxed);
        self.total_budget_micro_usd.saturating_sub(spent)
    }

    /// Check if a call with the given estimated cost would fit in the
    /// remaining budget. Does NOT debit — call `commit()` after the RPC
    /// completes with the actual cost.
    pub fn check(&self, estimated_cost_micro_usd: u64) -> bool {
        self.remaining() >= estimated_cost_micro_usd
    }

    /// Commit an actual spend. Called after the RPC completes and the
    /// server reports the real cost. Resets the period if it has elapsed.
    pub fn commit(
        &self,
        agent_id: &AgentId,
        capability: &str,
        actual_cost_micro_usd: u64,
    ) -> Result<(), BudgetExceeded> {
        self.maybe_reset_period();

        let prev_spent = self.spent_micro_usd.load(std::sync::atomic::Ordering::Relaxed);
        let new_spent = prev_spent.saturating_add(actual_cost_micro_usd);
        if new_spent > self.total_budget_micro_usd {
            // Overspent — the call already happened, so we record the
            // overage and return an error so the caller can alert.
            self.spent_micro_usd.store(new_spent, std::sync::atomic::Ordering::Relaxed);
            return Err(BudgetExceeded {
                budget: self.total_budget_micro_usd,
                spent: new_spent,
                overage: new_spent - self.total_budget_micro_usd,
            });
        }
        self.spent_micro_usd.store(new_spent, std::sync::atomic::Ordering::Relaxed);

        self.per_agent.lock().entry(*agent_id)
            .and_modify(|c| *c += actual_cost_micro_usd)
            .or_insert(actual_cost_micro_usd);
        self.per_capability.lock().entry(capability.to_string())
            .and_modify(|c| *c += actual_cost_micro_usd)
            .or_insert(actual_cost_micro_usd);

        Ok(())
    }

    fn maybe_reset_period(&self) {
        let mut start = self.period_start.lock();
        if start.elapsed() >= self.period {
            self.spent_micro_usd.store(0, std::sync::atomic::Ordering::Relaxed);
            self.per_agent.lock().clear();
            self.per_capability.lock().clear();
            *start = Instant::now();
        }
    }
}

#[derive(Debug)]
pub struct BudgetExceeded {
    pub budget: u64,
    pub spent: u64,
    pub overage: u64,
}
```

### 3.2 Pre-Call Budget Check

Before initiating an RPC, the caller estimates the cost using
`CostExtension::estimate_cost()` with a token-count prediction (for LLM
agents, this is `input_tokens + expected_output_tokens`; the latter is a
caller-side heuristic). If `budget_tracker.check(estimated_cost)` returns
`false`, the caller **refuses to make the call** and the cost-aware
router selects a cheaper alternative or returns `NoAgentWithinBudget`.

```rust
/// Pre-call gate: returns true if the call should proceed.
fn budget_gate(
    budget: &BudgetTracker,
    cost_ext: &CostExtension,
    estimated_tokens: u64,
) -> bool {
    match cost_ext.estimate_cost(estimated_tokens) {
        Some(est) => budget.check(est),
        None => true, // unknown cost — allow, but track
    }
}
```

### 3.3 Post-Call Reconciliation

The server reports the actual cost in the response receipt
(`CostBreakdown` — see §10.3). The caller calls
`budget.commit(agent_id, capability, actual_cost)`. If the actual cost
exceeds the estimate by more than `overcharge_tolerance_bps`, the agent
is flagged:

```rust
fn check_overcharge(
    estimated: u64,
    actual: u64,
    tolerance_bps: u16,
) -> Option<u64> {
    if estimated == 0 {
        return if actual > 0 { Some(actual) } else { None };
    }
    let tolerance = estimated.saturating_mul(tolerance_bps as u64) / 10000;
    if actual > estimated + tolerance {
        Some(actual - estimated)
    } else {
        None
    }
}
```

Flagged agents have their routing score penalized (see §4.4) and, after
repeated violations, are added to a local **price-gouging denylist**.

### 3.4 Budget Propagation in Agent Chains

When agent A calls agent B which calls agent C, each hop has its own
budget tracker. AAFP does not propagate budget across hops — each agent
is autonomous and responsible for its own spend. However, an agent can
*advertise* a budget to downstream agents via a UCAN capability
constraint:

```
{ "resource": "budget", "action": "limit", "constraints": { "max_micro_usd": 50000 } }
```

A well-behaved downstream agent that receives this constraint will
refuse to make calls that would exceed it, returning a
`BUDGET_EXCEEDED` error to the upstream caller. This is advisory, not
enforced — a malicious downstream agent can ignore the constraint. The
upstream caller protects itself with its own budget tracker and
timeouts.

---

## 4. Cost-Aware Routing

Cost-aware routing extends the Adaptive Routing Plane (Track T) with a
cost dimension. The combined scoring function from `AR_T5_T7` fuses
static (capability fit) and dynamic (health) scores; cost-aware routing
adds a third dimension: **economic efficiency**.

### 4.1 Cost as a Hard Constraint

From `AR_T5_T7_INTEGRATION_API.md` §2.2, cost filters expressed as
`QueryFilter::Range` with `LessThan`/`LessThanOrEqual` are **hard
constraints** — candidates that exceed the max cost are eliminated, not
penalized:

```rust
// Cost: advertised per-invocation cost.
if let Some(cost_filter) = &query.cost {
    if let Some(max_cost) = cost_filter.max_per_invocation_micro_usd {
        if capability.cost.per_invocation_micro_usd > max_cost {
            return false; // eliminated
        }
    }
}
```

This is the primary cost-aware routing mechanism: the caller sets a
`max_per_invocation_micro_usd` in the `CapabilityQuery`, and the router
eliminates any agent whose advertised price exceeds it. Combined with
the budget tracker (§3), this ensures the caller never routes to an
agent it cannot afford.

### 4.2 Cost as a Soft Score Component

When no hard cost constraint is set, cost contributes to the soft score.
The cost score is a monotonically decreasing function of estimated cost,
normalized to `[0, 1]`:

```rust
/// Compute a cost score in [0, 1]. Lower cost → higher score.
/// `max_cost` is the highest cost among all candidates (for normalization).
fn cost_score(estimated_micro_usd: u64, max_cost: u64) -> f64 {
    if max_cost == 0 {
        return 1.0; // all free
    }
    1.0 - (estimated_micro_usd as f64 / max_cost as f64)
}
```

The combined score becomes a three-way weighted sum:

```
total_score = w_static * static_score
            + w_dynamic * dynamic_score
            + w_cost * cost_score
```

where `w_static + w_dynamic + w_cost = 1`. Defaults:
`w_static = 0.4, w_dynamic = 0.4, w_cost = 0.2`. Cost gets the lowest
default weight because capability fit and health are usually more
important than marginal price differences — but callers who are
budget-constrained can raise `w_cost` to 0.5 or higher.

### 4.3 Cheapest-Quality-Threshold Routing

A specialized routing strategy: route to the **cheapest agent that meets
a quality threshold**. This is the "value" strategy — it doesn't pick the
absolute cheapest (which may be low quality) or the absolute best (which
may be expensive), but the cheapest among the good-enough.

```rust
/// Select the cheapest candidate that meets the quality threshold.
/// Quality is measured by the static_score (capability fit + trust).
pub fn select_cheapest_above_threshold(
    candidates: &[ScoredCandidate],
    cost_estimates: &HashMap<AgentId, u64>,
    quality_threshold: f64,
) -> Option<&ScoredCandidate> {
    candidates.iter()
        .filter(|c| c.static_score >= quality_threshold)
        .filter(|c| c.circuit != CircuitState::Open)
        .min_by_key(|c| {
            cost_estimates.get(&c.agent_id).copied().unwrap_or(u64::MAX)
        })
}
```

The quality threshold defaults to `0.7` (out of 1.0), meaning "the agent
is a reasonably good capability match and has decent trust." Callers can
tune this: a threshold of `0.9` demands near-perfect fit; `0.5` accepts
mediocre agents if they're cheap.

This strategy is optimal for **batch workloads** where many calls are
made and small per-call savings compound. For latency-critical
single-call workloads, the default weighted-sum strategy is better
because it balances cost against speed.

### 4.4 Price-Gouging Penalty

Agents that consistently overcharge (actual cost > estimated cost +
tolerance) have their cost score penalized:

```rust
fn penalized_cost_score(
    agent_id: &AgentId,
    base_cost_score: f64,
    gouge_history: &GougeHistory,
) -> f64 {
    let violations = gouge_history.count(agent_id);
    let penalty = (violations as f64 * 0.1).min(0.5); // up to -0.5
    (base_cost_score - penalty).max(0.0)
}
```

After 5 violations, the agent's cost score is reduced by 0.5 (effectively
making it look 50% more expensive). After 10 violations, the agent is
added to the local denylist and eliminated from future routing.

### 4.5 Free-Tier-Aware Routing

When a caller has a free-tier-eligible agent in its candidate set (the
agent has `has_free_tier: true` and the caller's daily usage is below
`free_tier_daily_limit`), the router assigns that agent a cost score of
`1.0` (maximum). This makes free-tier agents preferred when available,
which is the desired behavior for budget-constrained callers.

The router must track per-agent daily usage to know whether the free
tier is still available:

```rust
pub struct FreeTierUsage {
    /// agent_id → (date, call_count)
    usage: HashMap<AgentId, (chrono::NaiveDate, u32)>,
}

impl FreeTierUsage {
    pub fn is_free_available(
        &mut self,
        agent_id: &AgentId,
        limit: Option<u32>,
    ) -> bool {
        let today = chrono::Local::now().date_naive();
        let entry = self.usage.entry(*agent_id).or_insert((today, 0));
        if entry.0 != today {
            *entry = (today, 0); // reset on new day
        }
        match limit {
            Some(lim) => entry.1 < lim,
            None => true,
        }
    }

    pub fn record_call(&mut self, agent_id: &AgentId) {
        let today = chrono::Local::now().date_naive();
        let entry = self.usage.entry(*agent_id).or_insert((today, 0));
        if entry.0 != today {
            *entry = (today, 0);
        }
        entry.1 += 1;
    }
}
```

---

## 5. Cost Aggregation

Cost aggregation answers: "how much did I spend, broken down by X?"
The `BudgetTracker` (§3.1) already maintains per-agent and per-capability
breakdowns. This section defines the aggregation queries and their
output formats.

### 5.1 Aggregation Dimensions

| Dimension | Key | Example Query |
|-----------|-----|---------------|
| Per agent | `AgentId` | "How much did I spend on agent X this week?" |
| Per capability | `String` (capability name) | "How much did translation cost me?" |
| Per time period | day / week / month | "What was my monthly spend?" |
| Per cost component | invocation / token / second | "Am I paying more for tokens or per-call fees?" |
| Per modality | text / image / audio | "How much did image generation cost?" |

### 5.2 Aggregation Query API

```rust
pub struct CostAggregator<'a> {
    tracker: &'a BudgetTracker,
}

impl<'a> CostAggregator<'a> {
    /// Total spend in the current period.
    pub fn total_spend(&self) -> u64 {
        self.tracker.spent_micro_usd.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Spend grouped by agent, sorted descending.
    pub fn spend_by_agent(&self) -> Vec<(AgentId, u64)> {
        let mut entries: Vec<_> = self.tracker.per_agent.lock()
            .iter().map(|(k, v)| (*k, *v)).collect();
        entries.sort_by(|a, b| b.1.cmp(&a.1));
        entries
    }

    /// Spend grouped by capability, sorted descending.
    pub fn spend_by_capability(&self) -> Vec<(String, u64)> {
        let mut entries: Vec<_> = self.tracker.per_capability.lock()
            .iter().map(|(k, v)| (k.clone(), *v)).collect();
        entries.sort_by(|a, b| b.1.cmp(&a.1));
        entries
    }

    /// Top N agents by spend.
    pub fn top_agents(&self, n: usize) -> Vec<(AgentId, u64)> {
        self.spend_by_agent().into_iter().take(n).collect()
    }

    /// Average cost per call for a given capability.
    pub fn avg_cost_per_call(&self, capability: &str, call_count: u64) -> Option<f64> {
        let spend = *self.tracker.per_capability.lock()
            .get(capability)?;
        if call_count == 0 { return None; }
        Some(spend as f64 / call_count as f64)
    }
}
```

### 5.3 Time-Series Aggregation

For daily/weekly/monthly reports (§6), the tracker persists a snapshot
at each period reset:

```rust
pub struct SpendSnapshot {
    pub period_start: u64,      // unix seconds
    pub period_end: u64,
    pub total_micro_usd: u64,
    pub by_agent: Vec<(AgentId, u64)>,
    pub by_capability: Vec<(String, u64)>,
    pub call_count: u64,
}

pub struct CostLedger {
    snapshots: Vec<SpendSnapshot>,
}

impl CostLedger {
    pub fn record_snapshot(&mut self, snapshot: SpendSnapshot) {
        self.snapshots.push(snapshot);
        // Retain only last 90 days of snapshots.
        let cutoff = snapshot.period_end - 90 * 86400;
        self.snapshots.retain(|s| s.period_end >= cutoff);
    }

    /// Aggregate spend over a time range.
    pub fn spend_in_range(&self, start: u64, end: u64) -> u64 {
        self.snapshots.iter()
            .filter(|s| s.period_start >= start && s.period_end <= end)
            .map(|s| s.total_micro_usd)
            .sum()
    }
}
```

---

## 6. Cost Reporting & Alerts

### 6.1 Report Types

| Report | Frequency | Content | Delivery |
|--------|-----------|---------|----------|
| Daily | Every 24h | Yesterday's total, top 5 agents, budget utilization % | Log + optional webhook |
| Weekly | Every 7d | 7-day trend, per-capability breakdown, anomaly flags | Log + webhook |
| Monthly | Every 30d | 30-day trend, month-over-month delta, projection | Log + webhook + email |

### 6.2 Report Format

```rust
pub struct CostReport {
    pub period: ReportPeriod,
    pub total_spend_micro_usd: u64,
    pub budget_micro_usd: u64,
    pub budget_utilization_bps: u16,  // 10000 = 100%
    pub top_agents: Vec<(AgentId, u64)>,
    pub top_capabilities: Vec<(String, u64)>,
    pub call_count: u64,
    pub avg_cost_per_call_micro_usd: u64,
    pub anomalies: Vec<CostAnomaly>,
}

pub enum ReportPeriod { Daily(u64), Weekly(u64), Monthly(u64) }

pub struct CostAnomaly {
    pub kind: AnomalyKind,
    pub agent_id: Option<AgentId>,
    pub detail: String,
}

pub enum AnomalyKind {
    PriceGouge,        // actual >> estimated
    SuddenCostIncrease, // day-over-day > 50%
    BudgetThresholdExceeded, // utilization > 80%
    NewHighCostAgent,  // agent with unusually high per-call cost
}
```

### 6.3 Budget Alerts

Alerts fire when budget utilization crosses configurable thresholds:

```rust
pub struct AlertConfig {
    /// Fire warning at this utilization (basis points, 8000 = 80%).
    pub warning_threshold_bps: u16,
    /// Fire critical alert at this utilization.
    pub critical_threshold_bps: u16,
    /// Webhook URL for alert delivery.
    pub webhook_url: Option<String>,
}

pub struct BudgetAlert {
    pub level: AlertLevel,
    pub budget_micro_usd: u64,
    pub spent_micro_usd: u64,
    pub utilization_bps: u16,
    pub timestamp: u64,
}

pub enum AlertLevel { Warning, Critical }

impl BudgetTracker {
    pub fn check_alerts(&self, config: &AlertConfig) -> Option<BudgetAlert> {
        let spent = self.spent_micro_usd.load(std::sync::atomic::Ordering::Relaxed);
        let util_bps = if self.total_budget_micro_usd > 0 {
            (spent * 10000 / self.total_budget_micro_usd) as u16
        } else { 0 };

        if util_bps >= config.critical_threshold_bps {
            return Some(BudgetAlert {
                level: AlertLevel::Critical,
                budget: self.total_budget_micro_usd,
                spent,
                utilization_bps: util_bps,
                timestamp: now_unix(),
            });
        }
        if util_bps >= config.warning_threshold_bps {
            return Some(BudgetAlert {
                level: AlertLevel::Warning,
                budget: self.total_budget_micro_usd,
                spent,
                utilization_bps: util_bps,
                timestamp: now_unix(),
            });
        }
        None
    }
}
```

### 6.4 Alert Delivery

Alerts are delivered via:

1. **Structured log** — `tracing::warn!` / `tracing::error!` with JSON
   payload, picked up by the observability stack (see
   `OBSERVABILITY_DEBUGGING.md`).
2. **Webhook** — HTTP POST to `config.webhook_url` with the `BudgetAlert`
   as JSON body. Retries with exponential backoff (3 attempts).
3. **Prometheus metric** — `aafp_budget_utilization_bps` gauge and
   `aafp_budget_exceeded_total` counter, scraped by the monitoring stack.

---

## 7. Free Tier Economics

### 7.1 Why Free Tiers Matter

Free tiers are essential for protocol adoption. A new user evaluating
AAFP will not commit to paid agents before testing the ecosystem. Free
agents lower the barrier to entry, enable grassroots experimentation,
and create a funnel toward paid agents (once the user's needs exceed
free-tier limits).

### 7.2 Sustainability Models

| Model | How it works | Sustainability |
|-------|-------------|----------------|
| Community-run | Volunteers operate agents on spare hardware | Sustainable while community is active; fragile long-term |
| Sponsored | A company funds free agents as a loss leader | Sustainable while sponsor benefits (ecosystem lock-in, goodwill) |
| Freemium | Agent offers free tier + paid tier; paid subsidizes free | Sustainable if conversion rate > CAC |
| Subsidized by staking | Agent operators stake tokens; free tier funded by staking yield | Requires a token economy (out of scope for v1) |
| Grant-funded | Non-profit or research grant covers compute costs | Sustainable for grant duration |

### 7.3 Community-Run Free Agents

A community-run agent sets:

```
CostExtension {
    per_invocation_micro_usd: Some(0),
    per_token_micro_usd: Some(0),
    has_free_tier: true,
    free_tier_daily_limit: None,  // unlimited
    currency: "USD",
    updated_at: now,
}
```

The agent operator absorbs all costs. To prevent abuse, the operator
typically:

- Rate-limits per `AgentId` (enforced server-side, not in the protocol).
- Requires a proof-of-work challenge for free-tier calls (optional,
  out-of-band).
- Prioritizes paid calls over free calls during high load.

The protocol's role is limited to making the free tier **discoverable**:
`has_free_tier: true` in the `CostExtension` lets cost-aware routing
prefer these agents for budget-constrained callers.

### 7.4 Sponsored Free Agents

A sponsor (e.g., a model provider promoting its new LLM) runs an agent
with a generous free tier:

```
CostExtension {
    per_invocation_micro_usd: Some(0),
    per_token_micro_usd: Some(0),
    has_free_tier: true,
    free_tier_daily_limit: Some(10000),  // 10k free calls/day
    currency: "USD",
    updated_at: now,
}
```

The sponsor pays for compute. In return, the agent's `AgentRecord`
metadata can include a `sponsor` field (custom metadata key) and the
sponsor gets brand exposure. The protocol treats this identically to a
community-run agent — the economics are external.

### 7.5 Freemium Conversion

A freemium agent offers both free and paid tiers. The free tier has a
daily limit; once exceeded, the agent charges `per_invocation_micro_usd`.
The caller's `FreeTierUsage` tracker (§4.5) knows when the free tier is
exhausted, and cost-aware routing switches to treating the agent as paid
for subsequent calls.

This is the most economically sustainable model because the agent
operator has a revenue path. The protocol supports it natively: the
`CostExtension` carries both the free-tier parameters and the paid
pricing, and the caller's budget tracker handles the transition
transparently.

### 7.6 Free-Tier Abuse Prevention

Free tiers are vulnerable to Sybil attacks: an attacker generates many
`AgentId`s to get unlimited free calls. Mitigations:

1. **Per-IP rate limiting** (server-side, out-of-protocol).
2. **Proof-of-work** for free-tier calls (optional challenge in the
   request header).
3. **Reputation-gated free tier**: free tier only available to agents
   with a minimum reputation score (from attestations — see
   `ARE_E3_E4_COST_SEMANTIC_REPUTATION.md` §6). New agents with no
   reputation get a smaller free tier.
4. **Web-of-trust gating**: free tier only for agents that are signed by
   a trusted introducer (existing web-of-trust infrastructure).

The protocol does not mandate any of these — they are operator choices.
The `CostExtension` only declares the free tier exists; enforcement is
server-side.

---

## 8. Cost Optimization Strategies

### 8.1 Caching (Avoid Redundant RPCs)

The single most effective cost optimization: don't make the call at all.
AAFP agents should cache results for idempotent capabilities.

**Cache key:** `SHA-256(capability_name || request_payload)`. The cache
is keyed by capability + payload, not by agent, so a cached result from
agent A can serve a request that would otherwise go to agent B.

**Cache TTL:** Determined by the capability's semantic stability. OCR of
a static document is cacheable forever. Translation of a news article is
cacheable for ~24h. LLM chat responses are generally not cacheable
(conversation state changes).

**Cache cost accounting:** A cache hit costs $0 (no RPC). The budget
tracker is not debited. The caller's `CostLedger` can track cache hit
rate as a separate metric for reporting.

```rust
pub struct ResultCache {
    entries: moka::future::Cache<[u8; 32], CachedResult>,
}

pub struct CachedResult {
    pub response: Vec<u8>,
    pub cached_at: Instant,
    pub ttl: Duration,
    pub original_cost_micro_usd: u64, // cost that was avoided
}

impl ResultCache {
    pub fn get(&self, key: &[u8; 32]) -> Option<CachedResult> {
        self.entries.get(key)
    }
    pub fn insert(&self, key: [u8; 32], result: CachedResult) {
        self.entries.insert(key, result);
    }
}
```

**Expected savings:** For workloads with high repetition (e.g., OCR of
the same documents, translation of common phrases), caching can reduce
spend by 50–90%.

### 8.2 Batching (Combine Multiple Requests)

Many agents support batch processing: a single RPC carries N requests,
and the per-invocation cost is paid once instead of N times. For
token-based agents, batching also reduces per-token overhead from
request framing.

```rust
pub struct BatchRequest {
    pub capability: String,
    pub items: Vec<Vec<u8>>,  // N individual request payloads
}

pub struct BatchResponse {
    pub results: Vec<Result>,
    pub total_cost_micro_usd: u64,
    pub per_item_cost_micro_usd: u64,
}
```

**Cost impact:**
- Per-invocation cost: paid once for the batch instead of N times.
  Savings = `(N - 1) * per_invocation_micro_usd`.
- Per-token cost: unchanged (total tokens are the same).
- Per-second cost: may increase (longer compute), but amortized over
  more results.

**When to batch:** Batch when `per_invocation_micro_usd` is the dominant
cost component and the items are independent. Do not batch when latency
matters (batching introduces queuing delay).

**Batch size limit:** The agent's `PerformanceProfile.max_batch_size`
advertises the maximum batch size. The caller should not exceed it.

### 8.3 Model Selection (Use Cheaper Model When Possible)

For LLM agents, the model choice dominates cost. A single agent can
expose multiple capabilities backed by different models:

- `text.summarize` → small model (cheap, fast)
- `text.codegen` → large model (expensive, high quality)
- `text.translate` → medium model (moderate cost)

Cost-aware routing naturally handles this: the per-capability
`CapabilityCostModel` reflects each capability's actual cost, and the
router selects the cheapest capability that satisfies the query.

For agents that expose a single capability with model tiers, the caller
can specify a `max_per_token_micro_usd` constraint that eliminates
expensive-model agents from the candidate set.

**Quality-cost tradeoff:** The cheapest-quality-threshold strategy
(§4.3) is the principled way to handle this: set a quality threshold
that's "good enough" and let the router find the cheapest agent above
it. This avoids overpaying for quality you don't need.

### 8.4 Connection Pooling (Reduce Handshake Overhead)

Each new QUIC connection incurs a handshake cost: ~100–200ms wall-clock
and CPU for ML-DSA-65 sign + verify + HKDF (709µs measured — see
`PERFORMANCE_SCALABILITY.md` §1.1). While this is not a *monetary* cost
charged by the agent, it is a real cost in latency and CPU that affects
throughput and thus cost-per-request for the caller.

**Connection pool:** The AAFP client maintains a pool of persistent
QUIC connections to frequently-used agents. Subsequent RPCs reuse the
existing connection, amortizing the handshake over many calls.

```rust
pub struct ConnectionPool {
    connections: HashMap<AgentId, PooledConnection>,
    max_idle: usize,
    idle_timeout: Duration,
}

struct PooledConnection {
    conn: quinn::Connection,
    last_used: Instant,
    in_flight: usize,
}
```

**Cost impact:** For an agent with `per_invocation_micro_usd: 50`, the
handshake cost (709µs CPU) is negligible compared to the per-call
charge. But for high-throughput workloads (1000+ calls/sec), connection
pooling reduces CPU cost by ~90% and enables higher RPS, which means
the caller can serve more users with the same budget.

### 8.5 Streaming (Start Processing Before Full Response)

For LLM agents, streaming responses allow the caller to begin
downstream processing (e.g., displaying tokens to the user) before the
full response is generated. This doesn't reduce the per-token cost, but
it reduces **time-to-first-token** and enables **early termination**:
if the caller detects that the response is going off-track, it can
cancel the stream and stop paying for subsequent tokens.

```rust
pub struct StreamingRpc {
    pub stream: quinn::SendStream,
    pub tokens_received: u64,
    pub cost_so_far_micro_usd: u64,
}

impl StreamingRpc {
    /// Cancel the stream. The caller stops paying for tokens
    /// not yet generated.
    pub async fn cancel(&mut self) {
        self.stream.finish().await.ok();
    }
}
```

**Cost impact:** For workloads where ~20% of responses are cancelled
mid-stream (e.g., safety filtering, relevance detection), streaming
with early cancellation reduces token costs by ~10–15%.

### 8.6 Strategy Comparison

| Strategy | Implementation Complexity | Typical Savings | Best For |
|----------|--------------------------|-----------------|----------|
| Caching | Low | 50–90% | Idempotent, repetitive workloads |
| Batching | Medium | 30–70% (per-invocation cost) | Bulk processing |
| Model selection | Low (via routing) | 50–90% (model-dependent) | Multi-tier LLM agents |
| Connection pooling | Medium | 10–20% (CPU/latency) | High-throughput callers |
| Streaming + cancel | Medium | 10–15% (token cost) | LLM with early-exit |

---

## 9. Multi-Currency Support

### 9.1 Design

`CostExtension.currency` carries an ISO 4217 currency code (default
`"USD"`). All monetary values in the extension are in **micro-units of
the stated currency**, not micro-USD. This means:

- `currency: "USD"`, `per_invocation_micro_usd: 50` → $0.00005
- `currency: "EUR"`, `per_invocation_micro_usd: 50` → €0.00005
- `currency: "JPY"`, `per_invocation_micro_usd: 50` → ¥0.00005

The field name retains `_micro_usd` for backward compatibility with v1
decoders, but the value is interpreted in the stated currency. A v2
extension may rename to `_micro_units` for clarity.

### 9.2 Supported Currencies

| Currency | Code | Micro-unit | Smallest charge |
|----------|------|-----------|-----------------|
| US Dollar | USD | micro-USD | $0.000001 |
| Euro | EUR | micro-EUR | €0.000001 |
| Japanese Yen | JPY | micro-JPY | ¥0.000001 |
| British Pound | GBP | micro-GBP | £0.000001 |
| Bitcoin | BTC | micro-BTC (satoshi/100) | 0.000001 BTC |
| Ether | ETH | micro-ETH (gwei/1000) | 0.000001 ETH |
| USDC | USDC | micro-USDC | 0.000001 USDC |

### 9.3 Cross-Currency Budget Tracking

A caller with a USD budget calling agents priced in EUR and JPY must
convert all costs to a common currency for budget tracking. The
`BudgetTracker` is parameterized by a `CurrencyConverter`:

```rust
pub trait CurrencyConverter {
    /// Convert `amount` micro-units of `from` currency to micro-units
    /// of `to` currency. Returns None if the rate is unavailable.
    fn convert(
        &self,
        amount: u64,
        from: &str,
        to: &str,
    ) -> Option<u64>;
}

pub struct FixedRateConverter {
    rates: HashMap<(String, String), u64>, // (from, to) → rate * 1_000_000
}

impl CurrencyConverter for FixedRateConverter {
    fn convert(&self, amount: u64, from: &str, to: &str) -> Option<u64> {
        if from == to { return Some(amount); }
        let rate = self.rates.get(&(from.to_string(), to.to_string()))?;
        // rate is stored as units_per_unit * 1_000_000
        Some(amount.saturating_mul(*rate) / 1_000_000)
    }
}
```

**Rate sources:**
- **Fixed rates** — hardcoded for testing or for stablecoin pairs
  (USDC/USD ≈ 1.0).
- **Oracle rates** — fetched from a price oracle (e.g., Chainlink for
  crypto, an FX API for fiat). Updated periodically.
- **On-chain rates** — for crypto-native agents, DEX prices can serve as
  oracle-free rates.

**Rate staleness:** The converter caches rates with a TTL (default 5
minutes for fiat, 1 minute for crypto). If a rate is stale or
unavailable, the budget tracker treats the cost as **unknown** and
allows the call (preferring availability over strictness). The
`CostLedger` flags unknown-currency spend for manual review.

### 9.4 Crypto Payment Considerations

For crypto-priced agents (`currency: "BTC"` or `"ETH"`):

- **Gas fees** are not included in `CostExtension` — they are a
  settlement-layer cost, not an agent pricing cost. The caller pays gas
  separately when settling the payment.
- **Price volatility** makes crypto pricing risky for both parties. The
  `updated_at` field lets callers detect stale pricing; agents should
  re-publish their `AgentRecord` when the fiat equivalent of their
  crypto price changes by more than 10%.
- **Micropayment channels** (Lightning for BTC, L2 for ETH) are the
  preferred settlement method for per-RPC charges. On-chain settlement
  is too expensive for micro-transactions.

### 9.5 Settlement

AAFP does not mandate a payment settlement mechanism. The `CostExtension`
declares the price; settlement is out-of-band. Common patterns:

1. **Prepaid balance** — caller deposits funds with the agent (or a
   payment processor) and the agent deducts per call.
2. **Micropayment channel** — caller and agent open a Lightning/L2
   channel; per-call payments are settled off-chain.
3. **Invoice** — agent invoices the caller periodically (requires trust).
4. **Zero-cost** — free tier or community-run (no settlement needed).

The protocol's responsibility ends at making pricing transparent and
verifiable. Settlement is an application-layer concern.

---

## 10. Concrete Cost Tracking Implementation

This section provides a complete, compilable implementation of
client-side cost tracking with budget enforcement, integrating
`CostExtension` (§2), `BudgetTracker` (§3), cost-aware routing (§4),
and the response receipt.

### 10.1 Module Structure

```
crates/aafp-sdk/src/
  cost/
    mod.rs              — re-exports
    budget.rs           — BudgetTracker, BudgetExceeded
    tracker.rs          — CostTracker (per-call tracking)
    receipt.rs          — CostBreakdown (server-reported actual cost)
    routing.rs          — cost_score, select_cheapest_above_threshold
    aggregator.rs       — CostAggregator, CostLedger, SpendSnapshot
    report.rs           — CostReport, BudgetAlert, AlertConfig
    cache.rs            — ResultCache (§8.1)
    currency.rs         — CurrencyConverter, FixedRateConverter
```

### 10.2 CostBreakdown (Response Receipt)

The server includes a `CostBreakdown` in every paid RPC response. This
is the authoritative actual cost, used by the caller's budget tracker
for reconciliation.

```rust
use aafp_cbor::{int_map, int_map_get, Value};

/// Server-reported cost breakdown, included in the RPC response trailer.
///
/// CBOR encoding:
/// ```cbor
/// CostBreakdown = {
///     1: uint,    // total_micro_usd (or currency unit)
///     ? 2: uint,  // invocation_micro_usd
///     ? 3: uint,  // token_micro_usd
///     ? 4: uint,  // second_micro_usd
///     5: uint,    // token_count
///     ? 6: uint,  // elapsed_seconds
///     7: tstr,    // currency
///     8: uint,    // timestamp
/// }
/// ```
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CostBreakdown {
    pub total_micro_usd: u64,
    pub invocation_micro_usd: u64,
    pub token_micro_usd: u64,
    pub second_micro_usd: u64,
    pub token_count: u64,
    pub elapsed_seconds: u64,
    pub currency: String,
    pub timestamp: u64,
}

impl CostBreakdown {
    pub fn to_cbor(&self) -> Value {
        int_map(vec![
            (1, Value::Unsigned(self.total_micro_usd)),
            (2, Value::Unsigned(self.invocation_micro_usd)),
            (3, Value::Unsigned(self.token_micro_usd)),
            (4, Value::Unsigned(self.second_micro_usd)),
            (5, Value::Unsigned(self.token_count)),
            (6, Value::Unsigned(self.elapsed_seconds)),
            (7, Value::TextString(self.currency.clone())),
            (8, Value::Unsigned(self.timestamp)),
        ])
    }

    pub fn from_cbor(val: &Value) -> Self {
        Self {
            total_micro_usd: match int_map_get(val, 1) {
                Some(Value::Unsigned(n)) => *n, _ => 0,
            },
            invocation_micro_usd: match int_map_get(val, 2) {
                Some(Value::Unsigned(n)) => *n, _ => 0,
            },
            token_micro_usd: match int_map_get(val, 3) {
                Some(Value::Unsigned(n)) => *n, _ => 0,
            },
            second_micro_usd: match int_map_get(val, 4) {
                Some(Value::Unsigned(n)) => *n, _ => 0,
            },
            token_count: match int_map_get(val, 5) {
                Some(Value::Unsigned(n)) => *n, _ => 0,
            },
            elapsed_seconds: match int_map_get(val, 6) {
                Some(Value::Unsigned(n)) => *n, _ => 0,
            },
            currency: match int_map_get(val, 7) {
                Some(Value::TextString(s)) => s.clone(), _ => "USD".into(),
            },
            timestamp: match int_map_get(val, 8) {
                Some(Value::Unsigned(n)) => *n, _ => 0,
            },
        }
    }
}
```

### 10.3 Per-Call Cost Tracker

The `CostTracker` wraps a single RPC, from pre-call estimate to
post-call reconciliation:

```rust
use aafp_identity::AgentId;
use super::budget::BudgetTracker;
use super::receipt::CostBreakdown;
use super::currency::CurrencyConverter;

/// Tracks the cost of a single RPC lifecycle.
pub struct CostTracker<'a, 'b> {
    budget: &'a BudgetTracker,
    converter: &'b dyn CurrencyConverter,
    agent_id: AgentId,
    capability: String,
    estimated_micro_usd: u64,
    estimated_currency: String,
    budget_currency: String,
    state: CallState,
}

#[derive(Debug)]
enum CallState {
    Estimated,
    InFlight,
    Reconciled { actual_micro_usd: u64 },
    Cancelled,
}

impl<'a, 'b> CostTracker<'a, 'b> {
    /// Create a tracker for an upcoming call. Returns None if the
    /// estimated cost exceeds the remaining budget.
    pub fn new(
        budget: &'a BudgetTracker,
        converter: &'b dyn CurrencyConverter,
        agent_id: AgentId,
        capability: impl Into<String>,
        estimated_micro_usd: u64,
        estimated_currency: &str,
        budget_currency: &str,
    ) -> Option<Self> {
        let est_in_budget = converter
            .convert(estimated_micro_usd, estimated_currency, budget_currency)
            .unwrap_or(estimated_micro_usd); // fallback: assume 1:1
        if !budget.check(est_in_budget) {
            return None; // budget exceeded — refuse call
        }
        Some(Self {
            budget,
            converter,
            agent_id,
            capability: capability.into(),
            estimated_micro_usd: est_in_budget,
            estimated_currency: estimated_currency.to_string(),
            budget_currency: budget_currency.to_string(),
            state: CallState::Estimated,
        })
    }

    /// Mark the call as in-flight.
    pub fn in_flight(&mut self) {
        self.state = CallState::InFlight;
    }

    /// Reconcile with the server-reported actual cost.
    /// Returns Ok(()) if within budget, Err if overcharge exceeded tolerance.
    pub fn reconcile(
        &mut self,
        breakdown: &CostBreakdown,
    ) -> Result<(), ReconcileError> {
        let actual_in_budget = self.converter
            .convert(
                breakdown.total_micro_usd,
                &breakdown.currency,
                &self.budget_currency,
            )
            .unwrap_or(breakdown.total_micro_usd);

        // Check for overcharge.
        let tolerance = self.estimated_micro_usd
            .saturating_mul(1000) / 10000; // 10%
        if actual_in_budget > self.estimated_micro_usd + tolerance {
            return Err(ReconcileError::Overcharge {
                estimated: self.estimated_micro_usd,
                actual: actual_in_budget,
            });
        }

        // Commit to budget tracker.
        self.budget.commit(
            &self.agent_id,
            &self.capability,
            actual_in_budget,
        ).map_err(|e| ReconcileError::BudgetExceeded(e))?;

        self.state = CallState::Reconciled { actual_micro_usd: actual_in_budget };
        Ok(())
    }

    /// Cancel the call (no charge).
    pub fn cancel(&mut self) {
        self.state = CallState::Cancelled;
    }

    pub fn estimated_cost(&self) -> u64 {
        self.estimated_micro_usd
    }
}

#[derive(Debug)]
pub enum ReconcileError {
    Overcharge { estimated: u64, actual: u64 },
    BudgetExceeded(super::budget::BudgetExceeded),
}
```

### 10.4 Integrated Call Flow

```rust
use aafp_identity::extensions::cost::CostExtension;
use aafp_sdk::cost::{CostTracker, CostBreakdown, BudgetTracker, FixedRateConverter};

async fn cost_aware_call(
    budget: &BudgetTracker,
    converter: &FixedRateConverter,
    agent_id: &AgentId,
    capability: &str,
    cost_ext: &CostExtension,
    estimated_tokens: u64,
    budget_currency: &str,
) -> Result<CostBreakdown, CallError> {
    // 1. Estimate cost.
    let est = cost_ext.estimate_cost(estimated_tokens)
        .unwrap_or(0);

    // 2. Budget gate — refuse if over budget.
    let mut tracker = CostTracker::new(
        budget,
        converter,
        *agent_id,
        capability,
        est,
        &cost_ext.currency,
        budget_currency,
    ).ok_or(CallError::BudgetExceeded)?;

    // 3. Check free tier.
    if cost_ext.is_free_eligible(daily_usage(agent_id)) {
        // Free call — no budget debit on success.
    }

    // 4. Make the RPC.
    tracker.in_flight();
    let response = make_rpc(agent_id, capability).await
        .map_err(|e| {
            tracker.cancel();
            CallError::Rpc(e)
        })?;

    // 5. Extract cost breakdown from response.
    let breakdown: CostBreakdown = response.cost_breakdown();

    // 6. Reconcile.
    tracker.reconcile(&breakdown)
        .map_err(CallError::Reconcile)?;

    Ok(breakdown)
}

#[derive(Debug)]
enum CallError {
    BudgetExceeded,
    Rpc(RpcError),
    Reconcile(ReconcileError),
}
```

### 10.5 Server-Side Cost Reporting

The server (agent) computes the `CostBreakdown` at the end of each RPC
and appends it to the response:

```rust
use aafp_identity::extensions::cost::CostExtension;
use aafp_sdk::cost::CostBreakdown;

fn compute_breakdown(
    cost_ext: &CostExtension,
    token_count: u64,
    elapsed_seconds: u64,
) -> CostBreakdown {
    let inv = cost_ext.per_invocation_micro_usd.unwrap_or(0);
    let tok = cost_ext.per_token_micro_usd.unwrap_or(0)
        .saturating_mul(token_count);
    let sec = cost_ext.per_second_micro_usd.unwrap_or(0)
        .saturating_mul(elapsed_seconds);
    CostBreakdown {
        total_micro_usd: inv.saturating_add(tok).saturating_add(sec),
        invocation_micro_usd: inv,
        token_micro_usd: tok,
        second_micro_usd: sec,
        token_count,
        elapsed_seconds,
        currency: cost_ext.currency.clone(),
        timestamp: now_unix(),
    }
}
```

---

## 11. Threats & Mitigations

### 11.1 Price Bait-and-Switch

**Threat:** Agent advertises a low price in `CostExtension` to win
routing, then charges a higher price in the `CostBreakdown`.

**Mitigation:** The signed `AgentRecord` binds the advertised price. The
caller's overcharge detection (§3.3) flags discrepancies > 10%. Repeated
violations lead to denylisting. The caller can also refuse to pay more
than `estimated_cost + tolerance` and dispute the charge via the
settlement layer.

### 11.2 Free-Tier Sybil Abuse

**Threat:** Attacker creates many `AgentId`s to get unlimited free calls.

**Mitigation:** Server-side rate limiting per IP, proof-of-work
challenges, reputation-gated free tiers (§7.6). The protocol makes free
tiers discoverable but does not enforce anti-abuse — that's the agent
operator's responsibility.

### 11.3 Currency Rate Manipulation

**Threat:** A malicious oracle feeds bad exchange rates, causing the
caller's budget tracker to under- or over-estimate costs.

**Mitigation:** Use multiple oracle sources and cross-check. Fall back
to conservative (higher) estimates when rates disagree. For
high-stakes budgets, use fixed rates updated manually.

### 11.4 Budget Tracker Tampering

**Threat:** A compromised client process manipulates the budget tracker
to allow overspend.

**Mitigation:** The budget tracker is in-process; if the process is
compromised, all bets are off. For high-assurance deployments, run the
budget tracker in a separate process with a narrow API (Unix socket),
so the main process cannot tamper with it.

### 11.5 Stale Pricing

**Threat:** An agent's `CostExtension` is cached by the caller, and the
agent has since raised prices. The caller routes based on stale pricing
and is overcharged.

**Mitigation:** The `updated_at` field lets callers detect staleness.
The client should re-fetch the `AgentRecord` if `updated_at` is older
than a configurable TTL (default 1 hour). The `CostBreakdown` in the
response always reflects current pricing, so the budget tracker
reconciles against the real price regardless of cache staleness.

---

## 12. Roadmap

### Phase 1: Core Cost Tracking (MVP)

- [ ] `CostExtension` encode/decode (from `ARE_E3_E4`).
- [ ] `BudgetTracker` with per-period budget and per-agent breakdown.
- [ ] `CostBreakdown` response receipt.
- [ ] Pre-call budget gate (refuse calls that exceed remaining budget).
- [ ] Post-call reconciliation with overcharge detection.

### Phase 2: Cost-Aware Routing

- [ ] `cost_score()` soft scoring component.
- [ ] `select_cheapest_above_threshold()` strategy.
- [ ] Free-tier-aware routing with `FreeTierUsage` tracker.
- [ ] Price-gouging penalty and denylist.
- [ ] Integration with `score_candidate()` from `AR_T5_T7`.

### Phase 3: Reporting & Aggregation

- [ ] `CostAggregator` (per-agent, per-capability, per-period).
- [ ] `CostLedger` with 90-day snapshot retention.
- [ ] Daily/weekly/monthly report generation.
- [ ] Budget alerts (warning + critical thresholds).
- [ ] Webhook delivery and Prometheus metrics.

### Phase 4: Optimization Strategies

- [ ] `ResultCache` with TTL and cost-avoided tracking.
- [ ] Batch request API with per-item cost breakdown.
- [ ] Streaming RPC with early cancellation.
- [ ] Connection pool integration (from `PERFORMANCE_SCALABILITY`).

### Phase 5: Multi-Currency

- [ ] `CurrencyConverter` trait + `FixedRateConverter`.
- [ ] Oracle rate fetching (FX API for fiat, Chainlink for crypto).
- [ ] Rate staleness handling in budget tracker.
- [ ] Crypto payment documentation (Lightning, L2).

### Phase 6: Advanced

- [ ] Per-capability `CapabilityCostModel` integration with routing.
- [ ] Reputation-gated free tiers (from `ARE_E3_E4` attestations).
- [ ] Budget propagation via UCAN constraints in agent chains.
- [ ] `CostExtension` v2 with subscription fields.

---

## Appendix A: Micro-USD Reference Table

| Micro-USD | USD | Typical for |
|-----------|-----|-------------|
| 1 | $0.000001 | — |
| 2 | $0.000002 | 1 token (cheap LLM) |
| 10 | $0.00001 | 1 token (premium LLM) |
| 50 | $0.00005 | 1 RPC (simple agent) |
| 500 | $0.0005 | 1 RPC (OCR, translation) |
| 5,000 | $0.005 | 1 RPC (code generation) |
| 50,000 | $0.05 | 1 RPC (complex reasoning) |
| 1,000,000 | $1.00 | 1 RPC (video generation) |

## Appendix B: Cost Extension Quick Reference

```rust
// Create a cost extension for a freemium LLM agent.
let cost = CostExtension {
    version: 1,
    per_invocation_micro_usd: Some(50),      // $0.00005/call
    per_token_micro_usd: Some(2),            // $0.000002/token
    per_second_micro_usd: None,
    has_free_tier: true,
    free_tier_daily_limit: Some(1000),       // 1000 free calls/day
    currency: "USD".into(),
    updated_at: now,
};

// Estimate cost for a 500-token call.
assert_eq!(cost.estimate_cost(500), Some(1050)); // $0.00105

// Check free tier eligibility.
assert!(cost.is_free_eligible(500));   // 500 < 1000 → free
assert!(!cost.is_free_eligible(1000)); // 1000 >= 1000 → paid
```

## Appendix C: Budget Enforcement Quick Reference

```rust
// Set a $10 monthly budget.
let budget = BudgetTracker::new(
    10_000_000, // 10 USD in micro-USD
    Duration::from_secs(30 * 86400), // 30 days
);

// Pre-call: estimate 1050 micro-USD, check budget.
let est = 1050;
assert!(budget.check(est)); // $10 >> $0.00105 → yes

// Post-call: server reports 1100 micro-USD actual.
budget.commit(&agent_id, "text.translate", 1100);
assert_eq!(budget.remaining(), 10_000_000 - 1100);

// After many calls, budget approaches zero.
// budget.check(est) returns false → router refuses call.
```
