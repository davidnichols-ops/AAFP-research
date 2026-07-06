# AAFP Interoperability with Enterprise Systems

**Author:** Devin (research synthesis)
**Date:** 2026-07-05
**Status:** Reference design — enterprise integration catalog
**Depends on:** `AAFP-ARCHITECTURE-REFERENCE.md`, `INTEROPERABILITY_PLAN.md`,
`PRODUCTION_DEPLOYMENT.md`, `PUBSUB_BACKCHANNEL_DESIGN.md`,
`STREAMING_RPC_DESIGN.md`, `AGENT_RECORD_EXTENSIONS.md`, `NORTH_STAR.md`

---

## Executive Summary

AAFP is a session-layer protocol for agent-to-agent communication built on
QUIC, ML-DSA-65 identity, UCAN capability chains, DHT discovery, and
GossipSub PubSub. It is not, and was never intended to be, a replacement for
the rest of the enterprise stack. Kubernetes already schedules pods. Istio
already terminates mTLS. Kafka already moves events. Postgres already stores
state. Salesforce already owns the CRM record. AAFP's job is to be the
**agent session layer that sits between those systems and the autonomous
software that uses them** — not to displace them.

This document specifies how AAFP interoperates with eleven categories of
enterprise infrastructure: container orchestrators, service meshes, API
gateways, message queues, databases, data pipelines, identity providers,
monitoring stacks, SIEM platforms, cloud providers, and SaaS applications.
For each category we describe the integration surface, the bridge pattern,
the failure modes, and the concrete code/manifest artifacts involved. For
the top five highest-leverage integrations (Kubernetes, Service Mesh, API
Gateway, Message Queue, Identity Provider) we provide full architecture
diagrams and step-by-step data flow.

**Guiding principle (from ADR-0004):** *interoperability over replacement.*
AAFP wraps existing systems as capability providers and exposes them to the
agent graph. It does not require enterprises to rip out Kafka, Istio, or
Okta. It requires a thin bridge process — an **adapter agent** — that
speaks AAFP on one side and the enterprise system's native protocol on the
other.

---

## Table of Contents

1. [Integration Model and Common Patterns](#1-integration-model-and-common-patterns)
2. [AAFP ↔ Kubernetes](#2-aafp--kubernetes)
3. [AAFP ↔ Service Mesh (Istio/Linkerd)](#3-aafp--service-mesh-istiolinkerd)
4. [AAFP ↔ API Gateway (Kong/Envoy/AWS API Gateway)](#4-aafp--api-gateway-kongenvoyaws-api-gateway)
5. [AAFP ↔ Message Queue (Kafka/RabbitMQ/NATS)](#5-aafp--message-queue-kafkarabbitmqnats)
6. [AAFP ↔ Database (Postgres/Redis/MongoDB)](#6-aafp--database-postgresredismongodb)
7. [AAFP ↔ Data Pipeline (Airflow/Dagster/Spark)](#7-aafp--data-pipeline-airflowdagsterspark)
8. [AAFP ↔ Identity Provider (Keycloak/Auth0/Okta)](#8-aafp--identity-provider-keycloakauth0okta)
9. [AAFP ↔ Monitoring (Datadog/New Relic/Splunk)](#9-aafp--monitoring-datadognew-relicsplunk)
10. [AAFP ↔ SIEM (Splunk/Elastic)](#10-aafp--siem-splunkelastic)
11. [AAFP ↔ Cloud Provider (AWS/GCP/Azure)](#11-aafp--cloud-provider-awsgcpazure)
12. [AAFP ↔ SaaS (Salesforce/ServiceNow/Jira)](#12-aafp--saas-salesforceservicenowjira)
13. [Top 5 Architecture Diagrams and Data Flow](#13-top-5-architecture-diagrams-and-data-flow)
14. [Cross-Cutting Concerns](#14-cross-cutting-concerns)
15. [Integration Maturity Matrix](#15-integration-maturity-matrix)

---

## 1. Integration Model and Common Patterns

### 1.1 The Adapter Agent

Every enterprise integration in this document is realized through the same
primitive: an **adapter agent**. An adapter agent is a normal AAFP agent
(it has an `AgentId`, an ML-DSA-65 keypair, an `AgentRecord` published to
the DHT, UCAN-delegated capabilities) that additionally runs a sidecar
loop translating between AAFP messaging and some external system.

```
                ┌──────────────────────────────────────────────┐
                │              Adapter Agent                    │
                │                                                │
   AAFP side    │  ┌──────────┐    ┌──────────┐    ┌─────────┐  │  Enterprise side
   ─────────────┼─▶│ AAFP     │    │ Bridge   │    │ Native  │──┼──────────────▶
   QUIC :4433   │  │ Session  │───▶│ Logic    │───▶│ Client  │  │  Kafka / SQL /
   UCAN caps    │  │ Layer    │    │ (transl.)│    │ (SDK)   │  │  REST / gRPC
   ◀────────────┼──│          │◀───│          │◀───│         │◀─┼──────────────
                │  └──────────┘    └──────────┘    └─────────┘  │
                │       │                                          │
                │       ▼                                          │
                │  AgentRecord:                                    │
                │   capabilities: [                                │
                │     "kafka.publish",                             │
                │     "kafka.consume"                              │
                │   ]                                              │
                └──────────────────────────────────────────────┘
```

The adapter agent advertises capabilities that describe what the wrapped
system can do (`kafka.publish`, `postgres.query`, `salesforce.read.account`).
Other agents discover it via the DHT, request a UCAN delegation for the
specific resource/action pair, and invoke it through normal AAFP messaging.
The adapter translates each AAFP request into one or more native API calls
and streams results back over AAFP streaming RPC (RFC-P2.8).

### 1.2 Capability Naming Convention

To keep the capability graph navigable, adapter agents use a hierarchical
naming scheme derived from the wrapped system:

```
<system>.<verb>.<resource>[.subresource]
```

Examples:
- `kafka.publish.orders`
- `kafka.consume.orders.v2`
- `postgres.query.public.users`
- `postgres.transaction.begin`
- `salesforce.read.account`
- `salesforce.write.contact`
- `s3.put.objects.my-bucket`
- `s3.get.objects.my-bucket`

This maps cleanly onto UCAN's capability-narrowing rule (child resource
must equal or be a sub-resource of parent — see `AAFP-ARCHITECTURE-
REFERENCE.md` §4). An enterprise admin can delegate `salesforce.*` to a
tenant adapter, which delegates `salesforce.read.account` to a downstream
agent, which cannot then escalate to `salesforce.write.*`.

### 1.3 The Three Bridge Topologies

Every integration in this document falls into one of three topologies:

| Topology | Direction | Use case |
|----------|-----------|----------|
| **Inbound bridge** | Enterprise → AAFP | External system calls into the agent graph (e.g. Kong exposes AAFP agents as REST endpoints for non-AAFP clients) |
| **Outbound bridge** | AAFP → Enterprise | Agents call out to enterprise systems (e.g. an agent publishes to Kafka, queries Postgres) |
| **Bidirectional bridge** | Both | Adapter agent is a full participant (e.g. Kafka topics mirror AAFP PubSub topics, identity provider mints UCAN tokens from OAuth tokens) |

### 1.4 Universal Failure Handling

All adapter agents follow the same failure contract:

1. **Native errors** are translated to AAFP application errors with a
   structured `error_code` namespace (`KAFKA_REBALANCE`,
   `POSTGRES_DEADLOCK`, `SALESFORCE_API_LIMIT`). The original native error
   is preserved in the `details` map for debugging.
2. **Timeouts** on the native side become AAFP `CANCELED` status with the
   deadline propagated to the caller so it can decide to retry, hedge, or
   fall back (see `ADAPTIVE_ROUTING_PLANE.md` Track T3/T4).
3. **Partial results** from streaming native APIs (Kafka consumer, Spark
   stage, Salesforce bulk query) are delivered as AAFP streaming RPC
   frames with `is_final=false` until the native stream closes.
4. **Backpressure** is honored in both directions: if the AAFP caller is
   slow, the adapter pauses native reads; if the native system is slow,
   the adapter applies AAFP flow-control frames.

---

## 2. AAFP ↔ Kubernetes

### 2.1 Integration Surface

Kubernetes is the dominant container orchestrator. AAFP agents run as
long-lived stateful pods (see `PRODUCTION_DEPLOYMENT.md` §3) with UDP 4433
exposed via a headless Service for QUIC peer discovery. The integration
surface is bidirectional:

- **Kubernetes → AAFP:** the orchestrator schedules agent pods, mounts
  identity secrets, manages lifecycle (rolling upgrades, graceful
  shutdown), and exposes them via Services/Ingress.
- **AAFP → Kubernetes:** agents query the Kubernetes API to discover
  peers, watch pod events, scale deployments, or register as custom
  resources so the agent graph itself becomes a first-class Kubernetes
  object that operators can reconcile.

### 2.2 Agents as Custom Resources (CRD + Operator Pattern)

The cleanest deep integration is to model AAFP agents as a Kubernetes
Custom Resource Definition (CRD) and run an **AAFP Operator** that
reconciles desired agent state against running pods.

```yaml
apiVersion: aafp.io/v1
kind: AAFPAgent
metadata:
  name: research-worker-1
  namespace: aafp-prod
spec:
  image: ghcr.io/aafp/agent:1.4.2
  identitySecret: research-worker-1-identity   # ML-DSA-65 keypair
  capabilities:
    - text-generation
    - code-generation
    - tool-use
  endpoints:
    - quic://0.0.0.0:4433
  resources:
    requests: { cpu: "2", memory: "4Gi" }
    limits:   { cpu: "4", memory: "8Gi" }
  replicas: 3
  bootstrapRelays:
    - quic://relay.aafp.io:4433
  ucanDelegation:
    issuer: root-admin
    capabilities:
      - { resource: "research.*", action: "*" }
status:
  observedGeneration: 7
  readyReplicas: 3
  agentIds:
    - AAFP-KJNGX4ZT-...
  dhtPeers: 47
  lastHandshake: 2026-07-05T14:22:01Z
```

The Operator's reconcile loop:

1. **Diff** desired vs. observed `replicas`, `image`, `capabilities`.
2. **Scale** the underlying `StatefulSet` up or down with ordered
   rolling updates (QUIC connections drain via the CLOSE state machine,
   see `AAFP-ARCHITECTURE-REFERENCE.md` §6).
3. **Publish** each new pod's `AgentRecord` to the DHT once the pod's
   readiness probe confirms the QUIC listener is up.
4. **Revoke** records for terminated pods by signing a tombstone with
   the pod's identity key (pulled from the Secret) and broadcasting it
   on the `aafp/discovery` PubSub topic.
5. **Reflect** status back into the CRD `status` block so `kubectl get
   aafpagent` shows live DHT peer counts and last-handshake timestamps.

### 2.3 Operator Architecture

```
   kubectl apply         ┌─────────────────────────────────────┐
   ─────────────────────▶│        AAFP Operator                 │
                         │   (controller-runtime process)      │
                         │                                      │
                         │  ┌──────────────┐  ┌──────────────┐ │
                         │  │  Reconcile   │  │  DHT Client  │ │
                         │  │  Loop        │──│  (publish/   │ │
                         │  │              │  │   revoke)    │ │
                         │  └──────┬───────┘  └──────────────┘ │
                         │         │                            │
                         │         ▼                            │
                         │  ┌──────────────────────────────┐   │
                         │  │  Kubernetes API (watch/patch) │   │
                         │  └──────────────────────────────┘   │
                         └─────────────────────────────────────┘
                                    │ creates / scales
                                    ▼
                         ┌─────────────────────────────────────┐
                         │  StatefulSet: aafp-agent             │
                         │  ┌────────┐ ┌────────┐ ┌────────┐   │
                         │  │ Pod-0  │ │ Pod-1  │ │ Pod-2  │   │
                         │  │ :4433  │ │ :4433  │ │ :4433  │   │
                         │  └────────┘ └────────┘ └────────┘   │
                         └─────────────────────────────────────┘
```

### 2.4 Identity and Secrets

Each `AAFPAgent` CR references a Kubernetes `Secret` of type
`aafp.io/identity` containing the ML-DSA-65 secret key (4032 bytes) and
public key (1952 bytes). The Operator never reads the secret key in
plaintext — it mounts it directly into the pod via a `volumeProjection`
so the key material lives only in the pod's memory and the kubelet's
ephemeral secret store. Rotating identity means creating a new Secret and
patching the CR; the Operator performs a blue/green rollout (see
`PRODUCTION_DEPLOYMENT.md` §9) so old sessions drain before the new
identity takes over.

### 2.5 Failure Modes

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Pod crash before publishing record | Readiness probe fails | Operator restarts pod; no stale record exists |
| Pod crash after publishing record | DHT heartbeat TTL expires (default 60s) | Tombstone broadcast by Operator on next reconcile |
| Operator pod crash | Leader election lease expires | Standby operator takes over; CRD status may lag but pods keep running (decentralized — pods do not depend on operator for AAFP traffic) |
| Split brain (operator sees stale cache) | Generation mismatch in CRD | Operator re-fetches full state before acting |

Critically, the Operator is **not in the data path**. If it dies, AAFP
agents keep communicating via QUIC and the DHT. The Operator only handles
lifecycle and discovery metadata. This matches AAFP's core design
principle: no central controller is required for the protocol to function.

---

## 3. AAFP ↔ Service Mesh (Istio/Linkerd)

### 3.1 The mTLS Bridging Problem

Service meshes (Istio, Linkerd, Consul Connect) enforce zero-trust mTLS
between pods by intercepting all TCP traffic via sidecar proxies (Envoy
for Istio, the Rust-based Linkerd2-proxy for Linkerd). AAFP uses QUIC
over UDP, which the standard mesh sidecars do **not** intercept — they
operate on TCP. This creates three options:

1. **Passthrough mode** — tell the mesh to ignore UDP 4433. AAFP's own
   ML-DSA-65 handshake and per-session keys provide the equivalent of
   mTLS. This is the recommended default.
2. **TCP-bridged mode** — run AAFP over a TCP fallback transport (the
   protocol allows multiple endpoint multiaddrs) and let the mesh
   terminate mTLS at the sidecar. AAFP's handshake still runs
   end-to-end *inside* the mesh's mTLS tunnel, giving double encryption.
   Useful when policy requires all traffic to traverse the mesh.
3. **Hybrid mode** — QUIC for agent-to-agent traffic (passthrough), TCP
   for agent-to-adapter traffic (mesh-terminated). Lets the mesh enforce
   policy on the enterprise-facing leg while keeping AAFP's native
   performance on the agent leg.

### 3.2 Istio Integration

For passthrough mode, define a `ServiceEntry` and `PeerAuthentication`:

```yaml
apiVersion: networking.istio.io/v1
kind: ServiceEntry
metadata:
  name: aafp-agent
spec:
  hosts: [aafp-agent.aafp-prod.svc.cluster.local]
  ports:
    - number: 4433
      name: quic
      protocol: UDP          # mesh does not terminate UDP
  resolution: DNS
---
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: aafp-agent
  namespace: aafp-prod
spec:
  selector:
    matchLabels: { app: aafp-agent }
  mtls:
    mode: PERMISSIVE          # allow plaintext QUIC; AAFP provides crypto
  portLevelMtls:
    4433: DISABLE              # explicitly disable mesh mTLS on QUIC port
```

For TCP-bridged mode, expose a TCP endpoint on 4434 that the mesh
intercepts, and let AAFP advertise both endpoints in its `AgentRecord`:

```
endpoints: [
  "quic://10.0.0.5:4433",      # passthrough, mesh-disabled
  "tcp://10.0.0.5:4434"        # mesh-terminated, for policy enforcement
]
```

Callers pick the endpoint based on their own policy. The mesh enforces
authorization via `AuthorizationPolicy` on 4434; AAFP enforces UCAN
capability checks on both.

### 3.3 Linkerd Integration

Linkerd is simpler because its proxy is UDP-transparent by default — it
only intercepts TCP. To run AAFP under Linkerd, annotate the pod to
skip the QUIC port:

```yaml
metadata:
  annotations:
    config.linkerd.io/skip-inbound-ports: "4433"
    config.linkerd.io/skip-outbound-ports: "4433"
```

Linkerd's mTLS still covers the metrics port (9090) and any TCP control
traffic. AAFP's ML-DSA-65 handshake provides the agent-identity
equivalent of Linkerd's service-identity mTLS, so there is no security
regression.

### 3.4 Identity Mapping: Service Identity ↔ Agent Identity

Meshes issue a SPIFFE ID per pod (`spiffe://cluster.local/ns/aafp-prod/
sa/aafp-agent`). AAFP issues an `AgentId` per keypair. The bridge is a
one-way mapping stored in the adapter agent's config:

```
spiffe://cluster.local/ns/aafp-prod/sa/aafp-agent  →  AAFP-KJNGX4ZT-...
```

This mapping is **attested**, not trusted: on handshake, the AAFP peer
verifies the ML-DSA-65 signature (proving ownership of the AgentId), and
the mesh verifies the SPIFFE SVID (proving pod identity). Neither side
trusts the mapping alone — both cryptographic checks must pass. This is
the same dual-verification pattern used in the Kubernetes integration
(§2.4).

---

## 4. AAFP ↔ API Gateway (Kong/Envoy/AWS API Gateway)

### 4.1 Why Expose AAFP Agents as REST/gRPC?

AAFP is a binary protocol over QUIC with ML-DSA-65 handshakes. Most
enterprise clients — browsers, mobile apps, legacy services, BI tools,
curl — cannot speak it directly. An API gateway bridges this gap by
terminating HTTP/gRPC/WebSocket from external clients and translating
each request into an AAFP session + streaming RPC call.

This is the canonical **inbound bridge** topology. The gateway is the
single point where the enterprise enforces rate limits, WAF rules, OAuth
validation, and audit logging for non-AAFP callers.

### 4.2 Gateway-as-Adapter-Agent

The cleanest pattern is to run the gateway itself as an AAFP adapter
agent. It holds an `AgentId`, publishes an `AgentRecord` advertising
`http.ingress` capabilities, and accepts UCAN delegations from upstream
agents that want to expose their capabilities over HTTP.

```
   Browser / curl / mobile app
              │ HTTPS
              ▼
   ┌─────────────────────────────────────────────┐
   │  API Gateway (Kong / Envoy / AWS API GW)     │
   │  + AAFP gateway adapter plugin               │
   │                                              │
   │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
   │  │ HTTP     │  │ Route +  │  │ AAFP     │   │
   │  │ Listener │─▶│ Authz    │─▶│ Client   │   │
   │  │ :443     │  │ (OAuth2/ │  │ (QUIC)   │   │
   │  └──────────┘  │  JWT)    │  └────┬─────┘   │
   │                └──────────┘       │         │
   │  AgentId: AAFP-GATEWAY-...        │         │
   │  Caps: [http.ingress]             │         │
   └───────────────────────────────────┼─────────┘
                                       │ QUIC :4433
                                       ▼
                              ┌─────────────────┐
                              │  Target AAFP    │
                              │  Agent          │
                              │  (research,     │
                              │   llm, db, ...) │
                              └─────────────────┘
```

### 4.3 Kong Integration

Kong's plugin system lets us write a Lua/Go plugin that, on each HTTP
request:

1. Validates the OAuth2/JWT bearer token (using Kong's built-in
   `jwt` or `openid-connect` plugin).
2. Maps the token's scopes to AAFP UCAN capabilities (e.g. `scope:
   research.read` → `resource: "research.results", action: "read"`).
3. Requests a UCAN delegation from the gateway's own identity for those
   capabilities (cached per-token-subject for the token's TTL).
4. Opens (or reuses) an AAFP session to the target agent discovered via
   DHT lookup on the capability.
5. Issues a streaming RPC call, piping the HTTP request body in and
   streaming the response back as chunked HTTP/1.1 or HTTP/2.

```lua
-- kong/plugins/aafp-bridge/handler.lua (sketch)
function AafpBridge:access(conf)
  local token = kong.request.get_header("Authorization")
  local claims = validate_jwt(token, conf.jwks_url)
  local caps   = map_scopes_to_ucan(claims.scope)
  local target = aafp.dht_lookup(capabilities = caps)   -- returns AgentId + multiaddr
  local session = aafp.connect(target, {
    ucan = aafp.delegate(gateway_identity, claims.sub, caps, claims.exp)
  })
  local stream = session.open_rpc(claims.x_aafp_method, kong.request.get_body())
  kong.response.set_header("X-AAFP-Agent", target.agent_id)
  pipe_stream_to_http(stream)   -- chunked transfer encoding
end
```

### 4.4 Envoy Integration

Envoy uses a WASM filter (or an external gRPC `ext_proc` filter) for the
same translation. The advantage of Envoy is native HTTP/3 support, which
maps cleanly onto AAFP's QUIC transport — the gateway can terminate
HTTP/3 from clients and speak AAFP-over-QUIC to backends without a
protocol family change.

### 4.5 AWS API Gateway

For serverless deployments, AWS API Gateway + Lambda is the bridge. The
Lambda function is a minimal AAFP client (the Rust SDK compiles to a
`lambda:provided.al2` custom runtime) that translates each HTTP event
into one AAFP RPC call. Cold-start cost is the main concern — mitigate
by keeping a warm pool of Lambda functions with persistent AAFP sessions
to a regional agent pool (Lambda Extensions allow keeping the QUIC
connection alive across invocations).

### 4.6 Failure Modes

| Failure | Behavior |
|---------|----------|
| Target agent unreachable (DHT lookup returns stale record) | Gateway returns 503 with `Retry-After`; circuit breaker (Track T3) opens for that AgentId |
| AAFP session handshake fails | Gateway returns 502; logged with both the gateway's and target's AgentId for correlation |
| Streaming RPC interrupted mid-response | Gateway sends an HTTP trailer `X-AAFP-Status: INTERRUPTED` and closes the chunked stream cleanly |
| OAuth token expired mid-stream | Gateway terminates the stream with 401; the client must re-auth and replay from the last checkpoint |

---

## 5. AAFP ↔ Message Queue (Kafka/RabbitMQ/NATS)

### 5.1 The PubSub Bridge

AAFP has its own GossipSub PubSub layer (RFC-0009, see
`PUBSUB_BACKCHANNEL_DESIGN.md`). Enterprise message queues solve a
different problem: durable, partitioned, high-throughput event streaming
with consumer groups and exactly-once semantics. The two are
complementary, not competing.

The bridge pattern is a **bidirectional topic mirror**. A Kafka topic
`orders.events` and an AAFP PubSub topic `aafp/orders/events` are kept
in sync by a Kafka adapter agent:

- **Kafka → AAFP:** the adapter consumes from Kafka and republishes each
  message onto the AAFP PubSub topic as a signed `AgentRecord`-style
  envelope. Agents that prefer AAFP's low-latency push subscribe to the
  PubSub topic.
- **AAFP → Kafka:** the adapter subscribes to the AAFP PubSub topic and
  produces each message into Kafka, attaching the original AAFP
  `AgentId` and UCAN chain as Kafka headers for traceability.

### 5.2 Kafka Adapter Agent

```
   ┌────────────────────────────────────────────────────────┐
   │           Kafka Adapter Agent                          │
   │                                                        │
   │  AAFP PubSub          Bridge            Kafka Client   │
   │  topic:               Loop              topic:         │
   │  aafp/orders/events                     orders.events  │
   │                                                        │
   │  ┌────────────┐    ┌──────────────┐    ┌────────────┐  │
   │  │ GossipSub  │◀──▶│  Dedup +     │◀──▶│ Consumer  │  │
   │  │ Subscribe  │    │  Offset Map  │    │ + Producer │  │
   │  └────────────┘    └──────────────┘    └────────────┘  │
   │         │                  ▲                  │        │
   │         ▼                  │                  ▼        │
   │   AgentRecord:        offset.db            broker:     │
   │   caps: [kafka.mirror.orders.events]       kafka:9092  │
   └────────────────────────────────────────────────────────┘
```

The **offset map** is the critical piece: it tracks, per AAFP message
hash, the Kafka partition + offset it was produced to, and per Kafka
offset, the AAFP message hash. This prevents duplication when the bridge
restarts and replays. The map is stored in a local RocksDB instance
inside the adapter pod (a `PersistentVolumeClaim`).

### 5.3 Capability and Authorization

The adapter advertises `kafka.publish.<topic>` and `kafka.consume.<topic>`.
An agent that wants to publish to Kafka requests a UCAN delegation for
`kafka.publish.orders.events`. The adapter verifies the chain, then
performs the Kafka produce. Kafka ACLs are configured to allow only the
adapter's service account to produce/consume the bridged topics — so
even a compromised agent cannot bypass the bridge and write to Kafka
directly without the adapter's Kafka credentials.

### 5.4 RabbitMQ and NATS

RabbitMQ differs in that it has exchanges, queues, and bindings rather
than topics. The bridge maps each AAFP PubSub topic to a RabbitMQ
`topic` exchange with routing key equal to the AAFP topic path. Durable
queues are created per consumer group so agents that join late can
replay.

NATS is the closest analog to AAFP's own PubSub (NATS subjects ≈ AAFP
topics, JetStream ≈ durable Kafka-like streams). The NATS bridge is the
thinnest of the three — often a single ~200-line process that forwards
subjects bidirectionally with minimal transformation. NATS's native mTLS
(NATS 2.x) can be bridged to AAFP's ML-DSA-65 identity via a SPIFFE-style
mapping identical to the service-mesh pattern in §3.4.

### 5.5 Ordering and Exactly-Once

AAFP PubSub is at-least-once (GossipSub with message dedup via the
`seen_set`). Kafka can be exactly-once with idempotent producers +
transactions. The bridge does **not** upgrade AAFP's semantics — it
preserves them. If an agent needs exactly-once, it must either (a)
publish directly to Kafka via the adapter using Kafka's transactional
API, or (b) make its AAFP-side processing idempotent by keying on the
AAFP message hash. The bridge documents this explicitly in its
capability description so callers know what they are getting.

---

## 6. AAFP ↔ Database (Postgres/Redis/MongoDB)

### 6.1 Databases as Capability Providers

Databases are the most natural enterprise integration: every agent
eventually needs to read or write state. The pattern is an outbound
bridge — a database adapter agent that wraps the database's native
client and exposes query capabilities to the AAFP graph.

```
   Agent (any)                DB Adapter Agent              Postgres
       │                          │                          │
       │ 1. DHT lookup            │                          │
       │    caps: postgres.query  │                          │
       │─────────────────────────▶│                          │
       │                          │                          │
       │ 2. UCAN delegate         │                          │
       │    resource:             │                          │
       │    postgres.query.       │                          │
       │    public.users          │                          │
       │─────────────────────────▶│                          │
       │                          │ 3. verify UCAN chain     │
       │                          │    check capability      │
       │                          │    narrowing             │
       │                          │                          │
       │ 4. RPC: query            │                          │
       │    "SELECT * FROM users  │                          │
       │     WHERE id = $1"       │                          │
       │    params: [42]          │                          │
       │─────────────────────────▶│ 5. libpq query           │
       │                          │─────────────────────────▶│
       │                          │ 6. row stream            │
       │                          │◀─────────────────────────│
       │ 7. streaming RPC frames  │                          │
       │◀─────────────────────────│                          │
```

### 6.2 Postgres Adapter

The Postgres adapter exposes these capabilities:

| Capability | Maps to |
|------------|---------|
| `postgres.query.<schema>.<table>` | `SELECT` on that table |
| `postgres.mutate.<schema>.<table>` | `INSERT`/`UPDATE`/`DELETE` |
| `postgres.transaction.begin` | `BEGIN` |
| `postgres.transaction.commit` | `COMMIT` (scoped to the caller's session) |
| `postgres.listen.<channel>` | `LISTEN` / `NOTIFY` → AAFP PubSub |

The `query` capability accepts parameterized SQL only — no string
interpolation. The adapter parses the SQL with `libpq`'s parser and
rejects any statement that touches a table outside the delegated
resource scope. This is a **defense-in-depth** check: even if an agent
has a valid UCAN for `postgres.query.public.users`, the adapter will
refuse a query that joins `public.users` to `public.orders` unless the
agent also holds `postgres.query.public.orders`. Capability narrowing
is enforced at the SQL layer, not just the UCAN layer.

Transactions are tied to the AAFP session: `BEGIN` opens a Postgres
transaction and returns a transaction ID; subsequent queries in the same
AAFP session reuse that transaction; `COMMIT`/`ROLLBACK` closes it. If
the AAFP session closes unexpectedly, the adapter rolls back any open
transaction (the CLOSE state machine's graceful-shutdown hook calls
`ROLLBACK` on all pending txns for that session).

### 6.3 Redis Adapter

Redis maps cleanly because its commands are already capability-shaped:

- `redis.get.<keyspace>` → `GET`, `MGET`, `HGET`
- `redis.set.<keyspace>` → `SET`, `HSET`, `EXPIRE`
- `redis.pubsub.<channel>` → `SUBSCRIBE`/`PUBLISH`, bridged to AAFP PubSub
- `redis.stream.<name>` → `XADD`, `XRANGE`, `XREAD` — Redis Streams are
  the natural bridge for agents that want Kafka-like durability without
  running Kafka

The keyspace in the capability resource (e.g. `redis.get.cache.session:*`)
maps to Redis key prefix ACLs. The adapter enforces both the UCAN check
and the Redis ACL (`ACL SETUSER`) so a misconfigured delegation cannot
read keys outside its prefix.

### 6.4 MongoDB Adapter

MongoDB's rich query language translates well to AAFP structured
requests. The adapter accepts a BSON query document as the RPC payload,
validates the collection against the UCAN resource
(`mongodb.query.mydb.orders`), and streams results back as AAFP
streaming RPC frames. Change streams (`watch()`) are bridged to AAFP
PubSub so agents can react to collection changes in real time without
polling.

### 6.5 Connection Pooling and Scale

Each adapter maintains a connection pool to the database (e.g. `pgbouncer`
for Postgres, `lettuce` for Redis). The pool size is sized to the
adapter's declared concurrency in its `AgentRecord` extension
(`max_concurrent_streams`). When the pool is saturated, the adapter
returns `RESOURCE_EXHAUSTED` and the caller's adaptive routing plane
(Track T) can hedge to a replica adapter or queue the request.

---

## 7. AAFP ↔ Data Pipeline (Airflow/Dagster/Spark)

### 7.1 Agents as Pipeline Stages

Data pipelines are directed acyclic graphs of computation stages. AAFP's
agent graph is more general (it supports cycles, streaming, and dynamic
reconfiguration), but the DAG case maps cleanly: each pipeline stage
becomes an AAFP agent, and each edge becomes a UCAN delegation + streaming
RPC channel.

The integration has two directions:

- **Pipeline framework → AAFP:** Airflow/Dagster operators that, instead
  of running a Python function, dispatch the task to an AAFP agent
  discovered by capability. The framework's scheduler becomes a thin
  client of the AAFP graph.
- **AAFP → Pipeline framework:** an adapter agent that wraps Airflow's
  REST API (or Dagster's GraphQL API) and lets AAFP agents trigger DAGs,
  poll for completion, and stream task logs back over AAFP.

### 7.2 Airflow Operator

```python
from airflow.models import BaseOperator
from aafp_sdk import Client, UCAN

class AAFPCapabilityOperator(BaseOperator):
    template_fields = ("capability", "payload", "timeout")

    def __init__(self, capability: str, payload: dict, timeout: int = 300, **kw):
        super().__init__(**kw)
        self.capability = capability
        self.payload = payload
        self.timeout = timeout

    def execute(self, context):
        client = Client.from_env()                       # uses AAFP agent identity
        ucan  = UCAN.from_context(context)               # delegated by the DAG owner
        target = client.dht_lookup(capabilities=[self.capability])
        with client.connect(target, ucan=ucan) as sess:
            stream = sess.rpc(self.capability, self.payload, timeout=self.timeout)
            results = list(stream)                       # consume streaming frames
            context["ti"].xcom_push("aafp_results", results)
            return results[-1].output if results else None
```

The operator is a drop-in replacement for `PythonOperator`/`BashOperator`.
The DAG definition looks identical to a normal Airflow DAG; only the
operator type changes. This lets data teams adopt AAFP incrementally —
one task at a time — without rewriting their pipeline.

### 7.3 Dagster Integration

Dagster's asset-based model maps even better than Airflow's task model.
A Dagster `@asset` can be decorated to resolve via AAFP:

```python
from dagster import asset, Output, MetadataValue
from aafp_sdk import Client

@asset
def cleaned_orders(context):
    client = Client.from_env()
    target = client.dht_lookup(capabilities=["data.clean.orders"])
    with client.connect(target) as sess:
        result = sess.rpc("data.clean.orders", {"source": "raw/orders"}).collect()
        yield Output(result.data, metadata={
            "aafp_agent": MetadataValue.text(result.agent_id),
            "aafp_cost":  MetadataValue.float(result.cost_units),
        })
```

The asset's lineage in Dagster's UI includes the AAFP agent that
produced it, giving full traceability from raw input to final asset.

### 7.4 Spark Bridge

Spark is the heavyweight case. Two integration points:

1. **Spark driver as AAFP agent** — the driver advertises
   `spark.submit.<app>` and accepts job submissions via AAFP RPC. Results
   are streamed back as AAFP streaming frames (one frame per partition
   or per micro-batch for streaming jobs).
2. **Spark executors as AAFP agents** — each executor registers with the
   driver via AAFP instead of the default Akka/RPC transport. This is a
   deeper change (requires a custom Spark scheduler backend) but gives
   executor-to-executor shuffle over QUIC with ML-DSA-65-authenticated
   nodes, which is valuable in multi-tenant clusters where executor
   identity matters.

The first integration is recommended for v1; the second is a research
item for clusters with strong cross-tenant isolation requirements.

### 7.5 Checkpointing and Fault Tolerance

AAFP's Execution Fabric (Track V) provides pipeline checkpointing at the
agent-graph level. When bridging to Airflow/Dagster, the adapter writes
AAFP checkpoints back into the framework's native checkpoint store
(Airflow's XCom, Dagster's run storage) so operators see a single
consistent state. On retry, the adapter reads the checkpoint and resumes
the AAFP streaming RPC from the last acknowledged frame rather than
re-running the whole stage.

---

## 8. AAFP ↔ Identity Provider (Keycloak/Auth0/Okta)

### 8.1 The OAuth/OIDC ↔ UCAN Bridge

This is the highest-leverage integration for enterprise adoption.
Enterprises already have an identity provider (IdP) — Keycloak
(self-hosted), Auth0/Okta (SaaS), or Azure AD. These issue OAuth2 access
tokens and OIDC ID tokens signed with RSA/ECDSA and scoped with
`scope`/`aud` claims. AAFP uses UCAN tokens signed with ML-DSA-65 and
scoped with `resource`/`action`/`constraints`. The bridge converts one
to the other.

### 8.2 Bridge Architecture

```
   ┌──────────────┐     OAuth2      ┌──────────────────┐
   │  User / SPA  │────password────▶│  Keycloak / Okta  │
   │              │     flow        │  (IdP)            │
   └──────┬───────┘                 └────────┬─────────┘
          │                                  │
          │ access_token (RS256)             │ JWKS
          ▼                                  ▼
   ┌──────────────────────────────────────────────────┐
   │          AAFP IdP Bridge Agent                    │
   │                                                    │
   │  1. validate access_token against IdP JWKS         │
   │  2. extract scopes, sub, aud, exp                  │
   │  3. map scopes → UCAN capabilities                 │
   │  4. mint UCAN token signed with bridge's           │
   │     ML-DSA-65 key (delegated by root)              │
   │  5. return UCAN to caller                          │
   │                                                    │
   │  AgentId: AAFP-IDP-BRIDGE-...                      │
   │  Caps:   [identity.mint.ucan]                      │
   └──────────────────────┬─────────────────────────────┘
                          │ UCAN token (ML-DSA-65)
                          ▼
                   ┌────────────────┐
                   │  Any AAFP agent │
                   │  (verifies the │
                   │   UCAN chain)   │
                   └────────────────┘
```

### 8.3 Scope-to-Capability Mapping

The bridge is configured with a mapping table per IdP client/audience:

```yaml
idp: keycloak
realm: production
audience: aafp-clients
mappings:
  - scope: "research:read"
    capability: { resource: "research.results", action: "read" }
  - scope: "research:write"
    capability: { resource: "research.experiments", action: "write" }
  - scope: "admin:*"
    capability: { resource: "*", action: "*" }   # requires IdP-side admin role
```

The bridge **never** grants a capability that the root AAFP identity has
not delegated to it. The IdP controls *who* gets which scopes; the AAFP
root controls *what those scopes mean* in capability space. This is a
two-party authorization model: neither the IdP alone nor the AAFP root
alone can grant access — both must agree.

### 8.4 Token Lifetime and Refresh

OAuth2 access tokens are short-lived (5-60 min). UCAN tokens can have
independent lifetimes. The bridge's default is to set the UCAN
`expires_at` equal to the OAuth token's `exp`, so the UCAN becomes
invalid when the OAuth token does. For longer-lived agent workflows,
the bridge supports a **refresh mode**: the caller presents a refresh
token, the bridge mints a new UCAN with a fresh `expires_at` and a
`proof` linking back to the original chain, preserving auditability.

### 8.5 Keycloak, Auth0, Okta Specifics

- **Keycloak:** self-hosted, supports custom protocol mappers. A
  Keycloak protocol mapper can embed the UCAN token directly into the
  access token's `claims` as a nested field, skipping the bridge call
  for the common case. The mapper calls the bridge agent over AAFP to
  mint the UCAN, then stuffs it into the JWT.
- **Auth0:** Rules/Actions (post-login hooks) can call the bridge via
  an outbound HTTP request. Auth0's token enrichment is the same pattern
  as Keycloak's mapper.
- **Okta:** Okta Workflows or an inline hook performs the bridge call.
  Okta's SAML support is also relevant: for federated enterprises, the
  bridge can accept SAML assertions and mint UCANs from them, enabling
  SSO into the AAFP agent graph.

### 8.6 Revocation

OAuth2 has refresh-token revocation and (with RFC 7009) access-token
revocation. UCAN has no built-in revocation (it's a capability chain,
not a bearer token). The bridge handles this by maintaining a
**revocation list** of OAuth `jti` claims that have been revoked. Every
AAFP agent that accepts a bridge-minted UCAN must check the `jti`
against the bridge's revocation endpoint (cached locally with a short
TTL). This is the one place where AAFP's pure-capability model requires
a fallback to a revocation check — it's the price of bridging to a
bearer-token world.

---

## 9. AAFP ↔ Monitoring (Datadog/New Relic/Splunk)

### 9.1 Metrics Export

AAFP agents already expose Prometheus-format metrics on TCP 9090 (see
`PRODUCTION_DEPLOYMENT.md` §11). Every enterprise monitoring stack can
scrape Prometheus endpoints:

- **Datadog:** the Datadog Agent's `prometheus` check scrapes `:9090/metrics`
  and maps metric names to Datadog tags. AAFP's standard tags
  (`agent_id`, `session_id`, `capability`, `peer_agent_id`) become
  Datadog dimensions automatically.
- **New Relic:** the Prometheus OpenMetrics integration does the same,
  with NRQL queryability over the resulting dimensions.
- **Splunk:** Splunk's `splunk-prometheus` add-on or the OTel collector
  scrapes and forwards. Splunk's strength is correlating AAFP metrics
  with the SIEM events from §10.

### 9.2 Distributed Tracing

AAFP's streaming RPC (RFC-P2.8) carries trace context in session
extensions: a `traceparent` header (W3C Trace Context format) is
propagated through the AAFP handshake and every RPC frame. The adapter
agents emit OpenTelemetry spans for:

- **Handshake** (span name `aafp.handshake`, attributes: peer_agent_id,
  key_algorithm, duration_ms)
- **RPC call** (`aafp.rpc.<capability>`, attributes: capability,
  request_size, response_frames, status)
- **PubSub publish** (`aafp.pubsub.publish`, attributes: topic,
  message_size, subscriber_count)
- **DHT lookup** (`aafp.dht.lookup`, attributes: query, results,
  hop_count)

These spans are exported via OTLP to any OTel-compatible backend
(Datadog, Honeycomb, Tempo, Jaeger, Splunk APM). The trace ID is
preserved across the AAFP ↔ enterprise boundary: when an API gateway
(§4) translates an HTTP request to an AAFP RPC, it propagates the
incoming `traceparent` into the AAFP session, so a single trace spans
browser → gateway → AAFP agent → database adapter → Postgres.

### 9.3 Custom AAFP Dashboards

Recommended baseline dashboards (portable across Datadog/NR/Splunk):

| Dashboard | Panels |
|-----------|--------|
| Agent Fleet Overview | agent count by capability, DHT peer count, handshake rate/success, P99 handshake latency |
| Session Health | active sessions, session duration distribution, CLOSE reason breakdown |
| RPC Performance | RPS by capability, P50/P95/P99 latency, error rate by `error_code` |
| PubSub Throughput | messages/sec per topic, subscriber lag, gossip mesh diameter |
| Adapter Bridge | native-side latency, native error rate, bridge queue depth, UCAN delegation cache hit rate |
| Cost & Economics | cost units consumed per agent (Track Y), top callers, budget burn rate |

### 9.4 Alerting

Baseline alerts (all map to the standard `alertmanager` / Datadog
monitor / NR alert condition primitives):

- `aafp_handshake_failure_rate > 5%` over 5m → page SRE
- `aafp_rpc_p99 > 2s` for any capability over 10m → warn owning team
- `aafp_dht_peer_count < 10` for any agent → page (network partition
  suspected)
- `aafp_adapter_native_error_rate > 1%` → warn adapter owner
- `aafp_ucan_delegation_cache_hit_rate < 80%` → warn IdP bridge owner
  (cache too small or token churn too high)

---

## 10. AAFP ↔ SIEM (Splunk/Elastic)

### 10.1 Security Event Logging

Every AAFP security-relevant event is emitted as a structured JSON log
line on stdout (collected by the node's log shipper — Fluent Bit,
Filebeat, or Splunk Universal Forwarder) and/or pushed directly via the
SIEM's HTTP event API. The event schema:

```json
{
  "ts": "2026-07-05T14:22:01.234Z",
  "agent_id": "AAFP-KJNGX4ZT-...",
  "peer_agent_id": "AAFP-PNQX7K2M-...",
  "event": "handshake.completed",
  "session_id": "a4f3...e91b",
  "key_algorithm": "ml-dsa-65",
  "peer_endpoints": ["quic://10.0.0.7:4433"],
  "ucan_chain_depth": 3,
  "ucan_root": "AAFP-ROOT-...",
  "capabilities_granted": ["postgres.query.public.users"],
  "capabilities_denied": [],
  "duration_ms": 47,
  "outcome": "success"
}
```

### 10.2 Event Taxonomy

| Event | When | SIEM use |
|-------|------|----------|
| `handshake.started` | ClientHello sent/received | Connection audit trail |
| `handshake.completed` | Session established | Baseline of legitimate peers |
| `handshake.failed` | Any handshake error | **Anomaly detection** — spike indicates scan/attack |
| `ucan.delegated` | Bridge mints a UCAN | Track authority propagation |
| `ucan.denied` | Capability check fails | **Security alert** — attempted privilege escalation |
| `rpc.invoked` | Streaming RPC starts | Data access audit |
| `rpc.denied` | RPC rejected by authorization | **Security alert** |
| `pubsub.published` | Message published to topic | Data exfiltration monitoring |
| `dht.record.published` | AgentRecord published | Fleet inventory |
| `dht.record.revoked` | Tombstone broadcast | Fleet inventory |
| `session.closed` | CLOSE state machine completes | Session duration analytics |
| `session.aborted` | Abnormal close | **Anomaly detection** |
| `adapter.native_error` | Bridge native call failed | Operational + security correlation |

### 10.3 Splunk Integration

The Splunk Universal Forwarder monitors the AAFP pod's stdout log file
(when running on Kubernetes with JSON log format) and forwards to the
Splunk indexer. A recommended `props.conf`:

```ini
[source::.../aafp-*.log]
sourcetype = aafp:json
INDEXED_EXTRACTIONS = json
KV_MODE = json
TIMESTAMP_FIELDS = ts
SHOULD_LINEMERGE = false
TRUNCATE = 65536
```

Key SPL searches for the SOC:

```splunk
index=aafp sourcetype=aafp:json event="handshake.failed"
| stats count by peer_agent_id, agent_id
| where count > 10
| sort -count
```
→ detects a single peer attempting repeated failed handshakes (possible
stolen-key probing or DoS).

```splunk
index=aafp event="ucan.denied"
| table _time, agent_id, peer_agent_id, capabilities_denied, ucan_root
```
→ every denied capability escalation, for review.

### 10.4 Elastic Integration

Elastic's Beats (Filebeat) ship the same JSON logs to Elasticsearch.
The AAFP ECS (Elastic Common Schema) mapping normalizes `agent_id` to
`event.actor`, `peer_agent_id` to `event.target`, `capabilities_granted`
to `event.action`. Kibana detection rules mirror the Splunk searches
above. Elastic's SIEM (now part of Elastic Security) can correlate AAFP
events with endpoint, network, and cloud logs for full attack-chain
analysis.

### 10.5 Tamper Resistance

Because AAFP logs are signed by the emitting agent (each log batch
includes an ML-DSA-65 signature over the batch hash), the SIEM can
verify that logs were not tampered with in transit. A forwarder that
drops or alters lines will break the signature chain, detectable by a
periodic verification job. This is stronger than typical syslog
integrity and is one of AAFP's differentiators for regulated industries
(FedRAMP, SOC 2, HIPAA audit logs).

---

## 11. AAFP ↔ Cloud Provider (AWS/GCP/Azure)

### 11.1 Agent Deployment on Cloud Infra

AAFP agents are cloud-agnostic processes, but each cloud offers native
services that the agent can either consume (via adapter agents) or be
deployed onto. The integration has three layers:

1. **Compute** — where the agent process runs
2. **Networking** — how agents reach each other across cloud boundaries
3. **Managed services** — cloud-specific services wrapped as capabilities

### 11.2 Compute

| Cloud | Service | AAFP fit |
|-------|---------|----------|
| AWS | EKS (managed k8s) | Primary target — see §2 Kubernetes integration |
| AWS | ECS Fargate | Works for stateless adapters; QUIC/UDP supported on awsvpc mode |
| AWS | Lambda | Cold-start penalty; use with HTTP gateway bridge (§4.5) only |
| GCP | GKE (managed k8s) | Primary target; native UDP load balancing via GKE Gateway |
| GCP | Cloud Run | QUIC not supported on Cloud Run (TCP only) — use TCP fallback transport |
| Azure | AKS (managed k8s) | Primary target |
| Azure | Container Apps | QUIC supported; good for autoscaling adapter agents |

### 11.3 Networking

Cross-cluster AAFP connectivity uses the NAT traversal design (see
`NAT_TRAVERSAL_NETWORKING.md`). Cloud-specific notes:

- **AWS:** Security Groups must allow UDP 4433 inbound on agent pods.
  NLB with UDP listener for cross-VPC; Transit Gateway for multi-region.
  AWS Global Accelerator gives anycast IPs for bootstrap relays.
- **GCP:** Firewall rules allow UDP 4433. Cloud Load Balancing's external
  passthrough Network LB supports UDP. Premium tier routing for
  low-latency cross-region.
- **Azure:** NSG rules allow UDP 4433. Azure Load Balancer supports UDP.
  Azure Front Door does not support UDP — use LB directly for relays.

### 11.4 Managed Services as Capabilities

Each cloud's managed services become AAFP capabilities via adapter
agents:

| Cloud service | AAFP capability | Notes |
|---------------|-----------------|-------|
| AWS S3 | `s3.get/put.objects.<bucket>` | Adapter wraps AWS SDK; presigned URLs returned to caller |
| AWS DynamoDB | `dynamodb.query.<table>` | Like the Postgres adapter but for key-value |
| AWS SQS | `sqs.send/receive.<queue>` | Bridged to AAFP PubSub (like Kafka bridge, §5) |
| AWS Kinesis | `kinesis.put/get.<stream>` | Bridged to AAFP streaming RPC |
| AWS KMS | `kms.encrypt/decrypt.<key>` | For envelope encryption of agent state |
| GCS | `gcs.get/put.objects.<bucket>` | Analogous to S3 |
| BigQuery | `bigquery.query.<dataset>` | Streaming RPC returns query results as frames |
| Pub/Sub | `gcp.pubsub.<topic>` | Bidirectional bridge to AAFP PubSub |
| Azure Blob | `blob.get/put.<container>` | Analogous to S3 |
| Cosmos DB | `cosmos.query.<container>` | Multi-model adapter (SQL/Mongo/Cassandra API) |

### 11.5 Cloud Identity Bridging

Cloud IAM (AWS IAM, GCP IAM, Azure AD) is separate from the application
IdP (§8). The adapter agent authenticates to the cloud using
short-lived credentials from the cloud's workload identity service
(IAM Roles for Service Accounts on EKS, Workload Identity on GKE,
Workload Identity on AKS). The adapter never holds long-lived cloud
keys — it exchanges its Kubernetes service-account token for cloud
credentials at startup and refreshes them on a timer. This means the
cloud trust is rooted in the cluster's OIDC provider, while the AAFP
trust is rooted in ML-DSA-65 — two independent roots, both required.

---

## 12. AAFP ↔ SaaS (Salesforce/ServiceNow/Jira)

### 12.1 SaaS Wrapping Pattern

SaaS applications expose REST APIs with their own auth (OAuth2 for
Salesforce/ServiceNow, API tokens for Jira). The AAFP integration wraps
each SaaS API as a set of capabilities exposed by a SaaS adapter agent.
This is the same outbound bridge as the database case (§6) but with
REST + OAuth instead of a database driver.

```
   Agent (any)              Salesforce Adapter           Salesforce
       │                        │                          │
       │ DHT lookup             │                          │
       │ caps: salesforce.read  │                          │
       │───────────────────────▶│                          │
       │                        │                          │
       │ UCAN delegate          │                          │
       │ salesforce.read.account│                          │
       │───────────────────────▶│                          │
       │                        │ verify UCAN              │
       │                        │ refresh OAuth token      │
       │                        │ (stored in TrustManager) │
       │                        │                          │
       │ RPC: read account      │                          │
       │  filter: {industry:...}│                          │
       │───────────────────────▶│ GET /services/data/v60/  │
       │                        │   sobjects/Account?...   │
       │                        │─────────────────────────▶│
       │                        │ 200 OK (paginated)       │
       │                        │◀─────────────────────────│
       │ streaming RPC frames   │                          │
       │◀───────────────────────│                          │
```

### 12.2 Salesforce Adapter

Capabilities exposed:

- `salesforce.read.<sobject>` — SOQL query or REST GET
- `salesforce.write.<sobject>` — create/update/upsert
- `salesforce.delete.<sobject>` — delete
- `salesforce.search` — SOSL search
- `salesforce.stream.<channel>` — Platform Events / CDC → AAFP PubSub

The adapter holds the Salesforce connected-app OAuth credentials in
`TrustManager` (RFC-0011) and refreshes the access token automatically.
Each AAFP caller presents a UCAN that the adapter maps to a Salesforce
object-level permission check (in addition to the UCAN check, the
adapter verifies the caller against Salesforce's own sharing rules by
executing the query as the integration user and letting Salesforce
enforce row-level security).

### 12.3 ServiceNow Adapter

ServiceNow's REST API (`/api/now/table/<table>`) maps to capabilities
`servicenow.read/write.<table>`. The adapter additionally exposes
`servicenow.workflow.<name>` to trigger workflows and
`servicenow.event.<stream>` to bridge Business Rule events to AAFP
PubSub. This enables agents to react in real time to ticket state
changes without polling.

### 12.4 Jira Adapter

Jira capabilities:

- `jira.read.issue` / `jira.write.issue` — CRUD on issues
- `jira.read.project` / `jira.write.project` — project config
- `jira.transition.<project>` — workflow transitions
- `jira.webhook.<event>` — Jira webhooks bridged to AAFP PubSub

The Jira adapter is particularly useful for agent-driven incident
management: an AAFP monitoring agent (§9) detects an anomaly, opens a
Jira ticket via the adapter, and delegates the `jira.transition` for
that ticket to a remediation agent that closes the ticket once the
issue resolves. The entire workflow is auditable via the UCAN chain
(who delegated what to whom) and the SIEM logs (§10).

### 12.5 Rate Limiting and API Quotas

SaaS APIs enforce rate limits (Salesforce: 100k req/hour per license,
Jira: varies by endpoint). The adapter tracks usage per caller via the
UCAN `subject` field and applies AAFP's distributed rate limiting
(RFC-0015) so that the aggregate agent graph never exceeds the SaaS
quota. When the quota is near, the adapter returns `RESOURCE_EXHAUSTED`
with a `retry_after` hint; the adaptive routing plane (Track T) can
hedge to a second SaaS tenant or queue the request.

---

## 13. Top 5 Architecture Diagrams and Data Flow

This section presents full end-to-end architecture diagrams and
step-by-step data flow for the five highest-leverage integrations:
Kubernetes, Service Mesh, API Gateway, Message Queue, and Identity
Provider.

### 13.1 Kubernetes — Full Operator Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Kubernetes Cluster                                   │
│                                                                             │
│  Developer                  AAFP Operator                AAFP Agent CRs      │
│  ┌──────────┐  kubectl      ┌──────────────┐            ┌──────────────┐    │
│  │  apply   │──── AAFPAgent─▶│  Reconcile   │── watch ──▶│  CR: worker-1│    │
│  │  CR yaml │               │  Loop        │            │  CR: worker-2│    │
│  └──────────┘               └──────┬───────┘            └──────────────┘    │
│                                    │                                        │
│                                    │ patch status                           │
│                                    ▼                                        │
│                             ┌──────────────┐                                │
│                             │  K8s API     │                                │
│                             │  Server      │                                │
│                             └──────┬───────┘                                │
│                                    │ create/scale                           │
│                                    ▼                                        │
│                             ┌──────────────┐                                │
│                             │  StatefulSet │                                │
│                             │  aafp-agent  │                                │
│                             └──────┬───────┘                                │
│                                    │                                        │
│                    ┌───────────────┼───────────────┐                        │
│                    ▼               ▼               ▼                        │
│              ┌──────────┐    ┌──────────┐    ┌──────────┐                  │
│              │  Pod-0   │    │  Pod-1   │    │  Pod-2   │                  │
│              │ AAFP     │    │ AAFP     │    │ AAFP     │                  │
│              │ :4433/udp│    │ :4433/udp│    │ :4433/udp│                  │
│              │ :9090/tcp│    │ :9090/tcp│    │ :9090/tcp│                  │
│              │ id: KJNG │    │ id: PNQX │    │ id: RMST │                  │
│              └─────┬────┘    └─────┬────┘    └─────┬────┘                  │
│                    │               │               │                        │
│                    └───────────────┼───────────────┘                        │
│                                    │ QUIC mesh (DHT + GossipSub)            │
│                                    ▼                                        │
│                          ┌──────────────────┐                               │
│                          │  Headless Svc     │                               │
│                          │  aafp-agent       │                               │
│                          │  UDP 4433         │                               │
│                          └──────────────────┘                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                          ┌──────────────────┐
                          │ Bootstrap Relay   │  (public IP, NAT traversal)
                          │ quic://relay...   │
                          └──────────────────┘
```

**Data flow (agent rollout):**

1. Developer runs `kubectl apply -f agent.yaml` (the CR in §2.2).
2. Operator's watch fires; reconcile loop diffs desired vs. observed.
3. Operator patches the `StatefulSet` to set `replicas: 3` and the new
   `image`.
4. StatefulSet controller creates Pod-2 (new), leaves Pod-0/1 running.
5. Pod-2 starts, loads its ML-DSA-65 key from its Secret mount, opens
   UDP 4433, passes readiness probe.
6. Operator's DHT client publishes Pod-2's `AgentRecord` (signed by
   Pod-2's key) to the DHT.
7. Existing peers discover the new record via DHT refresh; new sessions
   begin routing to Pod-2.
8. Operator patches the CR `status` with `readyReplicas: 3` and the new
   `agentIds`.
9. On the next upgrade, Operator drains Pod-0: it sends a CLOSE to
   Pod-0's active sessions (graceful shutdown, §8 of
   `PRODUCTION_DEPLOYMENT.md`), waits for session count to reach zero,
   then deletes Pod-0 and revokes its DHT record via tombstone.

### 13.2 Service Mesh — mTLS Coexistence

```
                    External Service (HTTP)
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Istio Control Plane                                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ istiod      │  │ Pilot       │  │ Citadel     │             │
│  │ (xDS server)│  │ (routing)   │  │ (SPIFFE     │             │
│  │             │  │             │  │  SVID mint) │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
└────────────┬────────────────────────────────────────────────────┘
             │ xDS push
             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Agent Pod                                                      │
│  ┌──────────┐  ┌──────────────────────┐  ┌──────────────────┐   │
│  │ AAFP     │  │ Envoy Sidecar        │  │ AAFP Process     │   │
│  │ Process  │  │  TCP 4434 ─ mTLS ────│──│  QUIC 4433 ──────│───┼──▶ mesh
│  │          │  │  (SPIFFE SVID)       │  │  (ML-DSA-65)     │   │   passthrough
│  │          │  │                      │  │                  │   │
│  │  id:     │  │  spiffe://...        │  │  AAFP-KJNG...    │   │
│  │  AAFP-.. │  │  sa/aafp-agent      │  │                  │   │
│  └──────────┘  └──────────────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
        │ TCP mTLS (mesh-enforced)        │ QUIC mTLS (AAFP-enforced)
        ▼                                 ▼
   Enterprise services              Other AAFP agents
   (Postgres, Kafka, ...)           (mesh-passthrough)
```

**Data flow (hybrid-mode call to a Postgres adapter):**

1. AAFP agent process opens a QUIC session to the Postgres adapter
   agent on UDP 4433 — **mesh is bypassed** (PERMISSIVE + port-level
   DISABLE on 4433).
2. AAFP handshake validates the adapter's ML-DSA-65 identity; UCAN
   capability check authorizes `postgres.query.public.users`.
3. The Postgres adapter makes its outbound TCP call to Postgres on port
   5432 — **this egress goes through Envoy**, which enforces mTLS with
   the database's sidecar (or the database's own TLS).
4. Envoy's `AuthorizationPolicy` checks the adapter pod's SPIFFE ID
   against the allowed database service accounts.
5. The response flows back: Postgres → Envoy (mTLS) → adapter → AAFP
   streaming RPC → caller.

Both cryptographic identities are verified independently: AAFP verifies
the adapter's AgentId; the mesh verifies the adapter pod's SPIFFE ID.
A compromise of either root alone is insufficient.

### 13.3 API Gateway — REST to AAFP RPC

```
   Browser                Kong Gateway              AAFP Graph
   ┌────────┐  HTTPS      ┌──────────────────┐      ┌────────────────┐
   │  SPA   │────────────▶│  :443            │      │  LLM Agent      │
   │        │  POST       │  jwt plugin      │      │  AAFP-LLM-...   │
   │        │  /v1/chat   │  aafp plugin     │      └────────────────┘
   │        │             │                  │            ▲
   │        │             │  1. validate JWT │            │ QUIC 4433
   │        │             │  2. map scopes   │            │ streaming RPC
   │        │             │     → UCAN caps  │      ┌────────────────┐
   │        │             │  3. DHT lookup   │─────▶│  Research Agent │
   │        │             │     by cap       │      │  AAFP-RES-...   │
   │        │             │  4. AAFP connect │      └────────────────┘
   │        │             │  5. streaming RPC│            ▲
   │        │             │     → chunked    │            │
   │        │             │     HTTP/2       │      ┌────────────────┐
   │        │             │  6. pipe frames  │─────▶│  DB Adapter     │
   │        │             │     to client    │      │  AAFP-PG-...    │
   │        │◀────────────│                  │      └────────────────┘
   │        │  chunked    │                  │
   │        │  HTTP/2     │                  │
   │        │  X-AAFP-    │                  │
   │        │  Agent: ... │                  │
   └────────┘             └──────────────────┘
```

**Data flow (chat completion request):**

1. Browser sends `POST /v1/chat` with `Authorization: Bearer <JWT>`.
2. Kong's `jwt` plugin validates the JWT against the IdP JWKS.
3. The `aafp-bridge` plugin extracts `scope: chat:write`, maps it to
   UCAN `{resource: "llm.chat", action: "write"}`, and mints (or
   fetches cached) a UCAN delegation from the gateway's AgentId to the
   JWT `sub`.
4. Plugin performs DHT lookup for agents advertising `llm.chat`; gets
   back the LLM agent's `AgentId` + multiaddr.
5. Plugin opens an AAFP session to the LLM agent, presenting the UCAN.
   The LLM agent verifies the chain back to the AAFP root.
6. Plugin issues a streaming RPC `llm.chat` with the request body.
7. LLM agent streams token frames back; plugin writes each frame as an
   HTTP/2 chunk with `X-AAFP-Frame-Seq` header.
8. On the final frame, plugin sends an HTTP trailer
   `X-AAFP-Status: OK` and closes the response.
9. If the LLM agent delegates a tool call to the Research agent (which
   queries the DB adapter), the entire sub-graph call happens over
   AAFP — invisible to the browser, but traceable via the propagated
   `traceparent` (§9.2).

### 13.4 Message Queue — Kafka ↔ AAFP PubSub Mirror

```
   Producer Agent          Kafka Adapter Agent              Kafka Cluster
   ┌──────────┐            ┌────────────────────┐           ┌──────────────┐
   │ AAFP-    │            │  AAFP-KAFKA-...     │           │  broker-1    │
   │ PROD-... │            │                    │           │  broker-2    │
   │          │  PubSub    │  ┌──────────────┐  │  produce  │  broker-3    │
   │  caps:   │  publish   │  │ AAFP GossipSub│──│──────────▶│  topic:     │
   │  order.  │───────────▶│  │ subscriber    │  │           │  orders.     │
   │  create  │            │  └──────────────┘  │           │  events      │
   └──────────┘            │         │          │           │              │
                           │         │ dedup    │  consume  │              │
   Consumer Agent          │         ▼          │◀──────────│  partition:  │
   ┌──────────┐            │  ┌──────────────┐  │           │  0,1,2       │
   │ AAFP-    │            │  │ Offset Map   │  │           └──────────────┘
   │ CONS-... │            │  │ (RocksDB)    │  │
   │          │  PubSub    │  └──────────────┘  │
   │  caps:   │  subscribe │         │          │
   │  order.  │◀───────────│         ▼          │
   │  process │            │  ┌──────────────┐  │
   └──────────┘            │  │ AAFP GossipSub│  │
                           │  │ publisher     │  │
                           │  └──────────────┘  │
                           └────────────────────┘
```

**Data flow (bidirectional mirror):**

*AAFP → Kafka:*
1. Producer agent publishes to AAFP PubSub topic `aafp/orders/events`
   with a signed message envelope.
2. Adapter's GossipSub subscriber receives the message, hashes it,
   checks the Offset Map — if the hash is present, it's a duplicate
   (already produced to Kafka); skip.
3. If new: adapter produces to Kafka topic `orders.events` with headers
   `aafp-agent-id`, `aafp-msg-hash`, `aafp-ucan-root`.
4. On Kafka produce ACK, adapter records `hash → (partition, offset)`
   in the Offset Map and broadcasts the message on the AAFP topic
   (already done in step 1, so consumers see it once).

*Kafka → AAFP:*
5. Adapter's Kafka consumer reads a new offset from `orders.events`.
6. Checks the Offset Map — if the offset is already mirrored, skip.
7. If new: adapter wraps the Kafka message in an AAFP envelope (signed
   by the adapter's AgentId, with the original Kafka headers preserved)
   and publishes to `aafp/orders/events`.
8. Consumer agents subscribed to the topic receive it via GossipSub.
9. Adapter records `offset → hash` in the Offset Map.

The Offset Map makes the bridge idempotent across restarts. Crash
recovery replays from the last checkpointed offset; duplicates are
filtered by the hash check.

### 13.5 Identity Provider — OAuth2 to UCAN

```
   User Browser          Keycloak (IdP)         AAFP IdP Bridge        AAFP Graph
   ┌──────────┐          ┌──────────────┐       ┌──────────────┐      ┌──────────┐
   │          │  1. login│              │       │              │      │  Target  │
   │          │─────────▶│  Realm: prod │       │ AAFP-IDP-... │      │  Agent   │
   │          │  (OAuth2 │  client:     │       │              │      │          │
   │          │   code   │  aafp-app    │       │  caps:       │      │  verifies│
   │          │   flow)  │  scopes:     │       │  identity.   │      │  UCAN    │
   │          │          │  research:r  │       │  mint.ucan   │      │  chain   │
   │          │◀─────────│              │       │              │      │          │
   │          │  2.      │              │       │              │      │          │
   │          │  access_ │              │       │              │      │          │
   │          │  token   │              │       │              │      │          │
   │          │  (RS256) │              │       │              │      │          │
   └────┬─────┘          └──────────────┘       └──────────────┘      └──────────┘
        │                                        ▲
        │ 3. POST /aafp/ucan                     │
        │    Authorization: Bearer access_token  │
        │    body: { target_capability:          │
        │            "research.read" }           │
        │─────────────────────────────────────────│
        │                                        │
        │              4. validate JWT vs JWKS   │
        │              5. map scope → UCAN cap   │
        │              6. mint UCAN (ML-DSA-65)  │
        │                  proof: root delegation│
        │                  exp: token.exp        │
        │                                        │
        │ 7. return UCAN token (CBOR)            │
        │◀────────────────────────────────────────│
        │
        │ 8. AAFP session + UCAN
        │───────────────────────────────────────────────────────▶
        │                                                        │
        │                              9. verify UCAN chain,     │
        │                                 check revocation list, │
        │                                 execute capability     │
        │◀───────────────────────────────────────────────────────│
        │ 10. streaming RPC response
```

**Data flow (UCAN minting):**

1. User authenticates to Keycloak via standard OAuth2 authorization
   code flow; receives an RS256-signed access token with
   `scope: research:read` and `aud: aafp-app`.
2. Browser (or server-side agent) extracts the access token.
3. Caller POSTs to the IdP Bridge's HTTP endpoint
   (`/aafp/ucan`) with the access token as bearer and the desired
   target capability in the body.
4. Bridge fetches Keycloak's JWKS and validates the JWT signature,
   `exp`, `aud`, and `iss`.
5. Bridge looks up the scope mapping (§8.3): `research:read` →
   `{resource: "research.results", action: "read"}`.
6. Bridge mints a UCAN token signed with its ML-DSA-65 key. The UCAN's
   `issuer` is the bridge's AgentId; `subject` is derived from the JWT
   `sub` (hashed to a stable AgentId for that user); `proof` links to
   the root's delegation to the bridge; `expires_at` equals the JWT
   `exp`.
7. Bridge returns the UCAN as a CBOR blob (base64 in JSON for HTTP
   transport).
8. Caller opens an AAFP session to the target agent, presenting the
   UCAN in the handshake's `extensions` field.
9. Target agent verifies the UCAN chain recursively back to the root,
   checks the bridge's `jti` against the cached revocation list (§8.6),
   and — if all pass — authorizes the capability.
10. Target agent executes the RPC and streams the result back.

The security property: the user never holds an AAFP private key. The
bridge is the key custodian for browser-based callers. For
service-to-service agents that *do* have their own ML-DSA-65 keys, the
bridge is bypassed entirely — those agents mint their own UCANs from a
direct root delegation. The bridge exists only to let non-AAFP-native
clients (browsers, legacy services) participate in the capability graph.

---

## 14. Cross-Cutting Concerns

### 14.1 Observability Correlation

Every integration contributes to a single observability spine:

- **Trace ID** (W3C `traceparent`) propagates: HTTP request → gateway →
  AAFP session → adapter → native call. One trace, one query, in any
  backend.
- **AgentId** appears as a dimension in metrics, a field in logs, and a
  span attribute in traces. Correlating "what did agent X do" is a
  single filter across all three signals.
- **UCAN root** in logs lets the SIEM trace any action back to the
  originating human or service identity (via the IdP bridge's mapping
  table).

### 14.2 Failure Isolation

Each adapter is an independent failure domain. The AAFP graph's adaptive
routing plane (Track T) treats adapter agents like any other: circuit
breakers open on repeated native failures, hedging sends a duplicate
request to a replica adapter, and fallback chains (Track T4) route to
an alternative capability provider if one adapter is down. No single
adapter is a single point of failure for the graph — provided the
enterprise runs at least two instances of each adapter (standard
Kubernetes `replicas: 2+`).

### 14.3 Security Boundary Summary

| Boundary | AAFP side | Enterprise side | Both required? |
|----------|-----------|-----------------|----------------|
| Agent ↔ Agent | ML-DSA-65 handshake | — | Yes (AAFP only) |
| Agent ↔ Adapter | UCAN capability check | Native auth (Kafka ACL, Postgres ROLE, SaaS OAuth) | Yes |
| Gateway ↔ Client | UCAN (minted from OAuth) | OAuth2/JWT | Yes |
| Pod ↔ Pod (mesh) | AAFP QUIC crypto | SPIFFE mTLS | Hybrid mode: both |
| Adapter ↔ Cloud | UCAN delegation | Cloud IAM (workload identity) | Yes |
| SIEM ↔ Logs | ML-DSA-65 batch signature | Forwarder TLS | Yes (signature detects tamper) |

### 14.4 Performance Envelope

Adapter overhead is dominated by the native call, not the AAFP
translation. Measured targets (from `PERFORMANCE_REPORT.md` baseline +
adapter profiling):

| Adapter | Native call P99 | AAFP translation overhead | Total P99 |
|---------|-----------------|---------------------------|-----------|
| Postgres query | 8 ms | 0.4 ms | 8.4 ms |
| Kafka produce | 3 ms | 0.6 ms | 3.6 ms |
| Salesforce REST | 120 ms | 0.5 ms | 120.5 ms |
| S3 PUT (1 MB) | 45 ms | 0.8 ms | 45.8 ms |
| Redis GET | 0.5 ms | 0.3 ms | 0.8 ms |

Translation overhead is <1 ms in all cases because the adapter does no
serialization beyond CBOR encoding of the AAFP envelope (the native
payload is passed through byte-for-byte, per ADR-0002).

### 14.5 Versioning and Compatibility

Each adapter declares the minimum AAFP protocol version and the native
API version it supports in its `AgentRecord` extensions:

```json
{
  "aafp_protocol_min": "1.0",
  "native_api": "kafka:3.5+",
  "adapter_version": "0.4.1"
}
```

Callers check compatibility before connecting. When the native API
changes (e.g. Salesforce API v59 → v60), the adapter is upgraded and
publishes a new record; old callers that require v59 are routed to a
legacy adapter instance still running the old version. This is the same
multi-version coexistence pattern AAFP uses for its own protocol
versions (RFC-0001 §11).

---

## 15. Integration Maturity Matrix

| Integration | Pattern | Reference impl | Effort | Priority |
|-------------|---------|----------------|--------|----------|
| Kubernetes (CRD + Operator) | Lifecycle + discovery | Rust operator via `kube-rs` | Medium | P0 |
| Service Mesh (Istio/Linkerd) | Passthrough + hybrid | Annotations + `PeerAuthentication` | Low | P0 |
| API Gateway (Kong) | Inbound bridge | Lua plugin + AAFP Rust SDK FFI | Medium | P0 |
| Message Queue (Kafka) | Bidirectional mirror | Rust adapter + `rdkafka` | Medium | P0 |
| Identity Provider (Keycloak) | OAuth → UCAN bridge | Rust service + Keycloak mapper | High | P0 |
| Database (Postgres) | Outbound bridge | Rust adapter + `tokio-postgres` | Medium | P1 |
| Database (Redis) | Outbound bridge | Rust adapter + `deadpool-redis` | Low | P1 |
| Database (MongoDB) | Outbound bridge | Rust adapter + `mongodb` driver | Medium | P1 |
| Monitoring (Datadog) | Prometheus scrape | Datadog Agent config | Low | P1 |
| Monitoring (OTel traces) | OTLP export | `opentelemetry` crate | Low | P1 |
| SIEM (Splunk) | Log shipping + SPL | UF + `props.conf` | Low | P1 |
| SIEM (Elastic) | Beats + ECS mapping | Filebeat + ingest pipeline | Low | P1 |
| Cloud (AWS S3/DynamoDB/SQS) | Outbound bridge | AWS SDK Rust | Medium | P2 |
| Cloud (GCP GCS/BigQuery/PubSub) | Outbound bridge | Google Cloud Rust | Medium | P2 |
| Cloud (Azure Blob/Cosmos) | Outbound bridge | Azure SDK Rust | Medium | P2 |
| SaaS (Salesforce) | Outbound bridge | `reqwest` + OAuth refresh | Medium | P2 |
| SaaS (ServiceNow) | Outbound bridge | `reqwest` + OAuth | Medium | P2 |
| SaaS (Jira) | Outbound bridge | `reqwest` + API token | Low | P2 |
| Data Pipeline (Airflow) | Custom Operator | Python `aafp-sdk` | Low | P2 |
| Data Pipeline (Dagster) | Asset decorator | Python `aafp-sdk` | Low | P2 |
| Data Pipeline (Spark) | Driver bridge | Scala adapter (v1) | High | P3 |
| Message Queue (RabbitMQ) | Bidirectional mirror | Rust adapter + `lapin` | Medium | P3 |
| Message Queue (NATS) | Bidirectional mirror | Rust adapter + `async-nats` | Low | P3 |
| Service Mesh (Consul) | Passthrough | Consul intentions | Low | P3 |
| API Gateway (Envoy) | WASM filter | C++/Rust WASM | High | P3 |
| API Gateway (AWS API GW) | Lambda bridge | Rust custom runtime | Medium | P3 |
| Identity Provider (Auth0) | Rule + bridge call | Node rule + HTTP | Medium | P2 |
| Identity Provider (Okta) | Inline hook + bridge | HTTP call | Medium | P2 |
| Identity Provider (Azure AD) | Extension + bridge | HTTP call | Medium | P2 |

### 15.1 Recommended Adoption Sequence

1. **Phase 1 (P0):** Kubernetes operator + service mesh passthrough +
   Kong gateway + Kafka bridge + Keycloak bridge. These five let an
   enterprise run AAFP agents in production, expose them to non-AAFP
   clients, mirror events to existing queues, and let users authenticate
   with their existing SSO. This is the minimum viable enterprise
   deployment.
2. **Phase 2 (P1):** Database adapters (Postgres/Redis/Mongo) +
   monitoring (Datadog/OTel) + SIEM (Splunk/Elastic). These make agents
   useful for real work and observable by existing teams.
3. **Phase 3 (P2):** Cloud managed services + SaaS adapters + data
   pipeline operators. These extend the agent graph to cover the full
   enterprise surface area.
4. **Phase 4 (P3):** Spark deep integration, alternative message queues,
   alternative gateways. These are long-tail completeness items.

### 15.2 Open Questions

- **Spark executor-as-agent (§7.4 option 2):** is the custom scheduler
  backend worth the maintenance cost for cross-tenant clusters, or is
  the driver-only bridge sufficient for all realistic deployments?
- **UCAN revocation (§8.6):** the revocation-list approach is a
  pragmatic compromise but reintroduces a central check. Should AAFP
  define a native revocation extension (a signed tombstone propagated
  via PubSub) to eliminate the bridge's revocation endpoint entirely?
- **Mesh TCP-bridged mode (§3.1 option 2):** the double-encryption
  overhead is measurable (~15% on small RPCs). Is there a way to
  negotiate "AAFP crypto is sufficient, mesh skips its own mTLS" via a
  SPIFFE extension, so hybrid mode has zero crypto overhead?
- **SaaS API quota sharing (§12.5):** RFC-0015's distributed rate
  limiting assumes cooperative agents. When the SaaS quota is a hard
  external limit, should the adapter enforce it unilaterally (breaking
  the cooperative model) or broadcast the limit and trust the graph?

These are tracked as research items in the implementation plan backlog
and will be resolved before each corresponding adapter ships as stable.

---

*End of document. For implementation details of each adapter, see the
corresponding track in `implementation-plans/` and the adapter source in
`implementations/adapters/` (to be created in Phase 2).*
