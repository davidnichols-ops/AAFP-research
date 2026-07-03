# Track I: Connection Lifecycle Optimization

**Priority:** HIGH
**Duration:** Q2 (4-6 weeks)
**Blocked by:** H (Lock-Free — needs channel-based send for connection pooling)
**Blocks:** J (QUIC Tuning)

---

## Problem

Every new connection pays the full cost of:
1. QUIC TLS handshake (1 RTT, ~100-200ms on LAN)
2. AAFP v1 handshake (ClientHello → ServerHello → ClientFinished, 1.5 RTT, 709µs crypto)
3. Authorization check
4. Stream opening

For agent-to-agent communication where peers reconnect frequently, this is wasteful. The protocol already supports session IDs and transcript hashes — we can extend this to support **0-RTT session resumption** for returning peers.

Additionally, there's no connection pooling — each `connect()` creates a new QUIC connection. For repeated RPCs to the same peer, a pooled connection would eliminate handshake cost entirely.

---

## Architecture

```
CURRENT:
  connect() → QUIC TLS handshake (1 RTT) → AAFP handshake (1.5 RTT) → auth → stream → message
  Total: 2.5 RTT + 709µs crypto

TARGET (returning peer with cached session):
  connect() → 0-RTT TLS → 0-RTT AAFP (cached session) → message
  Total: 0 RTT (data sent in first flight)

TARGET (pooled connection):
  pool.get(peer_id) → existing connection → message
  Total: 0 RTT, 0 crypto
```

---

## Steps

### I1: Session ticket cache
- Create `crates/aafp-transport-quic/src/session_cache.rs`
- `SessionCache`: LRU cache of TLS session tickets (keyed by server identity)
- Integrate with rustls `ClientConfig::resumption()` — enable session resumption
- Cache size: 1024 entries (configurable). TTL: 1 hour.
- **VERIFY:** Second connection to same server reuses TLS session (verify via rustls logs)

### I2: AAFP 0-RTT resumption protocol
- Write RFC amendment: `RFCs/AMENDMENTS-0002-resumption.md`
- Protocol: Client caches `(session_id, peer_agent_id, shared_secret)` from previous handshake
- On reconnect, client sends `ClientHello` with `resumption_ticket` extension containing:
  - `session_id` (32 bytes)
  - `nonce` (8 bytes)
  - `early_data` (optional first application message)
- Server validates: session_id exists in cache, nonce is fresh, shared_secret matches
- If valid: server sends `ServerHello` with `resumption_accepted=true` + processes early_data
- If invalid: falls back to full handshake (graceful degradation)
- **Security:** 0-RTT data is vulnerable to replay. Mitigation: only allow idempotent operations as early_data (PING, tools/list). Non-idempotent operations (tools/call, SendMessage) require full handshake.
- **VERIFY:** RFC amendment reviewed, unit test for resumption ticket encoding/decoding

### I3: Implement AAFP 0-RTT client path
- `handshake_driver::drive_client_handshake_0rtt()`:
  1. Check session cache for peer
  2. If cached: send ClientHello with resumption_ticket + early_data
  3. Wait for ServerHello
  4. If resumption_accepted: skip ClientFinished, transition directly to MessagingEnabled
  5. If resumption_rejected: fall back to full handshake
- Add `Agent::connect_0rtt()` that attempts 0-RTT, falls back to full
- **VERIFY:** Two consecutive connections to same server: second connection skips full handshake

### I4: Implement AAFP 0-RTT server path
- `handshake_driver::drive_server_handshake_0rtt()`:
  1. Receive ClientHello with resumption_ticket
  2. Look up session_id in server-side session cache
  3. Validate nonce freshness (ReplayCache)
  4. If valid: send ServerHello with resumption_accepted=true, process early_data
  5. If invalid: send ServerHello with resumption_rejected=true, proceed with full handshake
- Server-side session cache: LRU, 1024 entries, 1hr TTL
- **VERIFY:** Server correctly accepts and rejects resumption tickets

### I5: Connection pool
- Create `crates/aafp-sdk/src/connection_pool.rs`
- `ConnectionPool`: HashMap<AgentId, PooledConnection>
- `PooledConnection`: QuicConnection + last_used timestamp + idle timeout
- `pool.get_or_connect(agent_id, addr)`: returns existing connection or creates new
- `pool.release(agent_id)`: marks connection as idle (returns to pool, doesn't close)
- Idle timeout: 60s (configurable). Idle connections are closed and removed.
- Max pool size: 100 connections (configurable)
- **VERIFY:** 100 sequential RPCs to same peer use 1 connection (not 100)

### I6: Connection migration (QUIC CID-based)
- Quinn supports QUIC connection migration via connection IDs
- Implement `Agent::migrate_connection(old_conn, new_addr)`:
  1. Client opens new UDP socket bound to new address
  2. Quinn migrates the existing connection to the new path
  3. No handshake needed — connection ID identifies the connection
- Use case: agent moves from WiFi to cellular, or from one subnet to another
- **VERIFY:** Connection survives address change (test with two localhost addresses)

### I7: Keep-alive optimization
- Current keep-alive: 30s interval (PING/PONG from E1)
- Add adaptive keep-alive: 
  - Default: 30s
  - After 3 consecutive PONGs: increase to 60s (connection is stable)
  - After a missed PONG: decrease to 10s (connection may be unstable)
  - After 3 missed PONGs: close connection (peer is gone)
- PING/PONG frames are 28 bytes (header only, no payload) — minimal overhead
- **VERIFY:** Adaptive keep-alive test shows interval changes based on PONG responses

### I8: End-to-end connection lifecycle benchmark
- Benchmark scenarios:
  1. Cold connect (no session cache): measure time to first message
  2. Warm connect (session cache hit, 0-RTT): measure time to first message
  3. Pooled connect (connection reuse): measure time to first message
  4. Migration: measure time to resume after address change
- Write results to `test-results/performance/connection-lifecycle.json`
- Update `PERFORMANCE_REPORT.md`
- **VERIFY:**
  - Cold connect: <1ms (localhost, already achieved)
  - Warm connect (0-RTT): <300µs (from ~1ms)
  - Pooled connect: <50µs (no handshake at all)
  - Migration: <10ms (path validation only)

---

## Expected Outcomes

| Metric | Before | After | Method |
|--------|--------|-------|--------|
| Cold connect time | ~1ms | ~1ms | (unchanged — full handshake required) |
| Warm connect (0-RTT) | ~1ms | <300µs | Session resumption |
| Pooled connect | ~1ms | <50µs | Connection reuse |
| Connections per 1000 RPCs | 1000 | 1 | Connection pooling |
| Keep-alive overhead | 28B/30s | 28B/60s (adaptive) | Adaptive interval |

---

## Risks & Mitigations

1. **0-RTT replay attacks:** Early data can be replayed by an attacker. **Mitigation:** Only idempotent operations allowed as early_data. ReplayCache (already implemented in A-9) checks for duplicate nonces.

2. **Session cache memory:** 1024 entries × ~200 bytes = ~200KB. Acceptable. **Mitigation:** LRU eviction ensures bounded memory.

3. **Connection pool staleness:** Pooled connections may be closed by peer. **Mitigation:** Health check (PING) before reuse. If PING fails, discard and create new connection.

4. **Migration path validation:** QUIC path validation adds 1 RTT. **Mitigation:** Use `PATH_CHALLENGE` / `PATH_RESPONSE` (built into quinn). Old path remains active until new path is validated.
