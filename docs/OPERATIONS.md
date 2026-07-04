# AAFP Operations Runbook

This runbook covers common operational procedures for AAFP agents in production.

## Key Rotation

### When to Rotate Keys

- **Scheduled**: Every 90 days (recommended)
- **After incident**: If a key may have been compromised
- **After personnel change**: If someone with key access leaves

### Procedure

AAFP uses ML-DSA-65 keypairs for agent identity (Track P). Key rotation
involves generating a new keypair and updating the agent configuration.

#### 1. Generate New Keypair

```bash
# Generate new keypair
./target/release/aafp-agent keygen --output /data/keys/agent-new.key

# Verify the keypair
./target/release/aafp-agent keyinfo --keyfile /data/keys/agent-new.key
```

#### 2. Sign Transition Certificate (if using CA trust model)

```bash
# Using the old key, sign a transition certificate for the new key
./target/release/aafp-agent sign-transition \
  --old-key /data/keys/agent.key \
  --new-key /data/keys/agent-new.key
```

#### 3. Update Agent Configuration

```bash
# Stop the agent
sudo systemctl stop aafp-agent

# Swap keys
mv /data/keys/agent.key /data/keys/agent-old.key
mv /data/keys/agent-new.key /data/keys/agent.key

# Update the service file if keyfile path is specified
sudo systemctl edit aafp-agent
# Add: ExecStart=/usr/local/bin/aafp-agent serve --keyfile /data/keys/agent.key

# Start the agent
sudo systemctl start aafp-agent
```

#### 4. Verify

```bash
# Check agent health
./target/release/aafp-agent healthcheck

# Verify new AgentId
./target/release/aafp-agent keyinfo --keyfile /data/keys/agent.key

# Check that peers can connect
journalctl -u aafp-agent --since "5 minutes ago" | grep "handshake"
```

#### 5. Notify Peers

Send a revocation notice for the old key:

```bash
./target/release/aafp-agent revoke --key /data/keys/agent-old.key
```

#### 6. Archive Old Key

```bash
# Securely archive the old key (encrypted backup)
gpg --symmetric --output /backup/agent-old.key.gpg /data/keys/agent-old.key
shred -u /data/keys/agent-old.key
```

### Docker Key Rotation

```bash
# Generate new key
docker run --rm -v aafp-keys:/data/keys aafp-agent keygen --output /data/keys/agent-new.key

# Restart with new key
docker stop aafp-agent
docker run -d --name aafp-agent -v aafp-keys:/data/keys \
  -e AAFP_KEYFILE=/data/keys/agent-new.key aafp-agent
```

### Kubernetes Key Rotation

```bash
# Create new secret
kubectl create secret generic aafp-agent-key-new \
  --from-file=agent.key=/path/to/new-key

# Update deployment to use new secret
kubectl set volume deployment/aafp-agent \
  --secret-name=aafp-agent-key-new

# Restart pods
kubectl rollout restart deployment/aafp-agent
```

## Rolling Updates

### Procedure

Update agents one at a time to avoid service disruption.

#### 1. Build New Version

```bash
cd implementations/rust
git pull
cargo build --release -p aafp-cli
```

#### 2. Drain Connections (per agent)

```bash
# Stop accepting new connections
./target/release/aafp-agent drain

# Wait for active connections to close (with timeout)
./target/release/aafp-agent wait-drain --timeout 60s
```

#### 3. Update Binary

```bash
sudo systemctl stop aafp-agent
sudo cp target/release/aafp-agent /usr/local/bin/aafp-agent
sudo systemctl start aafp-agent
```

#### 4. Verify

```bash
# Health check
./target/release/aafp-agent healthcheck

# Check metrics
./target/release/aafp-agent metrics

# Verify connections are being accepted
journalctl -u aafp-agent --since "2 minutes ago" | grep "connection"
```

#### 5. Repeat for Next Agent

Wait at least 30 seconds between agent updates to allow DHT propagation.

### Docker Rolling Update

```bash
# Build new image
docker build -t aafp-agent:v2 .

# Update one container at a time
docker stop agent-1
docker run -d --name agent-1 ... aafp-agent:v2
# Verify, then continue with agent-2, agent-3, etc.
```

### Kubernetes Rolling Update

```bash
# Update image
kubectl set image deployment/aafp-agent aafp-agent=aafp-agent:v2

# Monitor rollout
kubectl rollout status deployment/aafp-agent

# Rollback if needed
kubectl rollout undo deployment/aafp-agent
```

## Scaling

### Adding More Agents

#### Docker

```bash
docker run -d --name agent-3 -p 4435:4433/udp \
  -e AAFP_CAPABILITIES=inference \
  -e AAFP_RELAY=quic://relay:4433 \
  aafp-agent
```

#### Kubernetes

```bash
kubectl scale deployment/aafp-agent --replicas=10
```

### Adding More Relays

Deploy relay nodes in different geographic regions:

```bash
# US relay
docker run -d --name relay-us -p 4433:4433/udp \
  -e AAFP_RELAY_MODE=true aafp-agent

# EU relay
docker run -d --name relay-eu -p 4433:4433/udp \
  -e AAFP_RELAY_MODE=true aafp-agent
```

Update agent configurations to include both relays:

```bash
-e AAFP_RELAY=quic://relay-us:4433,quic://relay-eu:4433
```

## Debugging Slow Agent

### Step 1: Check Metrics

```bash
./target/release/aafp-agent metrics
```

Look for:
- **High error rate** (>5%): Network issues or peer problems
- **Low connections** (0): Agent can't accept connections
- **High handshake failures** (>20%): Key issues or clock skew
- **High messages_sent but low messages_received**: Peers not responding

### Step 2: Check Logs

```bash
# systemd
journalctl -u aafp-agent --since "1 hour ago" | less

# Docker
docker logs aafp-agent --since 1h

# Kubernetes
kubectl logs -l app=aafp-agent --since=1h
```

Enable debug logging:

```bash
RUST_LOG=debug ./target/release/aafp-agent
# Or at runtime:
./target/release/aafp-agent log-level debug
```

### Step 3: Check CPU/Memory

```bash
# Process CPU and memory
top -p $(pgrep aafp-agent)

# Memory details
cat /proc/$(pgrep aafp-agent)/status | grep -E "VmRSS|VmSize|Threads"

# File descriptors
ls /proc/$(pgrep aafp-agent)/fd | wc -l

# Network connections
ss -u -a | grep :4433
```

### Step 4: Check Network

```bash
# Test QUIC connectivity to a peer
./target/release/aafp-agent ping quic://peer:4433

# Check for packet loss
ping -c 100 peer.example.com

# Check for UDP blocking
nc -u -z -v peer.example.com 4433
```

### Step 5: Check DHT

```bash
# List DHT records
./target/release/aafp-agent dht-list

# Check DHT size
./target/release/aafp-agent dht-size

# Lookup a specific agent
./target/release/aafp-agent dht-lookup <agent-id>
```

## Security Incident Response

### Key Compromise

If an agent's keypair has been compromised:

#### 1. Isolate the Agent

```bash
# Stop the agent immediately
sudo systemctl stop aafp-agent
# Or
docker stop aafp-agent
```

#### 2. Revoke the Key

```bash
# Generate revocation certificate
./target/release/aafp-agent revoke --key /data/keys/agent.key

# Broadcast revocation to all peers
./target/release/aafp-agent broadcast-revocation --key /data/keys/agent.key
```

#### 3. Generate New Keypair

Follow the [Key Rotation](#key-rotation) procedure above.

#### 4. Notify Peers

Send a revocation notice to all known peers. Peers should:
- Add the revoked AgentId to their revocation list
- Reject any connection attempts from the revoked identity
- Verify their own key integrity

#### 5. Audit Logs

```bash
# Check for unauthorized access
journalctl -u aafp-agent --since "24 hours ago" | grep -E "handshake|connection"
```

#### 6. Document the Incident

Record:
- When the compromise was detected
- Which agent was affected
- What data may have been exposed
- Actions taken

## Relay Management

### Deploying a Relay

```bash
# Binary
./target/release/aafp-agent serve --relay --bind 0.0.0.0:4433

# Docker
docker run -d -p 4433:4433/udp -e AAFP_RELAY_MODE=true aafp-agent
```

### Monitoring Relay Health

```bash
# Check relay connection count
./target/release/aafp-agent metrics | grep relay_connections

# Target: <1000 connections per relay
# If approaching limit, deploy additional relays
```

### Relay Maintenance

```bash
# Drain relay connections before maintenance
./target/release/aafp-agent drain --timeout 120s

# Agents will automatically failover to other configured relays
```

## DHT Maintenance

### Monitor DHT Health

```bash
# Check DHT record count
./target/release/aafp-agent dht-size

# Check for stale records (TTL expired)
./target/release/aafp-agent dht-check-stale
```

### Handle Churn

When many agents leave simultaneously:
- DHT records expire automatically (TTL-based)
- New lookups will not find departed agents
- No manual intervention needed

### Backup DHT

```bash
# Backup SQLite DHT database
cp /data/dht/records.db /backup/dht-$(date +%Y%m%d).db

# Restore
sudo systemctl stop aafp-agent
cp /backup/dht-20260704.db /data/dht/records.db
sudo systemctl start aafp-agent
```

## Backup and Recovery

### What to Backup

| Data | Location | Frequency | Retention |
|------|----------|-----------|-----------|
| Agent keypair | `/data/keys/agent.key` | On key rotation | 1 year |
| DHT database | `/data/dht/records.db` | Daily | 30 days |
| Configuration | Service file / env vars | On change | 90 days |
| Logs | journald / Docker logs | Continuous | 7 days |

### Backup Procedure

```bash
#!/bin/bash
# backup-aafp.sh
DATE=$(date +%Y%m%d)
BACKUP_DIR=/backup/aafp/$DATE

mkdir -p $BACKUP_DIR

# Backup keys (encrypted)
gpg --symmetric --output $BACKUP_DIR/agent.key.gpg /data/keys/agent.key

# Backup DHT
cp /data/dht/records.db $BACKUP_DIR/records.db

# Backup configuration
systemctl cat aafp-agent > $BACKUP_DIR/service.conf

# Compress
tar czf /backup/aafp-$DATE.tar.gz $BACKUP_DIR
rm -rf $BACKUP_DIR
```

### Recovery Procedure

```bash
# 1. Install binary
sudo cp aafp-agent /usr/local/bin/aafp-agent

# 2. Restore keys
gpg --decrypt /backup/agent.key.gpg > /data/keys/agent.key
chmod 600 /data/keys/agent.key

# 3. Restore DHT
cp /backup/records.db /data/dht/records.db

# 4. Restore configuration
sudo cp /backup/service.conf /etc/systemd/system/aafp-agent.service
sudo systemctl daemon-reload

# 5. Start agent
sudo systemctl start aafp-agent

# 6. Verify
./target/release/aafp-agent healthcheck
./target/release/aafp-agent metrics
```
