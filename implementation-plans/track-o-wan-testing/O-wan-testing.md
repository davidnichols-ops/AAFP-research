# Track O: WAN Testing — Real Network Validation

**Priority:** CRITICAL
**Duration:** 1-2 weeks
**Blocked by:** Track N (NAT traversal — needs relay for cross-NAT tests)
**Blocks:** nothing (but informs all future deployment decisions)

---

## Problem

Every test, benchmark, and interop verification in the AAFP project has
been run on localhost (<1ms RTT, no packet loss, no NAT, no congestion).
This means:

1. **BBR validation is meaningless.** The J7 benchmark showed "BBR 4%
   faster than Cubic for small messages" — but on localhost there's no
   congestion, no packet loss, and RTT is ~0.1ms. BBR's advantage is
   in real network conditions with variable bandwidth and packet loss.

2. **No failure mode testing.** What happens when:
   - Network goes down mid-handshake?
   - RTT spikes to 200ms (cross-continent)?
   - Packet loss is 5% (cellular)?
   - Bandwidth drops to 100KB/s (mobile data)?
   - Connection is reset by a middlebox?
   None of these have been tested.

3. **No cross-network interop.** Python MCP SDK interop, A2A interop,
   and Rust-Go interop were all tested in-process or on localhost.
   Real network conditions may reveal framing issues, timeout bugs,
   or buffer size problems.

4. **No multi-node DHT testing.** The DHT has never routed a lookup
   across multiple networked nodes. Discovery announce/lookup was
   tested "in-process, not over WAN."

5. **Connection migration untested.** I6 tested quinn rebind on
   localhost (14.31µs). Real WiFi-to-cellular handoff involves
   different IP ranges, NAT rebinding, and path validation delays.

---

## Steps

### O1: WAN test infrastructure

Create the infrastructure for running tests across two machines.

- Create `scripts/wan-test-setup.sh`:
  - Takes two arguments: local agent port, remote agent address
  - Starts a local agent, connects to the remote, runs a test suite
  - Outputs JSON results to test-results/interop/wan-*.json

- Create `scripts/wan-test-server.sh`:
  - Starts an agent in server mode on a specified port
  - Waits for connections from the test client
  - Responds to ping, echo, and streaming requests

- Create `tests/wan_test.rs`:
  - Integration test that can be run against a remote server
  - Configured via environment variables: `AAFP_REMOTE_ADDR`, `AAFP_TEST_MODE`
  - Modes: `ping`, `echo`, `stream`, `handshake`, `discovery`, `migration`
  - Each mode runs a specific test scenario and reports results

- Document the two-machine test setup in `docs/WAN_TESTING.md`:
  - Machine A: server (public IP or port-forwarded)
  - Machine B: client (any network)
  - Commands to run on each machine
  - Expected output and how to interpret results

- **VERIFY:** Test script runs against a remote server and produces JSON output

KEY FILES:
  scripts/wan-test-setup.sh (NEW)
  scripts/wan-test-server.sh (NEW)
  tests/wan_test.rs (NEW)
  docs/WAN_TESTING.md (NEW)

### O2: Latency and throughput over WAN

Measure round-trip latency and throughput across real network conditions.

- Run ping test (1000 pings) and measure:
  - p50, p90, p99, p99.9 latency
  - Compare to localhost baseline (41.47µs)
  - Expected: WAN latency = localhost + network RTT (~10-200ms)

- Run throughput test (1000 1KB messages) and measure:
  - Messages per second
  - Compare to localhost baseline (776K msg/s)
  - Expected: WAN throughput limited by bandwidth and RTT

- Run with different message sizes: 64B, 256B, 1KB, 4KB, 16KB, 64KB
  - Find the sweet spot where throughput is maximized
  - Identify where fragmentation/segmentation affects performance

- Test with BBR vs Cubic vs NewReno:
  - On localhost, NewReno was fastest (no congestion)
  - On WAN, BBR should be better (handles variable bandwidth)
  - Run each congestion controller 3 times, take median

- Write results to `test-results/performance/wan-latency-throughput.json`
- **VERIFY:** WAN latency and throughput are measured and documented

### O3: Packet loss and high-latency conditions

Test AAFP behavior under adverse network conditions.

- Use `tc` (traffic control) on Linux or `Network Link Conditioner` on macOS:
  - Add 1% packet loss → measure latency and throughput impact
  - Add 5% packet loss → verify connection survives, measure degradation
  - Add 200ms RTT (cross-continent simulation) → measure handshake time
  - Add 500ms RTT (satellite simulation) → verify timeout handling
  - Add 1% packet loss + 100ms RTT → realistic cross-continent conditions

- Test specific scenarios:
  - Handshake under packet loss: does the PQ handshake complete?
  - Mid-stream network interruption: does the connection recover?
  - Slow network (56KB/s bandwidth): does framing handle small windows?
  - Burst loss (10 packets lost in a row): does QUIC recover?

- Document failure modes:
  - At what packet loss % does the handshake fail?
  - At what RTT does the connection timeout?
  - How long does QUIC take to recover from a 5-second network outage?

- Write results to `test-results/performance/wan-adverse-conditions.json`
- **VERIFY:** AAFP survives 5% packet loss and 200ms RTT

IMPORTANT: `tc` requires root on Linux. `Network Link Conditioner` is
a macOS System Preferences panel (Additional Developer Tools). If neither
is available, document the test setup and skip execution. Alternatively,
use a proxy that adds latency/loss (e.g., `toxiproxy`).

### O4: BBR vs Cubic validation over WAN

The critical congestion control test that couldn't be done on localhost.

- Test setup: two machines with a real network between them
- Run 1000-message round-trip test with each congestion controller:
  - Cubic (quinn default)
  - BBR (low-latency preset)
  - NewReno

- Test under multiple conditions:
  - Clean network (no loss, low RTT)
  - 1% packet loss
  - 5% packet loss
  - 100ms RTT
  - 100ms RTT + 1% loss

- Measure for each condition:
  - Round-trip latency (p50, p99)
  - Throughput (msg/s)
  - Time to first message (handshake + first message)
  - Connection stability (does it stay connected?)

- Expected results:
  - Clean network: NewReno ≈ Cubic ≈ BBR (no congestion to manage)
  - With packet loss: BBR > Cubic > NewReno (BBR doesn't wait for loss)
  - High RTT: BBR > Cubic > NewReno (BBR estimates bandwidth better)

- Write results to `test-results/performance/wan-congestion-control.json`
- **VERIFY:** BBR shows measurable advantage over Cubic under packet loss

### O5: Cross-network interop testing

Test all interop scenarios over a real network.

- Python MCP SDK interop over WAN:
  - Rust server on Machine A
  - Python client on Machine B
  - Run initialize, tools/list, tools/call over WAN
  - Verify all operations succeed
  - Measure latency vs localhost interop

- A2A interop over WAN:
  - Rust A2A server on Machine A
  - Rust A2A client on Machine B
  - Run send_message, get_task, list_tasks, cancel_task over WAN
  - Verify all operations succeed

- Rust-Go frame interop over WAN:
  - Not applicable (Go has no QUIC transport)
  - But verify CBOR/frame compatibility is network-independent (already proven)

- Write results to `test-results/interop/wan-interop.json`
- **VERIFY:** All interop scenarios work over WAN

### O6: Connection migration over real network changes

Test I6 (connection migration) under real conditions.

- Test 1: WiFi to Ethernet (same machine):
  - Agent connected via WiFi
  - Disable WiFi, enable Ethernet
  - Verify connection migrates and survives
  - Measure migration time

- Test 2: WiFi to cellular (different network):
  - Agent connected via WiFi
  - Switch to cellular hotspot
  - Verify connection migrates (if NAT allows)
  - Measure migration time and any message loss

- Test 3: IP address change:
  - Agent bound to 192.168.1.X
  - Change to 10.0.0.X
  - Verify quinn rebind works
  - Measure path validation time

- Document which scenarios work and which fail
- Write results to `test-results/interop/wan-connection-migration.json`
- **VERIFY:** Connection survives at least one network change scenario

NOTE: This step requires real hardware. If you only have one machine,
test with multiple localhost addresses (127.0.0.1, 127.0.0.2) to
simulate address changes. Document the real-world test setup for
future execution.

### O7: Multi-node DHT over WAN

Test discovery with multiple nodes on different networks.

- Start 3+ agents on different machines:
  - Agent A on Machine 1 (announces "inference" capability)
  - Agent B on Machine 2 (announces "translation" capability)
  - Agent C on Machine 3 (bootstrap node, no capabilities)

- Test discovery scenarios:
  - Agent A announces to bootstrap → Agent B can lookup "inference"
  - Agent B announces to bootstrap → Agent C can lookup "translation"
  - Agent C can list all known agents
  - Agent A goes offline → Agent B's lookup for "inference" returns empty
  - Agent A comes back → re-announces → Agent B can find it again

- Measure:
  - Time to announce (RPC round-trip)
  - Time to lookup (RPC round-trip)
  - Time for propagation (announce on A → visible on B)
  - Churn handling (agents going offline/online)

- Write results to `test-results/interop/wan-dht-discovery.json`
- **VERIFY:** Multi-node DHT discovery works over WAN

NOTE: This step requires 3+ machines. If you only have one machine,
test with 3 agents on different localhost ports. Document the real-world
test setup for future execution.

### O8: WAN performance report

Compile all WAN test results into a comprehensive report.

- Create `test-results/performance/WAN_REPORT.md`:
  - Test environment (machines, network, RTT, bandwidth)
  - Latency results (localhost vs LAN vs WAN vs adverse conditions)
  - Throughput results (localhost vs WAN)
  - Congestion control comparison (BBR vs Cubic vs NewReno)
  - Failure modes and recovery times
  - Interop results over WAN
  - Connection migration results
  - DHT discovery results
  - Recommendations for production deployment

- Update `PERFORMANCE_STATUS.md` with WAN test results
- Update the dashboard to include WAN metrics

- **VERIFY:** Comprehensive WAN report exists with all test results

---

## Expected Outcomes

| Metric | Localhost | LAN (~1ms) | WAN (~50ms) | Adverse (5% loss) |
|--------|-----------|------------|-------------|-------------------|
| Round-trip | 41.47µs | ~2ms | ~100ms | ~200ms (est) |
| Throughput | 776K/s | ~100K/s | ~10K/s | ~5K/s (est) |
| Handshake | 240µs | ~5ms | ~200ms | ~500ms (est) |
| BBR advantage | 4% | ? | ? | ? (to measure) |

The key unknowns this track answers:
1. Does BBR actually help on real networks? (O4)
2. Does AAFP survive packet loss? (O3)
3. Does interop work cross-network? (O5)
4. Does connection migration work in real conditions? (O6)
5. Does DHT discovery work with distributed nodes? (O7)

---

## Risks & Mitigations

1. **No second machine available.** Many tests require two machines.
   **Mitigation:** Use localhost with different ports for logic testing.
   Document real-world test setup. Use cloud VMs (AWS, GCP) if available.

2. **No root access for `tc` (traffic control).** Packet loss simulation
   requires root on Linux. **Mitigation:** Use `toxiproxy` (userspace proxy
   that adds latency/loss) or macOS Network Link Conditioner.

3. **Firewall blocks QUIC.** Some firewalls block UDP (QUIC uses UDP).
   **Mitigation:** Test on an unblocked network. Document that QUIC
   requires UDP to be allowed through firewalls.

4. **NAT prevents inbound connections.** WAN tests need a server with
   inbound access. **Mitigation:** Use a cloud VM as the server, or use
   Track N's relay to reach agents behind NAT.

5. **Results are noisy.** WAN benchmarks have high variance due to
   network conditions. **Mitigation:** Run each test 3+ times, report
   median and p99. Document network conditions at test time.
