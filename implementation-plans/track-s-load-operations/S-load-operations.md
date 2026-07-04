# Track S: Load Testing & Operations — Production Readiness

**Priority:** HIGH
**Duration:** 2 weeks
**Blocked by:** Track N (NAT traversal — load test needs relay for cross-NAT)
**Blocks:** nothing (but required for production deployment)

---

## Problem

AAFP has never been tested with more than a few agents. There is no:

1. **Load testing.** No test has run 100+ concurrent agents. The
   connection pool, DHT, relay, and frame parser have been benchmarked
   individually but never under concurrent load from many agents.

2. **Monitoring and observability.** No metrics, no logging framework,
   no tracing, no health checks. In production, you need to know:
   - How many active connections?
   - What's the message rate?
   - What's the error rate?
   - Where is time being spent?
   - Is the agent healthy?

3. **Deployment documentation.** No guide for deploying an AAFP agent
   in production. No Dockerfile, no systemd service file, no Kubernetes
   manifest, no configuration guide.

4. **Failure mode analysis under load.** What happens when:
   - 100 agents connect simultaneously?
   - 1000 messages/second are being routed?
   - The DHT has 10,000 records?
   - The relay is forwarding 100 connections?
   - Memory grows over 24 hours (leak detection)?

5. **Operational runbooks.** No documentation for common operations:
   - How to rotate keys
   - How to update an agent without dropping connections
   - How to scale horizontally
   - How to debug a slow agent
   - How to monitor for security incidents

---

## Steps

### S1: Load test harness

Create infrastructure for load testing with many agents.

- Create `tests/load_test.rs`:
  - `LoadTestConfig`: num_agents, messages_per_agent, message_size,
    duration, topology (mesh, star, ring)
  - `LoadTestRunner`: starts N agents, connects them, sends messages,
    collects metrics
  - `LoadTestMetrics`: throughput, latency p50/p90/p99, error rate,
    memory usage, CPU usage, connection count

- Create `scripts/load-test.sh`:
  - Starts N agents in separate processes (or tokio tasks)
  - Runs the load test
  - Outputs JSON results to test-results/performance/load-test-N.json

- Support topologies:
  - **Mesh:** every agent connects to every other (N² connections)
  - **Star:** all agents connect to a central hub
  - **Ring:** each agent connects to its neighbor (N connections)
  - **Random:** each agent connects to K random peers

- **VERIFY:** Load test runs with 10 agents, 100 messages each,
  1KB message size, mesh topology, and produces metrics

KEY FILES:
  tests/load_test.rs (NEW)
  scripts/load-test.sh (NEW)
  implementations/rust/crates/aafp-sdk/src/agent.rs
    - Agent — used by load test

### S2: 100-agent load test

Run the load test with 100 agents.

- Configure: 100 agents, 1000 messages/agent, 1KB messages, 60s duration
- Topologies: mesh (limited to 10 connections per agent to avoid N²),
  star, ring, random (K=5)

- Measure:
  - Total messages sent/received
  - Throughput (messages/second aggregate)
  - Latency distribution (p50, p90, p99, p99.9)
  - Error rate (messages lost, connections failed)
  - Memory per agent (should be <10MB)
  - CPU usage per agent
  - File descriptors per agent

- Identify bottlenecks:
  - Is it CPU-bound (handshake/encryption)?
  - Is it memory-bound (buffer pool)?
  - Is it network-bound (QUIC streams)?
  - Is it lock contention (ArcSwap, Mutex)?

- Write results to `test-results/performance/load-test-100-agents.json`
- **VERIFY:** 100 agents can exchange 100K messages with <1% error rate

### S3: Long-running stability test (24-hour)

Test for memory leaks and stability over time.

- Run a single agent for 24 hours:
  - Accept connections from 10 clients
  - Each client sends 1 message/second
  - Monitor: memory, CPU, file descriptors, connection count
  - Log metrics every 5 minutes

- Check for:
  - Memory growth (leak detection)
  - File descriptor growth (connection leak)
  - CPU usage drift (thermal throttling or GC-like behavior)
  - Connection count stability

- If running 24 hours is impractical, run for 4 hours and extrapolate.
- Document any leaks found and fix them.

- Write results to `test-results/performance/stability-24h.json`
- **VERIFY:** Memory growth <10% over 4 hours of continuous operation

### S4: Metrics and observability

Add metrics collection to the agent.

- Add `AgentMetrics` struct:
  - `connections_active`: current active connections
  - `connections_total`: total connections since start
  - `messages_sent` / `messages_received`: total message count
  - `bytes_sent` / `bytes_received`: total bytes
  - `handshakes_completed` / `handshakes_failed`: handshake stats
  - `dht_records`: current DHT record count
  - `relay_connections`: current relayed connections (if relay)
  - `uptime_seconds`: time since start

- Add `Agent::metrics() → AgentMetrics`:
  - Returns current metrics snapshot
  - Uses AtomicU64 counters (lock-free, no contention)

- Add `Agent::health_check() → HealthStatus`:
  - `Healthy`: all systems normal
  - `Degraded`: some issues (high error rate, low memory)
  - `Unhealthy`: critical issues (no connections, OOM risk)

- Add metrics endpoint:
  - `aafp.metrics` RPC method: returns metrics as CBOR
  - HTTP endpoint (optional, behind feature flag): `/metrics` returns
    Prometheus-format metrics

- Add structured logging:
  - Use `tracing` crate (already a dependency via tokio)
  - Log: connections, handshakes, errors, DHT operations
  - Configurable log level (error, warn, info, debug, trace)

- **VERIFY:** Agent exposes metrics via RPC, metrics are accurate,
  health check returns correct status

KEY FILES:
  implementations/rust/crates/aafp-sdk/src/agent.rs
    - Add AgentMetrics, health_check()
  implementations/rust/crates/aafp-sdk/src/lib.rs
    - Add metrics module
  implementations/rust/crates/aafp-sdk/Cargo.toml
    - Add tracing, metrics features

### S5: Deployment documentation

Create production deployment guides.

- Create `docs/DEPLOYMENT.md`:
  - **Quick start:** Single agent deployment
  - **Docker:** Dockerfile + docker-compose.yml
  - **Systemd:** Service file for Linux deployment
  - **Kubernetes:** Deployment + Service + ConfigMap manifests
  - **Configuration:** All AgentBuilder options explained
  - **Security:** Key management, firewall rules, TLS config
  - **Monitoring:** How to collect metrics, set up alerts
  - **Scaling:** Horizontal scaling, relay deployment, DHT sizing

- Create `Dockerfile`:
  - Multi-stage build (build with cargo, runtime with distroless)
  - Expose QUIC port (UDP 4433)
  - Health check endpoint
  - Configurable via environment variables

- Create `docker-compose.yml`:
  - 3-agent setup (for testing)
  - Relay node + 2 agents behind NAT
  - Volumes for key storage and DHT database

- Create `deploy/systemd/aafp-agent.service`:
  - systemd unit file for production deployment
  - User isolation, restart on failure, resource limits

- Create `deploy/kubernetes/aafp-agent.yaml`:
  - Deployment (3 replicas)
  - Service (UDP load balancer for QUIC)
  - ConfigMap (agent configuration)
  - Secret (agent private key)

- **VERIFY:** Docker build succeeds, docker-compose starts 3 agents,
  agents can communicate

### S6: Operational runbook

Create documentation for common operations.

- Create `docs/OPERATIONS.md`:
  - **Key rotation:** How to rotate agent keys (reference Track P5)
  - **Rolling update:** How to update agents without downtime
    - Drain connections, update, restart, re-accept
  - **Scaling:** How to add more agents to the network
  - **Debugging slow agent:** How to diagnose performance issues
    - Check metrics, check logs, check CPU/memory, check network
  - **Security incident:** What to do if a key is compromised
    - Revoke key (Track P6), notify peers, rotate to new key
  - **Relay management:** How to deploy and maintain relay nodes
  - **DHT maintenance:** How to monitor DHT health, handle churn
  - **Backup and recovery:** How to backup DHT database and keys

- Create `docs/TROUBLESHOOTING.md`:
  - Common issues and solutions:
    - "Agent can't connect" → check firewall, NAT, relay
    - "High latency" → check network, congestion control, DHT routing
    - "Memory growth" → check for leaks, connection accumulation
    - "Handshake failures" → check key validity, clock skew, replay cache
    - "DHT lookup fails" → check bootstrap, peer connectivity, record TTL

- **VERIFY:** Runbook covers all common operations, troubleshooting
  guide covers known issues

### S7: Stress testing edge cases

Test AAFP under extreme conditions.

- Test: **Burst traffic**
  - 100 agents send 100 messages simultaneously (10K message burst)
  - Measure: does the agent process them all? Any drops?
  - Expected: queue handles burst, no messages lost

- Test: **Large message**
  - Send 1MB, 10MB, 100MB messages
  - Verify: frame fragmentation works, no OOM
  - Current limit: 1MB max frame size — is this sufficient?

- Test: **Many streams**
  - Open 100, 500, 1000 concurrent streams on one connection
  - Measure: memory per stream, does quinn handle it?
  - Current limit: max_streams_bidi (configured in J3)

- Test: **Connection churn**
  - 100 agents connect and disconnect every 1 second
  - Measure: connection setup/teardown overhead, memory recovery
  - Expected: connection pool handles churn, no FD leak

- Test: **DHT under load**
  - 100 agents announce simultaneously
  - 100 agents lookup simultaneously
  - Measure: DHT throughput, latency under concurrent load

- Write results to `test-results/performance/stress-tests.json`
- **VERIFY:** Agent survives all stress tests without crash or OOM

### S8: Production readiness report

Compile all operational findings into a production readiness report.

- Create `docs/PRODUCTION_READINESS.md`:
  - **Load test results:** 100 agents, throughput, latency, errors
  - **Stability results:** 4-24h run, memory/CPU stability
  - **Metrics available:** What can be monitored
  - **Deployment options:** Docker, systemd, Kubernetes
  - **Operational procedures:** Key rotation, updates, scaling
  - **Known limitations:** Max agents, max messages, max streams
  - **Recommendations:** Production config, monitoring setup, alerts
  - **Checklist:** Pre-production checklist (security, performance, ops)

- Update `STATUS.md` with production readiness status
- **VERIFY:** Comprehensive production readiness report exists

---

## Expected Outcomes

| Capability | Before | After |
|-----------|--------|-------|
| Load testing | None | 100-agent test with metrics |
| Stability testing | None | 4-24h continuous operation |
| Metrics | None | AgentMetrics + health check |
| Logging | Basic | Structured tracing |
| Deployment docs | None | Docker, systemd, Kubernetes |
| Operational runbook | None | Complete (key rotation, updates, debugging) |
| Stress testing | None | Burst, large messages, churn, DHT load |
| Production readiness | Unknown | Documented and verified |

---

## Risks & Mitigations

1. **100 agents may exceed system limits.** File descriptors, memory,
   CPU may be insufficient. **Mitigation:** Start with 10, scale up.
   Document system requirements (FD limit, memory, CPU).

2. **Memory leaks may be found.** Long-running tests may reveal leaks.
   **Mitigation:** Fix leaks. Use `valgrind` or `heaptrack` for
   profiling. Document known memory growth patterns.

3. **Docker image may be large.** Rust binaries can be 50MB+.
   **Mitigation:** Use distroless base image, strip debug symbols,
   use `cargo build --release` with LTO.

4. **Kubernetes UDP load balancing is tricky.** QUIC uses UDP, and
   not all Kubernetes load balancers support UDP well.
   **Mitigation:** Use NodePort or hostNetwork for QUIC. Document
   the limitation. Consider a QUIC-aware load balancer.
