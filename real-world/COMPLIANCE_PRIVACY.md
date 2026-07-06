# AAFP Regulatory Compliance & Privacy

**Status:** Research Document
**Track:** Real-World Deployment
**Date:** 2025-01-15
**Depends on:** `AGENT_RECORD_EXTENSIONS.md` (GeoExtension, attestation model),
`RFCs/0002-transport-framing.md` (QUIC/TLS 1.3, channel binding),
`RFCs/0003-identity-authentication.md` (AgentId, UCAN capability chains),
`implementations/rust/docs/THREAT_MODEL.md` (assets, attack surfaces),
`implementation-plans/track-f-production/F3-revocation-mechanism.md` (CRL)
**Affects:** Relay operators, federation operators, AAFP deployment operators,
`crates/aafp-discovery` (data residency enforcement), `crates/aafp-identity`
(audit logging, consent, revocation)

---

## 1. Executive Summary

AAFP (Agent-to-Agent Federated Protocol) is a decentralized, peer-to-peer
protocol in which autonomous software agents discover one another, mutually
authenticate, delegate capabilities, and exchange messages over QUIC. Because
agents routinely carry personal data, health information, commercial secrets,
and credentials across jurisdictional boundaries, any real-world AAFP
deployment must satisfy a layered set of regulatory obligations:

- **GDPR** (EU General Data Protection Regulation) for personal data and the
  right to erasure.
- **HIPAA** (US Health Insurance Portability and Accountability Act) for
  protected health information flowing through healthcare agent federations.
- **SOC 2 Type II** for the trust-service principles that relay and federation
  operators must demonstrate to enterprise customers.
- **EU AI Act** for the transparency, capability documentation, and audit
  trail obligations that apply to AI agents acting as autonomous actors.

This document maps each regulatory regime onto concrete AAFP mechanisms:
the `GeoExtension` data-residency constraints, UCAN capability chains as
consent tokens, ML-DSA-65 signed audit trails, DHT record TTLs as retention
controls, and CRL-based revocation as the technical substrate for the right
to be forgotten. It concludes with a deployable compliance checklist.

A core thesis of this document is that **AAFP's decentralized architecture is
not inherently non-compliant** — it is *differently* compliant. Where a
centralized SaaS provider satisfies GDPR by holding all data in one controlled
database, an AAFP federation satisfies it by (a) cryptographically binding
data to consent tokens that travel with the data, (b) enforcing residency at
the routing layer so data never enters a non-compliant jurisdiction, and (c)
making erasure achievable by revoking the consent tokens and purging the
signed records that reference the data subject. The compliance burden shifts
from "centralized storage control" to "cryptographic and routing-layer
enforcement," which is in many ways *stronger* because it does not depend on
the operator's promise alone.

---

## 2. Regulatory Landscape Overview

### 2.1 Regulations in Scope

| Regulation | Jurisdiction | Core Concern | AAFP Relevance |
|------------|--------------|--------------|-----------------|
| GDPR | EU/EEA | Personal data protection, consent, erasure | Agent identity, DHT records, cross-border routing |
| HIPAA | US | Protected Health Information (PHI) confidentiality | Healthcare agent federations, audit logs |
| SOC 2 Type II | Global (enterprise) | Security, availability, confidentiality, privacy | Relay operators, federation controllers |
| EU AI Act | EU | AI system transparency, risk management, auditability | AI agents as autonomous actors, capability disclosure |
| CCPA / CPRA | US-CA | Consumer privacy, right to delete | Data residency for US-CA, erasure |
| PIPL | China | Personal information, cross-border transfer | Data residency, cross-border routing |
| LGPD | Brazil | Personal data protection | Similar to GDPR |

### 2.2 The Decentralized Compliance Challenge

A centralized service has a single controller that owns the database and can
delete a row on request. AAFP has no central database — the `AgentRecord`
(defined in RFC-0003 §3 and extended in `AGENT_RECORD_EXTENSIONS.md`) is
replicated across a Kademlia DHT with `REPLICATION_FACTOR = 5` (k=5 closest
peers). This means:

1. **No single point of deletion.** A record exists on up to 5 (or more)
   nodes simultaneously. Erasure requires purging all replicas.
2. **No single controller.** Each agent is its own data controller for the
   records it publishes. Federation operators are *processors* or *joint
   controllers* depending on the deployment model.
3. **Cryptography is the compliance boundary.** Because there is no central
   ACL, compliance is enforced by signatures (record authenticity),
   capability chains (consent), and routing rules (residency).

### 2.3 Roles Under GDPR

| GDPR Role | AAFP Mapping |
|-----------|--------------|
| **Data Subject** | The human (or organization) represented by an agent. The AgentId is a pseudonymous identifier derived from the agent's public key (`SHA-256(public_key)`). |
| **Data Controller** | The entity that determines the purposes and means of processing. For a self-published agent, the agent operator. For a federation, the federation operator may be a joint controller. |
| **Data Processor** | Relay operators, DHT node operators that store records on behalf of others. They process data per the protocol rules, not for their own purposes. |
| **Personal Data** | AgentId (pseudonymous), GeoExtension coordinates (if published), capability metadata that reveals identity, audit logs containing AgentIds. |

---

## 3. GDPR Compliance for Agent-to-Agent Communication

### 3.1 Data Residency

GDPR Article 44–49 restricts transfers of personal data outside the EEA.
In AAFP, "transfer" occurs whenever a message or DHT record crosses a
jurisdictional boundary. The `GeoExtension` (namespace `"aafp.geo.v1"`,
defined in `AGENT_RECORD_EXTENSIONS.md` §5.1) provides the enforcement
substrate:

```rust
pub struct GeoExtension {
    pub version: u64,
    pub country: Option<String>,        // ISO 3166-1 alpha-2
    pub region: Option<String>,         // ISO 3166-2
    pub lat_micro_deg: Option<i32>,
    pub lon_micro_deg: Option<i32>,
    pub continent: Option<String>,
    pub data_residency: Vec<String>,    // jurisdictions where data MUST stay
}
```

The `data_residency` field is a list of jurisdiction codes (e.g.,
`["EU", "US-CA"]`) declaring that data associated with this agent MUST NOT
leave the listed jurisdictions. This is the machine-readable equivalent of
a GDPR data-localization mandate.

**Enforcement model:** A sending agent, before routing an RPC to a peer,
inspects the peer's `GeoExtension`. If the peer's `country`/`continent` is
not in the sender's `data_residency` allow-list, the sender MUST refuse to
route. This is a *pre-transfer* check, not a post-hoc audit. See §6 for the
full enforcement algorithm.

**Adequacy decisions:** The EU Commission maintains a list of "adequate"
countries (Article 45). AAFP deployments SHOULD encode the current adequacy
list as a configuration file consumed by the residency checker, so that
routing to an adequate country is permitted even without SCCs (Standard
Contractual Clauses). The configuration is operator-maintained because
adequacy decisions change.

### 3.2 Right to Erasure (Article 17)

GDPR Article 17 grants the data subject the right to obtain erasure of
personal data "without undue delay." In AAFP, personal data is distributed
across:

1. **DHT records** — the `AgentRecord` and its extensions, replicated to
   k=5 nodes.
2. **Attestations** — third-party signed documents stored under
   `SHA-256(b"aafp-attestation" || subject || attester)` keys.
3. **Audit logs** — every RPC recorded with AgentIds (see §8).
4. **Session caches** — peer AgentIds, public keys, and capability metadata
   held in `Session` state and `KeyDirectory` caches.
5. **Relay reservations** — `aafp-nat` reservation records referencing
   AgentIds.

Erasure is therefore a *multi-surface* operation. See §11 for the full
erasure procedure. The key insight is that AAFP cannot guarantee *instant*
global erasure (DHT propagation is eventually consistent), but it CAN
guarantee *cryptographic invalidation*: a revoked AgentId is refused by
every conformant peer within one handshake, even if stale records linger
in caches until TTL expiry.

### 3.3 Lawful Basis for Processing (Article 6)

| Lawful Basis | AAFP Application |
|--------------|------------------|
| **Consent** (Art 6(1)(a)) | UCAN capability tokens serve as machine-readable consent. See §9. |
| **Contract** (Art 6(1)(b)) | Agent-to-agent service invocation (e.g., paying for inference) is a contract between the agent operators. |
| **Legitimate interest** (Art 6(1)(f)) | DHT routing metadata (AgentId lookups) processed for network operation. Balancing test: routing metadata is pseudonymous and necessary for the protocol to function. |

### 3.4 Data Minimization (Article 5(1)(c))

AAFP's design already favors minimization:

- **AgentId is a hash**, not a direct identifier. `AgentId = SHA-256(public_key)`.
  It is pseudonymous; re-identification requires mapping the hash to a human.
- **GeoExtension coordinates are coarse** — the spec recommends rounding to
  ~1km precision (`AGENT_RECORD_EXTENSIONS.md` §5.1). Agents MAY omit
  coordinates entirely and publish only country/continent.
- **All extensions are optional** (key 11 is absent for agents that don't
  need it), so an agent publishes only the metadata it requires.
- **Discovery queries** (`CapabilityQuery`) filter by capability, not by
  identity. An agent can be discovered by "inference" without revealing who
  operates it.

### 3.5 Records of Processing (Article 30)

A federation operator acting as a controller MUST maintain a record of
processing activities. The AAFP audit log (§8) serves as the technical
substrate; the operator maps log entries to processing-purpose descriptions
in a separate ROPA document.

---

## 4. HIPAA Considerations for Healthcare Agent Federations

### 4.1 Scope

When AAFP agents carry Protected Health Information (PHI) — e.g., a clinical
decision-support agent querying a lab-results agent — the federation falls
under HIPAA's Privacy Rule (45 CFR §164) and Security Rule (45 CFR §164.302).

### 4.2 PHI in the AAFP Context

| HIPAA Concept | AAFP Mapping |
|---------------|--------------|
| **Covered Entity (CE)** | The healthcare organization operating the agent (hospital, clinic, insurer). |
| **Business Associate (BA)** | Any agent operator processing PHI on behalf of the CE — e.g., an external inference provider. A Business Associate Agreement (BAA) MUST be in place. |
| **PHI** | Any agent message payload containing individually identifiable health information. The AgentId itself is *not* PHI unless mapped to a patient. |
| **Designated Record Set** | Audit logs, attestation records, and DHT records that reference PHI-bearing agents. |

### 4.3 Security Rule Controls

| Safeguard | HIPAA Requirement | AAFP Mechanism |
|-----------|-------------------|-----------------|
| **Access control** (§164.312(a)) | Unique user identification, emergency access, automatic logoff | AgentId is the unique identifier. UCAN tokens enforce least-privilege access. Session idle timeout (`max_idle_timeout` 30s in QUIC). |
| **Audit controls** (§164.312(b)) | Hardware, software, procedural mechanisms recording examination of PHI | AAFP audit log (§8) records every RPC with AgentIds, capability, timestamp, outcome. |
| **Integrity** (§164.312(c)) | Mechanisms to authenticate PHI | ML-DSA-65 signatures on AgentRecords and UCAN tokens; TLS 1.3 integrity on the wire. |
| **Transmission security** (§164.312(e)) | Encryption of PHI in transit | QUIC with TLS 1.3 (RFC 9000/8446), PQ key exchange `X25519MLKEM768` preferred (RFC-0002 §2.3). End-to-end encryption for PHI payloads (§7.3). |
| **Encryption at rest** (§164.312(a)(2)(iv)) | Addressable — encrypt PHI stored on disk | DHT persistent backend (SQLite) MUST be encrypted (§7.2). Audit logs MUST be encrypted at rest. |

### 4.4 Minimum Necessary Standard

HIPAA's "minimum necessary" requirement (§164.502(b)) maps directly to
UCAN capability scoping. A lab-results agent should receive a UCAN token
scoped to `resource: "lab.results.read", action: "invoke"` — not a blanket
token. The capability chain (RFC-0003 §5.5) ensures that delegated tokens
convey only a *subset* of the parent's capabilities, enforcing least
privilege transitively.

### 4.5 Breach Notification

If a relay operator or DHT node suffers a breach exposing PHI, HIPAA's
Breach Notification Rule (§164.400) requires notification to the CE within
60 days. AAFP's audit log accelerates breach scoping: the operator can
query logs for all RPCs involving the affected AgentIds within the breach
window, producing a precise impact inventory rather than a blanket
notification.

### 4.6 De-identification

HIPAA Safe Harbor de-identification (§164.514(b)) requires removal of 18
identifiers. AAFP agents handling de-identified data SHOULD:

- Publish no `GeoExtension` coordinates (country only).
- Use a derived AgentId not linked to the patient identity.
- Omit `ReputationExtension` attestation references that could re-identify.

---

## 5. SOC 2 Type II for AAFP Relay Operators

### 5.1 Why SOC 2 Applies

Relay operators (`aafp-nat/relay_v1`) and DHT node operators provide
infrastructure that enterprise customers rely on. SOC 2 Type II attestation
demonstrates that the operator's controls are *designed and operating
effectively* over a period (typically 6–12 months). Unlike SOC 1 (financial
controls), SOC 2 addresses the AICPA Trust Services Criteria.

### 5.2 Trust Services Criteria Mapping

| Criterion | SOC 2 Requirement | AAFP Control |
|-----------|-------------------|--------------|
| **CC6.1** (Logical access) | Controls restrict access to systems | Agent identity via ML-DSA-65; no shared credentials. UCAN tokens enforce authorization. Relay reservation limits (`DEFAULT_MAX_RESERVATIONS`). |
| **CC6.6** (Transmission) | Data protected during transmission | TLS 1.3 over QUIC, PQ key exchange, channel binding (`TLS-Exporter`). |
| **CC6.7** (Boundary protection) | Network boundaries controlled | Relay operators SHOULD deploy egress filtering to enforce `data_residency`. DHT node operators SHOULD restrict peering to known federations. |
| **CC7.1** (Detection) | Controls detect security events | Audit logging of all RPCs (§8). `AgentMetrics` health monitoring (Healthy/Degraded/Unhealthy). Rate-limit alerts (`RATE_LIMIT_ANNOUNCE`, `RATE_LIMIT_LOOKUP`). |
| **CC7.2** (Response) | Incidents responded to | CRL-based revocation (F3) allows rapid disabling of compromised agents. Relay operators can drop reservations for revoked AgentIds. |
| **CC7.3** (Recovery) | Recovery from incidents | DHT replication (k=5) provides redundancy. Key rotation (RFC-0011 §6) recovers from key compromise. |
| **CC8.1** (Change management) | Controlled changes | Protocol versioning (RFC-0006); monotonic `record_version` prevents stale-record replay. |
| **C1.1** (Confidentiality) | Information protected | Encryption at rest (§7.2) and in transit (§7.1). End-to-end encryption for sensitive payloads (§7.3). |
| **P4.1** (Privacy — notice) | Data subjects informed | Agent's `AgentRecord` capabilities serve as a machine-readable notice of what data the agent processes. |
| **P5.1** (Privacy — choice/consent) | Consent obtained | UCAN tokens as consent (§9). |
| **P6.1** (Privacy — collection) | Data collected for specified purposes | Capability-scoped RPCs; agents SHOULD NOT collect data outside declared capabilities. |
| **P7.1** (Privacy — use/retention) | Retention limits | DHT TTL (§10.1), audit log retention (§10.3), attestation expiry (§10.2). |
| **P8.1** (Privacy — disclosure) | Disclosures controlled | Data residency enforcement prevents disclosure to non-compliant jurisdictions (§6). |
| **A1.1** (Availability) | System available | DHT replication, relay redundancy, heartbeat extension for liveness. |

### 5.3 Audit Evidence

A SOC 2 auditor will request evidence that controls operated effectively
throughout the audit period. AAFP provides:

- **Audit logs** (§8): timestamped, tamper-evident records of every RPC.
- **CRL history**: revocation events with timestamps and reasons.
- **Configuration baselines**: TLS policy (PQ KEX enabled), rate-limit
  settings, `data_residency` allow-lists.
- **Uptime metrics**: `AgentMetrics` counters (connections, handshakes,
  errors) exported for monitoring.

### 5.4 Relay Operator Responsibilities

A relay operator is a *processor* under GDPR and a *service provider* under
most other regimes. Specific obligations:

1. **Do not inspect payload contents.** Relay forwarding (`relay_forwarding`)
   operates on opaque streams. The operator MUST NOT add payload-inspection
   middleware.
2. **Enforce residency on relayed connections.** If either endpoint declares
   `data_residency`, the relay SHOULD refuse to relay if the relay's own
   jurisdiction is not in the allow-list. (This is a future enhancement;
   current relay code does not inspect GeoExtension.)
3. **Retain audit logs** for the period required by the customer's SOC 2
   engagement (typically 12 months).
4. **Implement breach notification** per the BAA or DPA with each customer.

---

## 6. Data Residency Enforcement via GeoExtension

### 6.1 The Enforcement Algorithm

Data residency is enforced at the **routing layer**, before any data leaves
the originating jurisdiction. The algorithm:

```
function can_route(sender_record, peer_record, data_classification):
    sender_geo = sender_record.get_extension("aafp.geo.v1")
    peer_geo   = peer_record.get_extension("aafp.geo.v1")

    # 1. If sender declares residency constraints, peer must satisfy them.
    if sender_geo and sender_geo.data_residency is not empty:
        peer_jurisdiction = peer_geo.country or peer_geo.continent
        if peer_jurisdiction not in sender_geo.data_residency:
            return DENY("peer jurisdiction %s not in sender residency %s"
                        % (peer_jurisdiction, sender_geo.data_residency))

    # 2. If data classification imposes stricter residency, check that too.
    if data_classification.residency:
        if peer_jurisdiction not in data_classification.residency:
            return DENY("data classification requires %s, peer is %s"
                        % (data_classification.residency, peer_jurisdiction))

    # 3. If peer has no GeoExtension at all, apply operator default.
    if peer_geo is None:
        if operator_policy.require_geo:
            return DENY("peer has no geo extension; operator requires geo")
        else:
            return ALLOW_WITH_WARNING("no geo metadata; routing at operator risk")

    return ALLOW
```

### 6.2 Agents Refuse to Route to Non-Compliant Regions

The critical property is that **the sending agent enforces residency, not
the network.** There is no central firewall. Each agent, upon discovering a
candidate peer via the DHT, checks the peer's `GeoExtension` *before*
opening a QUIC connection. If the peer's jurisdiction is not in the
sender's `data_residency` allow-list, the agent does not connect.

This is stronger than a centralized egress filter because:

- It is **cryptographically bound**: the `GeoExtension` is inside the signed
  `AgentRecord` envelope (key 11 is covered by the ML-DSA-65 signature per
  `AGENT_RECORD_EXTENSIONS.md` §6.2). A peer cannot lie about its location
  without invalidating its signature.
- It is **per-agent**: different agents in the same deployment can have
  different residency constraints. A healthcare agent can require `["US"]`
  while a marketing agent in the same fleet allows `["EU", "US"]`.
- It is **auditable**: the routing decision (allow/deny) is recorded in the
  audit log with both AgentIds and the residency evaluation.

### 6.3 Limitations and Caveats

1. **Self-reported location.** The `GeoExtension` is self-reported by the
   peer. A malicious agent could publish a false country code. Mitigations:
   - CA-signed agents (RFC-0011) can have their geo location attested by
     the CA, producing a verifiable binding between network endpoint and
     jurisdiction.
   - Network-layer geolocation (IP → country) can be used as a cross-check.
     If the declared country disagrees with the IP geolocation, the agent
     SHOULD refuse or flag the connection.
2. **No GeoExtension = no enforcement.** An agent without `aafp.geo.v1`
   cannot be residency-checked. Operators SHOULD set
   `operator_policy.require_geo = true` for regulated deployments, refusing
   to route to agents that lack geo metadata.
3. **Sub-national jurisdictions.** GDPR is EU-wide, but some member states
   (e.g., Germany) have additional data-localization requirements. The
   `data_residency` list supports sub-national codes (`"DE"`, `"US-CA"`),
   but the operator must maintain the mapping.
4. **Relay hops.** If a connection is relayed (RFC-0010 circuit relay),
   the relay node is an intermediary. The relay's jurisdiction also matters.
   See §6.4.

### 6.4 Relay-Aware Residency

When a connection traverses a circuit relay, data passes through the relay's
jurisdiction. The residency check MUST therefore include the relay:

```
can_route(sender, peer, relay):
    if not can_route(sender, peer, classification): return DENY
    if not can_route(sender, relay, classification): return DENY  # relay is also a data locus
    return ALLOW
```

The relay's `AgentRecord` carries its own `GeoExtension`, so the same
algorithm applies. A relay operator in a non-adequate country cannot serve
EU-restricted traffic.

### 6.5 Configuration: Adequacy and SCCs

Operators maintain a `residency_config.toml` that encodes:

```toml
[adequacy]
# EU Commission adequacy decisions (Article 45)
countries = ["US", "CH", "JP", "GB", "IL", "NZ", "KR", ...]

[scc]
# Countries where Standard Contractual Clauses are required
requires_scc = ["CN", "RU", "IN", "BR"]

[operator_policy]
require_geo = true
default_deny_no_geo = true
```

The residency checker consults this config so that routing to an adequate
country is permitted, routing to an SCC-required country is permitted only
if an SCC is on file (signaled by a UCAN capability `data.transfer.scc`),
and routing to all others is denied.

---

## 7. Encryption Requirements

### 7.1 Encryption in Transit

AAFP mandates QUIC version 1 (RFC 9000) with TLS 1.3 (RFC 8446) for all
transport (RFC-0002 §2). Specific requirements:

| Requirement | Mechanism | Reference |
|-------------|-----------|-----------|
| Transport encryption | TLS 1.3 over QUIC | RFC-0002 §2.1 |
| ALPN negotiation | `aafp/1` | RFC-0002 §2.2 |
| PQ key exchange | `X25519MLKEM768` preferred | RFC-0002 §2.3 |
| Channel binding | `TLS-Exporter("EXPORTER-AAFP-Channel-Binding", "", 32)` | RFC-0002 §2.5, RFC 9266 |
| Certificate model | Self-signed; identity verified at application layer | RFC-0002 §2.4 |
| Replay protection | `ReplayCache` (check-before-verify, insert-after-verify) | THREAT_MODEL §2.3 |

The PQ key exchange (`X25519MLKEM768`) is significant for compliance: it
protects against "harvest now, decrypt later" attacks, satisfying the
forward-confidentiality expectations of GDPR Article 32(1)(a) ("ongoing
confidentiality... appropriate to the risk").

### 7.2 Encryption at Rest

Data stored by AAFP components MUST be encrypted at rest in regulated
deployments:

| Component | Storage | Encryption Requirement |
|-----------|---------|------------------------|
| **DHT persistent backend** | SQLite (`persistent_dht.rs`) | Database file encrypted (SQLCipher or OS-level full-disk encryption). Key managed via HSM or OS keychain. |
| **KeyDirectory** | In-memory or SQLite | If SQLite, same as above. Private keys (`AgentKeypair`, 4032 bytes) MUST be stored in an HSM or OS secure enclave, never in plaintext on disk. |
| **Audit logs** | File or append-only store | Encrypted at rest. Log integrity via hash chaining (§8.4). |
| **Relay reservation state** | In-memory | Not persisted by default. If persisted, encrypt. |
| **Attestation cache** | In-memory or SQLite | Encrypt if persisted. |

### 7.3 End-to-End Encryption

TLS 1.3 provides point-to-point encryption between two directly connected
agents. However, in a relayed connection (RFC-0010), the relay terminates
the QUIC connection on both sides and forwards opaque streams. The relay
can therefore see plaintext if the application layer does not provide its
own encryption.

For sensitive payloads (PHI, credentials, commercial secrets), agents
SHOULD apply an additional **end-to-end encryption layer** above the
transport:

```
payload_e2ee = AEAD_Encrypt(
    key = HKDF(shared_secret, "aafp-e2ee-v1"),
    nonce = session_nonce,
    aad = agent_id_sender || agent_id_receiver || capability || timestamp,
    plaintext = application_payload
)
```

The shared secret is derived from an ECDH or PQ-KEM exchange authenticated
by the agents' ML-DSA-65 keys (binding the E2EE key to the same identities
verified in the handshake). The relay forwards `payload_e2ee` opaquely;
only the destination agent can decrypt. This satisfies HIPAA §164.312(e)
for relayed PHI and GDPR Article 32 for cross-jurisdiction payloads.

**Status:** E2EE is a *recommended* layer not yet specified in an RFC. A
future RFC (proposed: RFC-0012) should standardize the E2EE payload format.
Until then, regulated deployments SHOULD avoid relays for PHI or use
direct connections only.

---

## 8. Audit Logging

### 8.1 Requirement

Every RPC exchanged between agents MUST be recorded in an audit log. This
satisfies:

- **HIPAA §164.312(b)** — audit controls for PHI examination.
- **SOC 2 CC7.1** — detection of security events.
- **EU AI Act Article 12** — automatic logging for high-risk AI systems.
- **GDPR Article 30** — records of processing activities.
- **GDPR Article 33** — breach notification (logs enable scoping).

### 8.2 Log Entry Schema

Each audit log entry is a CBOR-encoded record:

```rust
pub struct AuditLogEntry {
    /// Monotonic sequence number (per agent).
    pub seq: u64,
    /// Unix timestamp (seconds) with millisecond sub-precision.
    pub timestamp_ms: u64,
    /// The agent that initiated the RPC (sender).
    pub caller_agent_id: AgentId,       // 32 bytes
    /// The agent that received the RPC (callee).
    pub callee_agent_id: AgentId,       // 32 bytes
    /// The capability invoked (e.g., "inference", "lab.results.read").
    pub capability: String,
    /// The UCAN token chain authorizing this RPC (hash of the chain).
    pub ucan_chain_hash: [u8; 32],      // SHA-256 of the chain
    /// The RPC method name.
    pub method: String,
    /// Outcome: "success", "denied", "error", "timeout".
    pub outcome: String,
    /// Error code if outcome != success (AAFP error code, RFC-0005).
    pub error_code: Option<u16>,
    /// Bytes sent (payload size, for volume auditing).
    pub bytes_in: u32,
    /// Bytes received.
    pub bytes_out: u32,
    /// Residency check result (if a routing decision was made).
    pub residency_check: Option<ResidencyDecision>,
    /// Hash of the previous log entry (hash chaining, §8.4).
    pub prev_hash: [u8; 32],
}

pub enum ResidencyDecision {
    Allowed { peer_jurisdiction: String, reason: String },
    Denied  { peer_jurisdiction: String, reason: String },
    NotApplicable,
}
```

### 8.3 What Is Logged vs. What Is Not

| Logged | NOT Logged (privacy) |
|--------|----------------------|
| AgentIds (pseudonymous) | Payload contents |
| Capability name | Payload plaintext |
| Method name | UCAN token plaintext (only hash) |
| Outcome and error code | Private keys |
| Byte volumes | GeoExtension coordinates (only jurisdiction) |
| Timestamp | Patient identifiers (unless the payload itself is audited under a separate PHI log) |

The design principle is **metadata-only logging**: the audit log records
*that* an interaction occurred and *what capability* was invoked, but not
the *content* of the interaction. This keeps the audit log itself from
becoming a secondary PHI store requiring its own HIPAA safeguards (though
it still requires encryption at rest).

### 8.4 Tamper Evidence (Hash Chaining)

Each log entry includes `prev_hash = SHA-256(prev_entry_canonical_bytes)`.
This forms a hash chain analogous to a blockchain (without consensus). Any
deletion or modification of an entry breaks the chain, detectable by
verifying the chain from the genesis entry forward. For stronger assurance,
periodic anchor hashes can be published to an external notary (e.g., a
transparency log or a notarized timestamp).

### 8.5 Log Retention

| Log Type | Minimum Retention | Rationale |
|----------|-------------------|-----------|
| **RPC audit log** | 12 months (SOC 2), 6 years (HIPAA §164.530(j)) | HIPAA requires 6 years for documentation of policies/actions. SOC 2 typically 12 months. Operators MUST retain for the longer of applicable requirements. |
| **Handshake log** | 90 days | Sufficient for incident investigation without indefinite metadata retention. |
| **Residency denial log** | 12 months | Demonstrates enforcement for regulator inquiries. |
| **CRL history** | 6 years (HIPAA) / indefinite (best practice) | Revocation events are historically significant. |

After the retention period, logs MUST be securely deleted (cryptographic
erasure: destroy the encryption key, rendering the ciphertext unrecoverable).

---

## 9. Consent Management (UCAN as Consent Tokens)

### 9.1 UCAN as Machine-Readable Consent

GDPR Article 7 requires that consent be "freely given, specific, informed,
and unambiguous." AAFP's UCAN (User-Controlled Authorization Networks)
capability tokens, defined in RFC-0003 §5.4, are a *machine-readable
instantiation* of these requirements:

| GDPR Consent Property | UCAN Mechanism |
|-----------------------|----------------|
| **Freely given** | The data subject's agent issues the UCAN token; no central authority forces it. |
| **Specific** | Each token carries explicit `Capability { resource, action }` pairs (e.g., `resource: "lab.results.read", action: "invoke"`). |
| **Informed** | The `resource` and `action` fields describe exactly what the delegatee may do. The `AgentRecord` capabilities describe what the delegatee *is*. |
| **Unambiguous** | A UCAN token is a signed CBOR structure; its presence is an affirmative act. |
| **Withdrawable** | UCAN tokens have `expires_at` (field 4). Revocation via CRL (F3) or token expiry. See §11. |

### 9.2 UCAN Token Structure (Recap)

```
UcanToken = {
    1: bstr,          // issuer: AgentId of the token issuer
    2: bstr,          // subject: AgentId of the token subject
    3: [ *Capability ],  // capabilities
    4: uint,          // expires_at: Unix timestamp
    5: bstr / null,   // proof: parent token (for delegation chains)
    6: bstr,          // signature: ML-DSA-65 over "aafp-v1-ucan" || CBOR(1-5)
}
```

The signature domain separator `"aafp-v1-ucan"` prevents token reuse in
other contexts (RFC-0003 §5.4).

### 9.3 Consent Lifecycle

```
   ┌──────────────────────────────────────────────────────────┐
   │  1. Data subject's agent grants consent                  │
   │     → issues UCAN token to processor agent               │
   │     → token stored locally + published to DHT (optional) │
   ├──────────────────────────────────────────────────────────┤
   │  2. Processor agent invokes capability                   │
   │     → presents UCAN token in RPC                         │
   │     → callee verifies chain, checks expiry               │
   │     → audit log records ucan_chain_hash                  │
   ├──────────────────────────────────────────────────────────┤
   │  3. Data subject withdraws consent                       │
   │     → stops renewing the UCAN token (let it expire)      │
   │     → OR issues CRL entry revoking the delegatee         │
   │     → OR issues a revocation attestation (trust_score=0) │
   ├──────────────────────────────────────────────────────────┤
   │  4. Withdrawal propagates                                │
   │     → peers check CRL on next handshake                  │
   │     → expired/revoked tokens rejected                    │
   │     → audit log records "denied" outcomes                │
   └──────────────────────────────────────────────────────────┘
```

### 9.4 Granular Consent

Consent should be as granular as the capability model allows. Anti-pattern:

```
# BAD: blanket consent
Capability { resource: "*", action: "*" }
```

Best practice:

```
# GOOD: scoped consent with expiry
Capability { resource: "lab.results.read", action: "invoke" }
expires_at: now + 24 * 3600   # 24 hours
```

The delegation chain (RFC-0003 §5.5) ensures that a delegatee cannot
escalate privileges: a delegated token MUST convey a *subset* of the
parent's capabilities. This is verified during chain verification
(step 3 of the chain verification algorithm).

### 9.5 Consent for Minors and Vulnerable Data Subjects

GDPR Article 8 requires parental consent for data subjects under 16 (member
states may lower to 13). In AAFP, this maps to a UCAN chain where the
parent's agent issues a token to the child's agent, which in turn issues
tokens to service agents. The chain verification confirms the parent's
authorization is present in the chain.

---

## 10. Data Retention Policies

### 10.1 DHT Record TTL

The `AgentRecord` carries `expires_at` (field 7). The DHT enforces:

- `MAX_RECORD_EXPIRY` = 30 days (2,592,000s) — a mitigation guideline
  (`AGENT_RECORD_EXTENSIONS.md` §2.4). Records exceeding this SHOULD be
  flagged by DHT nodes.
- `RECOMMENDED_RENEWAL` = 7 days (604,800s).
- `DhtRouter::republish_own_record()` re-announces to k=5 closest peers
  every 30 minutes (before TTL expiry).
- `evict_expired()` removes records where `expires_at <= now`.
- `KeyDirectory::publish()` rate-limits to 1 publish per AgentId per hour.

**Retention policy:** The DHT does not retain records beyond their
`expires_at`. An agent that stops republishing will have its record
evicted within 30 days maximum (typically sooner, as each DHT node runs
`evict_expired()` on its maintenance cycle). This is the *default* erasure
mechanism: stop republishing, and the record ages out.

### 10.2 Attestation Expiry

Attestations (`AGENT_RECORD_EXTENSIONS.md` §7.2) carry their own
`expires_at` (field 6). `Attestation::verify()` rejects expired
attestations. The recommended attestation TTL is 90 days, after which the
attester must re-attest if the relationship continues. This prevents stale
reputation from persisting indefinitely and supports the data-minimization
principle.

### 10.3 Audit Log Retention

See §8.5. The key tension: HIPAA requires 6 years, but GDPR's storage-
limitation principle (Article 5(1)(e)) requires data not be kept "longer
than is necessary." Resolution: retain *metadata-only* audit logs (no
payload contents) for the HIPAA-required period, then cryptographically
erase. Because the logs contain only pseudonymous AgentIds and capability
names (not direct identifiers), the GDPR risk of extended retention is
lower, but operators MUST document the balancing decision in their ROPA.

### 10.4 Session Data Retention

| Data | Retention | Erasure |
|------|-----------|---------|
| `Session` state (AgentId, pubkey, capabilities) | Duration of session + 30s grace | In-memory; dropped on close. |
| `ReplayCache` entries | 300s (default) | LRU eviction. |
| `KeyDirectory` cache | Until record expiry or eviction | TTL-based. |
| Relay reservation | `DEFAULT_MAX_DURATION_SECS` | Canceled on expiry or explicit Cancel RPC. |

### 10.5 Retention Configuration

Operators configure retention via a policy file:

```toml
[retention]
dht_record_max_ttl_days = 30
attestation_max_ttl_days = 90
audit_log_retention_days = 2190   # 6 years (HIPAA)
handshake_log_retention_days = 90
residency_denial_log_days = 365
crl_history_retention = "indefinite"

[erasure]
# Cryptographic erasure of logs after retention period
method = "key_destruction"
key_rotation_days = 90
```

---

## 11. Right to Be Forgotten (Erasure Procedure)

### 11.1 The Erasure Challenge in a DHT

GDPR Article 17 erasure in a decentralized system is harder than in a
centralized database because the data is replicated. AAFP's erasure
procedure combines *cryptographic invalidation* (immediate) with *physical
purging* (eventual):

1. **Cryptographic invalidation** (immediate, < 1 handshake): Revoke the
   AgentId so no peer will accept new connections or RPCs from it.
2. **DHT record purging** (eventual, < 30 days): Stop republishing; the
   record expires and is evicted by `evict_expired()`.
3. **Attestation revocation** (immediate): Issue a revocation attestation
   (`trust_score = 0`) that supersedes prior attestations.
4. **Audit log redaction** (per policy): Audit logs are retained per §8.5
   but the AgentId mapping can be severed by destroying the key-to-human
   mapping in the operator's records.

### 11.2 Step-by-Step Erasure Procedure

```
ERASURE PROCEDURE (triggered by data subject request or operator policy):

Step 1: DEREGISTER THE AGENT
  - Agent stops calling republish_own_record().
  - Agent publishes a final record_version with expires_at = now
    (immediate expiry), signed with its key.
  - DHT nodes evict the record on next evict_expired() cycle.

Step 2: REVOKE THE AGENT IDENTITY
  - Issue a CRL entry (F3 revocation mechanism):
      { agent_id, revoked_at: now, reason: "erasure_request",
        revoking_key_id: self, signature: ML-DSA-65(key, ...) }
  - Publish CRL to DHT under capability "aafp.revocation.crl".
  - All peers check CRL on next handshake → reject the AgentId
    with ERROR 2002.

Step 3: REVOKE ALL UCAN CONSENT TOKENS
  - For each outstanding UCAN token issued by this agent:
      - Stop renewing (let expires_at pass), OR
      - Add the delegatee AgentId to the CRL (if the delegatee
        was acting solely on this agent's behalf).
  - This withdraws consent per GDPR Article 7(3).

Step 4: REVOKE ATTESTATIONS
  - Issue a revocation attestation:
      { subject: self, attester: self, trust_score: 0,
        notes: "erasure_request", expires_at: now + 90 days }
  - Publish to DHT attestation namespace.
  - compute_reputation() now returns 0 (or None) for this agent.

Step 5: PURGE LOCAL STATE
  - Destroy the agent's private key (AgentKeypair, 4032 bytes).
    If stored in an HSM, invoke key destruction.
  - Clear KeyDirectory entries for this AgentId.
  - Clear Session state and ReplayCache entries.

Step 6: NOTIFY FEDERATION (if applicable)
  - If the agent was part of a federation with a controller,
    notify the controller to purge their copies:
      - DHT records (they will expire via TTL)
      - Audit logs (redact or retain per policy)
      - Attestation caches

Step 7: VERIFY
  - Confirm no new connections accepted (CRL enforced).
  - Confirm DHT lookups return no record (after eviction).
  - Confirm reputation score is 0/None.
  - Log the erasure event in the audit log (meta-entry).
```

### 11.3 Limitations

- **Other parties' copies.** AAFP cannot force a third party that copied a
  record out-of-band to delete it. The CRL ensures the record is *invalid*
  (no peer will act on it), but the bytes may persist in a non-conformant
  store. This is analogous to a centralized service that cannot force a
  user who screenshotted data to delete their screenshot. The compliance
  posture is: the record is *functionally* erased (cryptographically
  unusable) even if bytes linger.
- **Audit logs.** HIPAA may require retaining audit logs that reference the
  AgentId for 6 years. GDPR Article 17(3)(b) exempts processing "for
  archiving purposes in the public interest" — audit logs may qualify.
  Operators should document this in their ROPA.
- **Blockchain-like immutability.** AAFP does not use a blockchain; DHT
  records are mutable and evictable. This is *easier* for erasure than a
  blockchain-based identity system.

---

## 12. Privacy-Preserving Discovery

### 12.1 The Tension

Discovery requires agents to advertise capabilities so peers can find them.
But advertising reveals *who* the agent is and *what* it can do — metadata
that could enable surveillance (the THREAT_MODEL lists "network metadata"
and "agent graph mapping" as assets an attacker seeks).

### 12.2 Capability-Indexed Discovery (Not Identity-Indexed)

The AAFP DHT is keyed by `SHA-256(capability_name)`, not by AgentId
(`aafp-discovery` design). This means:

- A peer searching for "inference" queries the DHT at
  `SHA-256("inference")` and receives all agents advertising that
  capability.
- The querier does not need to know any AgentId in advance.
- The DHT nodes routing the query see the capability hash, not the
  querier's target identity.

### 12.3 Advertising Without Revealing Identity

An agent can advertise a capability while minimizing identity disclosure:

1. **Omit `ReputationExtension`.** No attestation references that could
   link the AgentId to a known entity.
2. **Omit `GeoExtension` coordinates.** Publish only `continent` (e.g.,
   "EU") for residency purposes, not country or lat/lon.
3. **Use a derived AgentId.** For high-privacy scenarios, an agent can
   generate a fresh keypair (and thus a fresh AgentId) for each federation
   or interaction context. The AgentId is `SHA-256(public_key)`, so a new
   key yields a new, unlinkable identity. (Trade-off: no reputation
   portability.)
4. **Capability-only metadata.** The `CapabilityDescriptor` carries
   `name` and `metadata`; agents SHOULD avoid putting identifying
   information (organization name, email) in metadata.

### 12.4 Query Privacy

The querier's privacy is protected by the DHT routing structure:

- Kademlia iterative lookups contact α=3 nodes per hop. No single node
  sees the full query path.
- The query key is a capability hash, not the querier's identity.
- The querier's AgentId is revealed only to the final peer it connects to
  (during the AAFP handshake). Intermediate DHT nodes see the querier's
  IP but not necessarily its AgentId.

### 12.5 Future: Private Information Retrieval

For stronger query privacy, a future extension could use Private
Information Retrieval (PIR) or Oblivious DHT lookups, so DHT nodes cannot
even see which capability is being queried. This is out of scope for v1
but noted as a research direction.

---

## 13. Cross-Border Data Transfer

### 13.1 The Transfer Problem

GDPR Chapter V (Articles 44–49) restricts transfers of personal data to
third countries. In AAFP, a "transfer" occurs whenever:

- An agent in the EEA sends a message to an agent outside the EEA.
- A DHT node in the EEA replicates a record to a node outside the EEA.
- A relay in the EEA forwards a connection to a peer outside the EEA.

### 13.2 Transfer Mechanisms

| Mechanism | AAFP Implementation |
|-----------|---------------------|
| **Adequacy decision** (Art 45) | Residency checker allows routing to adequate countries per operator config (§6.5). |
| **SCCs** (Art 46) | UCAN capability `data.transfer.scc` signals that an SCC is in place. Residency checker permits routing if the capability is present. |
| **BCRs** (Art 47) | For intra-group transfers, the federation operator's BCR policy is encoded in the operator config. |
| **Derogations** (Art 49) | Not machine-enforceable; requires human judgment. Operators SHOULD log derogation-based transfers for regulator review. |

### 13.3 DHT Replication Across Borders

DHT replication (k=5) means a record published in the EEA may replicate to
nodes outside the EEA if the k closest peers are geographically dispersed.
This is a *transfer* under GDPR. Mitigations:

1. **Regional DHT sharding.** The `ShardedCapabilityDht` (discovery_v1)
   supports `DHT_SHARD_COUNT` shards. Operators SHOULD configure shards
   aligned with jurisdictions so that EU records replicate only to EU
   nodes.
2. **Residency-aware replication.** A DHT node, before storing a replicated
   record, checks the record's `GeoExtension.data_residency`. If the node's
   own jurisdiction is not in the allow-list, it refuses to store the
   record. (This is a future enhancement; current `DhtRouter` does not
   inspect GeoExtension on store.)
3. **Bootstrap configuration.** EU deployments SHOULD bootstrap only to EU
   seed nodes, biasing the routing table toward EU peers.

### 13.4 Transfer Impact Assessment (TIA)

Under the Schrems II ruling, transfers to third countries require a TIA
assessing whether the destination country's surveillance laws undermine
GDPR protections. AAFP operators performing cross-border transfers SHOULD:

- Document the TIA in their records.
- Use E2EE (§7.3) so that even if a foreign government compels access to
  a relay or DHT node, the payload is unintelligible.
- Prefer routing to adequate countries; use SCCs + E2EE for others.

---

## 14. EU AI Act Compliance

### 14.1 Scope

The EU AI Act (Regulation 2024/1689) applies to AI systems placed on the
EU market or whose outputs are used in the EU. AAFP agents that embed AI
models (inference agents, LLM agents, decision-support agents) are "AI
systems" under the Act. The Act classifies systems by risk:

| Risk Tier | Examples | AAFP Implication |
|-----------|----------|------------------|
| **Unacceptable** (prohibited) | Social scoring, manipulative AI | AAFP MUST NOT be used to deploy prohibited systems. |
| **High-risk** (Annex III) | Medical, biometric, critical infrastructure, employment | Full compliance: risk management, logging, transparency, human oversight. |
| **Limited-risk** | Chatbots, emotion recognition | Transparency obligations (Article 50). |
| **Minimal-risk** | Spam filters, recommendation systems | No specific obligations (voluntary codes). |

### 14.2 Agent Transparency (Article 50)

Limited-risk AI systems must inform users that they are interacting with an
AI. In AAFP, this maps to the `AgentRecord`:

- The `record_type` field (`"aafp-record-v1"`) identifies the entity as an
  AAFP agent (not a human).
- The `CapabilityDescriptor` names declare what the agent *does* (e.g.,
  `"inference"`, `"translation"`), serving as machine-readable disclosure.
- A proposed `TransparencyExtension` (namespace `"aafp.transparency.v1"`)
  could carry:

```rust
pub struct TransparencyExtension {
    pub version: u64,
    pub is_ai_system: bool,
    pub model_name: Option<String>,         // e.g., "gpt-4", "llama-3-70b"
    pub provider: Option<String>,           // AI system provider
    pub risk_tier: Option<String>,          // "high", "limited", "minimal"
    pub human_oversight_contact: Option<String>,  // contact for human oversight
    pub intended_purpose: Option<String>,   // Annex III purpose if high-risk
}
```

This extension allows a peer (or a human via a UI) to determine, before
interacting, that it is dealing with an AI system and what its
characteristics are.

### 14.3 Capability Documentation (Article 13)

High-risk AI systems require technical documentation (Annex IV). AAFP
supports this via:

- **`SemanticCapabilityData`** in `CapabilityDescriptor` (key 3,
  `AGENT_RECORD_EXTENSIONS.md` §5.4): carries `PerformanceProfile`,
  `QualityMetrics`, `CostModel`, and `SemanticVersion` per capability.
  This is machine-readable capability documentation.
- **`PerformanceExtension`** (`"aafp.perf.v1"`): self-reported latency,
  throughput, uptime.
- **Attestations** (§7 of the extensions doc): third-party verified
  performance metrics, addressing the Act's requirement for "appropriately
  validated" documentation.

### 14.4 Audit Trails (Article 12)

High-risk AI systems must maintain automatic logs. The AAFP audit log (§8)
satisfies this:

- Every RPC is logged with AgentIds, capability, timestamp, outcome.
- The log is hash-chained (tamper-evident).
- Logs are retained per §8.5.

For high-risk systems, the log SHOULD additionally record:

- The input parameters (or a hash thereof) to enable post-incident
  reconstruction. (Privacy trade-off: input logging may capture personal
  data. Operators MUST apply data minimization — hash inputs rather than
  store plaintext.)
- The model version (`SemanticVersion` from `CapabilityVersionExtension`)
  to identify which model produced an output.

### 14.5 Human Oversight (Article 14)

High-risk systems must allow human oversight. In AAFP, this means:

- The agent operator (a human or organization) retains the private key and
  can revoke the agent at any time (CRL, §11).
- UCAN tokens have `expires_at`, ensuring delegated authority is
  time-limited and re-granted only with continued human approval.
- A "kill switch" pattern: the operator's agent can issue a CRL entry
  revoking the AI agent's identity, immediately disabling it across the
  federation.

### 14.6 Risk Management System (Article 9)

High-risk system providers must implement a risk management system. AAFP
components that support this:

- **Threat model** (`THREAT_MODEL.md`): enumerates assets, attack surfaces,
  mitigations.
- **Red team review** (`ARCHITECTURAL_RED_TEAM_REVIEW.md`): adversarial
  analysis of the protocol.
- **Conformance test suite** (`aafp-conformance`): verifies protocol
  compliance.
- **Fuzz targets**: 8 fuzz targets covering CBOR, frames, handshakes, RPC.

---

## 15. Compliance Checklist for AAFP Deployment Operators

This checklist is designed for an operator deploying an AAFP federation
in a regulated environment (healthcare, EU, enterprise). Each item is
marked **[MUST]** (regulatory requirement), **[SHOULD]** (strong
recommendation), or **[MAY]** (optional best practice).

### 15.1 Identity and Key Management

- [ ] **[MUST]** Generate ML-DSA-65 keypairs using a FIPS 204-compliant
      library. Store private keys (4032 bytes) in an HSM or OS secure
      enclave, never in plaintext on disk.
- [ ] **[MUST]** Implement key rotation per RFC-0011 §6. Document the
      rotation schedule (recommended: annual or on personnel change).
- [ ] **[MUST]** Deploy CRL-based revocation (F3 mechanism). Verify CRLs
      on every handshake.
- [ ] **[SHOULD]** Use CA-signed identities (RFC-0011) for regulated
      deployments, enabling attested geo-location.
- [ ] **[MAY]** Use derived AgentIds (fresh keypair per context) for
      high-privacy scenarios.

### 15.2 Encryption

- [ ] **[MUST]** Enable TLS 1.3 over QUIC with ALPN `aafp/1`.
- [ ] **[MUST]** Enable PQ key exchange (`X25519MLKEM768`). Disable
      classical-only fallback in production.
- [ ] **[MUST]** Encrypt DHT persistent backend (SQLite) at rest (SQLCipher
      or full-disk encryption).
- [ ] **[MUST]** Encrypt audit logs at rest.
- [ ] **[SHOULD]** Deploy E2EE for sensitive payloads (PHI, credentials)
      especially if using circuit relays.
- [ ] **[MUST]** Destroy encryption keys securely on decommissioning
      (cryptographic erasure).

### 15.3 Data Residency

- [ ] **[MUST]** Publish `GeoExtension` with `data_residency` for all
      agents handling personal data.
- [ ] **[MUST]** Configure `residency_config.toml` with current adequacy
      decisions and SCC requirements.
- [ ] **[MUST]** Enable residency checking in the routing layer (refuse
      to route to non-compliant jurisdictions).
- [ ] **[MUST]** Set `operator_policy.require_geo = true` for regulated
      deployments (refuse agents without GeoExtension).
- [ ] **[SHOULD]** Configure regional DHT shards aligned with jurisdictions.
- [ ] **[SHOULD]** Bootstrap only to in-jurisdiction seed nodes.
- [ ] **[SHOULD]** Cross-check declared geo with IP geolocation; flag
      discrepancies.

### 15.4 Audit Logging

- [ ] **[MUST]** Enable audit logging for all RPCs (every call recorded
      with AgentIds, capability, timestamp, outcome).
- [ ] **[MUST]** Implement hash chaining for tamper evidence.
- [ ] **[MUST]** Retain audit logs per applicable regulation (HIPAA: 6
      years; SOC 2: 12 months minimum).
- [ ] **[MUST]** Log residency decisions (allow/deny with reason).
- [ ] **[SHOULD]** Publish periodic anchor hashes to an external
      notary/transparency log.
- [ ] **[SHOULD]** Log model version for AI agent outputs (EU AI Act
      Article 12).
- [ ] **[MUST]** Securely delete logs after retention period
      (cryptographic erasure).

### 15.5 Consent Management

- [ ] **[MUST]** Use UCAN tokens for all delegated authority, scoped to
      specific `resource`/`action` pairs (no blanket tokens).
- [ ] **[MUST]** Set `expires_at` on all UCAN tokens (recommended: ≤ 24h
      for sensitive capabilities).
- [ ] **[MUST]** Implement consent withdrawal (stop renewal + CRL
      revocation of delegatee if needed).
- [ ] **[SHOULD]** Log UCAN chain hashes in the audit log for every
      authorized RPC.
- [ ] **[MUST]** Verify UCAN delegation chains on every RPC (subset
      capability check, expiry check).

### 15.6 Data Retention

- [ ] **[MUST]** Configure DHT record `expires_at` ≤ 30 days.
- [ ] **[MUST]** Configure attestation `expires_at` ≤ 90 days.
- [ ] **[MUST]** Run `evict_expired()` on a regular maintenance cycle
      (recommended: every 5 minutes).
- [ ] **[MUST]** Document retention periods in the ROPA (GDPR Article 30).
- [ ] **[SHOULD]** Configure `TtlHintExtension` for agents with dynamic
      capabilities.

### 15.7 Right to Be Forgotten

- [ ] **[MUST]** Implement the erasure procedure (§11): deregister, revoke
      (CRL), revoke UCAN tokens, revoke attestations, purge local state,
      notify federation.
- [ ] **[MUST]** Destroy private keys on erasure (HSM key destruction).
- [ ] **[MUST]** Document the erasure procedure in the privacy policy.
- [ ] **[SHOULD]** Provide a user-facing erasure request mechanism (API
      or UI) that triggers the procedure automatically.
- [ ] **[MUST]** Log the erasure event (meta-entry in audit log).

### 15.8 HIPAA-Specific (Healthcare Federations)

- [ ] **[MUST]** Execute a BAA with every agent operator processing PHI
      on behalf of a covered entity.
- [ ] **[MUST]** Encrypt PHI in transit (TLS 1.3) and at rest.
- [ ] **[MUST]** Apply minimum-necessary scoping via UCAN tokens.
- [ ] **[MUST]** Retain audit logs for 6 years (§164.530(j)).
- [ ] **[SHOULD]** Avoid circuit relays for PHI (use direct connections
      or E2EE).
- [ ] **[SHOULD]** De-identify data where possible (Safe Harbor: omit
      geo coordinates, use derived AgentIds).

### 15.9 EU AI Act-Specific (AI Agents)

- [ ] **[MUST]** Classify each AI agent by risk tier (unacceptable /
      high / limited / minimal).
- [ ] **[MUST]** Publish `TransparencyExtension` declaring `is_ai_system`
      and model metadata.
- [ ] **[MUST]** For high-risk: implement risk management system, logging,
      human oversight, technical documentation.
- [ ] **[MUST]** For limited-risk: inform interacting peers/humans that
      they are interacting with an AI (via transparency extension).
- [ ] **[SHOULD]** Log model version with each AI output for auditability.
- [ ] **[MUST]** Do not deploy prohibited AI systems (social scoring,
      manipulative AI) on AAFP infrastructure.

### 15.10 SOC 2 Readiness (Relay/Federation Operators)

- [ ] **[MUST]** Document all controls in a system description.
- [ ] **[MUST]** Collect audit evidence (logs, configs, metrics) for the
      audit period.
- [ ] **[MUST]** Implement access controls (no shared credentials; agent
      identity via ML-DSA-65).
- [ ] **[MUST]** Implement change management (protocol versioning,
      record_version monotonicity).
- [ ] **[MUST]** Implement incident response (CRL revocation, breach
      notification process).
- [ ] **[SHOULD]** Engage a SOC 2 auditor for Type II attestation.
- [ ] **[SHOULD]** Monitor `AgentMetrics` health (Healthy/Degraded/
      Unhealthy) and alert on degradation.

### 15.11 Operational Security

- [ ] **[MUST]** Enable rate limiting (`RATE_LIMIT_ANNOUNCE`: 10/s,
      `RATE_LIMIT_LOOKUP`: 50/s; per-IP handshake rate limiting: 10/s).
- [ ] **[MUST]** Set `MAX_RECORDS` to bound DHT memory.
- [ ] **[MUST]** Set relay reservation/connection/duration caps
      (`DEFAULT_MAX_RESERVATIONS`, `DEFAULT_MAX_CONNECTIONS`,
      `DEFAULT_MAX_DURATION_SECS`).
- [ ] **[SHOULD]** Deploy egress filtering to enforce residency at the
      network layer (defense in depth with application-layer checks).
- [ ] **[SHOULD]** Run fuzz targets regularly (`cargo +nightly fuzz`).
- [ ] **[SHOULD]** Monitor for eclipse attacks (diversity of DHT peers).

---

## 16. Compliance Gaps and Future Work

### 16.1 Current Gaps

| Gap | Description | Mitigation Until Resolved |
|-----|-------------|---------------------------|
| **No E2EE RFC** | End-to-end encryption above transport is recommended but not specified. | Use direct connections (no relay) for sensitive data. |
| **Residency not enforced on DHT store** | `DhtRouter` does not inspect `GeoExtension` when storing replicated records. | Use regional shards and in-jurisdiction bootstrap. |
| **No audit logging implementation** | Audit log schema (§8) is proposed, not yet implemented in code. | Operators MUST build an external audit layer intercepting RPCs. |
| **No TransparencyExtension** | EU AI Act transparency extension is proposed, not in the extension registry. | Operators can use `CapabilityDescriptor.metadata` ad hoc. |
| **CRL not yet implemented** | F3 revocation mechanism is designed but not merged. | Rely on UCAN token expiry for short-term revocation; key rotation for long-term. |
| **Relay does not inspect GeoExtension** | Relay forwarding is opaque to residency. | Avoid relays for regulated traffic; use E2EE. |
| **No PIR for query privacy** | DHT lookups reveal capability hashes to intermediate nodes. | Acceptable for v1; research PIR for future. |

### 16.2 Proposed RFCs

1. **RFC-0012: End-to-End Encryption** — standardize the E2EE payload
   format (AEAD with HKDF-derived keys, authenticated by ML-DSA-65).
2. **RFC-0013: Audit Logging** — standardize the `AuditLogEntry` CBOR
   schema, hash chaining, and retention hooks.
3. **RFC-0014: Data Residency Enforcement** — normative requirements for
   residency checking on route, on DHT store, and on relay.
4. **RFC-0015: AI Transparency Extension** — register
   `"aafp.transparency.v1"` in the extension namespace.

### 16.3 Research Directions

- **Zero-knowledge attestations:** Prove performance/reputation claims
  without revealing the underlying interaction data.
- **Oblivious DHT:** PIR-based lookups so DHT nodes cannot observe query
  content.
- **Federated learning over AAFP:** Privacy-preserving model training
  where agents contribute gradients without sharing raw data.
- **Differential privacy for audit logs:** Add noise to aggregate metrics
  derived from logs to protect individual agent privacy.

---

## 17. Summary: Compliance Posture by Deployment Model

| Deployment Model | GDPR | HIPAA | SOC 2 | EU AI Act |
|------------------|------|-------|-------|-----------|
| **Open federation** (public DHT, anyone joins) | Partial — residency unenforceable without geo; consent via UCAN | Not applicable (no PHI) | Not applicable | Transparency extension recommended |
| **Enterprise federation** (known members, CA-signed) | Full — residency, consent, erasure, audit | Full with BAA | Full (Type II attainable) | Full for AI agents |
| **Healthcare federation** (BAA-governed, US-only) | N/A (US-only) | Full — encryption, audit, minimum necessary, 6-year retention | Full | Full if AI agents present |
| **EU-regulated federation** (EU-only, GDPR-bound) | Full — residency, erasure, consent, ROPA | N/A (no PHI) | Recommended | Full for AI agents |

---

## 18. Conclusion

AAFP's decentralized architecture is compatible with major regulatory
frameworks — GDPR, HIPAA, SOC 2, and the EU AI Act — provided that
operators implement the enforcement layers described in this document.
The protocol's existing primitives provide strong foundations:

- **ML-DSA-65 signatures** and **UCAN capability chains** provide
  cryptographic authenticity and consent that do not depend on a central
  authority's promise.
- **GeoExtension data residency** enables jurisdiction-aware routing that
  prevents data from entering non-compliant regions *before* a transfer
  occurs.
- **DHT record TTLs** and **attestation expiry** provide automatic data
  minimization and retention limits.
- **CRL-based revocation** provides the technical substrate for the right
  to be forgotten: cryptographic invalidation is immediate, physical
  purging follows via TTL expiry.
- **Audit logging** (once implemented) provides the tamper-evident trail
  required by HIPAA, SOC 2, and the EU AI Act.

The compliance burden in AAFP shifts from centralized storage control to
**cryptographic and routing-layer enforcement**. This is, in many cases,
*stronger* than traditional compliance because it is enforced by the
protocol itself rather than by operator policy that can be violated
without detection. The remaining gaps — E2EE standardization, DHT-store
residency checks, audit log implementation, and the transparency
extension — are tractable engineering tasks that should be addressed in
the proposed RFCs (0012–0015).

Operators deploying AAFP in regulated environments SHOULD use the
compliance checklist (§15) as a starting point, augmented by legal
counsel familiar with their specific jurisdiction and industry.

---

*End of document.*
