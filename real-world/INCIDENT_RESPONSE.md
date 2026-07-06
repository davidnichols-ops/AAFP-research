# AAFP Debugging & Incident Response Runbook

**Date:** 2026-07-04
**Status:** Operational reference for on-call engineers responding to AAFP incidents
**Audience:** SREs, platform engineers, on-call rotations operating AAFP infrastructure

---

## Table of Contents

1. [Incident Severity Levels](#1-incident-severity-levels)
2. [Health Endpoints & Metrics Reference](#2-health-endpoints--metrics-reference)
3. [Diagnostic Commands](#3-diagnostic-commands)
4. [Common Incident Scenarios & Runbooks](#4-common-incident-scenarios--runbooks)
   - 4.1 [Agent Unreachable](#41-agent-unreachable-sev1sev2)
   - 4.2 [High Latency](#42-high-latency-sev2)
   - 4.3 [Handshake Failures](#43-handshake-failures-sev2)
   - 4.4 [DHT Corruption](#44-dht-corruption-sev2sev3)
   - 4.5 [Relay Failure](#45-relay-failure-sev1sev2)
   - 4.6 [Memory Leak](#46-memory-leak-sev2sev3)
   - 4.7 [Cascading Failure](#47-cascading-failure-sev1)
   - 4.8 [PubSub Message Loss](#48-pubsub-message-loss-sev2sev3)
5. [Log Analysis Patterns](#5-log-analysis-patterns)
6. [Post-Incident Review Template](#6-post-incident-review-template)
7. [On-Call Guide](#7-on-call-guide)

---

## 1. Incident Severity Levels

AAFP incidents are classified into four severity levels. Severity drives response
time, escalation, and communication cadence.

### SEV1 — Network Down / Critical Outage

**Definition:** Total or near-total loss of AAFP connectivity across a fleet. No
agents can reach each other, or a core subsystem (DHT, relay mesh, transport) is
hard-down. Data loss or security breach in progress.

**Examples:**
- All agents report `Unhealthy` health status with zero active connections.
- Relay mesh entirely offline — no cross-cluster connectivity.
- DHT routing table corrupted network-wide; lookups fail >90%.
- Cascading failure propagating across the agent fleet.
- Private key compromise suspected (rotate keys immediately).

**Response:**
- **Acknowledge within 5 minutes** of page.
- **Incident commander (IC) assigned within 10 minutes.**
- **War room / bridge opened within 15 minutes.**
- Status page updated within 15 minutes.
- Executive notification within 30 minutes.
- Updates every 30 minutes until resolved.

**Resolution target:** Mitigate (restore partial service) within 60 minutes;
full resolution within 4 hours.

---

### SEV2 — Degraded Service

**Definition:** Significant degradation of a subsystem. Agents are reachable but
with elevated error rates, latency, or partial functionality loss. Customer-visible
impact but not a total outage.

**Examples:**
- Health status `Degraded` across multiple agents (error rate >10%, handshake
  failure rate >30%).
- High latency: p99 RPC latency >2x baseline for >15 minutes.
- Handshake failures spiking (>30% failure rate).
- A single relay node down but failover relay is absorbing load.
- DHT lookups succeeding but with elevated latency or reduced success rate (<80%).
- PubSub message loss detected on a subset of topics.

**Response:**
- **Acknowledge within 15 minutes** of page.
- **IC assigned within 30 minutes.**
- War room optional; Slack incident channel required.
- Status page updated if customer-visible.
- Updates every 60 minutes.

**Resolution target:** Mitigate within 2 hours; full resolution within 8 hours.

---

### SEV3 — Minor / Localized Impact

**Definition:** Limited impact affecting a small number of agents or a non-critical
subsystem. No widespread customer-visible impact. Workarounds exist.

**Examples:**
- A single agent pod in `Degraded` state; fleet overall `Healthy`.
- DHT record replication lag on one node (self-heals via churn handling).
- PubSub topic delivery delayed on one topic with low subscriber count.
- Metrics scrape failing for one agent (monitoring gap, not service impact).
- Occasional handshake retries that eventually succeed.

**Response:**
- **Acknowledge within 30 minutes** during business hours.
- **IC assigned within 2 hours.**
- No war room; track in ticketing system.
- No status page update unless trending toward SEV2.

**Resolution target:** Full resolution within 1 business day.

---

### SEV4 — Cosmetic / Non-Urgent

**Definition:** No service impact. Cosmetic issues, documentation gaps, log noise,
or minor bugs that do not affect functionality.

**Examples:**
- Log formatting inconsistency (e.g., agent ID not short-formatted in one path).
- CLI output alignment issue in `aafp metrics`.
- Metrics counter showing slightly stale values due to lock-free snapshot timing.
- Deprecation warnings in build output.
- Health check warmup period (uptime <60s) reporting `Healthy` with zero
  connections — this is by design, not a bug.

**Response:**
- **Acknowledge within 1 business day.**
- No IC; file as a backlog ticket.
- No status page.

**Resolution target:** Next regular release cycle.

---

### Severity Decision Matrix

| Condition | SEV1 | SEV2 | SEV3 | SEV4 |
|-----------|------|------|------|------|
| Agents unreachable (fleet-wide) | ✓ | | | |
| Agents unreachable (single pod) | | | ✓ | |
| Error rate >50% (fleet) | ✓ | | | |
| Error rate 10–50% (fleet) | | ✓ | | |
| Error rate <10% (single agent) | | | ✓ | |
| Handshake failure >30% | | ✓ | | |
| Handshake failure <30% (intermittent) | | | ✓ | |
| Relay mesh entirely down | ✓ | | | |
| Single relay down (failover OK) | | ✓ | | |
| DHT lookup success <50% | ✓ | | | |
| DHT lookup success 50–80% | | ✓ | | |
| Memory growth (OOM imminent) | | ✓ | | |
| Memory growth (slow, stable) | | | ✓ | |
| Cascading failure detected | ✓ | | | |
| PubSub loss on critical topic | | ✓ | | |
| PubSub loss on low-traffic topic | | | ✓ | |
| Cosmetic / log noise | | | | ✓ |

---

## 2. Health Endpoints & Metrics Reference

AAFP exposes health and metrics through the SDK's `AgentMetrics` and
`HealthStatus` types, surfaced via the CLI and the `aafp.metrics` RPC method.

### Health Status Levels

The `HealthStatus` enum (`aafp-sdk/src/metrics.rs`) has three states derived
from a `MetricsSnapshot`:

| Status | Condition | CLI Exit Code |
|--------|-----------|---------------|
| `Healthy` | Has connections, error rate ≤10%, handshake failure rate ≤30% | 0 |
| `Degraded` | Error rate >10%, or handshake failure rate >30%, or <1 connection with uptime >60s | 1 |
| `Unhealthy` | Zero connections AND uptime >60s, OR error rate >50% | 2 |

**Warmup period:** During the first 60 seconds of uptime, zero connections is
treated as `Healthy` (agents are still bootstrapping and discovering peers).

### MetricsSnapshot Fields

All fields are lock-free `AtomicU64` counters. A snapshot is a point-in-time read
that may be slightly inconsistent across counters (acceptable for monitoring).

| Field | Description |
|-------|-------------|
| `connections_active` | Current active connection count |
| `connections_total` | Cumulative connections ever established |
| `messages_sent` | Total messages sent |
| `messages_received` | Total messages received |
| `bytes_sent` | Total bytes sent |
| `bytes_received` | Total bytes received |
| `handshakes_completed` | Successful v1 handshakes |
| `handshakes_failed` | Failed handshakes |
| `dht_records` | DHT records stored locally |
| `relay_connections` | Active relay connections |
| `messages_failed` | Messages that failed (send error, timeout) |
| `uptime_seconds` | Agent uptime in seconds |

### Derived Rates

- **Error rate** = `messages_failed / (messages_sent + messages_received)`
- **Handshake failure rate** = `handshakes_failed / (handshakes_completed + handshakes_failed)`

### RPC Access

The `aafp.metrics` RPC method returns a `MetricsRpcResponse` containing the
snapshot, health status, and agent ID (hex-encoded). Serialized as CBOR for wire
transmission; JSON available via `to_json()`.

### Kubernetes Health Probes

In production (see `PRODUCTION_DEPLOYMENT.md`), agents expose:
- **Liveness probe** → `aafp health` (exit 0 = live, exit 2 = restart)
- **Readiness probe** → `aafp health` (exit 0 = ready to receive traffic)
- **Metrics scrape** → Prometheus endpoint on TCP port 9090

---

## 3. Diagnostic Commands

The `aafp` CLI (`aafp-cli` crate) provides the primary diagnostic interface.
All commands accept `--identity <path>` (default: `aafp-identity.bin`).

### `aafp health`

Checks agent health status. Exits with code matching severity:
- `0` → `Healthy` (green)
- `1` → `Degraded` (yellow)
- `2` → `Unhealthy` (red)

```bash
aafp health --identity /path/to/aafp-identity.bin
# Output: Agent a1b2c3 is Healthy
```

**Use during incidents:** First-line check. Wire this into liveness probes,
load balancer health checks, and alerting thresholds. An exit code of `2` on
multiple agents is a strong SEV1 signal.

### `aafp metrics`

Prints a full metrics dashboard: agent ID, health status, uptime, connections
(active + total), messages (sent + received), handshakes (completed + failed),
DHT records, and bytes transferred.

```bash
aafp metrics --identity /path/to/aafp-identity.bin
```

**Use during incidents:** Correlate error rates, handshake failure rates, and
connection counts. A spike in `handshakes_failed` with stable `connections_active`
suggests a handshake-layer issue (keys, clock, replay cache). A drop in
`connections_active` toward zero suggests a transport or network issue.

### `aafp status`

Verifies the local identity file: agent ID (hex + short form), public/secret key
sizes (ML-DSA-65), and a keypair sign/verify self-test.

```bash
aafp status --identity /path/to/aafp-identity.bin
# Output includes: Keypair verification: PASS
```

**Use during incidents:** If `Keypair verification: FAIL` appears, the identity
file is corrupted or the keypair is invalid. This is a root cause for handshake
failures — the agent cannot produce valid signatures. Rotate the identity
immediately.

### `aafp peers`

Lists discovered peers from the DHT: agent ID (short), capabilities, multiaddr,
and NAT status.

```bash
aafp peers --identity /path/to/aafp-identity.bin
```

**Use during incidents:** An empty peer list after uptime >60s indicates DHT
discovery failure. Check bootstrap node connectivity, DHT routing table health,
and firewall rules. A peer list with stale multiaddrs (unreachable endpoints)
indicates DHT record churn without proper eviction.

### `aafp discover`

Discovers agents advertising a specific capability via the DHT.

```bash
aafp discover --capability translation --identity /path/to/aafp-identity.bin
```

**Use during incidents:** If `discover` returns no results for a capability that
should have providers, the DHT routing or record storage is compromised. Cross-
check with `aafp peers` and direct DHT inspection.

### `aafp connect`

Opens a direct connection to a peer by address.

```bash
aafp connect --addr quic://1.2.3.4:4433 --identity /path/to/aafp-identity.bin
```

**Use during incidents:** Bypasses DHT discovery to test direct connectivity.
If `connect` succeeds but `discover` fails, the problem is in DHT routing, not
transport. If `connect` fails, the problem is network-level (firewall, NAT,
relay).

### `aafp call`

Calls an agent by capability (routes through DHT discovery + connection pool).

```bash
aafp call translation "hello" --identity /path/to/aafp-identity.bin --json
```

**Use during incidents:** End-to-end functional test. If `call` fails but
`connect` + `send` succeed, the routing plane (scoring, circuit breaker, bulkhead)
is misbehaving.

### Diagnostic Command Flowchart

```
Incident detected
       │
       ▼
  aafp health ──exit 2──► SEV1/SEV2: investigate transport + network
       │
    exit 0/1
       │
       ▼
  aafp metrics ──handshakes_failed spiking──► Check keys, clock, replay cache
       │
       ▼
  aafp peers ──empty──► Check DHT, bootstrap, firewall
       │
    peers present
       │
       ▼
  aafp connect <peer> ──fail──► Check NAT, relay, firewall
       │
    connect OK
       │
       ▼
  aafp call <cap> ──fail──► Check routing plane, circuit breakers
```

---

## 4. Common Incident Scenarios & Runbooks

### 4.1 Agent Unreachable (SEV1/SEV2)

**Symptoms:** `aafp health` returns `Unhealthy` (exit 2). Other agents cannot
connect. DHT lookups for the agent's ID return no records. Monitoring alerts
fire on connection count = 0 with uptime >60s.

**Root cause categories:** Network/firewall, DHT record missing, relay failure,
agent process crash.

#### Runbook

**Step 1 — Check the health endpoint:**
```bash
aafp health --identity /path/to/identity.bin
aafp metrics --identity /path/to/identity.bin
```
Confirm `connections_active = 0` and `uptime_seconds > 60`. If uptime <60s, the
agent may still be in warmup — wait and recheck.

**Step 2 — Check the DHT record:**
```bash
aafp discover --capability <agent-capability> --identity /path/to/identity.bin
aafp peers --identity /path/to/identity.bin
```
If the agent's record is missing from the DHT, the agent either failed to publish
its `AgentRecord` or the record was evicted by churn. The DHT uses k=5 replication
(`REPLICATION_FACTOR`) across 256 k-buckets. A record disappears only if all 5
replicas evict it simultaneously (massive churn) or the agent never published.

**Action:** Restart the agent so it re-publishes its record. Verify the agent's
`AgentRecord` signature is valid — the DHT router (`dht_router.rs`) rejects
records that fail `record.verify()` before storing.

**Step 3 — Check relay status:**
```bash
# From another agent, check if relay connectivity exists
aafp connect --addr quic://<relay-addr>:4433 --identity /path/to/identity.bin
```
If the agent is behind NAT and relies on a relay (`RelayDiscovery` in
`aafp-nat`), verify the relay is healthy. The relay discovery module tracks
`RelayNodeInfo` with `is_healthy()` and `has_capacity()`. If the primary relay
is down, `select_best_relay_excluding()` should failover to the next best relay.

**Action:** If all relays are down, this is SEV1. Restore relay infrastructure
(see [§4.5 Relay Failure](#45-relay-failure-sev1sev2)). If failover relay exists,
force the agent to re-discover relays by restarting.

**Step 4 — Check firewall and network:**
```bash
# Verify UDP port 4433 is reachable (QUIC runs over UDP, not TCP)
nc -u -z <agent-host> 4433
# Or from another AAFP agent
aafp connect --addr quic://<agent-host>:4433 --identity /path/to/identity.bin
```
QUIC uses UDP. A common misconfiguration is opening TCP 4433 but not UDP 4433.
Verify security groups, NetworkPolicies, and iptables allow UDP 4433 inbound.

**Step 5 — Check the agent process:**
```bash
# Is the process running?
ps aux | grep aafp
# Check recent logs for panic or crash
journalctl -u aafp-agent --since "30 min ago" | grep -i "panic\|fatal\|crash"
```
If the process crashed, check for OOM kills (`dmesg | grep -i oom`), segfaults,
or panic traces. Restart the agent and monitor.

**Resolution criteria:** `aafp health` returns `Healthy` (exit 0) with
`connections_active > 0` and other agents can `aafp connect` successfully.

---

### 4.2 High Latency (SEV2)

**Symptoms:** `aafp call` responses take >2x baseline p99. RPC timeouts
increasing. Health status may still be `Healthy` (latency is not directly tracked
in `HealthStatus`, but `messages_failed` may rise if timeouts are counted as
failures).

**Root cause categories:** Connection pool exhaustion, routing plane misselection,
network conditions, agent CPU/load.

#### Runbook

**Step 1 — Check the connection pool:**
```bash
aafp metrics --identity /path/to/identity.bin
```
Look at `connections_active` vs expected. If `connections_active` is at the pool
maximum, new RPCs queue waiting for a connection. The QUIC transport multiplexes
streams over a single connection, so a single connection per peer is normal —
but if there are many peers and the pool is saturated, latency spikes.

**Action:** Increase the connection pool limit or reduce the peer fan-out. Check
for connection leaks (connections that never close — `connections_total` grows
but `connections_active` stays flat is normal; `connections_active` growing
without bound is a leak).

**Step 2 — Check routing metrics:**
The adaptive routing plane (`aafp-sdk/src/routing/`) scores peers by a fusion of
static and dynamic scores (`Weights`: 0.5/0.5 by default). The default strategy is
`PowerOfTwo` (sample two candidates, pick the higher score). If the dynamic score
is stale (older than `staleness_threshold` = 60s), it is pruned.

**Action:** If the router is selecting slow peers, the dynamic EWMA latency may
be stale or the scoring weights may need tuning. Check `RoutingConfig` —
consider switching to `LowestLatency` strategy during the incident as a
mitigation. Verify circuit breakers are not stuck open (see
[§4.7 Cascading Failure](#47-cascading-failure-sev1)).

**Step 3 — Check network conditions:**
```bash
# Latency to the target peer
ping <peer-host>
# Packet loss
mtr --report <peer-host>
# QUIC-specific: check UDP retransmissions
ss -u -i | grep 4433
```
QUIC is sensitive to packet loss. High packet loss causes QUIC retransmissions
that inflate latency. If the network path is degraded, there is no AAFP-level
fix — escalate to network engineering.

**Step 4 — Check agent load:**
```bash
# CPU and memory on the agent pod
kubectl top pod <agent-pod>
# Or on bare metal
top -p $(pgrep aafp)
```
If the agent process is CPU-bound (e.g., ML-DSA-65 signature verification under
high handshake load), RPC processing latency increases. ML-DSA-65 verification is
computationally expensive. Scale horizontally (more agent replicas) or vertically
(more CPU).

**Step 5 — Check for hedging opportunity:**
The `HedgePolicy` (default: disabled, delay 50ms, adaptive) can mask tail latency
by sending a secondary request after a delay. If hedging is disabled, enabling it
during the incident can reduce p99 latency at the cost of duplicate requests.

**Resolution criteria:** p99 RPC latency returns to <1.5x baseline for 30 minutes.

---

### 4.3 Handshake Failures (SEV2)

**Symptoms:** `aafp metrics` shows `handshakes_failed` spiking relative to
`handshakes_completed`. Health status degrades to `Degraded` when handshake
failure rate exceeds 30%. New connections fail to establish.

**Root cause categories:** Invalid keypair, clock skew, replay cache false
positives, TLS/QUIC configuration mismatch.

#### Runbook

**Step 1 — Check keypair validity:**
```bash
aafp status --identity /path/to/identity.bin
```
If `Keypair verification: FAIL`, the identity file is corrupted. The ML-DSA-65
keypair (`AgentKeypair`) cannot produce valid signatures, so every handshake
that requires signature verification will fail. The v1 handshake protocol
(`aafp-crypto`) signs handshake transcripts with ML-DSA-65.

**Action:** Regenerate the identity (`aafp init`) and re-publish the agent record
to the DHT. If the keypair was compromised, revoke the old AgentId in the
`TrustManager` revocation list and notify peers.

**Step 2 — Check clock skew:**
```bash
# On the agent host
timedatectl status
chronyc tracking  # or: ntpq -p
```
The v1 handshake uses timestamps for replay protection and record validity.
`AgentRecord.verify()` checks the record's timestamp against `now()`. Significant
clock skew (>300s default replay cache retention) can cause records to be
rejected as expired or replay detections to fire incorrectly.

**Action:** Sync the system clock (NTP/chrony). Restart the agent after clock
sync. The `ReplayCache` (`aafp-crypto/src/replay_cache.rs`) uses a default
retention of 300s and max 100K entries — clock jumps larger than this window can
cause false replay positives or missed replay detection.

**Step 3 — Check the replay cache:**
The `ReplayCache` tracks `(agent_id, nonce)` pairs to detect cross-connection
nonce replay (RFC-0002 §6.7, Rev 6 A-9). It uses check-before-verify,
insert-after-verify semantics. If the cache is full (100K entries) and eviction
is not keeping up, legitimate nonces may be evicted and replayed — but this
causes security failures, not false rejections. False rejections occur if the
same nonce is reused (a client bug).

**Action:** Check logs for `replay_cache` entries. If the cache is rejecting
legitimate handshakes, inspect the nonce generation on the client side. The
cache is thread-safe via internal `Mutex` — under extreme contention, handshake
latency may increase but should not fail.

**Step 4 — Check TLS/QUIC configuration:**
The QUIC transport (`aafp-transport-quic`) uses `quinn` + `rustls` with PQ TLS.
A mismatch in TLS cipher suites, ALPN protocols, or QUIC version between client
and server causes handshake failures at the transport layer (before the AAFP
v1 handshake even begins).

**Action:** Verify both peers run compatible AAFP versions. Check `rustls`
cipher suite configuration. QUIC connection errors appear in logs as
`quinn::connection` errors, distinct from AAFP handshake errors.

**Step 5 — Check handshake rate limiting:**
The SDK server (`aafp-sdk/src/server`) enforces per-IP handshake rate limiting
(10/sec default, 10K cap). If a single IP is initiating too many handshakes
(e.g., a misconfigured load balancer or a retry storm), legitimate handshakes
from that IP are dropped.

**Action:** Check logs for rate-limit rejections. Temporarily raise the limit or
identify and throttle the offending source.

**Resolution criteria:** Handshake failure rate drops below 10% for 30 minutes;
`handshakes_completed` resumes normal growth.

---

### 4.4 DHT Corruption (SEV2/SEV3)

**Symptoms:** `aafp discover` returns incorrect or stale results. `aafp peers`
shows unreachable endpoints. DHT lookups succeed but return wrong agents.
`dht_records` count is unexpectedly low or high.

**Root cause categories:** Record integrity failure (signature tampering),
routing table corruption, replication failure, churn storm.

#### Runbook

**Step 1 — Check record integrity:**
The DHT router (`aafp-discovery/src/dht_router.rs`) verifies every record's
signature before storing: `record.verify((self.now)())`. If verification fails,
the record is rejected. However, a corrupted record already in the store (from
a bug or storage fault) can persist.

**Action:** Dump the local DHT store and verify each record's signature
manually. Look for records with `signature: vec![]` (empty signature — a sign of
test data or corruption). Remove corrupted records and trigger re-replication
from healthy peers.

**Step 2 — Check signature verification:**
```bash
aafp status --identity /path/to/identity.bin
```
Verify the local agent's keypair is valid (see [§4.3 Step 1](#43-handshake-failures-sev2)).
If the local keypair is invalid, the agent cannot verify records signed by others
(verification uses the signer's public key from the record, not the local
keypair — but a broken local keypair means the agent cannot sign its own records
for re-publishing).

**Step 3 — Check DHT routing:**
The routing table uses 256 k-buckets keyed by XOR distance, with α=3 concurrency
for iterative lookups and k=5 replication. If the routing table is empty or
degraded (all buckets empty), lookups fail.

**Action:** Check the number of peers in the routing table via `aafp peers`. If
empty, the agent lost its bootstrap connections. Restart the agent with valid
seed addresses (`aafp start --seeds <seed-addr>`). Verify bootstrap nodes are
reachable.

**Step 4 — Check for churn storms:**
The DHT has churn handling (`churn_tests` module). If agents are rapidly joining
and leaving (e.g., aggressive autoscaling or crash-looping pods), the routing
table thrashes and records may be evicted before replication stabilizes.

**Action:** Stabilize the agent fleet. Pause autoscaling. Fix crash-looping pods.
Wait for the DHT to converge (replication + PEX peer exchange). Monitor
`dht_records` count for stabilization.

**Step 5 — Check PEX (Peer Exchange):**
PEX augments DHT routing by exchanging peer lists between connected peers. If
PEX is disabled or failing, the routing table relies solely on iterative DHT
lookups, which are slower to converge after churn.

**Resolution criteria:** `aafp discover` returns correct, reachable peers.
`dht_records` count stabilizes. Lookups succeed >95%.

---

### 4.5 Relay Failure (SEV1/SEV2)

**Symptoms:** Agents behind NAT cannot be reached. `relay_connections` metric
drops to zero. Cross-cluster connectivity lost. Direct `aafp connect` to
NAT'd agents fails.

**Root cause categories:** Relay node down, relay at capacity, failover relay
unavailable, direct connectivity impossible (symmetric NAT).

#### Runbook

**Step 1 — Check relay health:**
The `RelayDiscovery` module (`aafp-nat/src/relay_discovery.rs`) tracks relay
health via `RelayNodeInfo.is_healthy()` and `has_capacity()`. Relays are
discovered by looking up the `"relay"` capability in the DHT and from bootstrap
relay addresses.

```bash
# Test relay connectivity directly
aafp connect --addr quic://<relay-host>:4433 --identity /path/to/identity.bin
```
If the relay is unreachable, check the relay process and network.

**Step 2 — Check failover relay:**
`select_best_relay_excluding()` picks the next best relay when the current one
fails. The relay cache (`max_relays` default) maintains multiple relays. If only
one relay is configured and it fails, there is no failover.

**Action:** Ensure at least 2–3 relay nodes are deployed across different
availability zones. Add relay addresses as bootstrap relays:
`RelayDiscovery::add_bootstrap_relays()`. Verify the DHT has multiple agents
advertising the `"relay"` capability.

**Step 3 — Check direct connectivity:**
If relay failover is working but the agent is still unreachable, the agent may
be behind symmetric NAT where neither direct dial-back (AutoNAT) nor hole
punching (DCuTR) can establish a connection. The only path is through a relay.

**Action:** Verify the agent's NAT status. If symmetric NAT is confirmed,
ensure relay connectivity is the primary path and relays have sufficient
capacity (`has_capacity()` checks `current < max`).

**Step 4 — Check relay capacity:**
A relay at capacity (`utilization() = 1.0`) rejects new connections. The
`update_capacity()` method tracks `max` and `current` connection counts.

**Action:** Scale the relay horizontally (more relay pods) or increase the per-
relay connection limit. Monitor relay CPU/memory — relays forward traffic and are
I/O intensive.

**Step 5 — Restore relay infrastructure (SEV1):**
If all relays are down, this is SEV1. Restore relay pods first (they are
stateless and fast to restart). Verify the `"relay"` capability is advertised in
the DHT. Force agents to re-discover relays by restarting them or triggering a
relay refresh (`needs_refresh()` check, default interval 5 minutes).

**Resolution criteria:** NAT'd agents reachable via relay. `relay_connections >
0`. Failover relay tested and functional.

---

### 4.6 Memory Leak (SEV2/SEV3)

**Symptoms:** Agent RSS memory grows monotonically. OOM kills occur. Kubernetes
restarts pods due to memory limit exceeded. `connections_active` or stream counts
grow without bound.

**Root cause categories:** Connection leak, stream leak, buffer pool growth,
DHT routing table growth, replay cache growth.

#### Runbook

**Step 1 — Check heap profile:**
```bash
# If running with jemalloc
jemalloc-prof dump /tmp/agent-heap.prof
# Or capture core + analyze
gcore $(pgrep aafp)
# Kubernetes: check previous pod's OOM event
kubectl describe pod <agent-pod> | grep -i "oom\|killed"
```
Identify the dominant allocation site. Common leak sources in AAFP: connection
objects not dropped, stream handles not closed, DHT routing table entries
accumulating, replay cache not evicting.

**Step 2 — Check connection count:**
```bash
aafp metrics --identity /path/to/identity.bin
```
Compare `connections_active` vs `connections_total`. If `connections_active`
grows monotonically (never decreases despite idle peers), connections are not
being closed. The `record_disconnect()` method decrements `connections_active`;
if it is not called, connections leak.

**Action:** Identify which peers have stale connections. Restart the agent as a
mitigation (releases all connections). File a bug for the connection lifecycle
issue — the `CloseManager` (`aafp-messaging/src/close_manager.rs`) governs CLOSE
frame state transitions; a bug there can prevent connection cleanup.

**Step 3 — Check stream count:**
QUIC multiplexes streams over connections. Each RPC call opens a bidirectional
stream. If streams are not properly closed (CLOSE frame not sent/processed),
they accumulate. The `CloseManager` tracks 5 states: Open, LocalCloseSent,
RemoteCloseReceived, CloseReceived, Closed. A stream stuck in any non-Closed
state leaks memory.

**Action:** Check logs for streams stuck in intermediate close states. The
`CloseManager` is the single authority for CLOSE transitions — inspect its state
machine for violations.

**Step 4 — Check buffer pool:**
CBOR encoding/decoding and frame processing allocate buffers. If the buffer pool
is not recycling buffers, memory grows with traffic volume.

**Action:** Check `bytes_sent` + `bytes_received` growth rate vs RSS growth. If
RSS grows proportional to traffic but not proportional to active connections,
the buffer pool is leaking. Profile allocations in `aafp-cbor` and
`aafp-messaging` frame encode/decode paths.

**Step 5 — Check replay cache size:**
The `ReplayCache` has a max of 100K entries with LRU eviction and 300s retention.
If eviction is broken, the cache grows unbounded. Under normal load, the cache
self-regulates; under a handshake flood, it may temporarily grow.

**Action:** Check `evict_expired()` is being called periodically. If the cache
Mutex is contended, eviction may be delayed. Monitor cache size if exposed via
metrics.

**Resolution criteria:** RSS memory stabilizes (flat or oscillating with load)
for 1 hour. No OOM kills. `connections_active` decreases when peers disconnect.

---

### 4.7 Cascading Failure (SEV1)

**Symptoms:** Failure spreads from one agent/subsystem to others. Multiple
agents degrade simultaneously. Error rates climb across the fleet. Health
status flips from `Healthy` to `Degraded` to `Unhealthy` in a wave pattern.

**Root cause categories:** Circuit breakers not tripping, bulkhead limits
exceeded, timeout misconfiguration, shared dependency failure.

#### Runbook

**Step 1 — Check circuit breakers:**
The routing plane (`aafp-sdk/src/routing/config.rs`) has `CircuitBreakerConfig`:
- `failure_threshold`: 5 consecutive failures to trip (default)
- `cooldown`: 10s open→half-open wait (default)
- `half_open_max_trials`: 1 trial request in half-open (default)

If circuit breakers are not tripping, a failing peer continues to receive
traffic, spreading latency and failures. If breakers are stuck open, healthy
peers are unnecessarily avoided.

**Action:** Check breaker state per peer. If breakers are not tripping, lower
`failure_threshold` temporarily. If stuck open, force a cooldown reset by
restarting the routing plane or the agent. The breaker should transition:
Open → (cooldown) → HalfOpen → (trial succeeds) → Closed.

**Step 2 — Check bulkhead limits:**
The `BulkheadRegistry` (`aafp-sdk/src/routing/bulkhead.rs`) enforces per-peer
concurrency limits (`ConcurrencyLimit` with `max_inflight`). If a single slow
peer exhausts its bulkhead, the router should skip to the next candidate. If
bulkheads are not enforced, a slow peer consumes all concurrent slots.

**Action:** Verify `acquire()` / `release()` are called correctly. If the
bulkhead is not releasing slots on error (only on success), slots leak and the
peer becomes permanently blocked. Check that error paths call `release()`.

**Step 3 — Check timeout configuration:**
If RPC timeouts are too long, a slow peer holds resources (connection, stream,
bulkhead slot) for the full timeout duration, amplifying load. If timeouts are
too short, legitimate slow requests fail and trigger retry storms.

**Action:** Review timeout settings. During a cascade, temporarily reduce
timeouts to fail fast and free resources. Ensure retry logic has exponential
backoff and a max retry count to prevent retry storms.

**Step 4 — Check for shared dependency failure:**
Cascading failure often originates from a shared dependency: a common bootstrap
node, a shared relay, a DHT seed, or an external service (e.g., a key directory
or CA). If all agents depend on the same bootstrap node and it fails, the entire
fleet loses DHT connectivity.

**Action:** Identify the shared dependency. Diversify bootstrap nodes, relays,
and seed addresses across availability zones. Remove the single point of
failure.

**Step 5 — Shed load to stop the cascade:**
As an emergency mitigation, shed load:
- Disable non-critical RPC paths.
- Reduce the peer fan-out (fewer concurrent connections).
- Enable aggressive circuit breaking (lower `failure_threshold`).
- Rate-limit incoming requests at the transport layer.

**Resolution criteria:** Error rate stops spreading. Fleet health stabilizes.
Circuit breakers transition to Closed as peers recover.

---

### 4.8 PubSub Message Loss (SEV2/SEV3)

**Symptoms:** Subscribers miss published messages. Topic streams have gaps.
Back-channel events (e.g., LLM token streams) are incomplete. No error logged —
messages silently dropped.

**Root cause categories:** Subscription state mismatch, topic matching failure,
propagation driver not running, connection drop during delivery.

#### Runbook

**Step 1 — Check subscription status:**
PubSub subscriptions are per-connection. The `aafp.pubsub.subscribe` RPC
registers a topic subscription on the remote peer. If the subscription was not
established (RPC failed silently) or was dropped (connection closed), published
messages are not forwarded.

**Action:** Verify the subscription RPC completed successfully. Check logs for
`pubsub.subscribe` acknowledgments. If the connection dropped, the subscription
is automatically removed — resubscribe after reconnection. The SDK removes
subscriptions on disconnect and optionally publishes a will message.

**Step 2 — Check topic matching:**
AAFP supports hierarchical topics with `/` separators and `+`/`#` wildcards
(MQTT/RabbitMQ-style). A mismatch between the published topic and the
subscription filter causes silent message loss.

Example:
- Publisher sends to `translate.events`
- Subscriber subscribed to `translate.*` — **does not match** (AAFP uses `+` for
  single-level, not `*`)
- Correct filter: `translate.+` or `translate.#`

**Action:** Verify the topic filter syntax. Test with `aafp call` using the
PubSub API to confirm matching. The `topic_matches()` function implements the
matching logic — review its behavior for the specific topic pattern.

**Step 3 — Check the propagation driver:**
The PubSub propagation driver (background task) forwards published messages to
all `remote_subscribers(topic)`. If the driver task is not running (panicked,
cancelled, or never started), local publishes work but remote delivery does not.

**Action:** Check logs for propagation driver errors. The driver queries
`remote_subscribers(topic)`, computes a `seen` list (to prevent loops), and sends
`aafp.pubsub.publish` frames with decrementing TTL. If the driver is dead,
restart the agent. Verify the driver is spawned in the `ServeBuilder` path.

**Step 4 — Check for TTL exhaustion:**
Published messages carry a TTL (default: `DEFAULT_TTL`). Each hop decrements the
TTL. If the TTL reaches zero before delivery, the message is dropped. In a deep
mesh topology, messages may not reach all subscribers.

**Action:** Increase the TTL for the affected topic. Check the mesh diameter —
if the topology requires many hops, the default TTL may be insufficient.

**Step 5 — Check the seen-list:**
The `seen` list (AgentIds that have already processed the message) prevents
loops. If the seen-list is too aggressive (includes the target subscriber
erroneously), the message is dropped as a "duplicate."

**Action:** Inspect the seen-list construction in the propagation driver. The
list includes `our_id + from` — if a subscriber's AgentId is mistakenly added,
delivery is skipped.

**Step 6 — Check topic ACLs:**
Topic ACLs (rooted in UCAN capability chains) may block publish or subscribe.
A capability is `pubsub/<topic>/<action>` (action = publish or subscribe). If
the caller lacks the capability, the operation is silently rejected (or
returns an authorization error, depending on implementation).

**Action:** Verify the caller has a valid UCAN capability chain for the topic.
Check the `TopicAcl::check()` authorization before subscription/publish.

**Resolution criteria:** Published messages arrive at all subscribers. No gaps
in topic streams. Propagation driver running and healthy.

---

## 5. Log Analysis Patterns

AAFP uses `tracing` (via `tracing-subscriber`) for structured logging. Logs
include span context, agent IDs, and trace IDs for correlation.

### 5.1 Grep for Errors

```bash
# All ERROR and WARN level entries in the last hour
journalctl -u aafp-agent --since "1 hour ago" | grep -E "ERROR|WARN"

# Filter by crate/module
journalctl -u aafp-agent | grep -E "aafp_crypto|aafp_transport|aafp_discovery"

# Find panic traces
journalctl -u aafp-agent | grep -A 20 "panic"

# Handshake-specific errors
journalctl -u aafp-agent | grep -iE "handshake.*(fail|error|reject)"

# Replay cache rejections
journalctl -u aafp-agent | grep -i "replay_cache"

# DHT routing errors
journalctl -u aafp-agent | grep -iE "dht.*(error|reject|corrupt)"

# Relay failures
journalctl -u aafp-agent | grep -iE "relay.*(fail|unreachable|capacity)"

# Circuit breaker state transitions
journalctl -u aafp-agent | grep -iE "circuit.*(open|closed|half_open|trip)"
```

### 5.2 Trace ID Correlation

AAFP RPCs carry a trace context for distributed tracing. To follow a single
request across agents:

```bash
# Extract the trace_id from the initial request
TRACE_ID="abc123..."
# Correlate across all agent logs
grep -r "$TRACE_ID" /var/log/aafp/
# Or across Kubernetes pods
kubectl logs -l app=aafp-agent --all-containers | grep "$TRACE_ID"
```

The trace ID appears in log span context. Correlate by:
1. Find the originating agent's log entry with the trace ID.
2. Follow the trace ID to downstream agents.
3. Identify where the trace diverges from expected behavior (timeout, error,
   unexpected response).

### 5.3 Timeline Reconstruction

```bash
# Sort all agent logs by timestamp for a fleet-wide timeline
for pod in $(kubectl get pods -l app=aafp-agent -o name); do
  kubectl logs "$pod" --since "2 hours ago" --timestamps
done | sort -k1 > /tmp/aafp-timeline.log

# Filter to a specific time window
awk '$1 >= "2026-07-04T10:00:00" && $1 <= "2026-07-04T10:30:00"' /tmp/aafp-timeline.log

# Find the first error (incident onset)
grep -m 1 "ERROR" /tmp/aafp-timeline.log

# Find error bursts (multiple errors within seconds)
awk '/ERROR/{print NR, $0}' /tmp/aafp-timeline.log | awk 'NR>1 && $1-prev<5 {print "BURST:", prev_line, $0} {prev=$1; prev_line=$0}'
```

### 5.4 Key Log Patterns by Incident Type

| Incident | Log Pattern | Grep Expression |
|----------|-------------|-----------------|
| Agent unreachable | No log entries (process dead) | `ps aux \| grep aafp` |
| Handshake failure | `handshake.*failed.*signature` | `grep -i "handshake.*fail"` |
| Replay detection | `replay.*detect\|nonce.*reject` | `grep -i "replay"` |
| DHT corruption | `record.*verify.*fail\|signature.*invalid` | `grep -iE "record.*(verify|signature).*fail"` |
| Relay failure | `relay.*unreachable\|relay.*capacity` | `grep -iE "relay.*(unreachable|capacity)"` |
| Circuit breaker | `circuit.*open\|breaker.*trip` | `grep -iE "circuit.*open\|breaker"` |
| PubSub loss | `pubsub.*drop\|propagation.*error` | `grep -iE "pubsub\|propagation"` |
| OOM | (no log — process killed) | `dmesg \| grep -i oom` |
| Connection leak | `connections_active` monotonic increase | (metrics-based, not logs) |

---

## 6. Post-Incident Review Template

Every SEV1 and SEV2 incident requires a post-incident review (PIR) within 3
business days of resolution. SEV3 incidents require a PIR if recurring.

### Post-Incident Review Document

```markdown
# PIR: [Incident Title]

**Date:** YYYY-MM-DD
**Severity:** SEV[1-4]
**Duration:** [start time] to [end time] ([total time])
**Incident Commander:** [name]
**Reviewers:** [names]

---

## Summary

[1-2 paragraph executive summary of what happened, impact, and resolution.
Non-technical audience should understand this.]

## Impact

- **User-visible impact:** [What users experienced]
- **Agents affected:** [count / percentage of fleet]
- **Requests failed:** [count or rate]
- **Data loss:** [yes/no, details]
- **Security impact:** [yes/no, details]

## Timeline

| Time (UTC) | Event | Source |
|------------|-------|--------|
| 10:00 | Alert fired: agent health Unhealthy | PagerDuty |
| 10:05 | On-call acknowledged | PagerDuty |
| 10:10 | IC assigned, war room opened | Slack |
| 10:15 | Identified relay failure as root cause | `aafp health` + logs |
| 10:30 | Failover relay activated | Runbook §4.5 |
| 10:45 | Agents reconnecting, health improving | `aafp metrics` |
| 11:00 | All agents Healthy | `aafp health` fleet-wide |
| 11:15 | Incident declared resolved | IC |

## Root Cause

[Detailed technical explanation of the root cause. Include the specific
component, code path, and why the failure occurred. Reference file paths and
line numbers where relevant.]

**Root cause category:** [network / software bug / config error / capacity /
security / third-party]

**Triggering event:** [What started the incident]

**Contributing factors:**
- [Factor 1]
- [Factor 2]

## What Went Well

- [e.g., Alert fired within 30 seconds of impact]
- [e.g., Failover relay activated automatically]
- [e.g., Runbook §4.5 was followed and resolved the issue in 15 minutes]

## What Went Poorly

- [e.g., No alert for relay capacity — only alerted on agent unreachable]
- [e.g., War room took 12 minutes to assemble]
- [e.g., DHT inspection required manual commands not in the runbook]

## Action Items

| # | Action | Owner | Priority | Due Date | Ticket |
|---|--------|-------|----------|----------|--------|
| 1 | Add relay capacity alert at 80% utilization | @sre | P1 | 2026-07-11 | AAFP-123 |
| 2 | Deploy second relay in us-east-1b | @platform | P1 | 2026-07-18 | AAFP-124 |
| 3 | Add `aafp relay-status` CLI command | @sdk | P2 | 2026-07-25 | AAFP-125 |
| 4 | Update runbook with relay capacity check | @sre | P2 | 2026-07-08 | AAFP-126 |

## Lessons Learned

- [Broader architectural or process insight]
- [What would prevent this class of incident entirely]

## Appendix

- [Links to dashboards, logs, traces]
- [Command output captured during incident]
- [Relevant metrics graphs]
```

---

## 7. On-Call Guide

### 7.1 What to Check First (Triage Checklist)

When paged, run through this checklist in order. Most incidents are resolved or
categorized within 10 minutes.

```
□ 1. Is the agent process running?
     → ps aux | grep aafp  (or: kubectl get pods -l app=aafp-agent)

□ 2. What does `aafp health` say?
     → exit 0 = Healthy, exit 1 = Degraded, exit 2 = Unhealthy
     → If Unhealthy: this is at least SEV2. Check connections_active.

□ 3. What does `aafp metrics` show?
     → handshakes_failed > 30% of total? → Handshake issue (§4.3)
     → connections_active = 0? → Transport/network issue (§4.1)
     → messages_failed > 10%? → Error rate issue, check logs
     → relay_connections = 0? → Relay issue (§4.5)

□ 4. Are peers visible?
     → aafp peers — empty? → DHT issue (§4.4) or bootstrap failure

□ 5. Can you connect directly to a known peer?
     → aafp connect --addr <known-peer> — fails? → Network/firewall (§4.1)

□ 6. Check recent logs for errors.
     → journalctl -u aafp-agent --since "30 min ago" | grep ERROR

□ 7. Is this a single agent or fleet-wide?
     → Single agent: SEV3. Fleet-wide: SEV1/SEV2.

□ 8. Is there an active deployment or config change?
     → Check CI/CD pipeline and recent config commits.
```

### 7.2 Escalation Paths

```
On-call SRE (you)
    │
    ├── Cannot resolve in 15 min ──► Escalate to SRE Lead
    │
    ├── Suspected security incident (key compromise) ──► Security On-Call
    │
    ├── DHT/discovery core bug ──► AAFP SDK Engineer On-Call
    │
    ├── Transport/QUIC/TLS issue ──► Transport Engineer On-Call
    │
    ├── Network infrastructure ──► Network Engineering On-Call
    │
    ├── SEV1 confirmed ──► Engineering Manager + Director
    │
    └── SEV1 + customer impact ──► VP Engineering + Status Page
```

**Escalation criteria:**
- **SRE Lead:** Incident not mitigated within 30 minutes (SEV2) or 15 minutes
  (SEV1), or you are unsure of next steps.
- **Security On-Call:** Any suspected key compromise, unauthorized access,
  replay attack, or signature forgery.
- **AAFP SDK Engineer:** Bug in the SDK, routing plane, handshake, or DHT code
  that requires code-level expertise.
- **Transport Engineer:** QUIC connection failures, TLS handshake errors,
  rustls/quinn issues.
- **Network Engineering:** Firewall, NAT, routing, or cross-cluster connectivity
  issues that are infrastructure-level.

### 7.3 Communication Templates

#### 7.3.1 Incident Declaration (Slack / Status Page)

```
🚨 INCIDENT DECLARED — SEV[1/2]: [Brief title]

**What:** [1-sentence description of the issue]
**Impact:** [Who/what is affected — e.g., "All agents in us-east-1 unreachable"]
**Started:** [timestamp UTC]
**IC:** [name]
**War room:** [Slack channel / bridge link]
**Status:** Investigating

Next update in 30 minutes.
```

#### 7.3.2 Incident Update (Every 30 min for SEV1, 60 min for SEV2)

```
📊 INCIDENT UPDATE — SEV[1/2]: [Brief title]

**Status:** [Investigating / Mitigating / Monitoring / Resolved]
**Current impact:** [What is happening now]
**Actions taken:**
- [Action 1 — e.g., "Failed over to backup relay"]
- [Action 2 — e.g., "Restarted 12 affected agent pods"]
**Next steps:** [What we are doing next]
**ETA to resolution:** [time or "unknown"]

Next update in [30/60] minutes.
```

#### 7.3.3 Incident Resolved

```
✅ INCIDENT RESOLVED — SEV[1/2]: [Brief title]

**Duration:** [start] to [end] ([total time])
**Root cause (preliminary):** [1-sentence summary]
**Resolution:** [What fixed it]
**Final impact:** [Total affected — e.g., "45 agents unreachable for 22 minutes"]

A post-incident review will be scheduled within 3 business days.
Tracking: [PIR ticket link]
```

#### 7.3.4 Internal Handoff (Shift Change / Escalation)

```
📋 INCIDENT HANDOFF — SEV[1/2]: [Brief title]

**Current IC:** [outgoing] → **New IC:** [incoming]
**Incident state:** [Investigating / Mitigating / Monitoring]
**Summary so far:**
- [Key finding 1]
- [Key finding 2]
**Active mitigations:**
- [What has been done and its effect]
**Pending actions:**
- [ ] [Action item with owner]
**Open questions:**
- [Question needing investigation]
**Relevant links:**
- Runbook section: [§4.x]
- Logs: [link]
- Dashboard: [link]
```

#### 7.3.5 Customer-Facing Status Page (SEV1 only)

```
[Service] is experiencing [degraded performance / an outage]

We have identified an issue affecting [specific functionality]. Our team is
actively investigating and working to restore service. We will provide another
update by [time].

Last updated: [timestamp UTC]
```

### 7.4 On-Call Quick Reference Card

| Situation | First Command | Runbook | Severity |
|-----------|--------------|---------|----------|
| Agent unreachable | `aafp health` | §4.1 | SEV1/2 |
| High latency | `aafp metrics` | §4.2 | SEV2 |
| Handshake failures | `aafp status` + `aafp metrics` | §4.3 | SEV2 |
| DHT corruption | `aafp peers` + `aafp discover` | §4.4 | SEV2/3 |
| Relay failure | `aafp connect <relay>` | §4.5 | SEV1/2 |
| Memory leak | `aafp metrics` (conn count) | §4.6 | SEV2/3 |
| Cascading failure | Fleet-wide `aafp health` | §4.7 | SEV1 |
| PubSub loss | Check subscription logs | §4.8 | SEV2/3 |

### 7.5 Key Thresholds Reference

| Metric | Healthy | Degraded | Unhealthy |
|--------|---------|----------|-----------|
| Error rate | ≤10% | 10–50% | >50% |
| Handshake failure rate | ≤30% | >30% | — |
| Active connections (uptime >60s) | >0 | — | 0 |
| Active connections (uptime <60s) | 0 OK (warmup) | — | — |
| DHT lookup success | >95% | 80–95% | <80% |
| p99 RPC latency | <1.5x baseline | 1.5–3x baseline | >3x baseline |
| Relay utilization | <70% | 70–90% | >90% |
| Circuit breaker trips | 0 | occasional | persistent |

### 7.6 Pre-Incident Preparation

Before going on-call, verify:

```
□ CLI tool installed: aafp --version
□ Access to all agent clusters (kubectl contexts configured)
□ Access to log aggregation (Loki/ELK/Splunk)
□ Access to metrics dashboards (Grafana/Prometheus)
□ PagerDuty / alerting channel configured
□ War room bridge link known
□ Escalation contacts saved
□ This runbook bookmarked
□ Recent changes/deployments reviewed
□ Known ongoing issues checked (status page, incident channel)
```

---

*This runbook is a living document. Update it after every post-incident review
with new runbook steps, diagnostic commands, and thresholds discovered during
incidents. File improvements as tickets referenced from the PIR action items.*
