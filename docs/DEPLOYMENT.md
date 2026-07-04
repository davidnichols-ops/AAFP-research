# AAFP Deployment Guide

This guide covers deploying AAFP agents in production using Docker, systemd,
or Kubernetes.

## Quick Start

### Single Agent (Binary)

```bash
# Build
cd implementations/rust
cargo build --release -p aafp-cli

# Run
./target/release/aafp-agent --bind 0.0.0.0:4433 --capabilities inference
```

### Single Agent (Docker)

```bash
docker build -t aafp-agent .
docker run -d --name aafp-agent -p 4433:4433/udp \
  -e AAFP_BIND=0.0.0.0:4433 \
  -e AAFP_CAPABILITIES=inference \
  -v aafp-keys:/data/keys \
  aafp-agent
```

## Docker

### Dockerfile

The `Dockerfile` in the repo root uses a multi-stage build:

1. **Builder stage**: Rust toolchain, compiles the agent binary
2. **Runtime stage**: Distroless image, minimal attack surface

```bash
# Build
docker build -t aafp-agent .

# Run with default config
docker run -d -p 4433:4433/udp aafp-agent

# Run with custom config
docker run -d -p 4433:4433/udp \
  -e AAFP_BIND=0.0.0.0:4433 \
  -e AAFP_CAPABILITIES=inference,translation \
  -e AAFP_RELAY=quic://relay.example.com:4433 \
  -e RUST_LOG=info \
  -v aafp-keys:/data/keys \
  -v aafp-dht:/data/dht \
  aafp-agent
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AAFP_BIND` | `0.0.0.0:4433` | Bind address for QUIC transport |
| `AAFP_CAPABILITIES` | (empty) | Comma-separated capabilities |
| `AAFP_RELAY` | (empty) | Bootstrap relay address |
| `AAFP_SEEDS` | (empty) | Comma-separated seed node addresses |
| `AAFP_PQ` | `true` | Enable post-quantum KEX |
| `RUST_LOG` | `warn` | Log level (trace/debug/info/warn/error) |
| `AAFP_DATA_DIR` | `/data` | Data directory for keys and DHT |

### Volumes

| Mount | Purpose |
|-------|---------|
| `/data/keys` | Agent keypair (persistent identity) |
| `/data/dht` | DHT database (SQLite) |

### Health Check

The Docker image includes a health check that verifies the agent is listening
on UDP 4433:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["/aafp-agent", "healthcheck"]
```

### docker-compose.yml

The `docker-compose.yml` in the repo root starts a 3-agent setup:

```bash
docker-compose up -d
```

This starts:
- **relay**: A public relay node (port 4433)
- **agent-1**: An agent behind NAT (uses relay)
- **agent-2**: Another agent behind NAT (uses relay)

Agents communicate through the relay. View logs:

```bash
docker-compose logs -f agent-1
```

## Systemd

### Service File

Deploy `deploy/systemd/aafp-agent.service` to `/etc/systemd/system/`:

```bash
sudo cp deploy/systemd/aafp-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable aafp-agent
sudo systemctl start aafp-agent
```

### Configuration

Edit the service file or use an override:

```bash
sudo systemctl edit aafp-agent
```

```ini
[Service]
Environment=AAFP_BIND=0.0.0.0:4433
Environment=AAFP_CAPABILITIES=inference,translation
Environment=AAFP_RELAY=quic://relay.example.com:4433
Environment=RUST_LOG=info
```

### Resource Limits

The service file includes resource limits:

```ini
[Service]
# Memory limit: 512MB
MemoryMax=512M
# CPU limit: 50% of one core
CPUQuota=50%
# File descriptor limit
LimitNOFILE=65536
# Process limit
LimitNPROC=256
```

### Logs

```bash
journalctl -u aafp-agent -f
```

## Kubernetes

### Deployment

Deploy `deploy/kubernetes/aafp-agent.yaml`:

```bash
kubectl apply -f deploy/kubernetes/aafp-agent.yaml
```

This creates:
- **Deployment**: 3 replicas of the AAFP agent
- **Service**: UDP load balancer on port 4433
- **ConfigMap**: Agent configuration
- **Secret**: Agent keypair (base64-encoded)

### Scaling

```bash
kubectl scale deployment aafp-agent --replicas=10
```

### Configuration

Edit the ConfigMap:

```bash
kubectl edit configmap aafp-agent-config
```

### Monitoring

```bash
kubectl logs -f deployment/aafp-agent
kubectl exec -it deployment/aafp-agent -- /aafp-agent metrics
```

## Configuration

### AgentBuilder Options

All deployment methods use the same `AgentBuilder` options:

| Option | CLI Flag | Env Var | Default |
|--------|----------|---------|---------|
| Bind address | `--bind` | `AAFP_BIND` | `127.0.0.1:0` |
| Capabilities | `--capabilities` | `AAFP_CAPABILITIES` | (empty) |
| Seed nodes | `--seeds` | `AAFP_SEEDS` | (empty) |
| Relay mode | `--relay` | `AAFP_RELAY_MODE` | false |
| PQ KEX | `--pq` | `AAFP_PQ` | true |
| Bootstrap relays | `--bootstrap-relays` | `AAFP_RELAY` | (empty) |
| DCuTR | `--dcutr` | `AAFP_DCUTR` | true |
| AutoNAT | `--autonat` | `AAFP_AUTONAT` | true |
| Keep-alive interval | `--keepalive-interval` | `AAFP_KEEPALIVE_INTERVAL` | 30s |
| Keep-alive timeout | `--keepalive-timeout` | `AAFP_KEEPALIVE_TIMEOUT` | 10s |

## Security

### Key Management

Agent identity is based on ML-DSA-65 keypairs. Store keys securely:

```bash
# Generate a keypair
./target/release/aafp-agent keygen --output /data/keys/agent.key

# Use existing keypair
./target/release/aafp-agent --keyfile /data/keys/agent.key
```

**Recommendations:**
- Store keys in a secrets manager (Vault, AWS Secrets Manager, etc.)
- Use Kubernetes Secrets for K8s deployments
- Never commit keys to version control
- Rotate keys periodically (see OPERATIONS.md)

### Firewall Rules

AAFP uses UDP for QUIC transport:

```bash
# Allow incoming QUIC
sudo ufw allow 4433/udp

# Allow outgoing QUIC (if behind firewall)
sudo ufw allow out 4433/udp
```

### TLS Configuration

AAFP uses post-quantum TLS (PQ-TLS) via rustls + quinn. The TLS certificates
are self-signed and based on the agent's ML-DSA-65 keypair. No external CA
is required for agent-to-agent communication.

For relay nodes exposed to the internet, consider:
- Rate limiting incoming connections
- DDoS protection (Cloudflare, AWS Shield)
- Network policies (Kubernetes)

## Monitoring

### Metrics

AAFP agents expose metrics via the `aafp.metrics` RPC method:

```bash
# Get metrics
./target/release/aafp-agent metrics

# Response (JSON):
{
  "connections_active": 5,
  "connections_total": 142,
  "messages_sent": 1024,
  "messages_received": 1020,
  "bytes_sent": 1048576,
  "bytes_received": 1044480,
  "handshakes_completed": 142,
  "handshakes_failed": 3,
  "uptime_seconds": 3600
}
```

### Health Check

```bash
# Check health
./target/release/aafp-agent healthcheck
# Output: healthy | degraded | unhealthy
```

### Logging

AAFP uses structured logging via the `tracing` crate:

```bash
# Set log level
RUST_LOG=info ./target/release/aafp-agent

# JSON format (for log aggregation)
RUST_LOG_FORMAT=json RUST_LOG=info ./target/release/aafp-agent
```

### Prometheus (Optional)

Enable the Prometheus metrics endpoint with the `prometheus` feature:

```bash
cargo build --release --features prometheus
```

Metrics are exposed on `http://0.0.0.0:9090/metrics`.

### Alerting

Recommended alerts:
- **Unhealthy**: Agent health check returns `unhealthy`
- **High error rate**: Message error rate > 5%
- **No connections**: `connections_active == 0` for > 5 minutes
- **High handshake failure**: Handshake failure rate > 20%
- **Memory growth**: RSS memory growth > 10% over 1 hour

## Scaling

### Horizontal Scaling

Add more agents by deploying additional instances:

```bash
# Docker
docker run -d -p 4434:4433/udp aafp-agent

# Kubernetes
kubectl scale deployment aafp-agent --replicas=10
```

### Relay Deployment

For NAT traversal, deploy relay nodes in public subnets:

```bash
# Deploy relay
docker run -d -p 4433:4433/udp \
  -e AAFP_RELAY_MODE=true \
  -e AAFP_BIND=0.0.0.0:4433 \
  aafp-agent
```

**Recommendations:**
- Deploy at least 2 relays for redundancy
- Use geographically distributed relays
- Monitor relay connection count (target: <1000 per relay)
- Increase relay max_connections to 1000+ for production

### DHT Sizing

The DHT is in-memory by default. For persistent DHT:

```bash
# Enable persistent DHT (SQLite)
./target/release/aafp-agent --dht-path /data/dht/records.db
```

**Recommendations:**
- 1 DHT record per agent (~200 bytes)
- 1000 agents = ~200KB DHT
- 100K agents = ~20MB DHT
- SQLite handles up to 1M records efficiently

## System Requirements

### Minimum

- **CPU**: 1 core
- **RAM**: 64MB
- **Disk**: 10MB (binary) + DHT size
- **OS**: Linux (x86_64, ARM64), macOS
- **Network**: UDP port 4433

### Recommended (100+ connections)

- **CPU**: 2 cores
- **RAM**: 256MB
- **Disk**: 100MB
- **FD limit**: 65536 (`ulimit -n 65536`)
- **OS**: Linux (x86_64)

### Production (1000+ connections)

- **CPU**: 4 cores
- **RAM**: 512MB
- **Disk**: 1GB
- **FD limit**: 65536
- **OS**: Linux (x86_64)
- **Kernel**: 5.15+ (for UDP GRO)

## Performance Benchmarks

Based on Track S2 load testing (100 agents, 1KB messages):

| Topology | Messages | Throughput | p50 Latency | p99 Latency | Error Rate |
|----------|----------|------------|-------------|-------------|------------|
| Mesh (10 conn/agent) | 100K | 93K msg/s | 32ms | 158ms | 0% |
| Star (hub) | 99K | 61K msg/s | 9ms | 25ms | 0% |
| Ring | 100K | 181K msg/s | 3ms | 10ms | 0% |
| Random (K=5) | 100K | 138K msg/s | 14ms | 83ms | 0% |

Memory per agent: ~5-10MB. File descriptors per agent: ~20-30.
