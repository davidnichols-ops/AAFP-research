# Track N: NAT Traversal — DCUtR Hole Punching + Real Relay Testing

**Priority:** CRITICAL
**Duration:** 2-3 weeks
**Blocked by:** nothing (can start immediately)
**Blocks:** Track O (WAN testing needs working NAT traversal to test cross-NAT scenarios)

---

## Problem

The AAFP relay protocol (RFC 0010) is implemented as a state machine
(`RelayV1Service`) but has never been tested over a real network. The
DCuTR module (hole punching) is a stub — it records attempts but doesn't
actually punch holes. This means:

1. **Two agents behind different NATs cannot connect** without a manually
   configured relay, and even then the relay has never forwarded real traffic.
2. **DCuTR is a stub** — `dcutr.rs` has `record_attempt()` but no actual
   hole-punching logic (no simultaneous open, no address exchange).
3. **AutoNAT is a stub** — `auto_nat.rs` tracks status but doesn't perform
   real dial-back checks.
4. **No relay data forwarding** — `RelayedConnection` tracks metadata but
   doesn't actually forward QUIC streams between source and target.

The goal of this track is to make NAT traversal actually work: a relay
node forwards real traffic, AutoNAT detects NAT status via dial-back,
and DCuTR upgrades relayed connections to direct connections via hole
punching.

---

## Steps

### N1: Implement relay data forwarding

The relay service manages reservations but doesn't forward data. When
agent A connects to the relay and requests a relayed connection to agent
B, the relay must:

1. Accept a QUIC bi-stream from A
2. Open a QUIC bi-stream to B (B has an active reservation)
3. Copy bytes bidirectionally between A's stream and B's stream
4. Track bytes forwarded and close both streams when either side closes

- Implement `RelayV1Service::forward_stream()` that takes two QUIC
  streams and copies bytes between them using `tokio::io::copy()`
- Add a `handle_relayed_connection()` async function that:
  - Accepts the incoming stream from the caller
  - Dials the target agent (using the relay's own transport)
  - Opens a bi-stream to the target
  - Spawns a tokio task that copies bytes bidirectionally
  - Returns when either side closes
- Add connection lifecycle management: track active relayed connections,
  enforce max_connections, clean up on disconnect
- **VERIFY:** A test where agent A → relay → agent B can send and receive
  data through the relay (localhost first, then two-machine test in N7)

KEY FILES:
  implementations/rust/crates/aafp-nat/src/relay_v1.rs
    - RelayV1Service, RelayedConnection — add forward_stream()
  implementations/rust/crates/aafp-nat/src/lib.rs
    - Add relay forwarding module or extend relay_v1.rs
  implementations/rust/crates/aafp-transport-quic/src/transport.rs
    - QuicTransport, QuicConnection — relay uses these to dial targets

### N2: Implement AutoNAT dial-back

AutoNAT detects whether an agent is behind NAT by asking peers to
dial back to the agent's advertised address. Current implementation
is a stub that just tracks status.

- Implement `AutoNatV1::request_dial_back()`:
  1. Agent sends its local address to a peer via RPC
  2. Peer attempts to dial the agent's advertised address
  3. Peer reports success/failure back to the agent
  4. Agent updates its NatStatus based on the result
- Implement `AutoNatV1::handle_dial_back_request()` on the peer side:
  1. Receive the agent's advertised address
  2. Attempt to dial it (with a short timeout — 5s)
  3. Report success or failure
- Add RPC methods: `aafp.autonat.dialback_request`, `aafp.autonat.dialback_response`
- Require multiple successful dial-backs (default: 2) before declaring
  NotBehindNat, and multiple failures (default: 2) before declaring BehindNat
- **VERIFY:** A test where an agent behind a simulated NAT (bind to
  127.0.0.1, advertise 127.0.0.1) gets correct NatStatus from dial-back

KEY FILES:
  implementations/rust/crates/aafp-nat/src/relay_v1.rs
    - AutoNatV1 — add request_dial_back(), handle_dial_back_request()
  implementations/rust/crates/aafp-nat/src/auto_nat.rs
    - Legacy AutoNat — update or replace with AutoNatV1
  implementations/rust/crates/aafp-discovery/src/rpc_handler.rs
    - Pattern for RPC handlers — follow same structure

### N3: Implement DCuTR hole punching

DCuTR upgrades a relayed connection to a direct connection by having
both peers simultaneously open connections to each other's observed
addresses. This works for cone NATs (where the same external port is
used for all destinations) but not for symmetric NATs.

- Implement `Dcutr::initiate_upgrade()`:
  1. Both peers exchange their observed external addresses (via relay)
  2. Both peers simultaneously dial each other's observed addresses
  3. QUIC connection migration handles the path validation
  4. If both dials succeed, upgrade to direct connection
  5. If either fails, keep the relayed connection
- Add address exchange protocol:
  - `aafp.dcutr.observe`: Ask peer to report my observed address
  - `aafp.dcutr.connect`: Initiate simultaneous open
- Use quinn's `Connection::migrate()` or endpoint rebind for the
  simultaneous open (the relay provides the observed addresses)
- Add NAT type detection: if both peers are cone NAT, attempt DCuTR.
  If either is symmetric NAT, skip DCuTR and keep relay.
- **VERIFY:** A test where two agents behind different cone NATs
  (simulated with two localhost addresses) upgrade from relayed to
  direct connection

KEY FILES:
  implementations/rust/crates/aafp-nat/src/dcutr.rs
    - Replace stub with real implementation
  implementations/rust/crates/aafp-nat/src/relay_v1.rs
    - AutoNatV1 provides observed addresses
  implementations/rust/crates/aafp-transport-quic/src/transport.rs
    - QuicTransport::dial() — used for simultaneous open

### N4: Relay discovery and bootstrap

Agents need to discover relay nodes. Currently there's no mechanism for
an agent to find a relay.

- Add relay nodes to the bootstrap discovery list (configurable)
- Add a `RelayDiscovery` type that:
  1. Connects to bootstrap nodes
  2. Queries for agents with the "aafp.relay" capability
  3. Returns a list of known relay multiaddrs
- Add relay selection logic: choose the relay with lowest latency
  (ping each relay, pick the fastest)
- Add relay reservation management: automatically reserve on connect,
  renew before expiry, cancel on disconnect
- **VERIFY:** An agent can discover a relay via bootstrap, reserve,
  and maintain the reservation with automatic renewal

KEY FILES:
  implementations/rust/crates/aafp-discovery/src/bootstrap.rs
    - BootstrapDiscovery — add relay discovery
  implementations/rust/crates/aafp-nat/src/relay_v1.rs
    - RelayV1Client — add reservation lifecycle management
  implementations/rust/crates/aafp-sdk/src/builder.rs
    - AgentBuilder — add with_relay(), with_auto_nat()

### N5: Integrate NAT traversal into the SDK

Wire the relay, AutoNAT, and DCuTR into the Agent SDK so that
connection establishment automatically handles NAT:

1. Agent starts → AutoNAT runs dial-back checks → determines NatStatus
2. If behind NAT → discover relay → reserve on relay
3. When a peer connects (directly or via relay) → attempt DCuTR upgrade
4. Agent advertises its relay address in discovery (if behind NAT)

- Add `Agent::nat_status()` that returns current NAT status
- Add `Agent::relay_addr()` that returns the relay address (if reserved)
- Modify `AgentClient::connect()` to:
  - Try direct dial first
  - If direct fails and a relay is known, try relayed connection
  - After relayed connection, attempt DCuTR upgrade in background
- Modify `AgentServer::accept()` to accept both direct and relayed connections
- **VERIFY:** An agent behind NAT can be reached via relay, and the
  connection is later upgraded to direct via DCuTR

KEY FILES:
  implementations/rust/crates/aafp-sdk/src/client.rs
    - AgentClient::connect() — add relay fallback + DCuTR
  implementations/rust/crates/aafp-sdk/src/server.rs
    - AgentServer::accept() — accept relayed connections
  implementations/rust/crates/aafp-sdk/src/builder.rs
    - AgentBuilder — add NAT traversal configuration
  implementations/rust/crates/aafp-sdk/src/lib.rs
    - Agent struct — add nat_status, relay fields

### N6: NAT traversal test harness

Create a test harness that simulates NAT scenarios:

- `NATScenario` enum: NoNAT, ConeNAT, SymmetricNAT, PortRestricted
- `NatSimulator` that:
  1. Creates virtual network interfaces (or uses different localhost ports)
  2. Simulates NAT behavior (port mapping, address rewriting)
  3. Allows testing relay forwarding, AutoNAT, and DCuTR
- For localhost testing: use multiple bind addresses (127.0.0.1:XXXX,
  127.0.0.2:XXXX) to simulate different networks
- For real NAT testing: document how to test with two machines behind
  different NATs (home WiFi + cellular hotspot)
- **VERIFY:** All four NAT scenarios produce correct behavior:
  - NoNAT: direct connection works, no relay needed
  - ConeNAT: direct works, DCuTR upgrade works
  - SymmetricNAT: direct fails, relay works, DCuTR fails (expected)
  - PortRestricted: direct may fail, relay works, DCuTR may work

KEY FILES:
  implementations/rust/crates/aafp-tests/tests/nat_traversal.rs (NEW)
    - Integration tests for all NAT scenarios
  implementations/rust/crates/aafp-tests/src/nat_simulator.rs (NEW)
    - NAT simulation helpers

### N7: Two-machine relay test

The critical real-world test: two machines on different networks,
both behind NAT, connecting through a relay.

- Create a test script that:
  1. Starts a relay node on a public server (or a machine with port forwarding)
  2. Starts agent A behind NAT (home WiFi)
  3. Starts agent B behind NAT (cellular hotspot)
  4. Agent A reserves on the relay
  5. Agent B connects to agent A via the relay
  6. Verify bidirectional communication works
  7. Verify DCuTR upgrade (if both NATs are cone-type)
- Document the test setup (network topology, commands to run)
- Write results to test-results/interop/nat-traversal-real-world.json
- **VERIFY:** Two agents behind different NATs can communicate via relay

KEY FILES:
  test-results/interop/nat-traversal-real-world.json (NEW)
  scripts/test-nat-traversal.sh (NEW)
  docs/NAT_TRAVERSAL_TESTING.md (NEW)

### N8: Relay performance and capacity testing

- Benchmark relay throughput: how many bytes/sec can a relay forward?
- Benchmark relay concurrent connections: how many simultaneous relayed
  connections can a relay handle?
- Test relay under load: 10 agents, each sending 1KB messages through
  the relay at 1000 msg/s
- Measure latency overhead of relay vs direct connection
- **VERIFY:** Relay can handle 50 concurrent connections at 100KB/s each
  without degradation (RFC 0010 default max_connections = 50)

KEY FILES:
  implementations/rust/crates/aafp-benchmark/benches/relay_performance.rs (NEW)
  test-results/performance/relay-performance.json (NEW)

---

## Expected Outcomes

| Capability | Before | After |
|-----------|--------|-------|
| Relay data forwarding | Stub (tracks metadata only) | Working (forwards real QUIC streams) |
| AutoNAT | Stub (tracks status only) | Working (dial-back detection) |
| DCuTR | Stub (records attempts only) | Working (hole punching for cone NATs) |
| Relay discovery | Not implemented | Working (via bootstrap + capability query) |
| SDK integration | Manual | Automatic (connect with relay fallback) |
| Real-world NAT test | Never done | Two-machine cross-NAT test |
| Relay capacity | Unknown | Benchmarked (50 connections, 100KB/s each) |

---

## Risks & Mitigations

1. **Symmetric NAT is unfixable:** ~20% of NATs are symmetric, where
   DCuTR cannot work. **Mitigation:** Relay is the fallback. Document
   that symmetric NAT requires relay.

2. **QUIC hole punching may not work with quinn:** Quinn's connection
   migration is designed for address changes, not simultaneous open.
   **Mitigation:** If quinn doesn't support simultaneous open, use
   raw UDP socket binding + quinn rebind. If that doesn't work, fall
   back to relay-only.

3. **Relay is a trusted middleman:** The relay can see traffic metadata
   (source, target, timing) but not content (TLS is end-to-end).
   **Mitigation:** Document that relays see metadata but not plaintext.
   AAFP's TLS + AAFP handshake is end-to-end, not terminated at the relay.

4. **Port prediction for symmetric NAT:** Some implementations use port
   prediction to punch through symmetric NATs. **Mitigation:** Out of
   scope for this track. Document as future work.

5. **IPv6 eliminates NAT:** If both peers have IPv6, NAT is not needed.
   **Mitigation:** AutoNAT should check IPv6 connectivity first. If
   both peers have IPv6, skip NAT traversal entirely.
