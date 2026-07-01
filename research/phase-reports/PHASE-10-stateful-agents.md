# Phase 10: Stateful Agents

```
Phase:          10 of 16
Title:          Stateful Agents
Status:         Complete
Date:           2026-07-01
Researchers:    Devin (autonomous)
```

## 1. Objective

Examine AAFP's session model in the context of long-running agent tasks,
multi-agent group communication, and post-compromise security. Identify
gaps in AAFP's state handling and recommend solutions.

## 2. AAFP's Current Session Model

### 2.1 Session State Machine (8 states)

```
Connecting -> TransportEstablished -> IdentityVerified ->
AuthorizationVerified -> Authenticated -> MessagingEnabled ->
Closing -> Closed
```

This is a **connection-oriented** state machine. It tracks the lifecycle
of a single QUIC connection between two agents. Once `MessagingEnabled`
is reached, application data flows until `Closing` -> `Closed`.

### 2.2 CLOSE State Machine (5 states)

```
Open -> LocalCloseSent -> CloseReceived -> Closed
Open -> RemoteCloseReceived -> CloseReceived -> Closed
```

This handles **graceful shutdown** of a single session. It ensures both
sides acknowledge the close before the QUIC connection is terminated.

### 2.3 What's Missing

The current model handles **pairwise, connection-oriented sessions**. It
does not address:

1. **Session resumption**: Reconnecting after a network interruption
2. **Session migration**: Moving a session to a new connection
3. **Group sessions**: More than two agents in one session
4. **Long-running tasks**: Sessions that last hours or days
5. **Post-compromise security**: Recovering from a key compromise
6. **State synchronization**: Keeping agent state consistent across
   reconnections

## 3. Ecosystem Comparison

### 3.1 A2A Task Lifecycle

A2A defines an 8-state task lifecycle:
```
SUBMITTED -> WORKING -> COMPLETED/FAILED/CANCELED
                    -> INPUT_REQUIRED (human-in-the-loop)
                    -> AUTH_REQUIRED (step-up auth)
                    -> REJECTED
```

This is an **application-layer** state machine that tracks what an agent
is doing (a task), not the connection state. AAFP's session state
machine and A2A's task state machine operate at different layers and
are complementary.

### 3.2 SLIM Session Model

SLIM defines two session types:
- **Point-to-Point**: Two agents, reliable delivery, MLS E2EE
- **Group**: Many agents, named channels, MLS group state

SLIM sessions have `ProcessingState` (Active, Draining) for graceful
shutdown. The group session model includes a moderator who can
add/remove participants.

### 3.3 AgentMesh Circuit Breaker

AgentMesh defines a circuit breaker state machine:
```
CLOSED (normal) -> OPEN (failures exceed threshold) -> HALF_OPEN (testing)
```

This is a **reliability** state machine, not a session state machine.
It isolates misbehaving agents. AAFP has no equivalent.

### 3.4 MCP Session Evolution

MCP is moving from **stateful** (initialization handshake) to
**stateless** (every request carries metadata). This is the opposite
direction from AAFP, which has a rich stateful session model.

The stateless trend in MCP is driven by:
- Serverless deployments (no persistent state)
- Load balancing (any server can handle any request)
- Simplicity (no session management)

AAFP's stateful model is better for:
- Long-lived agent relationships
- Streaming communication
- Stateful authorization (UCAN chains verified once)
- Replay protection (ReplayCache requires state)

## 4. Gap Analysis

### 4.1 Session Resumption

**Gap**: If a QUIC connection drops, the AAFP session is lost. The
agents must perform a full handshake (3 messages + TLS PQ KEX) to
reconnect.

**Impact**: For mobile/edge agents with unreliable connections, this
is expensive. QUIC has 0-RTT resumption at the transport layer, but
AAFP's session state is not resumed.

**Solution**: Define a session resumption protocol:
1. Server issues a `SessionTicket` during handshake (like TLS 1.3
   session tickets)
2. SessionTicket contains: session_id, expiry, server signature
3. On reconnection, client presents SessionTicket
4. Server verifies ticket, skips full handshake, resumes session
5. Session state (capabilities, UCAN chains) is restored

**Estimated complexity**: Medium. Requires new handshake extension
and session state serialization.

### 4.2 Group Sessions

**Gap**: AAFP is pairwise only. There is no mechanism for 3+ agents to
share a single encrypted session.

**Impact**: Multi-agent collaboration (orchestrator + workers, agent
teams, swarm coordination) requires either:
- N*(N-1)/2 pairwise sessions (quadratic complexity)
- A relay that re-encrypts messages (trust in relay)
- Group encryption (MLS-like)

**Solution options**:

**Option A: MLS integration**
- Use MLS (RFC 9420) for group encryption within AAFP sessions
- This is what SLIM does
- Requires adding MLS crate dependency and group management
- Complex but standards-based

**Option B: Application-layer group protocol**
- Define a group messaging extension on top of AAFP
- One agent is the "coordinator" and manages membership
- Messages are encrypted to all members' public keys
- Simpler but less efficient (no forward secrecy for group)

**Option C: Don't solve this**
- AAFP remains pairwise
- Group messaging is an application-layer concern
- Agents use AAFP for pairwise; use a separate group protocol for groups

**Recommendation**: Option C for now (focus), Option A for the future
(when group messaging demand is clear). AAFP's value is pairwise PQ
security; group messaging is a separate problem.

### 4.3 Post-Compromise Security

**Gap**: If an AAFP session key is compromised, all messages in that
session are exposed. There is no ratchet mechanism to evolve keys.

**Impact**: For long-lived sessions (hours, days), a single compromise
exposes everything. SLIM (MLS) and AgentMesh (Double Ratchet) both
provide PCS.

**Solution**: Add an optional ratchet mechanism:

```
After each message:
    new_key = HKDF(current_key, message_counter)
    delete current_key
    use new_key for next message
```

This is a simplified version of the Double Ratchet. It provides:
- **Forward secrecy**: Past messages can't be decrypted from current key
- **Post-compromise security**: After a compromised message, future
  messages are secure (key evolves)

**Estimated complexity**: Low-Medium. The AEAD module already exists;
adding a ratchet is a key derivation change.

**Recommendation**: Add a ratchet mechanism as a negotiated extension.
Agents can opt in during handshake. This is important for long-lived
sessions.

### 4.4 Long-Running Task State

**Gap**: AAFP's session model is connection-oriented. If an agent is
running a long task (hours), the session must stay open. If the
connection drops, the task state is lost.

**Impact**: Long-running agent tasks (training, inference, data
processing) need to survive network interruptions.

**Solution**: Define a task state synchronization protocol:
1. Agents exchange task state periodically (checkpoint)
2. State is encrypted and signed
3. On reconnection, state is restored from last checkpoint
4. Task continues from checkpoint, not from start

This is an **application-layer** concern, but AAFP can provide the
primitives (encrypted, authenticated messages) for it.

**Recommendation**: Don't build task state into AAFP. Provide the
session resumption primitive (section 4.1) and let application
protocols (A2A) handle task state.

### 4.5 Circuit Breaker

**Gap**: AAFP has no mechanism to isolate misbehaving agents. If an
agent is flooding messages or returning errors, the session continues
until manually closed.

**Impact**: In multi-agent systems, one misbehaving agent can degrade
the entire network.

**Solution**: Add a circuit breaker to the session layer:
1. Track failure count (errors, timeouts, rejections)
2. When failures exceed threshold, transition to `Closing`
3. AgentId is temporarily blocked (with expiry)
4. After block expires, allow reconnection

This is similar to AgentMesh's circuit breaker (CLOSED/OPEN/HALF_OPEN).

**Recommendation**: Add a simple circuit breaker to the SDK (not the
protocol). The SDK tracks failures and closes sessions when threshold
is exceeded. This doesn't require spec changes.

## 5. Stateful vs. Stateless Debate

### 5.1 The Ecosystem Trend

MCP is moving toward stateless (SEP-2575). The argument:
- Stateless is simpler (no session management)
- Stateless scales better (any server handles any request)
- Stateless works with serverless (no persistent state)

### 5.2 The AAFP Counter-Argument

AAFP is stateful by design. The argument:
- Post-quantum signatures are expensive (ML-DSA-65 = 3309 bytes)
- Re-authenticating on every request is wasteful
- Replay protection requires state (ReplayCache)
- UCAN chain verification is expensive (recursive signatures)
- Session state enables streaming (QUIC streams)

### 5.3 The Right Answer

Both are right, for different use cases:

| Use Case | Stateful (AAFP) | Stateless (MCP) |
|----------|-----------------|-----------------|
| High-frequency agent pairs | Better (auth once) | Worse (auth every time) |
| Serverless agents | Worse (no state) | Better (no state needed) |
| Long-lived sessions | Better (session resumption) | Worse (no session) |
| Load-balanced clusters | Worse (sticky sessions) | Better (any server) |
| Streaming | Better (QUIC streams) | Worse (SSE over HTTP) |
| PQ crypto | Better (amortize sig cost) | Worse (sig every request) |

**Recommendation**: AAFP should remain stateful. The PQ signature cost
alone justifies this — verifying a 3309-byte ML-DSA-65 signature on
every request would be prohibitively expensive. For serverless
deployments, AAFP can use short-lived sessions (handshake, exchange,
close) that approximate stateless behavior.

## 6. Recommendations Summary

| Feature | Priority | Complexity | Spec Change? |
|---------|----------|------------|-------------|
| Session resumption (SessionTicket) | High | Medium | Yes (new RFC) |
| Post-compromise security (ratchet) | High | Low-Medium | Yes (extension) |
| Circuit breaker (SDK-level) | Medium | Low | No (SDK only) |
| Group sessions (MLS) | Low (future) | High | Yes (new RFC) |
| Task state sync | Low (app layer) | — | No (not AAFP's concern) |

## 7. Transition to Phase 11

Phase 11 (Extension Framework Design) will examine how AAFP can evolve
without breaking compatibility — the extension pipeline, version
negotiation, and governance model for new features.
