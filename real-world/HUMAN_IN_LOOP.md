# Human-in-the-Loop Patterns for AAFP

**Author:** Devin (research synthesis)
**Date:** 2026-07-05
**Status:** Reference design — real-world integration patterns
**Depends on:** `PUBSUB_BACKCHANNEL_DESIGN.md`, `STREAMING_RPC_DESIGN.md`,
`SESSION_AFFINITY_DESIGN.md`, `SIMPLE_API_V2_DESIGN.md`, `AGENT_RECORD_EXTENSIONS.md`,
RFC-0003 (UCAN), RFC-0009 (PubSub), RFC-0006 (Extensions)

---

## Executive Summary

Autonomous agents that take real-world actions — deploying code, spending money,
sending emails, mutating production databases — cannot be fully autonomous. They
require **human-in-the-loop (HITL)** checkpoints: moments where an agent pauses,
asks a human for a decision, and either proceeds or aborts based on the answer.
AAFP's design must make these checkpoints first-class, not bolted on.

This document specifies how AAFP supports human-in-the-loop workflows using
primitives already designed in the streaming RPC and PubSub back-channeling
tracks. It covers: the approval workflow (agent requests, human decides via UI),
back-channeling for human notifications, the human-as-agent model (a human
operating a terminal agent that is a full AAFP peer), approval delegation via
UCAN, timeout handling, multi-human collaboration, UI integration surfaces (web
dashboard, Slack, email), audit trails, escalation, and a concrete code-review-
before-deploy example.

**Key conclusion:** HITL in AAFP is not a special protocol. It is a composition
of three existing primitives: (1) back-channeling for the request/notification
channel, (2) PubSub topics for the approval decision channel, and (3) UCAN
capability chains for delegation of approval authority. The human is modeled as
an AAFP agent — either directly (a human-operated terminal agent) or indirectly
(a bridge agent that forwards decisions from Slack/email/web UI into AAFP
PubSub topics). This keeps the protocol uniform: there is no "human protocol"
and "machine protocol," only agents and capabilities.

---

## 1. Why Human-in-the-Loop Is a First-Class Concern

### 1.1 The Autonomy Spectrum

Not every agent action warrants human review. The spectrum runs from
**fully autonomous** (a translation agent returning text) to **gated**
(a deploy agent that must never push to production without sign-off). AAFP
must support the full spectrum, letting each capability declare its required
level of human oversight.

| Level | Name | Example | Human role |
|-------|------|---------|------------|
| 0 | Autonomous | `translate` | None |
| 1 | Observable | `summarize` | None, but progress visible |
| 2 | Notify | `send-email` | Informed after the fact |
| 3 | Approve | `deploy`, `spend-budget` | Must approve before action |
| 4 | Co-pilot | `code-edit` | Human in the loop continuously |
| 5 | Human-operated | `manual-deploy` | Human is the agent |

Levels 0–2 need no HITL protocol — they use streaming RPC and PubSub events
already specified. Levels 3–5 are the subject of this document.

### 1.2 The Cost of Getting HITL Wrong

A HITL system that is unreliable in any of these dimensions is dangerous:

- **Lost requests:** the agent asks for approval but the human never sees it.
  The agent hangs forever, or worse, times out and proceeds anyway.
- **Spoofed approvals:** an attacker (or a buggy agent) forges an approval and
  the action executes. This is the classic "rubber-stamp" failure.
- **Unauditable decisions:** a deploy happened, but nobody can reconstruct who
  approved it, when, with what justification, or under what capability.
- **Unescalatable stalls:** the approver is on vacation and the pipeline is
  blocked for a week because there is no backup.
- **UI fragmentation:** every agent has its own approval UI, so humans juggle
  five tabs and miss requests.

AAFP's design addresses each of these explicitly (§§ 4, 7, 9, 10, 11).

### 1.3 HITL as a Composition, Not a Protocol

The central design principle: **there is no `aafp.hitl.*` RPC method family.**
HITL is assembled from primitives that exist for other reasons:

- **Back-channeling** (`PUBSUB_BACKCHANNEL_DESIGN.md` §5) carries the approval
  *request* from agent to human during a long-running RPC.
- **PubSub topics** carry the approval *decision* from human back to agent.
- **UCAN capability chains** (RFC-0003) carry the *authority* to approve.
- **Streaming RPC cancellation** (`STREAMING_RPC_DESIGN.md` §6) carries the
  *timeout/abort* signal.
- **`AgentRecord` extensions** carry the *audit record* of the decision.

This keeps the wire protocol frozen (no new frame types) and the semantics
uniform (everything is agents, capabilities, and topics).

---

## 2. The Human Approval Workflow

### 2.1 The Core Round-Trip

The fundamental HITL interaction is a four-phase round-trip:

```
Agent (server)            Human (via UI/bridge)         Agent (client/caller)
     |                            |                              |
     |  1. request_approval()    |                              |
     |  --- back-channel ------> |                              |
     |  (APPROVAL_REQUIRED)      |                              |
     |                            |                              |
     |                            |  2. human decides            |
     |                            |  (approve/deny/comment)      |
     |                            |                              |
     |  3. publish(decision)      |                              |
     |  <--- PubSub topic ------ |                              |
     |  (rpc.S.<id>.progress)     |                              |
     |                            |                              |
     |  4. resume handler         |                              |
     |  --- RPC_RESPONSE -------> |                              |
     |  (final result)            |                              |
```

The agent that needs approval is the **server** in an RPC (it was called by
some other agent to do work). The human is reached via a **bridge agent** that
subscribes to the back-channel topic and surfaces the request in a UI. The
human's decision is published back to the same topic. The server's handler,
which was `await`ing the decision, resumes and either completes the action or
returns an error.

### 2.2 The Approval Request Object

When an agent requests approval, it emits a structured event on the
back-channel topic. The payload is a CBOR map (RFC-0006 extension convention)
with a well-known schema so that any bridge agent can render it:

```rust
/// Structured approval request published on the back-channel topic.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ApprovalRequest {
    /// Unique ID for this approval (same as the RPC req_id).
    pub request_id: String,
    /// The capability being gated (e.g. "deploy.production").
    pub capability: String,
    /// Human-readable summary of the action.
    pub summary: String,
    /// Structured details (diff, cost estimate, affected resources).
    pub details: serde_json::Value,
    /// The risk level (informational; the capability's policy is authoritative).
    pub risk: RiskLevel,
    /// Timeout in seconds after which the agent will auto-fail (or auto-proceed
    /// per policy). The UI should show a countdown.
    pub timeout_secs: u64,
    /// The AgentId of the agent requesting approval (for audit).
    pub requesting_agent: AgentId,
    /// The capability chain proving the requesting agent is authorized to
    /// *ask* for this approval (UCAN attestation from a principal).
    pub request_attestation: UcanAttestation,
    /// List of approver AgentIds or roles authorized to decide.
    pub authorized_approvers: Vec<ApproverRef>,
    /// Optional deep-link URL for the UI (web dashboard, Slack deep link).
    pub deep_link: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ApproverRef {
    /// A specific agent (human-operated terminal or bridge agent).
    Agent(AgentId),
    /// A role resolved via the DHT (e.g. "oncall", "release-manager").
    Role(String),
}
```

The bridge agent renders this into whatever UI surface it owns (Slack card,
email, web dashboard row). The schema is stable so that a single bridge can
serve many different requesting agents.

### 2.3 The Approval Decision Object

The human's response is published back to the same back-channel topic as a
decision object:

```rust
/// Structured approval decision published by the human (via bridge).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalDecision {
    /// Matches the ApprovalRequest.request_id.
    pub request_id: String,
    /// The outcome.
    pub outcome: ApprovalOutcome,
    /// Free-text justification (required for denials; optional for approvals).
    pub comment: Option<String>,
    /// The AgentId of the approver (the bridge agent or human-operated agent).
    pub approver: AgentId,
    /// UCAN capability chain proving the approver is authorized.
    pub approval_attestation: UcanAttestation,
    /// Timestamp (Unix seconds) of the decision.
    pub decided_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ApprovalOutcome {
    Approved,
    Denied,
    /// Human needs more info; agent should provide it and re-request.
    NeedsInfo,
    /// Human delegates to another approver (see §7).
    Delegated { to: ApproverRef },
}
```

The requesting agent's handler verifies the attestation, checks the approver is
in `authorized_approvers`, and proceeds or aborts.

### 2.4 Handler-Side: Requesting Approval

The server handler uses the `Backchannel` handle
(`PUBSUB_BACKCHANNEL_DESIGN.md` §5.2) to request approval and then awaits the
decision on the same topic:

```rust
use aafp_sdk::simple::{Backchannel, Event};
use aafp_sdk::hitl::{ApprovalRequest, ApprovalDecision, ApprovalOutcome};
use tokio::time::{timeout, Duration};

async fn deploy_handler(
    req: Request,
    bc: Backchannel,
    cancel: CancellationToken,
) -> Result<Response, String> {
    // 1. Prepare the deploy plan.
    let plan = build_deploy_plan(&req)?;

    // 2. Emit a structured approval request on the back-channel.
    let approval = ApprovalRequest {
        request_id: bc.request_id().to_string(),
        capability: "deploy.production".into(),
        summary: format!("Deploy {} to production", plan.service),
        details: plan.to_json(),
        risk: RiskLevel::High,
        timeout_secs: 1800, // 30 minutes
        requesting_agent: bc.our_id(),
        request_attestation: bc.attestation().clone(),
        authorized_approvers: vec![
            ApproverRef::Role("release-manager".into()),
            ApproverRef::Role("oncall".into()),
        ],
        deep_link: Some(format!(
            "https://aafp.example/approvals/{}", bc.request_id()
        )),
    };
    bc.request_approval_structured(approval).await?;

    // 3. Await the decision on the back-channel topic, with a timeout.
    let decision = timeout(
        Duration::from_secs(1800),
        bc.await_decision(),
    ).await
    .map_err(|_| "approval timed out".to_string())??;

    // 4. Act on the decision.
    match decision.outcome {
        ApprovalOutcome::Approved => {
            bc.progress(90, "approved, deploying").await;
            let result = execute_deploy(plan).await?;
            Ok(Response::text(result.summary()))
        }
        ApprovalOutcome::Denied => {
            Err(format!("deploy denied by {}: {}",
                decision.approver,
                decision.comment.unwrap_or_default()))
        }
        ApprovalOutcome::NeedsInfo => {
            // Re-emit with the requested info and loop.
            Err("approval needs more info".into())
        }
        ApprovalOutcome::Delegated { to } => {
            // Update authorized approvers and re-request (see §7).
            Err(format!("approval delegated to {:?}", to))
        }
    }
}
```

`bc.await_decision()` is a convenience that filters the back-channel event
stream for an `ApprovalDecision` whose `request_id` matches. Under the hood it
is a `Stream::filter` over the PubSub subscription.

### 2.5 Why the Same Topic for Request and Decision?

A subtle design choice: the approval *request* and the approval *decision*
both flow on `rpc.<server_id>.<req_id>.progress`. This is deliberate:

- The client (caller of the RPC) is already subscribed to this topic to
  receive progress. It sees the approval request too, so it knows the agent is
  blocked waiting for a human — useful for dashboards.
- The bridge agent subscribes to a *wildcard* topic (`rpc.<server_id>.+.progress`
  or a dedicated `approvals.<server_id>.*` alias) to receive all approval
  requests for a given server. It publishes decisions back to the exact topic,
  so the server receives them without a second subscription.
- There is no second channel to secure. The back-channel topic ACL
  (`PUBSUB_BACKCHANNEL_DESIGN.md` §6.4) already restricts publish to the
  server; we extend it to also permit authorized approvers (§7.2).

An alternative would be a dedicated `approvals.<id>` topic, but that doubles
the subscription surface and the ACL machinery. Reusing the back-channel is
simpler and the security model is identical.

---

## 3. Back-Channeling for Human Notifications

### 3.1 Progress Updates to Humans

Not every human interaction is a blocking approval. Often the human just wants
to *observe* a long-running agent: "the deploy is 60% done," "tests are
passing," "rollback initiated." This is the **notify** level (§1.1, level 2).

The back-channel is the natural transport. The server publishes progress
events to `rpc.<server_id>.<req_id>.progress`, and any subscriber — including
a human-facing bridge — receives them:

```rust
async fn long_deploy_handler(
    req: Request,
    bc: Backchannel,
    cancel: CancellationToken,
) -> Result<Response, String> {
    bc.progress(10, "building artifacts").await;
    build().await?;
    bc.progress(40, "running tests").await;
    test().await?;
    bc.progress(70, "deploying to canary").await;
    deploy_canary().await?;
    bc.progress(85, "baking for 5 minutes").await;
    bake().await?;
    bc.progress(100, "deploy complete").await;
    Ok(Response::text("deployed"))
}
```

A bridge agent subscribed to the topic (or to a wildcard like
`rpc.deploy-agent.+.progress`) renders these into a Slack thread, an email
digest, or a web dashboard live-updating row. No special "notification
protocol" is needed — the bridge is just another PubSub subscriber.

### 3.2 Non-Blocking vs Blocking Notifications

Two flavors:

- **Fire-and-forget notifications** (level 2): the agent publishes to a
  general topic (`tasks.<task_id>.events`, `deploys.<service>.events`) and
  continues. Humans subscribe via a bridge. No round-trip, no waiting.
- **Blocking approval requests** (level 3): the agent publishes to the
  back-channel topic and *awaits* a decision. This is the §2 workflow.

The same `Backchannel` handle serves both: `bc.progress()` is fire-and-forget;
`bc.request_approval_structured()` + `bc.await_decision()` is blocking. The
transport (PubSub publish) is identical; the difference is whether the handler
awaits a reply.

### 3.3 Topic Conventions for Human-Facing Events

Extending `PUBSUB_BACKCHANNEL_DESIGN.md` §6.2, human-facing topics follow a
convention that bridges can wildcard-subscribe to:

| Topic pattern | Meaning | Who subscribes |
|---------------|---------|----------------|
| `rpc.<server>.<req>.progress` | Per-RPC back-channel | caller + approval bridge |
| `approvals.<server>.<req>` | Alias for approval requests | approval bridge (wildcard `approvals.<server>.*`) |
| `tasks.<task_id>.events` | Task lifecycle | observability bridge, humans |
| `deploys.<service>.events` | Deploy lifecycle | release bridge, oncall humans |
| `agents.<agent_id>.status` | Agent presence/health | dashboard bridge |

The `approvals.*` alias is optional: a bridge can subscribe to
`rpc.<server>.+.progress` and filter for `APPROVAL_REQUIRED` events. The alias
exists so a bridge dedicated to approvals doesn't have to wade through progress
noise. It is implemented as a second `publish_topic` call in
`request_approval_structured()`.

---

## 4. Human as an AAFP Agent

### 4.1 The Uniform Model

A core AAFP principle: **the human is an agent.** There is no separate "human
protocol." A human participates in the AAFP network by operating an agent —
either a terminal-based agent they drive directly, or a bridge agent that
translates UI actions into AAFP operations. Both hold an `AgentKeypair`, publish
an `AgentRecord`, advertise capabilities, and are full peers.

This has deep consequences, all positive:

- **UCAN works unchanged.** Approval authority is delegated to the human's
  AgentId via a standard UCAN attestation. No special "human delegation" type.
- **Audit works unchanged.** A human's decision is an AAFP publish event with
  `from = <human_agent_id>`, recorded like any other agent action.
- **Discovery works unchanged.** A human's agent advertises capabilities
  (`approve.deploy.production`, `review.code`) and is discoverable via the DHT.
- **Routing works unchanged.** An agent requests approval by publishing to a
  topic the human's agent subscribes to. The network routes it.

### 4.2 Human-Operated Terminal Agent

The most direct model: a human runs a terminal agent (`aafp-term`) that is a
full AAFP peer. It subscribes to approval topics, renders requests as
interactive prompts, and publishes decisions:

```rust
use aafp_sdk::simple::{Agent, Event};
use aafp_sdk::hitl::{ApprovalRequest, ApprovalDecision, ApprovalOutcome};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let agent = Agent::serve()
        .capability("approve.deploy.production")
        .capability("review.code")
        .on_publish("approvals.deploy-agent.+", |_topic, ev| async move {
            // 1. Decode the approval request.
            let req: ApprovalRequest = serde_cbor::from_slice(ev.payload())?;

            // 2. Render it to the human in the terminal.
            println!("\n=== APPROVAL REQUIRED ===");
            println!("Capability: {}", req.capability);
            println!("Summary:    {}", req.summary);
            println!("Risk:       {:?}", req.risk);
            println!("Details:    {}", serde_json::to_string_pretty(&req.details)?);
            println!("Timeout:    {}s", req.timeout_secs);
            println!("Requester:  {}", req.requesting_agent);
            println!("\nApprove? [y/n/comment]: ");

            // 3. Read the human's input.
            let mut input = String::new();
            std::io::stdin().read_line(&mut input)?;
            let (outcome, comment) = match input.trim() {
                "y" | "yes" => (ApprovalOutcome::Approved, None),
                "n" | "no"  => (ApprovalOutcome::Denied,
                                Some("denied via terminal".into())),
                other       => (ApprovalOutcome::Approved,
                                Some(other.into())),
            };

            // 4. Publish the decision back to the request topic.
            let decision = ApprovalDecision {
                request_id: req.request_id,
                outcome,
                comment,
                approver: our_agent_id(),
                approval_attestation: our_attestation().clone(),
                decided_at: now(),
            };
            agent.publish(
                &format!("rpc.deploy-agent.{}.progress", req.request_id),
                Event::data(serde_cbor::to_vec(&decision)?),
            ).await?;

            Ok(())
        })
        .start().await?;

    Ok(())
}
```

This is the "human is the agent" model in its purest form. The human's terminal
*is* the UI. It is appropriate for engineers and power users.

### 4.3 Bridge Agent Model

For non-terminal humans (managers, oncall who prefer Slack, reviewers who
prefer email), a **bridge agent** translates between a UI surface and AAFP.
The bridge holds the AgentId and UCAN authority; the human interacts with the
UI (Slack button, email reply, web form); the bridge publishes the decision
into AAFP on the human's behalf.

```
[Requesting agent] --back-channel--> [Bridge agent] --Slack API--> [Human]
[Requesting agent] <--PubSub decision-- [Bridge agent] <--Slack API-- [Human]
```

The bridge is an AAFP agent like any other. It advertises
`approve.*` capabilities (or specific ones) and subscribes to approval topics.
The human never touches AAFP directly; the bridge is their proxy.

The security implication: the bridge holds the human's UCAN authority. This is
acceptable if the bridge is trusted and the human authenticated to the bridge
(Slack login, SSO for the web dashboard). For higher assurance, the human can
hold their own AgentId and the bridge merely forwards (§4.4).

### 4.4 Proxy vs Owned Identity

Two identity models for bridge-mediated humans:

- **Proxy identity:** the bridge holds a single AgentId and UCAN authority for
  many humans. The `approver` field in `ApprovalDecision` is the bridge's
  AgentId, with a `comment` noting which human. Simpler, lower assurance.
- **Owned identity:** each human has their own AgentId (held in a hardware key
  or a secrets manager the bridge accesses per-user). The bridge publishes
  decisions signed under the human's AgentId. Higher assurance, the audit
  trail names the actual human.

Owned identity is preferred for regulated environments (SOX, HIPAA) where the
audit trail must name the human, not a service. The bridge then acts as a
*signing oracle*: it never holds the key long-term; it requests a per-decision
signature from the human's key store (e.g., a WebAuthn flow).

---

## 5. Approval Delegation via UCAN

### 5.1 The Problem

An approver is authorized to approve deploys. They go on vacation. Without
delegation, either (a) deploys block for a week, or (b) someone shares the
approver's key (catastrophic). AAFP solves this with UCAN capability
delegation (RFC-0003).

### 5.2 UCAN Capability for Approval

An approval capability is a UCAN attestation of the form:

```
approve/<capability>/<scope>
```

Examples:

- `approve/deploy.production/*` — approve any production deploy.
- `approve/deploy.production/service-payments` — approve deploys of one service.
- `approve/spend.budget/quarterly-up-to-10k` — approve spending up to $10k/quarter.

The capability is signed by a principal (the root authority, e.g., an org admin
agent) and delegated down a chain. The requesting agent verifies the chain
(RFC-0003 §4) when it receives an `ApprovalDecision`.

### 5.3 Delegation Flow

```
Org Admin (root)
  |
  |  attestation: approve/deploy.production/*  ->  Alice
  v
Alice (release manager)
  |
  |  delegation: approve/deploy.production/*  ->  Bob  (with caveat: "while I'm on PTO")
  v
Bob (backup approver)
  |
  |  ApprovalDecision { approver: Bob, attestation: <chain: Admin->Alice->Bob> }
  v
Requesting agent verifies chain: Admin -> Alice -> Bob. Valid. Proceeds.
```

The delegation is a standard UCAN delegation: Alice signs a new attestation
transferring (a subset of) her capability to Bob, with optional caveats
(time-bound, scope-bound). Bob's `ApprovalDecision` includes the full chain.
The requesting agent validates:

1. The root attestation is signed by a recognized principal.
2. Each link in the chain is validly signed by the previous holder.
3. The caveats are satisfied (e.g., the time bound hasn't expired).
4. The final holder is the `approver` named in the decision.

### 5.4 Delegation via the Decision Object

Delegation can happen *inside* an approval flow via the `Delegated` outcome
(§2.3). An approver who cannot decide can delegate rather than deny:

```rust
ApprovalDecision {
    request_id: req_id,
    outcome: ApprovalOutcome::Delegated {
        to: ApproverRef::Agent(bob_agent_id),
    },
    comment: Some("I'm on PTO, Bob is covering".into()),
    approver: alice_agent_id,
    approval_attestation: alice_chain,
    decided_at: now(),
}
```

The requesting agent's handler, on receiving a `Delegated` outcome, re-requests
approval with `authorized_approvers` updated to `[Bob]` and the delegation
chain attached. Bob then decides with his own chain (Alice -> Bob). This is
the **escalation** pattern (§10) expressed via the decision object.

### 5.5 Time-Bound and Scope-Bound Delegation

UCAN caveats make delegation safe:

- **Time-bound:** `valid_until: 2026-07-10T00:00:00Z` — Bob's authority expires
  when Alice returns from PTO. The requesting agent rejects decisions after
  this time.
- **Scope-bound:** `scope: deploy.production/service-payments` — Bob can only
  approve one service, not all production deploys.
- **Quota-bound:** `max_uses: 5` — Bob can approve at most 5 deploys. The
  requesting agent tracks a counter (or the attestation includes a nonce list).

These caveats are enforced by the requesting agent at verification time. They
are part of the UCAN chain, not a separate HITL mechanism.

### 5.6 Revocation

If Alice returns early and wants to revoke Bob's authority, she publishes a
revocation to a well-known topic (`ucan.revocations.<alice_agent_id>`). The
requesting agent subscribes (or polls) and invalidates Bob's chain upon seeing
the revocation. Revocation is eventual-consistency: a decision made seconds
before the revocation arrives is still valid (the audit trail records it).
For instant revocation, the requesting agent can require an online check
against a revocation topic before proceeding — at the cost of a dependency on
the network.

---

## 6. Timeout Handling

### 6.1 The Stall Problem

A requesting agent asks for approval and waits. The human is at lunch, the
bridge is down, the Slack channel is muted. The agent waits forever. This is
unacceptable for two reasons:

1. The RPC caller is blocked, holding resources (a QUIC bi-stream, a handler
   task, possibly a database transaction).
2. The action may be time-sensitive (a deploy window, an incident response).

### 6.2 Timeout in the Approval Request

Every `ApprovalRequest` carries a `timeout_secs` (§2.2). The handler enforces
it via `tokio::time::timeout` (§2.4). On timeout, the handler's behavior is
governed by the **timeout policy** attached to the capability, not by the
agent's whim.

### 6.3 Timeout Policies

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TimeoutPolicy {
    /// Fail the RPC with an error. Default for high-risk capabilities.
    Fail,
    /// Proceed with the action, recording that approval was not obtained.
    /// Only for low-risk, reversible actions. Requires a fallback attestation.
    AutoApprove { fallback_attestation: UcanAttestation },
    /// Escalate to a backup approver (see §10). Re-request with a longer timeout.
    Escalate { backup: ApproverRef, extended_timeout_secs: u64 },
    /// Cancel the action and notify the caller + a monitoring topic.
    Cancel { notify_topic: String },
}
```

The policy is declared in the capability's `AgentRecord` extension
(`AGENT_RECORD_EXTENSIONS.md`) or in a policy document the agent loads at
startup. It is *not* chosen per-request by the handler — that would let a
compromised agent bypass approval by setting `AutoApprove`.

| Capability risk | Default policy |
|-----------------|----------------|
| Critical (prod deploy, large spend) | `Fail` |
| High (canary deploy, small spend) | `Escalate` |
| Medium (merge to main, send email batch) | `Escalate` |
| Low (merge to feature branch) | `AutoApprove` with fallback |

### 6.4 Implementing the Timeout

```rust
async fn deploy_handler(
    req: Request,
    bc: Backchannel,
    cancel: CancellationToken,
) -> Result<Response, String> {
    let policy = load_timeout_policy("deploy.production")?; // from AgentRecord ext
    let approval = build_approval_request(&req, &bc, policy.timeout_secs());
    bc.request_approval_structured(approval).await?;

    let result = timeout(
        Duration::from_secs(policy.timeout_secs()),
        bc.await_decision(),
    ).await;

    match result {
        Ok(Ok(decision)) => handle_decision(decision, &bc).await,
        Ok(Err(e)) => Err(format!("approval stream error: {e}")),
        Err(_elapsed) => {
            // Timeout. Apply policy.
            bc.progress(0, "APPROVAL_TIMEOUT").await;
            match policy {
                TimeoutPolicy::Fail => {
                    Err("approval timed out; deploy aborted".into())
                }
                TimeoutPolicy::AutoApprove { fallback_attestation } => {
                    bc.progress(50, "auto-approved by timeout policy").await;
                    let result = execute_deploy(plan).await?;
                    Ok(Response::text(result.summary()))
                }
                TimeoutPolicy::Escalate { backup, extended_timeout_secs } => {
                    bc.progress(10, &format!("escalating to {:?}", backup)).await;
                    // Re-request with backup approver and extended timeout.
                    escalate_to(backup, extended_timeout_secs, &bc).await
                }
                TimeoutPolicy::Cancel { notify_topic } => {
                    bc.publish_topic(&notify_topic,
                        Event::text("deploy cancelled: approval timeout")).await;
                    Err("deploy cancelled by timeout policy".into())
                }
            }
        }
    }
}
```

### 6.5 Heartbeats During the Wait

While awaiting a decision, the handler should emit periodic heartbeats so the
caller and observers know it is alive (not crashed):

```rust
// Spawn a heartbeat alongside the await.
let hb_bc = bc.clone();
let hb_task = tokio::spawn(async move {
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        hb_bc.progress(/* same pct */, "awaiting approval").await;
    }
});
let decision = bc.await_decision().await?;
hb_task.abort();
```

Without heartbeats, a 30-minute approval wait looks identical to a hung agent.
The back-channel makes heartbeats cheap (a PubSub publish).

---

## 7. Multi-Human Collaboration

### 7.1 The Problem

Some actions require *multiple* humans to agree: a production deploy needs
both the release manager and the oncall SRE; a large spend needs both the
team lead and finance; a schema migration needs two reviewers. AAFP must
support **quorum approvals**: N-of-M approvers must agree before the action
proceeds.

### 7.2 Quorum in the Approval Request

The `ApprovalRequest` is extended with a quorum spec:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequest {
    // ... fields from §2.2 ...
    /// If present, requires multiple approvers.
    pub quorum: Option<QuorumSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuorumSpec {
    /// The approvers who must participate.
    pub approvers: Vec<ApproverRef>,
    /// How many must approve (N of M).
    pub required: usize,
    /// Whether a single denial rejects the whole request.
    pub deny_vetoes: bool,
    /// Whether approvals must be simultaneous or can be collected over time.
    pub window_secs: u64,
}
```

### 7.3 Collecting Multiple Decisions

The handler awaits *multiple* decisions on the back-channel topic, filtering
by `approver`:

```rust
async fn quorum_deploy_handler(
    req: Request,
    bc: Backchannel,
    cancel: CancellationToken,
) -> Result<Response, String> {
    let approval = build_quorum_approval(&req, &bc);
    bc.request_approval_structured(approval).await?;

    let quorum = approval.quorum.unwrap();
    let mut approvals = 0usize;
    let mut denials = 0usize;
    let mut seen = HashSet::new();

    let deadline = Instant::now() + Duration::from_secs(quorum.window_secs);
    while Instant::now() < deadline {
        let remaining = deadline - Instant::now();
        let decision = match timeout(remaining, bc.await_decision()).await {
            Ok(Ok(d)) => d,
            _ => break,
        };
        if !seen.insert(decision.approver) { continue; } // dedupe
        match decision.outcome {
            ApprovalOutcome::Approved => approvals += 1,
            ApprovalOutcome::Denied => {
                denials += 1;
                if quorum.deny_vetoes {
                    return Err("deploy denied (veto)".into());
                }
            }
            _ => {}
        }
        if approvals >= quorum.required {
            bc.progress(90, "quorum reached").await;
            return execute_deploy(plan).await.map(Response::text);
        }
    }
    Err(format!("quorum not reached: {approvals}/{} approved", quorum.required))
}
```

### 7.4 Parallel vs Sequential Review

Two collaboration modes:

- **Parallel:** all approvers receive the request simultaneously (the bridge
  fans out to all `authorized_approvers`). Faster, used when approvers are
  independent.
- **Sequential (chain of custody):** approver A reviews, then forwards to
  approver B with their endorsement. Used when B trusts A's review and only
  sanity-checks (e.g., code review -> QA -> deploy).

Sequential is modeled as a series of `Delegated` outcomes: A approves-and-
delegates-to-B, B approves-and-delegates-to-C, C approves (final). The
requesting agent tracks the chain and proceeds when the last approver
approves. Each delegation is a UCAN chain extension, so the final decision
carries the full endorsement chain in its attestation.

### 7.5 Concurrent Edits and Race Conditions

If multiple humans can *modify* the action (not just approve/deny), race
conditions arise (human A edits the deploy manifest while human B approves
the old version). AAFP's model sidesteps this: the `ApprovalRequest` is
immutable once published. If a human wants to change the action, they
`Deny` with a comment, and the requesting agent re-requests with the modified
plan. This keeps the approval object content-addressed and the audit trail
unambiguous.

---

## 8. UI Integration: How Humans See AAFP Requests

### 8.1 The Three Surfaces

Humans interact with AAFP approval requests through three primary surfaces:

1. **Web dashboard** — a dedicated AAFP console showing all pending approvals,
   their status, history, and a decision UI. Best for dedicated approvers
   (release managers, finance ops).
2. **Slack (or chat)** — approval requests delivered as interactive messages
   (cards with Approve/Deny buttons) in a channel or DM. Best for oncall and
   team-adjacent approvers who live in chat.
3. **Email** — approval requests as emails with deep links back to the web
   dashboard (or reply-to-approve for low-risk). Best for asynchronous,
   cross-timezone, or executive approvers.

All three are **bridge agents** in AAFP terms (§4.3). They subscribe to
approval topics, render requests, and publish decisions. The requesting agent
is unaware which surface the human used.

### 8.2 Web Dashboard Bridge

The web dashboard is a bridge agent that:

- Subscribes to `approvals.+.+` (wildcard, all approval requests in the org).
- Stores pending requests in a database (for listing, filtering, history).
- Renders a UI (React/Vue) showing the request details, risk, approvers,
  countdown timer, and Approve/Deny/Comment buttons.
- On a button click, constructs an `ApprovalDecision`, signs it with the
  human's AgentId (via WebAuthn or server-held key), and publishes to the
  request's back-channel topic.

```rust
// Web dashboard bridge (simplified)
Agent::serve()
    .capability("bridge.web-dashboard")
    .on_publish_wildcard("approvals.+.+", |_topic, ev| async move {
        let req: ApprovalRequest = serde_cbor::from_slice(ev.payload())?;
        db.insert_pending_approval(&req).await?;
        // The frontend polls the DB or receives a WebSocket push.
        Ok(())
    })
    .handler("submit-decision", |req: Request| async move {
        let decision: ApprovalDecision = serde_cbor::from_slice(req.body())?;
        // Verify the human authenticated to the dashboard (SSO session).
        verify_session(&req)?;
        // Publish the decision to the original back-channel topic.
        agent.publish(
            &format!("rpc.{}.{}.progress",
                decision.requesting_agent, decision.request_id),
            Event::data(serde_cbor::to_vec(&decision)?),
        ).await?;
        db.record_decision(&decision).await?;
        Ok(Response::text("recorded"))
    })
    .start().await?;
```

### 8.3 Deep Links

Every `ApprovalRequest` carries an optional `deep_link` (§2.2) — a URL that
opens the request directly in the web dashboard:

```
https://aafp.example/approvals/req_01H8XK...
```

This is embedded in Slack cards and emails so a human can click through to the
full-context view (diff, cost breakdown, affected resources) even if the
notification surface (Slack/email) only shows a summary.

### 8.4 Mobile / Push

A mobile app is a fourth surface, implemented as another bridge agent that
subscribes to approval topics and sends push notifications (APNs/FCM). The
decision flow is identical to the web dashboard. The deep link opens the
mobile app or falls back to the web URL.

---

## 9. Slack Integration

### 9.1 Slack as a Bridge Agent

The Slack bridge is an AAFP agent that:

1. Subscribes to approval topics (e.g., `approvals.deploy-agent.+`).
2. On each `ApprovalRequest`, posts a Slack message with interactive buttons
   to a configured channel (e.g., `#deploys`) or DMs the oncall.
3. Listens for Slack interactive payloads (button clicks) via Slack's Events
   API or a webhook.
4. On a button click, constructs an `ApprovalDecision`, signs it, and
   publishes to the back-channel topic.

### 9.2 The Slack Card

The bridge renders the `ApprovalRequest` as a Slack Block Kit message:

```json
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "Approval required: deploy.production" }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Service:*\npayments-api" },
        { "type": "mrkdwn", "text": "*Risk:*\nHigh" },
        { "type": "mrkdwn", "text": "*Requester:*\ndeploy-agent-01" },
        { "type": "mrkdwn", "text": "*Timeout:*\n29:42 remaining" }
      ]
    },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*Summary:*\nDeploy payments-api v2.3.1 to production (3 commits, 1 migration)" }
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Approve" },
          "style": "primary",
          "value": "approve:req_01H8XK...",
          "action_id": "approve"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Deny" },
          "style": "danger",
          "value": "deny:req_01H8XK...",
          "action_id": "deny"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "View details" },
          "url": "https://aafp.example/approvals/req_01H8XK..."
        }
      ]
    }
  ]
}
```

The `value` encodes the decision and `request_id` so the bridge can construct
the `ApprovalDecision` when the button is clicked.

### 9.3 Handling the Button Click

```rust
// Slack bridge: handle interactive payload
async fn handle_slack_action(payload: SlackActionPayload) -> Result<(), Error> {
    let (action, req_id) = parse_button_value(&payload.actions[0].value)?;
    let human = resolve_slack_user_to_agent(&payload.user.id)?;
    let decision = ApprovalDecision {
        request_id: req_id,
        outcome: match action {
            "approve" => ApprovalOutcome::Approved,
            "deny"    => ApprovalOutcome::Denied,
            _ => return Err("unknown action".into()),
        },
        comment: Some(format!("via Slack by {}", payload.user.name)),
        approver: human.agent_id,
        approval_attestation: human.attestation_chain,
        decided_at: now(),
    };
    // Publish to the back-channel topic.
    agent.publish(
        &format!("rpc.{}.{}.progress", decision.requesting_agent, req_id),
        Event::data(serde_cbor::to_vec(&decision)?),
    ).await?;
    // Update the Slack message to show the decision.
    slack.update_message(&payload.message.ts, &rendered_decision(&decision)).await?;
    Ok(())
}
```

### 9.4 Channel Routing

The bridge routes requests to channels based on the capability and risk:

| Capability | Channel | Mentions |
|------------|---------|----------|
| `deploy.production` | `#deploys` | `@oncall` |
| `spend.budget` | `#finance-approvals` | `@finance-ops` |
| `review.code` (critical path) | `#code-reviews` | `@codeowners` |
| `deploy.staging` | (none — auto-approved) | — |

Routing rules are configured in the bridge agent's config, not in the protocol.
This keeps AAFP unaware of Slack specifics.

### 9.5 Slack-Specific Considerations

- **Authentication:** the bridge maps Slack users to AAFP AgentIds via a
  provisioning table (Slack user `U123` -> AgentId `alice`). For owned
  identity (§4.4), the bridge triggers a WebAuthn flow on first use.
- **Rate limits:** Slack's API has rate limits. The bridge batches or queues
  posts during bursts (e.g., 10 deploys at once).
- **Timeout display:** the bridge updates the card's countdown periodically
  (every 30s) via `chat.update`. On timeout, it marks the card as "expired."
- **Threaded discussion:** approvers can reply in the Slack thread; the bridge
  optionally publishes these as `comment` events on the back-channel so the
  requesting agent and other subscribers see the discussion.

---

## 10. Email Integration

### 10.1 Email as a Bridge Agent

The email bridge is an AAFP agent that:

1. Subscribes to approval topics.
2. On each `ApprovalRequest`, sends an email to the configured approver(s).
3. The email contains a summary and a **deep link** to the web dashboard
   (where the actual Approve/Deny buttons live, since email clients can't
   reliably do interactive POSTs).
4. Optionally supports **reply-to-approve** for low-risk actions: the human
  replies with "APPROVE" in the body, and a mail-processing agent parses it
  and publishes the decision.

### 10.2 The Email Body

```
Subject: [Approval required] Deploy payments-api v2.3.1 to production

An AAFP agent is requesting your approval:

  Capability: deploy.production
  Service:    payments-api
  Version:    v2.3.1
  Risk:       High
  Requester:  deploy-agent-01
  Timeout:    30 minutes (expires 2026-07-05T14:30Z)

Summary:
  Deploy payments-api v2.3.1 to production (3 commits, 1 migration).

Changes:
  - feat: add refund endpoint (abc123)
  - fix: handle null customer (def456)
  - chore: bump deps (ghi789)

Migration:
  - 20260705_add_refund_column.sql (non-breaking)

To approve or deny, open:
  https://aafp.example/approvals/req_01H8XK...

--
AAFP approval system | do not reply to this email
```

The deep link is the primary action path. Reply-to-approve is a secondary,
convenience path for low-risk items, gated by a per-approver setting.

### 10.3 Reply-to-Approve (Low Assurance)

For low-risk approvals, the email bridge can generate a per-request
reply-to address encoding the request ID and a token:

```
Reply-To: approve+req_01H8XK...+token_9f2a@auto.aafp.example
```

When the human replies, the mail-processing agent:

1. Verifies the reply came from the approver's registered email (SPF/DKIM).
2. Verifies the token matches the request.
3. Parses the body for "APPROVE" or "DENY".
4. Publishes the `ApprovalDecision`.

This is **low assurance** (email can be spoofed despite SPF/DKIM, and the
token is in the reply-to header which forwards with the email). It is only
enabled for capabilities with `TimeoutPolicy::AutoApprove` or lower risk.
High-risk approvals always require the web dashboard (with SSO + WebAuthn).

### 10.4 Email-Specific Considerations

- **Asynchrony:** email is inherently async. The 30-minute timeout may expire
  before the human reads the email. The bridge should send a "request
  expired" follow-up if the timeout fires, to avoid late approvals.
- **Threading:** use the `In-Reply-To`/`References` headers so approvals
  thread in the human's mail client.
- **Digest mode:** for high-volume environments, the bridge can batch
  pending approvals into a daily digest email rather than per-request.
- **Cross-timezone:** email is ideal for approvers in distant timezones who
  won't see Slack in time. The deep link lets them act when they wake up,
  though the request may have timed out — the dashboard shows the expired
  state and offers a "re-request" button.

---

## 11. Audit Trail

### 11.1 Why Audit Is Non-Negotiable

Every human decision in a HITL flow must be reconstructable after the fact:
who approved, when, what capability, what action, what was the justification,
what was the UCAN chain. This is required for:

- **Compliance** (SOX, HIPAA, SOC 2, PCI): regulators demand an audit trail
  for any action affecting financials, patient data, or cardholder data.
- **Incident postmortems:** when a deploy breaks production, the first
  question is "who approved this and why?"
- **Trust:** humans are more willing to use an approval system they can
  verify after the fact.

### 11.2 The Audit Event

Every approval request and decision is recorded as an immutable audit event.
The audit log is a PubSub topic (`audit.<org>.approvals`) that a dedicated
audit agent subscribes to and writes to an append-only store (a log-structured
database, S3 with object lock, or a blockchain for high-assurance):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    /// Monotonic sequence number (per-org).
    pub seq: u64,
    /// Timestamp (Unix nanos).
    pub timestamp: u64,
    /// The event type.
    pub event: AuditEventType,
    /// The request ID (correlates request + decision).
    pub request_id: String,
    /// The capability being gated.
    pub capability: String,
    /// The requesting agent.
    pub requesting_agent: AgentId,
    /// The approver (for decision events).
    pub approver: Option<AgentId>,
    /// The outcome (for decision events).
    pub outcome: Option<ApprovalOutcome>,
    /// The full UCAN chain at decision time.
    pub attestation_chain: Option<Vec<UcanAttestation>>,
    /// The human-readable comment.
    pub comment: Option<String>,
    /// Hash of the previous audit event (tamper-evidence chain).
    pub prev_hash: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuditEventType {
    ApprovalRequested,
    ApprovalDecided,
    ApprovalDelegated,
    ApprovalEscalated,
    ApprovalTimeout,
    ActionExecuted,
    ActionRolledBack,
}
```

### 11.3 Recording at Each Stage

The requesting agent publishes audit events at each transition:

```rust
// On requesting approval:
audit.publish(AuditEvent {
    event: AuditEventType::ApprovalRequested,
    request_id: req_id.clone(),
    capability: "deploy.production".into(),
    requesting_agent: bc.our_id(),
    ...
}).await?;

// On receiving a decision:
audit.publish(AuditEvent {
    event: AuditEventType::ApprovalDecided,
    request_id: req_id.clone(),
    approver: Some(decision.approver),
    outcome: Some(decision.outcome.clone()),
    attestation_chain: Some(decision.chain()),
    comment: decision.comment.clone(),
    ...
}).await?;

// On executing the action:
audit.publish(AuditEvent {
    event: AuditEventType::ActionExecuted,
    request_id: req_id.clone(),
    ...
}).await?;
```

### 11.4 Tamper-Evidence

Each audit event includes `prev_hash` — the SHA-256 of the previous event's
CBOR encoding. This forms a hash chain (like a blockchain's block linkage,
without the consensus). Any tampering with a historical event breaks the chain
and is detectable by recomputation. For full tamper-resistance, the audit
agent periodically publishes the latest hash to an external notarization
service (e.g., a public blockchain, or a Merkle root to a transparency log
like Certificate Transparency).

### 11.5 Querying the Audit Trail

The audit agent exposes a query capability (`audit.query`) that lets
authorized humans and agents search the trail:

```rust
// Query all approvals by Alice in the last 30 days
let events = agent.call("audit.query", AuditQuery {
    approver: Some(alice_agent_id),
    since: now() - 30 * 86400,
    capability: Some("deploy.production".into()),
}).await?;
```

This powers the web dashboard's "approval history" view and compliance reports.

### 11.6 Retention

Audit events are retained per policy (often 7 years for SOX). The audit store
is append-only; events are never deleted, only aged out to cold storage after
the retention period. The hash chain is preserved across the age-out by
keeping the `prev_hash` of the first event in cold storage linked to the last
event in hot storage.

---

## 12. Escalation

### 12.1 The Unavailable Approver Problem

The primary approver is unavailable (PTO, sick, asleep, offline). Without
escalation, the request times out and fails (§6). Escalation redirects the
request to a backup approver before the timeout fires.

### 12.2 Escalation Triggers

Escalation is triggered by:

1. **Explicit delegation:** the primary approver responds with
   `ApprovalOutcome::Delegated { to: backup }` (§5.4). Immediate.
2. **Timeout with `Escalate` policy:** the timeout fires and the policy says
   escalate (§6.3). The handler re-requests with the backup approver.
3. **Pre-emptive escalation:** the bridge detects the primary approver is
   offline (no presence on `agents.<primary>.status` topic for N minutes) and
   proactively routes to the backup without waiting for timeout.

### 12.3 The Escalation Chain

An `ApprovalRequest` can carry an ordered escalation chain:

```rust
pub struct ApprovalRequest {
    // ...
    pub escalation_chain: Vec<EscalationStep>,
}

pub struct EscalationStep {
    pub approver: ApproverRef,
    /// Wait this long before escalating to the next step.
    pub wait_secs: u64,
}
```

Example:

```rust
escalation_chain: vec![
    EscalationStep { approver: ApproverRef::Role("release-manager".into()), wait_secs: 900 },
    EscalationStep { approver: ApproverRef::Role("oncall".into()),           wait_secs: 900 },
    EscalationStep { approver: ApproverRef::Agent(vp_agent_id),              wait_secs: 0 },
]
```

The handler tries the first approver. If no decision in 15 minutes, it
escalates to oncall. If oncall doesn't respond in 15 minutes, it escalates to
the VP. Each escalation is recorded as an `AuditEventType::ApprovalEscalated`
event.

### 12.4 Implementing Escalation

```rust
async fn escalate_handler(
    req: Request,
    bc: Backchannel,
    cancel: CancellationToken,
) -> Result<Response, String> {
    let approval = build_approval(&req, &bc);
    for (i, step) in approval.escalation_chain.iter().enumerate() {
        let mut step_approval = approval.clone();
        step_approval.authorized_approvers = vec![step.approver.clone()];
        step_approval.timeout_secs = step.wait_secs;
        bc.request_approval_structured(step_approval).await?;

        audit.publish(AuditEvent {
            event: if i == 0 { AuditEventType::ApprovalRequested }
                   else { AuditEventType::ApprovalEscalated },
            ...
        }).await?;

        match timeout(
            Duration::from_secs(step.wait_secs),
            bc.await_decision(),
        ).await {
            Ok(Ok(decision)) => return handle_decision(decision, &bc).await,
            Ok(Err(e)) => return Err(e),
            Err(_) => continue, // escalate to next step
        }
    }
    Err("all escalation steps exhausted".into())
}
```

### 12.5 Notifying the Original Approver

When escalation occurs, the original approver should be notified (so they
know they missed a request and can improve their responsiveness). The handler
publishes a notification to `agents.<original_approver>.inbox`:

```rust
bc.publish_topic(
    &format!("agents.{}.inbox", original_approver),
    Event::text(format!(
        "Approval {} was escalated to {} after you didn't respond in {}s",
        req_id, backup, wait_secs
    )),
).await?;
```

This is a courtesy, not a security mechanism. The audit trail records the
escalation regardless.

---

## 13. Concrete Example: Code Review Agent Before Deploy

### 13.1 Scenario

A code review agent (`review-agent`) is triggered when a PR is opened against
`main`. It runs static analysis, checks test coverage, and — if all checks
pass — requests human approval to merge and deploy. The deploy is gated: the
merge requires a codeowner's approval; the production deploy requires both
the codeowner and the oncall SRE (quorum). If the codeowner doesn't respond
in 2 hours, the request escalates to the backup codeowner. The whole flow is
audited, and notifications go to Slack (`#code-reviews`) and email (the
codeowner's registered address).

### 13.2 The Agents

- `review-agent` — advertises `review.code` and `merge.pr`. Runs checks,
  requests approval, merges, and triggers deploy.
- `deploy-agent` — advertises `deploy.production`. Receives the deploy
  request from `review-agent` after merge, requests its own approval, deploys.
- `slack-bridge` — subscribes to approval topics, posts to Slack.
- `email-bridge` — subscribes to approval topics, sends emails.
- `audit-agent` — subscribes to `audit.org.approvals`, writes the audit log.
- `alice-terminal` — Alice's human-operated terminal agent, advertises
  `approve.merge.main` and `approve.deploy.production`.
- `bob-terminal` — Bob's terminal agent, backup codeowner.

### 13.3 The Flow

```
PR opened ──> review-agent runs checks ──> checks pass
  |
  v
review-agent: request_approval(merge.main, approvers=[codeowner], timeout=2h, escalate=[backup-codeowner])
  |
  ├──> slack-bridge posts to #code-reviews (@alice)
  ├──> email-bridge emails alice@example.com
  |
  v
Alice sees Slack card, clicks "Approve" (with comment "lgtm, migration looks safe")
  |
  v
slack-bridge publishes ApprovalDecision{Approved, approver=alice-terminal} to rpc.review-agent.<id>.progress
  |
  v
review-agent receives decision, verifies UCAN chain (org-admin -> alice), merges PR
  |
  v
review-agent calls deploy-agent.call_with_backchannel("deploy.production", {service: payments-api, version: v2.3.1})
  |
  v
deploy-agent: request_approval(deploy.production, quorum={approvers:[codeowner, oncall], required:2}, timeout=30m)
  |
  ├──> slack-bridge posts to #deploys (@alice, @oncall)
  |
  v
Alice approves (already reviewed the code). Oncall (Charlie) approves after checking canary.
  |
  v
deploy-agent receives 2 approvals (quorum reached), executes deploy
  |
  v
deploy-agent publishes progress (canary -> bake -> full rollout) on back-channel
  |
  v
deploy-agent returns RPC_RESPONSE(success) to review-agent
  |
  v
review-agent returns success to the PR trigger, posts "Deployed v2.3.1" on the PR
```

### 13.4 The Review Agent Handler

```rust
async fn review_and_merge_handler(
    req: Request,
    bc: Backchannel,
    cancel: CancellationToken,
) -> Result<Response, String> {
    let pr = parse_pr(&req)?;
    bc.progress(10, "running static analysis").await;
    let analysis = run_static_analysis(&pr).await?;
    bc.progress(30, "checking test coverage").await;
    let coverage = check_coverage(&pr).await?;
    if !analysis.passed || !coverage.passed {
        return Err("checks failed; not requesting approval".into());
    }
    bc.progress(50, "checks passed, requesting merge approval").await;

    // Request merge approval with escalation.
    let approval = ApprovalRequest {
        request_id: bc.request_id().to_string(),
        capability: "merge.main".into(),
        summary: format!("Merge PR #{}: {}", pr.number, pr.title),
        details: serde_json::json!({
            "analysis": analysis,
            "coverage": coverage,
            "diff_url": pr.diff_url,
        }),
        risk: RiskLevel::Medium,
        timeout_secs: 7200, // 2 hours
        requesting_agent: bc.our_id(),
        request_attestation: bc.attestation().clone(),
        authorized_approvers: vec![ApproverRef::Role("codeowner".into())],
        escalation_chain: vec![
            EscalationStep { approver: ApproverRef::Role("codeowner".into()), wait_secs: 7200 },
            EscalationStep { approver: ApproverRef::Agent(bob_agent_id), wait_secs: 3600 },
        ],
        quorum: None,
        deep_link: Some(format!("https://aafp.example/approvals/{}", bc.request_id())),
    };
    bc.request_approval_structured(approval.clone()).await?;
    audit.record(AuditEventType::ApprovalRequested, &approval).await?;

    let decision = await_with_escalation(&bc, &approval, &cancel).await?;
    match decision.outcome {
        ApprovalOutcome::Approved => {
            bc.progress(70, "merge approved, merging").await;
            merge_pr(&pr).await?;
            bc.progress(80, "merged, triggering deploy").await;

            // Call deploy-agent with a back-channel.
            let deploy_agent = Agent::connect().discover("deploy.production").await?;
            let (deploy_fut, mut deploy_progress) = deploy_agent
                .call_with_backchannel(Request::text(serde_json::to_string(&pr)?))
                .await?;
            // Forward deploy progress to our own back-channel.
            while let Some(ev) = deploy_progress.next().await {
                bc.progress(85, ev?.body()).await;
            }
            let deploy_result = deploy_fut.await?;
            bc.progress(100, "deploy complete").await;
            Ok(Response::text(format!("merged and deployed: {}", deploy_result.body())))
        }
        ApprovalOutcome::Denied => {
            Err(format!("merge denied by {}: {}",
                decision.approver, decision.comment.unwrap_or_default()))
        }
        _ => Err("unexpected outcome".into()),
    }
}
```

### 13.5 The Deploy Agent Handler

```rust
async fn deploy_handler(
    req: Request,
    bc: Backchannel,
    cancel: CancellationToken,
) -> Result<Response, String> {
    let plan = parse_deploy_plan(&req)?;
    bc.progress(5, "deploy plan received").await;

    // Quorum approval: codeowner + oncall.
    let approval = ApprovalRequest {
        request_id: bc.request_id().to_string(),
        capability: "deploy.production".into(),
        summary: format!("Deploy {} v{} to production", plan.service, plan.version),
        details: plan.to_json(),
        risk: RiskLevel::High,
        timeout_secs: 1800,
        requesting_agent: bc.our_id(),
        request_attestation: bc.attestation().clone(),
        authorized_approvers: vec![
            ApproverRef::Role("codeowner".into()),
            ApproverRef::Role("oncall".into()),
        ],
        quorum: Some(QuorumSpec {
            approvers: vec![
                ApproverRef::Role("codeowner".into()),
                ApproverRef::Role("oncall".into()),
            ],
            required: 2,
            deny_vetoes: true,
            window_secs: 1800,
        }),
        escalation_chain: vec![],
        deep_link: Some(format!("https://aafp.example/approvals/{}", bc.request_id())),
    };
    bc.request_approval_structured(approval.clone()).await?;
    audit.record(AuditEventType::ApprovalRequested, &approval).await?;

    // Collect quorum.
    let decisions = await_quorum(&bc, &approval, &cancel).await?;
    audit.record(AuditEventType::ApprovalDecided, &decisions[0]).await?;
    audit.record(AuditEventType::ApprovalDecided, &decisions[1]).await?;

    // Execute deploy with progress.
    bc.progress(50, "deploying to canary").await;
    deploy_canary(&plan).await?;
    bc.progress(70, "canary healthy, baking 5 minutes").await;
    bake(Duration::from_secs(300)).await?;
    bc.progress(85, "rolling out to full fleet").await;
    rollout(&plan).await?;
    bc.progress(100, "deploy complete").await;
    audit.record(AuditEventType::ActionExecuted, &approval).await?;

    Ok(Response::text(format!("deployed {} v{}", plan.service, plan.version)))
}
```

### 13.6 The Audit Trail for This Flow

The `audit-agent` records (in order):

1. `ApprovalRequested` — merge.main, by review-agent, approvers=[codeowner].
2. `ApprovalDecided` — merge.main, by alice-terminal, Approved, "lgtm".
3. `ActionExecuted` — merge.main, PR #123 merged.
4. `ApprovalRequested` — deploy.production, by deploy-agent, quorum=[codeowner, oncall].
5. `ApprovalDecided` — deploy.production, by alice-terminal, Approved.
6. `ApprovalDecided` — deploy.production, by charlie-terminal, Approved.
7. `ActionExecuted` — deploy.production, payments-api v2.3.1 deployed.

Each event is hash-chained to the previous. The full UCAN chain for each
decision is stored. A compliance auditor can reconstruct the entire flow:
who approved what, when, why, and with what authority.

---

## 14. Security Considerations

### 14.1 Forged Approvals

**Threat:** an attacker (or buggy agent) publishes an `ApprovalDecision`
claiming to be an authorized approver.

**Mitigations:**
- The `approval_attestation` is a UCAN chain verified by the requesting agent
  (§5.2). A forged decision without a valid chain is rejected.
- The back-channel topic ACL (`PUBSUB_BACKCHANNEL_DESIGN.md` §6.4) restricts
  publish to the server and authorized approvers. Unauthorized publishes are
  rejected with code `9006 PUBSUB_UNAUTHORIZED`.
- The `approver` field must match the final holder of the UCAN chain.
  Mismatches are rejected.

### 14.2 Stolen Approver Keys

**Threat:** an attacker steals an approver's AgentKeypair and approves
malicious deploys.

**Mitigations:**
- UCAN revocation (§5.6): the principal publishes a revocation, and the
  requesting agent invalidates the stolen key's chain.
- Key rotation: approvers rotate keys periodically; old chains expire.
- Hardware-backed keys (WebAuthn, HSM): the key never leaves the hardware,
  so theft requires physical access.
- Quorum (§7): a single stolen key cannot approve high-risk actions if the
  quorum requires M > 1 approvers.

### 14.3 Timeout Bypass

**Threat:** an agent sets a short timeout and `AutoApprove` policy to bypass
approval.

**Mitigations:**
- The `TimeoutPolicy` is declared in the capability's `AgentRecord` extension
  or a policy document, *not* chosen per-request by the handler (§6.3). A
  compromised agent cannot change its own policy without re-publishing the
  `AgentRecord`, which is signed and can be monitored.
- `AutoApprove` requires a `fallback_attestation` — a UCAN chain authorizing
  auto-approval. This chain is itself auditable and revocable.
- High-risk capabilities never allow `AutoApprove`; the policy is enforced
  by the requesting agent's policy loader, which can be a separate, hardened
  component.

### 14.4 Back-Channel Spoofing

**Threat:** a malicious peer publishes fake progress or fake approval
*requests* on `rpc.<server>.<id>.progress`.

**Mitigations** (from `PUBSUB_BACKCHANNEL_DESIGN.md` §11.3):
- The `req_id` is unguessable (64+ random bits), so guessing a topic is
  infeasible.
- ACLs restrict publish on `rpc.*` topics to the owning server.
- Clients verify `event.from()` equals the server's AgentId.
- For approval *requests*, the bridge additionally verifies the
  `request_attestation` in the `ApprovalRequest` before rendering it, so a
  spoofed request without a valid attestation is ignored.

### 14.5 Bridge Compromise

**Threat:** the Slack/email/web bridge is compromised, and the attacker
approves requests on behalf of humans.

**Mitigations:**
- Owned identity (§4.4): the bridge doesn't hold the human's key; it triggers
  a WebAuthn flow per decision. Compromising the bridge doesn't yield keys.
- Per-decision re-authentication: high-risk approvals require MFA at decision
  time, not just at bridge login.
- Bridge capability scoping: the bridge's own AgentId is scoped
  (`bridge.slack`), and the requesting agent verifies the *human's* chain,
  not the bridge's. A bridge publishing a decision under its own AgentId
  (not the human's) is rejected unless the human explicitly delegated to the
  bridge (and that delegation is auditable).

### 14.6 Audit Trail Tampering

**Threat:** an attacker edits the audit log to hide a bad approval.

**Mitigations:**
- Hash chaining (§11.4): editing one event breaks the chain.
- External notarization: periodic publication of the chain head to a
  transparency log makes retroactive tampering detectable by third parties.
- Append-only storage: the audit store rejects overwrites (S3 Object Lock,
  WORM tape, blockchain).

---

## 15. Performance Considerations

### 15.1 Latency of an Approval Round-Trip

The critical path for an approval:

1. Requesting agent publishes `ApprovalRequest` to back-channel topic (~14µs
   with pooled connections, per `PUBSUB_BACKCHANNEL_DESIGN.md` §12.2).
2. Bridge receives via PubSub subscription (~1ms local, ~10ms remote).
3. Bridge renders and posts to Slack/email (~100ms–10s depending on surface).
4. Human reads and decides (seconds to minutes — the dominant latency).
5. Bridge publishes `ApprovalDecision` to back-channel topic (~14µs).
6. Requesting agent receives and verifies UCAN chain (~1ms verification).

The machine-side overhead is < 50ms; the human-side latency dominates. This
is inherent to HITL and not a protocol concern.

### 15.2 Concurrent Pending Approvals

An agent may have many pending approvals (e.g., 50 PRs open). Each holds:

- A QUIC bi-stream (the RPC) — bounded by `max_concurrent_streams` (default
  256, configurable in `QuicConfig`).
- A handler task — bounded by the agent's task budget.
- A PubSub subscription on the back-channel topic — cheap (one broadcast
  receiver per topic).

The bottleneck is `max_concurrent_streams`. For high-throughput review
agents, increase it in `QuicConfig` or shard across multiple connections.

### 15.3 Audit Throughput

The audit topic is a hot path: every approval request and decision flows
through it. For a large org (1000 approvals/day), this is ~0.01 events/sec —
trivial. For a burst (100 deploys in an hour), it's ~0.06/sec — still
trivial. The audit agent's append-only store is the bottleneck; a
log-structured DB handles 10K+ events/sec, so audit is not a concern.

### 15.4 Bridge Fan-Out

When a request goes to multiple surfaces (Slack + email + web dashboard), the
bridge fans out. Slack's API rate limits (~1 msg/sec per channel) are the
binding constraint. The bridge queues and batches; a burst of 50 requests
takes ~50 seconds to post to Slack, which is acceptable (humans can't read
50 cards instantly anyway).

---

## 16. Comparison with Other HITL Systems

### 16.1 GitHub Branch Protection / Required Reviews

GitHub's required reviews are a HITL system: a PR merge is gated on N
approvals from codeowners. AAFP generalizes this:

- GitHub's "review" is AAFP's `ApprovalOutcome::Approved` with
  `capability: "merge.main"`.
- GitHub's "codeowner rule" is AAFP's `authorized_approvers` + UCAN chain.
- GitHub's "dismiss stale reviews" is AAFP's re-request on `NeedsInfo` or
  plan change (§7.5).
- GitHub is single-surface (web); AAFP is multi-surface (Slack, email,
  terminal, web) via bridges.

**Lesson:** GitHub's model is PR-centric. AAFP's is capability-centric,
generalizing beyond code review to any gated action (deploy, spend, email).

### 16.2 Argo CD / Spinnaker Manual Approvals

Argo CD and Spinnaker have manual approval gates in deploy pipelines: a stage
pauses until a human clicks "Approve" in the UI.

- Argo's "manual gate" is AAFP's `ApprovalRequest` with
  `capability: "deploy.production"`.
- Argo's UI is one bridge (web dashboard). AAFP supports the same plus Slack
  and email.
- Argo's approval is unstructured (just a click). AAFP's is structured
  (UCAN chain, comment, quorum, escalation).

**Lesson:** Argo/Spinnaker are pipeline-centric (approval is a stage). AAFP
is agent-centric (approval is a capability gate any agent can request), which
composes better with dynamic, non-pipeline workflows.

### 16.3 OpenAI/Anthropic Constitutional AI Human Feedback

Constitutional AI and RLHF use human feedback to steer model behavior. This
is HITL at the *training* level, not the *inference* level. AAFP's HITL is
inference-time (per-action approval), not training-time. They are
complementary: RLHF shapes the model; AAFP HITL gates the model's actions in
deployment.

### 16.4 Slack-based approval bots (e.g., ApproveSimple)

Existing Slack approval bots deliver approval requests as Slack messages with
buttons. AAFP's Slack bridge (§9) is the same UX, but:

- The decision is cryptographically signed (UCAN), not just a Slack click.
- The audit trail is tamper-evident (hash chain), not a Slack log.
- The approval authority is delegable (UCAN chains), not hardcoded to a
  Slack user.
- The protocol is open: any agent can request, any bridge can render.

**Lesson:** the UX of Slack-based approvals is proven and popular. AAFP
keeps the UX, adds the cryptographic and audit guarantees that
enterprise/compliance contexts require.

---

## 17. Implementation Roadmap

### Phase H1: Approval Primitives (Weeks 1-2)

**Goal:** the core approval round-trip over back-channel.

| Step | Deliverable |
|------|-------------|
| 1 | `ApprovalRequest` / `ApprovalDecision` CBOR schema |
| 2 | `Backchannel::request_approval_structured()` + `await_decision()` |
| 3 | `TimeoutPolicy` enum + policy loader from `AgentRecord` ext |
| 4 | Terminal-based human approver (`aafp-term` approve mode) |
| 5 | Integration test: agent requests, terminal approves, agent proceeds |

**Files:** `aafp-sdk/src/hitl.rs` (new), `aafp-sdk/src/simple.rs`,
`aafp-term/src/approve.rs` (new).

### Phase H2: Bridge Agents (Weeks 3-4)

**Goal:** Slack and web dashboard bridges.

| Step | Deliverable |
|------|-------------|
| 1 | `slack-bridge` agent: subscribe, post card, handle button, publish decision |
| 2 | `web-dashboard` bridge: subscribe, store pending, render UI, submit decision |
| 3 | Deep-link generation and resolution |
| 4 | Email bridge: send email with deep link; reply-to-approve for low-risk |
| 5 | End-to-end test: agent -> Slack -> human clicks -> agent proceeds |

**Files:** `bridges/slack-bridge/` (new), `bridges/web-dashboard/` (new),
`bridges/email-bridge/` (new).

### Phase H3: UCAN Delegation & Escalation (Weeks 5-6)

**Goal:** delegation, escalation chains, revocation.

| Step | Deliverable |
|------|-------------|
| 1 | `approve/<cap>/<scope>` UCAN capability encoding |
| 2 | Delegation flow (`Delegated` outcome, chain re-request) |
| 3 | `EscalationStep` chain + `await_with_escalation()` |
| 4 | Revocation topic + agent-side revocation check |
| 5 | Test: primary times out, escalates to backup, backup approves |

**Files:** `aafp-sdk/src/hitl.rs`, `aafp-core/src/ucan.rs`.

### Phase H4: Quorum & Multi-Human (Weeks 7-8)

**Goal:** N-of-M approvals, parallel and sequential.

| Step | Deliverable |
|------|-------------|
| 1 | `QuorumSpec` in `ApprovalRequest` |
| 2 | `await_quorum()` handler helper |
| 3 | Sequential delegation chain (A -> B -> C) |
| 4 | Test: 2-of-3 quorum, one denial vetoes, two approvals proceed |

**Files:** `aafp-sdk/src/hitl.rs`.

### Phase H5: Audit Trail (Weeks 9-10)

**Goal:** tamper-evident audit log.

| Step | Deliverable |
|------|-------------|
| 1 | `AuditEvent` schema + hash chaining |
| 2 | `audit-agent` with append-only store |
| 3 | `audit.query` capability for dashboard/compliance |
| 4 | External notarization (transparency log) integration |
| 5 | Test: tamper detection on historical event |

**Files:** `aafp-audit/` (new crate), `aafp-sdk/src/audit.rs` (new).

### Phase H6: Hardening & Polish (Weeks 11-12)

**Goal:** production readiness.

| Step | Deliverable |
|------|-------------|
| 1 | Heartbeats during approval wait |
| 2 | Bridge rate-limit handling (Slack API) |
| 3 | Mobile/push bridge (FCM/APNs) |
| 4 | Compliance report generation (SOX/SOC2) |
| 5 | Load test: 100 concurrent pending approvals |

---

## 18. Open Questions

1. **Approval reuse:** if the same action is requested twice (e.g., retry a
   failed deploy), should the prior approval be reusable within a window, or
   must it be re-requested? Reuse reduces human fatigue but risks approving
   a subtly different action. Propose: reuse only if the action hash is
   identical and within a `reuse_window_secs`.
2. **Off-chain attestation verification:** the requesting agent verifies the
   UCAN chain locally. For large orgs with complex chains, should there be a
   dedicated `ucan-verify` agent to offload verification? Trades latency for
   trust centralization.
3. **Human fatigue / approval spam:** if every low-risk action requires
   approval, humans rubber-stamp. Should AAFP define a "batch approval"
   pattern (approve a batch of similar requests with one decision)? This is
   a UI concern, but the protocol should support a `batch_id` linking
   related requests.
4. **Cross-org approvals:** if agent A in org X requests approval from a
   human in org Y (e.g., a vendor deploy), how does the UCAN chain cross org
   boundaries? Likely a cross-org principal attestation, but the trust model
   needs elaboration.
5. **Mobile offline decisions:** if a human approves on mobile while offline,
   the bridge can't publish until connectivity returns. Should the decision
   be queued locally and published on reconnect, with the `decided_at`
   timestamp preserved? This risks the action already having timed out.
6. **Approval for approval:** meta-HITL — should delegating approval
   authority itself require approval (e.g., Alice can't delegate to Bob
   without her manager's sign-off)? UCAN supports this (the delegation is
   itself an attestation that could require a co-signer), but the UX is
   complex.

---

## Appendix A: Complete Terminal Approver Example

```rust
use aafp_sdk::simple::{Agent, Event, Request, Response};
use aafp_sdk::hitl::{ApprovalRequest, ApprovalDecision, ApprovalOutcome, RiskLevel};
use futures::stream::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let agent = Agent::serve()
        .capability("approve.deploy.production")
        .capability("approve.merge.main")
        .on_publish_wildcard("approvals.+.+", |topic, ev| async move {
            let req: ApprovalRequest = serde_cbor::from_slice(ev.payload())?;

            // Render to terminal.
            println!("\n{'='*60}");
            println!("APPROVAL REQUIRED: {}", req.capability);
            println!("{'='*60}");
            println!("Summary:   {}", req.summary);
            println!("Risk:      {:?}", req.risk);
            println!("Requester: {}", req.requesting_agent);
            println!("Timeout:   {}s", req.timeout_secs);
            println!("Details:   {}", serde_json::to_string_pretty(&req.details)?);
            if let Some(link) = &req.deep_link {
                println!("Deep link: {}", link);
            }
            println!("\n[a]pprove / [d]eny / [c]omment / [i]nfo / [e]scalate: ");

            let mut input = String::new();
            std::io::stdin().read_line(&mut input)?;

            let (outcome, comment) = match input.trim() {
                "a" => (ApprovalOutcome::Approved, None),
                "d" => (ApprovalOutcome::Denied, Some("denied".into())),
                "i" => {
                    // Request more info.
                    (ApprovalOutcome::NeedsInfo, Some("need more info".into()))
                }
                "e" => {
                    // Delegate to backup.
                    println!("Delegate to (agent id): ");
                    let mut to = String::new();
                    std::io::stdin().read_line(&mut to)?;
                    (ApprovalOutcome::Delegated {
                        to: ApproverRef::Agent(to.trim().parse()?),
                    }, Some("delegated".into()))
                }
                other => (ApprovalOutcome::Approved, Some(other.into())),
            };

            let decision = ApprovalDecision {
                request_id: req.request_id.clone(),
                outcome,
                comment,
                approver: agent.our_id(),
                approval_attestation: agent.attestation().clone(),
                decided_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?.as_secs(),
            };

            // Publish decision back to the request's back-channel topic.
            agent.publish(
                &format!("rpc.{}.{}.progress",
                    req.requesting_agent, req.request_id),
                Event::data(serde_cbor::to_vec(&decision)?),
            ).await?;

            println!("Decision published.");
            Ok(())
        })
        .start().await?;

    println!("Human approver agent ready: {}", agent.our_id());
    Ok(())
}
```

---

## Appendix B: UCAN Approval Capability Encoding

An approval capability is a UCAN attestation with a capability string:

```
approve/<capability>/<scope>
```

The capability is the AAFP capability being gated (e.g.,
`deploy.production`). The scope is a filter:

- `*` — all actions under the capability.
- `<resource>` — a specific resource (e.g., `service-payments`).
- `<resource>/<sub>` — a sub-resource.

Examples:

```
approve/deploy.production/*                        # approve any prod deploy
approve/deploy.production/service-payments         # one service only
approve/spend.budget/quarterly-up-to-10k           # bounded spend
approve/merge.main/*                               # any merge to main
```

The capability is carried in the UCAN `att` field (RFC-0003 §3) as a CBOR
text string. The requesting agent, on receiving an `ApprovalDecision`:

1. Extracts the `approval_attestation` (a UCAN chain).
2. Validates each link's signature (RFC-0003 §4).
3. Checks the root is signed by a recognized principal (org admin).
4. Checks the final capability matches `approve/<requested_capability>/<scope>`
   where `<scope>` matches the action's resource (via `topic_matches` from
   `PUBSUB_BACKCHANNEL_DESIGN.md` Appendix B).
5. Checks caveats (time bound, use count, etc.).

Only if all checks pass does the agent proceed. A failed verification returns
an error to the caller and records an `AuditEvent` with the failure reason.

---

## Appendix C: Topic Layout for HITL

```
rpc.<server_id>.<req_id>.progress      # back-channel: progress + approval req/decision
approvals.<server_id>.<req_id>         # alias for approval requests (bridge subscribes)
approvals.<server_id>.*                # wildcard: all approvals for a server
approvals.+.+                          # wildcard: all approvals in the org (dashboard)
audit.<org>.approvals                  # audit event stream
agents.<approver_id>.inbox             # direct notifications to an approver
agents.<approver_id>.status            # approver presence (for pre-emptive escalation)
ucan.revocations.<agent_id>            # revocation notices for a delegator
```

Bridges subscribe to the wildcards; requesting agents publish to the
per-request topics; the audit agent subscribes to the audit topic; humans'
terminal agents subscribe to their inbox. The layout is consistent with
`PUBSUB_BACKCHANNEL_DESIGN.md` §6.1-6.2 and requires no new topic machinery.

---

This document specifies human-in-the-loop for AAFP as a composition of
back-channeling (for the request/notification channel), PubSub topics (for
the decision channel), UCAN capability chains (for approval authority and
delegation), streaming RPC cancellation (for timeouts), and `AgentRecord`
extensions (for audit). No wire protocol changes are required. The human is
modeled as an AAFP agent — directly via a terminal or indirectly via a bridge
— keeping the protocol uniform. The phased roadmap delivers the approval
round-trip first, bridges second, delegation/escalation third, quorum fourth,
and audit fifth, each independently shippable.
