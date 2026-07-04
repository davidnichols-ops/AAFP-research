# AAFP World-Scale Research: Actionable Findings

**Date:** 2026-07-03
**Researcher:** Devin (parallel web research + architecture analysis)
**Goal:** How to augment AAFP to handle world-scale traffic (millions of agents,
billions of messages/day, global multi-continent deployment)

---

## Executive Summary

AAFP's current architecture (QUIC + ML-DSA-65 + CBOR framing + capability DHT)
is sound for thousands of agents on localhost/LAN. To reach world scale
(millions of agents, global deployment), AAFP needs augmentations in 6 areas:

1. **Connection plane architecture** (WhatsApp/Discord pattern: gateway shards)
2. **Kernel bypass for high throughput** (XDP/AF_XDP or DPDK for quinn)
3. **DHT scaling** (IPFS pattern: client/server mode, optimized K-buckets)
4. **PQ crypto at scale** (verification caching, batched verification)
5. **Global relay infrastructure** (geo-routed TURN-like relay network)
6. **Congestion control tuning** (BBR fairness issues, per-scenario CCA)

The good news: AAFP's foundation (QUIC, post-quantum crypto, lock-free data
path) is the right foundation. The augmentations are additive, not rewrites.

---

## Finding 1: Connection Plane Architecture

### What the research shows

**WhatsApp** handles 2M+ concurrent connections per server using:
- Erlang/BEAM VM (lightweight processes, per-process GC)
- One Erlang process per connection, one connection per user
- Vertical density first (push each server to 2M connections before adding servers)
- ~550 servers for 465M monthly users, 19B messages/day
- FreeBSD kernel tuning (FD limits, buffer sizes)
- Custom binary protocol (FunXMPP) to shrink message size

**Discord** handles 5M+ concurrent users using:
- Gateway servers (WebSocket connection plane) → separate from guild processes (coordination)
- Sharding: each shard handles a subset of users/guilds
- Relays: split fanout work across multiple processes (15K sessions per relay)
- Kafka for decoupling message ingestion from delivery
- Redis for ephemeral connection state (who's online, which shard)
- ScyllaDB for message persistence (p99 read: 15ms, write: 5ms)

**Key pattern:** Separate the connection plane (gateway) from the coordination
plane (routing/fanout) from the storage plane (persistence).

### AAFP cross-reference

AAFP currently has no separation between connection handling and message
routing. An agent both accepts connections AND processes messages. At scale,
this means:
- A single agent handling 10K connections also has to route all their messages
- No way to shard connection acceptance across multiple processes
- No gateway pattern for load balancing incoming connections

### What AAFP needs

```
Current AAFP:
  Agent = Connection Handler + Message Router + DHT Node + App Logic

World-Scale AAFP:
  ┌─────────────┐     ┌──────────────┐     ┌─────────────┐
  │  Gateway    │────▶│  Router      │────▶│  Agent      │
  │  (QUIC      │     │  (DHT lookup,│     │  (App logic,│
  │   accept,   │     │   fanout,    │     │   LLM,      │
  │   TLS,      │     │   capability │     │   tools)    │
  │   handshake)│     │   matching)  │     │             │
  └─────────────┘     └──────────────┘     └─────────────┘
       │                     │                    │
       ▼                     ▼                    ▼
  ┌──────────┐         ┌──────────┐         ┌──────────┐
  │ Redis    │         │ Kafka    │         │ ScyllaDB │
  │ (conn    │         │ (event   │         │ (message │
  │  state)  │         │  bus)    │         │  store)  │
  └──────────┘         └──────────┘         └──────────┘
```

**Action items:**
1. Add `Gateway` mode to AgentBuilder — accepts QUIC connections, completes
   TLS + AAFP handshake, then forwards the established session to a Router
2. Add `Router` mode — receives forwarded sessions, does DHT lookup,
   capability matching, and routes messages to the right Agent
3. Add connection sharding — Gateway assigns connections to shards based
   on AgentId hash (consistent hashing)
4. Add Redis-backed connection state — track which gateway holds which
   connection (for cross-gateway routing)
5. Add Kafka/NATS event bus — decouple message ingestion from delivery

---

## Finding 2: Kernel Bypass for High Throughput

### What the research shows

**DPDK (Data Plane Development Kit):**
- Bypasses kernel entirely using userspace drivers + polling
- ~2x higher packet throughput (700K PPS vs 310K PPS with kernel)
- Zero packet drops up to 350K PPS (kernel starts dropping)
- Zero syscalls, zero context switches
- Rust integration exists: `dpdk-stdlib-rust` (drop-in UdpSocket replacement)
- QUIC + DPDK: picoquic-dpdk shows 3x throughput improvement
- Downside: requires dedicated NIC, 100% CPU on polling cores

**XDP/eBPF + AF_XDP:**
- XDP program runs in kernel at NIC driver level (earliest hook point)
- AF_XDP redirects packets to userspace via shared memory (UMEM)
- Zero-copy: NIC → UMEM → application (no kernel copy)
- Solana's Afterburner: 4.7M TPS with sub-100µs latency using XDP + QUIC
- s2n-quic has production XDP implementation (Rust + aya eBPF library)
- ExpressGateway: L4/L7 load balancer with XDP + QUIC in Rust
- More practical than DPDK (doesn't need dedicated NIC, works with SR-IOV)

**io_uring:**
- Async I/O without syscalls (submission/completion rings)
- Zero-copy RX: 116 Gbps vs 82 Gbps with epoll (+41%)
- P99 latency: 4.2µs (io_uring) vs 12.3µs (kernel sockets) vs 1.8µs (DPDK)
- rzmq (Rust ZeroMQ): 2.2M msg/s with io_uring + cork
- Still maturing for networking (zero-copy RX patches in kernel 6.11+)
- Tokio integration exists but not yet at parity with epoll for TCP

### AAFP cross-reference

AAFP uses quinn (Rust QUIC) which uses standard UDP sockets via `quinn-udp`.
On Linux, quinn-udp already uses `recvmmsg` for batched receives. But:
- No XDP/eBPF integration (packets go through full kernel network stack)
- No DPDK integration (all I/O goes through kernel syscalls)
- No io_uring integration (uses epoll via tokio)
- Current throughput: 776K msg/s on localhost (limited by QUIC processing,
  not kernel I/O — but at scale, kernel I/O becomes the bottleneck)

### What AAFP needs

**Tier 1 (most practical, Linux-only): XDP + AF_XDP**
- Write an eBPF XDP program that filters QUIC packets (UDP port 4433)
- Redirect to AF_XDP sockets for zero-copy userspace processing
- Use `aya` crate (Rust eBPF library, same as s2n-quic)
- Expected: 2-3x throughput improvement on Linux
- Pattern: Afterburner (Solana) and s2n-quic already prove this works

**Tier 2 (highest performance, dedicated hardware): DPDK**
- Use `dpdk-stdlib-rust` as drop-in replacement for UdpSocket
- Quinn endpoint on DPDK UDP socket
- Expected: 3x throughput, sub-µs latency
- Downside: requires dedicated NIC, Linux only, 100% CPU on polling cores
- Use case: relay nodes and gateway servers (not individual agents)

**Tier 3 (future, when stable): io_uring zero-copy**
- Wait for io_uring zero-copy RX to stabilize (kernel 6.11+)
- Use `tokio-uring` for async I/O
- Expected: 40% throughput improvement over epoll
- Not ready for production yet (tokio-uring networking still maturing)

**Action items:**
1. Add `xdp` feature flag to aafp-transport-quic
2. Write eBPF XDP program (aya crate) for QUIC packet filtering
3. Add AF_XDP socket support to quinn-udp (or wrap quinn endpoint)
4. Benchmark: XDP vs standard sockets at 100K+ connections
5. Add `dpdk` feature flag for relay/gateway nodes (optional, Linux-only)
6. Document kernel tuning: SO_SNDBUF, SO_RCVBUF, UDP buffer sizes

---

## Finding 3: DHT at Massive Scale

### What the research shows

**IPFS Kademlia DHT** (20K+ nodes in production):
- 256-bit SHA-256 keyspace, k=20 bucket size
- DHT Server mode (public IP) vs DHT Client mode (behind NAT)
- AutoNAT: new peers join as clients, upgrade to server if 3+ peers can dial back
- Iterative lookup: O(log N) hops, ~5-7 hops for 20K nodes
- 95.21% of peers know at least 18 of their 20 closest peers
- Query optimization: parallel lookups (α=3), cached results
- Republish interval: 30 min (half of 1hr TTL)
- Replication: k=20 closest peers store each record

**BitTorrent Mainline DHT** (10M+ nodes):
- 160-bit keyspace, k=8 bucket size
- Survives massive churn (nodes join/leave constantly)
- Token-based security (prevent lookup spam)
- Compact node info format (26 bytes: 20-byte ID + 4-byte IP + 2-byte port)

**Key insight from IPFS:** "System parameters (like K) are computed to maximize
the probability that the network stays connected and no data is lost, while
maintaining a desired latency for queries, and assuming the observations (of
average churn) stay constant."

### AAFP cross-reference

AAFP's capability DHT is keyed by capability string (e.g., "inference",
"translation"), not by AgentId. This is different from IPFS/Mainline:
- **Advantage:** Lookups for "who has capability X" are O(1) (direct key lookup)
  instead of O(log N) (iterative routing)
- **Disadvantage:** The keyspace is tiny (maybe 100-1000 distinct capabilities)
  vs IPFS (millions of content IDs). This means all records for a capability
  cluster on 1-2 nodes → hotspots
- **Current state:** In-memory only, no routing, no replication, no churn handling
  (Track R addresses this)

### What AAFP needs

1. **Dual-key DHT:** Key by both capability AND AgentId
   - Capability index: "who has capability X" → list of AgentIds
   - AgentId index: "what's the record for agent Y" → AgentRecord
   - This prevents hotspots (capability lookups spread across AgentId keyspace)

2. **Client/Server mode** (from IPFS):
   - Agents behind NAT = DHT Client (query only, don't store records)
   - Agents with public IP = DHT Server (store + serve records)
   - AutoNAT determines which mode (Track N2 already planned)

3. **Routing table optimization:**
   - k=20 bucket size (IPFS standard, proven at 20K+ nodes)
   - 256-bit keyspace (SHA-256 of AgentId, already used by AAFP)
   - Bucket refresh every 15 min
   - Parallel lookups (α=3)

4. **Record format optimization:**
   - Compact node info: AgentId (32 bytes) + IP (4 bytes) + port (2 bytes) = 38 bytes
   - Current AgentRecord is much larger (includes capabilities, metadata, signature)
   - Use compact format for routing table, full record only on direct lookup

5. **Security:**
   - Token-based queries (prevent lookup spam, from BitTorrent)
   - Rate limiting per IP (already planned in Track Q4)
   - Signature verification on all records (already done)

**Action items (beyond Track R):**
1. Add AgentId-keyed DHT alongside capability-keyed DHT
2. Implement DHT Client/Server mode selection via AutoNAT
3. Add compact node info format for routing table entries
4. Add token-based query security
5. Benchmark at 1K, 10K, 100K nodes (simulation)

---

## Finding 4: Post-Quantum Crypto at Scale

### What the research shows

**ML-DSA-65 performance (from multiple benchmarks):**
- Key generation: 133-167µs (6K/sec per core)
- Signing: 272-456µs (2.2K/sec per core)
- Verification: 76-103µs (9.7K-13K/sec per core)
- Signature size: 3309 bytes (vs ECDSA P-256: 64 bytes)
- Public key size: 1952 bytes

**At scale (from Cachee blog):**
- 500K verifications/sec at 300µs each = 150 CPU cores just for verification
- With 90% cache hit rate: 15 CPU cores (90% reduction)
- Cache: 43M entries, 80 bytes each = 3.4GB for 24h freshness window
- Verification scales linearly and predictably under load

**Key insight from Aethyr:** "Post-quantum crypto is three to four orders of
magnitude faster than the LLM call it's protecting. The 'performance overhead'
argument was valid for early PQC implementations. It is not valid for optimized
Rust implementations on modern hardware."

### AAFP cross-reference

AAFP uses ML-DSA-65 for:
- Handshake signatures (ClientHello, ServerHello, ClientFinished)
- AgentRecord signatures (self-signed identity)
- UCAN token signatures (capability delegation)
- Revocation entry signatures (CRL)

Current performance (from benchmarks):
- ML-DSA-65 keygen: 133µs
- ML-DSA-65 sign: 272µs
- ML-DSA-65 verify: 76µs
- PQ handshake full: 709µs

At scale (1M agents, each doing 1 handshake/day):
- 1M handshakes × 76µs verify = 76 CPU-seconds = ~1 CPU core
- This is totally fine — handshake rate is low

At scale (1M agents, 1000 messages/sec each, each message verified):
- 1B verifications/sec × 76µs = 76,000 CPU cores — NOT FINE
- But AAFP doesn't verify signatures on every message (only on handshake)
- Messages use AEAD (AES-256-GCM: 1.1µs) not signatures

### What AAFP needs

1. **Signature verification cache:**
   - Cache (agent_id, public_key, verified_at) → bool
   - TTL: 1 hour (re-verify periodically)
   - LRU eviction: 100K entries
   - Expected: 90%+ cache hit rate for repeated connections
   - Saves: 90% of verification CPU

2. **Batched verification:**
   - When verifying multiple signatures (e.g., WoT chain), batch them
   - ML-DSA-65 verification can be parallelized across CPU cores
   - Use `rayon` for parallel verification

3. **Handshake rate limiting:**
   - Limit handshakes per IP: 10/sec (already planned in Track Q4)
   - Limit handshakes per agent: 100/sec
   - Prevents CPU exhaustion via handshake flood

4. **Key caching:**
   - Cache `MLDsaPublicKey` objects (parsing from bytes is expensive)
   - Key: agent_id → Arc<MLDsaPublicKey>
   - LRU: 10K entries
   - Expected: eliminates key parsing overhead for known peers

5. **Signature size optimization:**
   - 3309 bytes per signature is significant at scale
   - Consider ML-DSA-44 (Level 2, 2420 bytes) for less critical operations
   - Keep ML-DSA-65 for identity/handshake, use ML-DSA-44 for UCAN tokens
   - Or: use hash-based signatures (e.g., SLH-DSA) for specific cases

**Action items:**
1. Add `SignatureCache` to aafp-crypto (LRU, 100K entries, 1hr TTL)
2. Add `KeyCache` to aafp-identity (LRU, 10K entries)
3. Integrate caches into handshake_driver.rs
4. Add batched verification for WoT chains (Track P3)
5. Benchmark with and without cache at 10K, 100K verifications

---

## Finding 5: Global Relay Infrastructure

### What the research shows

**WebRTC TURN/STUN statistics:**
- 15-20% of consumer connections need TURN relay (NAT traversal fails)
- 40-60% of enterprise connections need TURN (symmetric NAT, firewalls)
- 85% in strict corporate environments
- Each TURN server: 50K-100K concurrent relayed flows
- 3-5 TURN servers per region for production
- Cost: $0.30-0.50 per GB egress

**Geo-routed TURN architecture:**
- DNS-based geo-routing (AWS Route53 latency-based routing)
- Application-layer routing: API knows client IP, checks Redis for healthy
  TURN servers, selects nearest by GeoIP
- HMAC-signed ephemeral credentials (per-session, per-server)
- Auto-scaling per region (AWS Auto Scaling Groups)

**LiveKit's global mesh (millions of participants):**
- Distributed media server mesh (not hierarchical)
- Each server holds presence info for session participants (100 bytes each)
- Servers forward only their local participants' media
- Overlay network: software virtual network, encrypted, cross-DC
- ICE restart for seamless migration between servers

### AAFP cross-reference

AAFP's relay protocol (RFC 0010) is a single-relay design:
- One relay node forwards traffic between two agents
- No geo-routing, no relay selection, no relay mesh
- No capacity planning, no auto-scaling
- Track N implements the basic relay forwarding, but not global scale

### What AAFP needs

1. **Relay discovery with geo-routing:**
   - DNS-based: `relay.aafp.net` → latency-based DNS routing
   - DHT-based: query "aafp.relay" capability, filter by region
   - Application-based: agent queries a coordinator API for nearest relay

2. **Relay mesh (not single relay):**
   - Relays connect to each other (mesh or hierarchical)
   - If relay A is full, forward to relay B
   - If relay A goes down, clients reconnect to relay B
   - Load balancing: round-robin, least-connections, or latency-based

3. **Relay capacity planning:**
   - Per relay: 50K concurrent relayed connections (from WebRTC data)
   - For 1M agents with 20% needing relay: 200K relayed connections
   - Need: 4-5 relay servers per region, 3-5 regions = 15-25 relay servers
   - Bandwidth: 200K connections × 1KB/msg × 10 msg/s = 2 GB/s per region

4. **Ephemeral credentials:**
   - Relays issue time-limited tokens (HMAC-signed)
   - Token includes: agent_id, relay_id, expiry, allowed bandwidth
   - Prevents relay abuse (unauthorized relay usage)

5. **Relay monitoring:**
   - Track: connections, bandwidth, CPU, memory per relay
   - Alert: when relay at 80% capacity, spin up new relay
   - Health check: relay reports status to coordinator every 30s

**Action items (beyond Track N):**
1. Design relay mesh protocol (relays connect to each other)
2. Add geo-routing to relay discovery (DNS + DHT-based)
3. Add relay capacity tracking and auto-scaling
4. Add ephemeral relay credentials (HMAC tokens)
5. Add relay monitoring dashboard
6. Document relay capacity planning (agents per relay, relays per region)

---

## Finding 6: Congestion Control at Scale

### What the research shows

**BBR production issues:**
- BBRv3 is "highly unfair to Cubic" — even 5 Cubic flows can't get bandwidth
  from 1 BBR flow
- RTT fairness problem: long-RTT BBR flows dominate short-RTT flows
- Bufferbloat: BBR's bandwidth probing causes buffer overflows
- BBR + ECN: surprisingly, ECN exacerbates unfairness
- BBR works great in controlled environments (Google's network) but causes
  problems on the public Internet when coexisting with Cubic

**BBR deployment statistics:**
- Google: 40% of Chrome traffic uses QUIC (with BBR)
- Meta: 75% of traffic uses QUIC/HTTP-3
- Cloudflare: 20.5% of web requests use HTTP/3 (2024)
- BBR is good for bulk transfer but problematic for real-time messaging
  when competing with other traffic

**Key insight:** "BBR's unfairness towards Cubic remains consistent when we
scale up the experiment by increasing the counts of both BBR and Cubic flows
in lock step. BBRv3's performance optimizations seem to have eroded the
progress made by BBRv2 on improving fairness."

### AAFP cross-reference

AAFP uses BBR for "low latency" preset and Cubic for "bulk transfer."
The J7 benchmark showed BBR 4% faster than Cubic on localhost — but this
is meaningless (no congestion on localhost). Track O4 will test BBR vs
Cubic over WAN, but the research suggests:

- BBR may cause fairness issues when AAFP traffic coexists with other
  Internet traffic (web browsing, video streaming)
- For agent-to-agent messaging (small, frequent messages), Cubic may
  actually be better (BBR's bandwidth probing is designed for bulk transfer)
- For relay traffic (high bandwidth, long-lived), BBR may be better

### What AAFP needs

1. **Scenario-specific congestion control:**
   - Agent-to-agent RPC (small messages): Cubic (fair, responsive)
   - Relay forwarding (bulk transfer): BBR (high throughput)
   - DHT queries (tiny messages): Cubic (don't need BBR's bandwidth probing)
   - File transfer / large payloads: BBR (maximize throughput)

2. **CCA negotiation:**
   - Both peers announce their preferred CCA during handshake
   - Use the lower-priority CCA (most conservative) to be good Internet citizens
   - Or: use BBR only when both peers agree (closed network)

3. **BBR fairness testing:**
   - Test AAFP traffic coexisting with Cubic web traffic
   - Measure: does AAFP starve other traffic?
   - If yes: default to Cubic, make BBR opt-in

4. **Per-stream CCA (future):**
   - QUIC allows different congestion control per stream (theoretically)
   - Use Cubic for control streams, BBR for data streams
   - Quinn doesn't support this yet — track quinn feature requests

**Action items:**
1. Change default CCA from BBR to Cubic for agent-to-agent RPC
2. Keep BBR as opt-in for relay nodes and bulk transfer
3. Add CCA negotiation to handshake (exchange preferred CCA, use conservative)
4. Test BBR fairness in Track O4 (coexist with Cubic traffic)
5. Document CCA selection guide: when to use BBR vs Cubic

---

## Finding 7: Distributed Systems Resilience

### What the research shows

**WhatsApp resilience:**
- Meta-clustering: limit cluster size, allow clusters to span distances
- wandist: custom distribution transport over gen_tcp (not Erlang's built-in dist)
- Mesh-connected functional groups of servers
- Transparent routing layer
- All messages single-hop (no multi-hop routing between clusters)

**Discord resilience:**
- Guild process handoff: move guild from one node to another for load balancing
- Manifold: separate "send" process for non-critical fanout (doesn't block guild)
- Session stampede protection: semaphores to limit concurrent requests
- Kafka for decoupling: if a service goes down, messages buffer in Kafka

**Service mesh patterns (Istio/Envoy):**
- Circuit breaker: stop sending requests to a failing service
- Bulkhead: limit concurrent requests to a service (isolate failures)
- Timeout: per-service timeouts (prevent cascading failures)
- Retry with backoff: retry failed requests with exponential backoff
- Health checking: periodic health checks, remove unhealthy instances

### AAFP cross-reference

AAFP has no resilience patterns:
- No circuit breaker (if a peer is failing, keep trying)
- No bulkhead (no limit on concurrent requests to a peer)
- No timeout per operation (only connection-level idle timeout)
- No retry with backoff (single attempt, then failure)
- No health checking (no way to know if a peer is healthy)

### What AAFP needs

1. **Circuit breaker per peer:**
   - Track failure count per peer
   - After 5 consecutive failures: open circuit (stop sending)
   - After 30s: half-open (try one request, if success, close circuit)
   - Configurable: failure threshold, recovery time

2. **Bulkhead per peer:**
   - Limit concurrent in-flight requests per peer (default: 10)
   - If limit reached: queue or reject (configurable)
   - Prevents one slow peer from consuming all resources

3. **Per-operation timeout:**
   - RPC timeout: 5s (configurable per RPC method)
   - Handshake timeout: 10s
   - DHT lookup timeout: 3s
   - Relay connect timeout: 5s

4. **Retry with backoff:**
   - Max 3 retries
   - Exponential backoff: 100ms, 400ms, 1.6s
   - Jitter: ±20% to avoid thundering herd
   - Only for idempotent operations

5. **Health checking:**
   - Ping each connected peer every 60s (already have PING/PONG from E1)
   - If 3 consecutive pings fail: mark peer unhealthy, trigger circuit breaker
   - Report peer health in Agent::metrics()

**Action items:**
1. Add `CircuitBreaker` to aafp-sdk (per-peer, configurable)
2. Add `Bulkhead` to aafp-sdk (per-peer concurrent request limit)
3. Add per-operation timeouts to RPC handler
4. Add `RetryPolicy` to AgentClient (exponential backoff + jitter)
5. Integrate health checking with PingTracker (E1) and metrics (S4)

---

## Finding 8: QUIC at Global Scale

### What the research shows

**Google QUIC deployment:**
- Thousands of servers globally
- 40% of Chrome traffic uses QUIC
- 30% of Google's total egress traffic (in bytes)
- Reduces Search latency by 8.0% (desktop), 3.6% (mobile)
- Reduces YouTube rebuffer rates by 18.0% (desktop), 15.3% (mobile)

**Quinn-specific limits:**
- Default: 100 concurrent bidi streams, 100 uni streams
- Default: tuned for 100Mbps link with 100ms RTT
- Memory: proportional to `max_concurrent_bidi_streams × stream_receive_window`
- Single UDP socket per endpoint (all connections share one socket)
- UDP buffer sizes may need increasing for high aggregate data rates
- `SO_SNDBUF` and `SO_RCVBUF` may need root or sysctl tuning on Linux

**Key quinn insight:** "Handling high aggregate data rates on a single endpoint
can require a larger UDP buffer than is configured by default in most
environments. If you observe erratic latency and/or throughput over a stable
network link, consider increasing the buffer sizes."

### AAFP cross-reference

AAFP's QUIC config (from Track J):
- max_concurrent_bidi_streams: 100 (quinn default)
- stream_receive_window: 1MB
- max_idle_timeout: 30s
- initial_rtt: 10ms
- BBR congestion control (low-latency preset)

At scale (10K connections per gateway):
- 10K connections × 100 streams × 1MB window = 1TB potential memory (worst case)
- This is way too much — need to tune for scale
- UDP buffer: default is usually 208KB on Linux, need ~10MB for 10K connections

### What AAFP needs

1. **Scale-aware QUIC config:**
   - For gateways (10K+ connections): max_streams=10, window=64KB
   - For agents (100 connections): max_streams=100, window=1MB
   - For relays (1K connections): max_streams=50, window=256KB
   - Auto-tune based on expected connection count

2. **UDP buffer tuning:**
   - Set SO_RCVBUF to 10MB for gateways (sysctl net.core.rmem_max)
   - Set SO_SNDBUF to 10MB for gateways (sysctl net.core.wmem_max)
   - Document required sysctl settings for production

3. **Connection pooling at gateway level:**
   - Gateway maintains a pool of QUIC connections to each router
   - Reuse connections for multiple client sessions
   - Track I5 connection pool, but at gateway-router level

4. **0-RTT for known peers:**
   - I2-I4 skipped because AAFP handshake provides identity verification
   - But TLS 1.3 0-RTT can still be used (without AAFP 0-RTT)
   - Reduces connection setup time for known peers (TLS resumption)
   - I1 already implemented TLS session ticket cache

5. **Connection migration at scale:**
   - I6 tested rebind on localhost (14.31µs)
   - At scale: need migration across gateway servers (not just IP changes)
   - If a gateway goes down, clients should reconnect to another gateway
   - Session resumption allows this (TLS ticket works across gateways if
     they share the ticket key)

**Action items:**
1. Add `QuicConfig::for_gateway()` preset (low streams, low window, high conn)
2. Add `QuicConfig::for_agent()` preset (high streams, high window, low conn)
3. Add `QuicConfig::for_relay()` preset (medium streams, medium window)
4. Document UDP buffer sysctl settings for production
5. Add gateway-to-gateway session migration (shared TLS ticket keys)
6. Benchmark: 10K connections with scale-aware config

---

## Gap Analysis: AAFP vs World-Scale

| Capability | Current AAFP | World-Scale Requirement | Gap |
|-----------|-------------|------------------------|-----|
| Connections per server | ~100 (tested) | 10K-100K (gateway) | 100-1000x |
| Message routing | Direct (agent-to-agent) | Gateway → Router → Agent | Architecture |
| DHT scale | 2-3 nodes (in-process) | 100K+ nodes | 10000x |
| Kernel I/O | Standard sockets | XDP/AF_XDP or DPDK | 2-3x throughput |
| PQ crypto at scale | No caching | Verification cache + batch | 10x CPU reduction |
| NAT traversal | Stub (no real relay) | Global relay mesh | Infrastructure |
| Congestion control | BBR (may be unfair) | Scenario-specific CCA | Fairness |
| Resilience | None | Circuit breaker, bulkhead | Patterns |
| Connection migration | Localhost rebind | Cross-gateway migration | Architecture |
| Monitoring | None | Metrics, health, tracing | Observability |
| Deployment | Manual | Docker, K8s, auto-scale | Operations |

---

## Actionable Recommendations (Ranked)

### Tier 1: Critical for >10K agents (do first)

1. **Gateway/Router/Agent separation** — Without this, no agent can handle
   more than a few hundred connections. (Effort: 2-3 weeks)

2. **Scale-aware QUIC config** — Current config will OOM at 10K connections.
   (Effort: 2-3 days)

3. **Signature verification cache** — Saves 90% of PQ crypto CPU at scale.
   (Effort: 2-3 days)

4. **Circuit breaker + bulkhead** — Prevents cascading failures.
   (Effort: 1 week)

5. **DHT Client/Server mode** — Prevents NAT'd agents from being DHT bottlenecks.
   (Effort: 1 week, part of Track R)

### Tier 2: Critical for >100K agents

6. **XDP/AF_XDP for Linux gateways** — 2-3x throughput on relay/gateway nodes.
   (Effort: 2-3 weeks, Linux-only)

7. **Global relay mesh** — Geo-routed relays with capacity planning.
   (Effort: 3-4 weeks, builds on Track N)

8. **Dual-key DHT** — Capability + AgentId keyspace to prevent hotspots.
   (Effort: 1-2 weeks, extends Track R)

9. **Per-operation timeouts + retry** — Prevents slow peers from blocking.
   (Effort: 1 week)

10. **UDP buffer tuning + sysctl docs** — Prevents packet drops at high PPS.
    (Effort: 1 day)

### Tier 3: Critical for >1M agents

11. **Kafka/NATS event bus** — Decouples message ingestion from delivery.
    (Effort: 2-3 weeks)

12. **Redis-backed connection state** — Cross-gateway connection tracking.
    (Effort: 2 weeks)

13. **Cross-gateway session migration** — Failover when a gateway dies.
    (Effort: 2-3 weeks)

14. **DPDK for relay nodes** — Maximum throughput for high-bandwidth relays.
    (Effort: 3-4 weeks, Linux-only, dedicated hardware)

15. **CCA negotiation + fairness testing** — Be a good Internet citizen.
    (Effort: 1-2 weeks, includes Track O4)

---

## Architecture Proposal: World-Scale AAFP

```
                    ┌─────────────────────────────────────────────┐
                    │              Global AAFP Network             │
                    │                                              │
                    │  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
                    │  │ Region  │  │ Region  │  │ Region  │    │
                    │  │  US     │  │  EU     │  │  APAC   │    │
                    │  └────┬────┘  └────┬────┘  └────┬────┘    │
                    │       │            │            │          │
                    └───────┼────────────┼────────────┼──────────┘
                            │            │            │
              ┌─────────────┼────────────┼────────────┼──────────┐
              │             │            │            │          │
     ┌────────┴───┐  ┌──────┴────┐  ┌────┴──────┐              │
     │  Gateways  │  │  Gateways │  │  Gateways │              │
     │  (XDP,     │  │  (XDP,    │  │  (XDP,    │              │
     │   10K conn │  │   10K conn│  │   10K conn│              │
     │   each)    │  │   each)   │  │   each)   │              │
     └──────┬─────┘  └──────┬────┘  └──────┬────┘              │
            │               │              │                    │
     ┌──────┴───────────────┴──────────────┴────┐              │
     │           Event Bus (Kafka/NATS)           │              │
     └──────┬───────────────┬──────────────┬────┘              │
            │               │              │                    │
     ┌──────┴────┐  ┌──────┴────┐  ┌──────┴────┐              │
     │  Routers  │  │  Routers  │  │  Routers  │              │
     │  (DHT,    │  │  (DHT,    │  │  (DHT,    │              │
     │   capab.  │  │   capab.  │  │   capab.  │              │
     │   match)  │  │   match)  │  │   match)  │              │
     └──────┬────┘  └──────┬────┘  └──────┬────┘              │
            │               │              │                    │
     ┌──────┴────┐  ┌──────┴────┐  ┌──────┴────┐              │
     │  Agents   │  │  Agents   │  │  Agents   │              │
     │  (LLM,    │  │  (LLM,    │  │  (LLM,    │              │
     │   tools,  │  │   tools,  │  │   tools,  │              │
     │   logic)  │  │   logic)  │  │   logic)  │              │
     └───────────┘  └───────────┘  └───────────┘              │
                                                                 │
     ┌──────────────────────────────────────────┐              │
     │        Relay Mesh (geo-routed)            │              │
     │  ┌──────┐  ┌──────┐  ┌──────┐           │              │
     │  │Relay │  │Relay │  │Relay │           │              │
     │  │ US   │  │ EU   │  │ APAC │           │              │
     │  │(DPDK)│  │(DPDK)│  │(DPDK)│           │              │
     │  └──────┘  └──────┘  └──────┘           │              │
     └──────────────────────────────────────────┘              │
                                                                 │
     ┌──────────────────────────────────────────┐              │
     │        DHT (Kademlia, 256-bit)            │              │
     │  Servers: public IP agents + relays      │              │
     │  Clients: NAT'd agents                    │              │
     │  Dual-key: capability + AgentId           │              │
     └──────────────────────────────────────────┘              │
                                                                 │
     ┌──────────────────────────────────────────┐              │
     │        Monitoring                         │              │
     │  Prometheus + Grafana                     │              │
     │  Per-gateway, relay, agent metrics        │              │
     │  Health checks, alerting                  │              │
     └──────────────────────────────────────────┘              │
```

---

## References

### WhatsApp Architecture
- WhatsApp Blog: "ONE MILLION!" — https://blog.whatsapp.com/on-e-millio-n
- Sujeet Jaiswal: "WhatsApp: 2 Million Connections Per Server" — https://sujeet.pro/articles/whatsapp-erlang-scaling
- Rick Reed: "Scaling to Millions of Simultaneous Connections" — https://www.erlang-factory.com/static/upload/media/1394350183453526efsf2014whatsappscaling.pdf
- High Scalability: "The WhatsApp Architecture Facebook Bought" — https://highscalability.com/the-whatsapp-architecture-facebook-bought-for-19-billion/

### Discord Architecture
- Discord: "How Discord Scaled Elixir to 5,000,000 Concurrent Users" — https://discord.com/blog/how-discord-scaled-elixir-to-5-000-000-concurrent-users
- Discord: "Maxjourney: Million+ Online Users in a Single Server" — https://discord.com/blog/maxjourney-pushing-discords-limits-with-a-million-plus-online-users-in-a-single-server
- ADHDecode: "Discord Architecture Teardown" — https://adhdecode.com/distributed-systems/other-industry-teardowns/discord-architecture/
- HLD Handbook: "Channel-Scale Chat" — https://hld.handbook.academy/curriculum/case-studies/channel-scale-chat/

### QUIC at Scale
- Google: "The QUIC Transport Protocol: Design and Internet-Scale Deployment" — https://research.google/pubs/the-quic-transport-protocol-design-and-internet-scale-deployment/
- Cloudflare: "2024 Year in Review" — https://blog.cloudflare.com/radar-2024-year-in-review/
- CellStream: "QUIC Adoption and Traffic Levels" — https://www.cellstream.com/2025/02/14/an-update-on-quic-adoption-and-traffic-levels/
- Quinn docs: TransportConfig — https://docs.rs/quinn/latest/quinn/struct.TransportConfig.html
- Quinn GitHub — https://github.com/quinn-rs/quinn

### DHT at Scale
- IPFS: "Design and Evaluation of IPFS" — https://www.cs.wm.edu/~smherwig/readings/papers/22-sigcomm-ipfs.pdf
- IPFS: "0.5 Content Routing Improvements" — https://blog.ipfs.tech/2020-07-20-dht-deep-dive/
- IPFS: "Kademlia DHT Spec" — https://specs.ipfs.tech/routing/kad-dht/
- Probe Lab: "DHT Routing Table Health" — https://github.com/probe-lab/network-measurements/blob/main/results/rfm19-dht-routing-table-health.md
- ACM: "Peer Clustering for IPFS" — https://doi.org/10.1145/3607504.3609289

### Kernel Bypass
- dpdk-stdlib-rust — https://github.com/gspivey/dpdk-stdlib-rust
- rust-dpdk-net — https://github.com/youyuanwu/rust-dpdk-net
- TUM: "Kernel Bypass Surgery for QUIC" — https://www.net.in.tum.de/fileadmin/bibtex/publications/papers/spaethj-noms2026.pdf
- Solana Afterburner (XDP + QUIC, 4.7M TPS) — https://github.com/Turbin3/afterburner
- TUM: "XDP for QUIC" — https://www.net.in.tum.de/fileadmin/TUM/NET/NET-2024-04-1/NET-2024-04-1_03.pdf
- io_uring zero-copy RX (LWN) — https://lwn.net/Articles/996435/
- NordVarg: "Kernel Bypassing in Linux with C++ and Rust" — https://nordvarg.com/blog/kernel-bypassing-linux
- rzmq (Rust ZeroMQ with io_uring) — https://crates.io/crates/rzmq

### Post-Quantum Crypto Performance
- Ascertia: "PQC in ADSS Server" — https://blog.ascertia.com/post-quantum-cryptography-in-adss-server-performance-benchmarks
- Cachee: "FIPS 204 Caching" — https://cachee.ai/blog/posts/2026-05-10-fips-204-caching-ml-dsa-87-key-sizes-performance.html
- Aethyr: "PQ Crypto for AI Agents" — https://aethyrresearch.com/blog/psam-crypto-benchmarks-2026
- Hive: "ML-DSA-65 in Production" — https://thehiveryiq.com/ml-dsa-receipts.html

### NAT Traversal at Scale
- NextStream: "TURN vs STUN Sizing Guide" — https://nextstream.cloud/turn-vs-stun-servers
- CelloIP: "WebRTC TURN Server Production Guide" — https://celloip.com/blog/webrtc-turn-server-production-guide/
- Deepak Mishra: "Geo-Routing and Scalable TURN" — https://dev.to/deepak_mishra_35863517037/spanning-the-globe-geo-routing-and-scalable-turn-architectures-257o
- LiveKit: "Scaling WebRTC with Distributed Mesh" — https://livekit.com/blog/scaling-webrtc-with-distributed-mesh

### Congestion Control
- ANRW 2024: "BBRv3 in the Public Internet" — https://balakrishnanc.github.io/papers/zeynali-anrw2024.pdf
- ACM: "Fairness of Congestion-Based Congestion Control" — https://doi.org/10.48550/arxiv.1706.09115
- IMC 2019: "Modeling BBR's Interactions with Loss-Based CC" — https://justinesherry.com/papers/ware-imc2019.pdf
- ITC 30: "Impact of TCP BBR on CUBIC Traffic" — https://doi.org/10.1109/itc30.2018.00040

### Service Mesh / Resilience
- Istio: "Performance and Scalability" — https://istio.io/latest/docs/ops/deployment/performance-and-scalability/
- Azure: "Istio AKS Performance" — https://learn.microsoft.com/en-us/azure/aks/istio-scale
- Amex: "Optimizing Istio for Large-Scale" — https://americanexpress.io/optimizing-istio-for-large-scale-enterprise-applications/

---

## Additional Findings (2026-07-04)

### Finding 9: QUIC Connection Migration in Production

**Research shows:**
- QUIC connection migration has a **76% failure rate** during hard handovers
  (Wi-Fi → Wi-Fi) due to passive initialization based on application data
  delivery timing (QUIC-HOA paper, GLOBECOM 2024)
- Only **52% of IPv4 QUIC servers** support connection migration (with SNI)
- **80% of IPv6 QUIC servers** support it (with SNI)
- 8.59% of connections are subject to migration (NETWORK_CHANGED events)
- 31.41% of migration attempts have no alternate network
- mQUIC (mobile QUIC) shows significant gains over default QUIC handover
- QUIC-HOA reduces migration time by 98% with cross-layer handover awareness

**AAFP impact:**
- AAFP's I6 connection migration (quinn rebind) works on localhost but will
  likely fail 76% of the time on real Wi-Fi→cellular handoffs
- Need: active migration initialization (not passive), platform notification
  integration, path degrading detection before handover
- For Track O6 (connection migration over real network changes): expect
  failures and document fallback (reconnect with session resumption)

### Finding 10: Rust Resilience Patterns (tower-resilience)

**The `tower-resilience` crate (v0.10) provides 16 production-ready patterns:**
- Circuit Breaker (sliding window or consecutive failures)
- Bulkhead (resource isolation / concurrency limits)
- Retry (exponential backoff + jitter + retry budgets)
- Rate Limiter (fixed or sliding window)
- Health Check (proactive health monitoring)
- Hedge (tail-latency hedging — race redundant requests)
- Coalesce (request deduplication / singleflight)
- Fallback (graceful degradation)
- Reconnect (automatic reconnection with backoff)
- Outlier Detection (fleet-aware instance ejection)
- Adaptive Concurrency (AIMD/Vegas dynamic limiting)
- Time Limiter (timeout with cancellation)
- Router (weighted traffic routing for canary deployments)
- Cache (response memoization)
- Executor (dedicated thread-pool execution)
- Chaos (fault injection for testing)

**AAFP should adopt:**
- Circuit breaker: `tower-resilience-circuitbreaker` (v0.9.4, well-maintained)
- Bulkhead: built-in to tower-resilience
- Retry: built-in with jitter
- Rate limiter: for Track Q4 (DoS prevention)

**However:** AAFP doesn't use Tower's `Service` trait — it has its own
`AgentClient` / `AgentServer` abstractions. Options:
1. Adopt tower-resilience and wrap AAFP's client in a Tower Service
2. Implement the patterns directly in aafp-sdk (simpler, no dependency)
3. Use tower-resilience as reference and implement similar logic

**Recommendation:** Option 2 — implement directly in aafp-sdk. The patterns
are simple enough (circuit breaker = state machine + counters, bulkhead =
semaphore) and AAFP's async model doesn't need Tower's Service abstraction.

### Finding 11: DHT Churn Handling (Bamboo)

**Bamboo (USENIX 2004) key findings:**
- Handles median node session times as short as **1.4 minutes**
- Uses **<900 bytes/s/node** maintenance bandwidth in 1000-node system
- Three key design features:
  1. **Static resilience** — routing around failures before recovery begins
  2. **Timely, accurate failure detection** — active probing + recursive routing
  3. **Congestion-aware recovery** — periodic (not reactive) recovery

**Reactive vs. periodic recovery:**
- Reactive (immediate response to membership changes) → congestion collapse
  under high churn (adds stress to already-stressed network)
- Periodic (refresh routing table at intervals) → better under high churn
- **Adaptive refresh intervals** — adjust based on observed churn rate

**Kademlia under churn (Scientific.Net):**
- Self-adaptive k-bucket size: adjust K based on churn rate
- Estimate churn rate by validity of data in routing table
- Reduces lookup latency under churn

**AAFP impact (Track R4 — churn handling):**
- Use periodic recovery (not reactive) for routing table maintenance
- Adaptive refresh intervals: fast refresh when churn is high, slow when stable
- Track node session times and adjust k-bucket size dynamically
- Ping-based liveness checking (already have PING/PONG from E1)
- Graceful departure: node sends DRAIN message before leaving
- Rejoin: node re-announces capabilities after reconnection

### Finding 12: GossipSub v1.1 Peer Scoring

**GossipSub v1.1 (libp2p) security extensions:**
- Peer scoring with 7 parameters (P1-P7):
  - P1: Time in mesh (reward long-lived connections)
  - P2: First message deliveries (reward timely message forwarding)
  - P3: Mesh message deliveries (penalize missing messages)
  - P3b: Mesh message deliveries invalid (penalize invalid messages)
  - P4: Message deliveries invalid (penalize invalid messages)
  - P5: Application-specific scoring
  - P6: IP colocation factor (penalize Sybil attacks)
  - P7: Behavioral penalties (penalize protocol violations)
- Thresholds: gossip_threshold, publish_threshold, graylist_threshold
- Peer Exchange (PX) — exchange peer lists during prune
- Backoff time — prevent rapid re-grafting

**AAFP impact (E3 networked pubsub):**
- AAFP's floodsub (E3) is simpler than gossipsub but lacks attack resistance
- For v1: floodsub is fine (small networks, trusted peers)
- For v1.1+: upgrade to gossipsub with peer scoring
- Peer scoring prevents Sybil attacks, message withholding, spam
- Use libp2p's scoring parameters as reference

### Finding 13: QUIC Fuzzing

**QUIC-Fuzz (arxiv 2503.19402):**
- Greybox fuzzer for QUIC protocol implementations
- Found 10 new security vulnerabilities, 2 CVEs across 6 implementations
- 84% increase in code coverage over state-of-the-art fuzzers
- Tests: Google, Alibaba, Cloudflare, MSQuic, quiche, ngtcp2

**Cloudflare quiche fuzzing targets:**
- `packet_recv_client` — process incoming client packets
- `packet_recv_server` — process incoming server packets
- `qpack_decode` — parse QPACK header blocks

**AAFP impact (Track Q2 — fuzz testing):**
- AAFP already has a `fuzz/` directory with cargo-fuzz targets
- Need to add fuzz targets for:
  1. CBOR decoder (malformed CBOR → panic/overflow)
  2. Frame decoder (malformed frames → panic/overflow)
  3. Handshake state machine (unexpected frames → panic)
  4. RPC handler (malformed JSON-RPC → panic)
  5. Relay protocol (malformed relay frames → panic)
  6. Discovery DHT (malformed records → panic)
- Use `cargo +nightly fuzz run <target>` for each
- Run for at least 1 hour per target
- Document any crashes found

### Finding 14: Message Storage at Scale

**Discord's migration (Cassandra → ScyllaDB):**
- 177 Cassandra nodes → 72 ScyllaDB nodes (60% reduction)
- p99 read latency: 40-125ms (Cassandra) → 15ms (ScyllaDB)
- p99 write latency: 5-70ms (Cassandra) → 5ms (ScyllaDB)
- ScyllaDB: shard-per-core C++ architecture, no GC pauses
- Trillions of messages, 9TB per node

**FoundationDB (Signal's choice):**
- Strict serializability, modular layers
- 99.999% availability with sub-second failover
- Requires building custom layer on top
- Best for: new systems needing strict consistency

**AAFP impact:**
- AAFP currently has no message persistence (pure P2P, in-memory DHT)
- F4 added SQLite-backed persistent DHT (for agent records, not messages)
- For world-scale: need message persistence layer (optional, for offline agents)
- Recommendation: ScyllaDB for message storage (proven at Discord scale)
- Or: FoundationDB for strict consistency (if agent messaging needs ACID)
- For v1: SQLite is sufficient (F4 pattern), add ScyllaDB/FDB for v2+
