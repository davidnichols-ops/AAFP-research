# AAFP Troubleshooting Guide

Common issues and their solutions.

## Agent Can't Connect

### Symptom
Agent fails to connect to a peer. Error: "connection refused" or "timeout".

### Diagnosis

1. **Check if peer is running:**
   ```bash
   ./target/release/aafp-agent ping quic://peer:4433
   ```

2. **Check firewall rules:**
   ```bash
   # Local firewall
   sudo ufw status
   # Should allow 4433/udp

   # Remote firewall
   nc -u -z -v peer.example.com 4433
   ```

3. **Check NAT status:**
   ```bash
   ./target/release/aafp-agent nat-status
   # If "behind NAT", ensure relay is configured
   ```

4. **Check relay connectivity:**
   ```bash
   ./target/release/aafp-agent ping quic://relay:4433
   ```

### Solutions

- **Firewall blocking UDP 4433**: Open the port
  ```bash
  sudo ufw allow 4433/udp
  ```
- **Behind NAT**: Configure a relay
  ```bash
  ./target/release/aafp-agent serve --bootstrap-relays quic://relay:4433
  ```
- **Peer not running**: Start the peer agent
- **Wrong address**: Verify the peer's address with `aafp-agent keyinfo`

## High Latency

### Symptom
Message round-trip latency is higher than expected (>100ms on LAN).

### Diagnosis

1. **Check latency metrics:**
   ```bash
   ./target/release/aafp-agent metrics
   ```

2. **Check network latency:**
   ```bash
   ping -c 100 peer.example.com
   ```

3. **Check CPU usage:**
   ```bash
   top -p $(pgrep aafp-agent)
   ```

4. **Check for relay path (should be direct if possible):**
   ```bash
   ./target/release/aafp-agent connections --verbose
   ```

### Solutions

- **Relayed connection**: Enable DCuTR to upgrade to direct
  ```bash
  ./target/release/aafp-agent serve --dcutr
  ```
- **CPU bound**: Use low-latency runtime
  ```bash
  ./target/release/aafp-agent serve --low-latency
  ```
- **Network congestion**: Check for packet loss, use QoS
- **Too many connections**: Reduce max_connections_per_agent

## Memory Growth

### Symptom
Agent RSS memory is continuously growing over time.

### Diagnosis

1. **Monitor memory over time:**
   ```bash
   watch -n 60 'cat /proc/$(pgrep aafp-agent)/status | grep VmRSS'
   ```

2. **Check connection count:**
   ```bash
   ./target/release/aafp-agent metrics | grep connections
   ```

3. **Check for connection leaks:**
   ```bash
   # Connections should stabilize, not grow indefinitely
   ./target/release/aafp-agent connections --count
   ```

4. **Run stability test:**
   ```bash
   ./target/release/stability --duration 3600 --clients 10 --interval 60
   ```

### Solutions

- **Connection leak**: Ensure connections are properly closed after use
- **DHT growth**: Enable DHT record expiration
- **Known issue**: If memory growth is <10% over 4 hours, it's likely
  allocator caching, not a leak. See stability test results.
- **File descriptor leak**: Check FD count
  ```bash
  ls /proc/$(pgrep aafp-agent)/fd | wc -l
  # Should stabilize, not grow indefinitely
  ```

## Handshake Failures

### Symptom
High handshake failure rate (>5%). Error: "handshake failed".

### Diagnosis

1. **Check handshake metrics:**
   ```bash
   ./target/release/aafp-agent metrics | grep handshake
   ```

2. **Check key validity:**
   ```bash
   ./target/release/aafp-agent keyinfo --keyfile /data/keys/agent.key
   ```

3. **Check clock skew:**
   ```bash
   # AAFP requires clocks within 300s of each other
   ntpdate -q peer.example.com
   ```

4. **Check replay cache:**
   ```bash
   ./target/release/aafp-agent replay-cache --stats
   ```

### Solutions

- **Expired key**: Rotate keys (see OPERATIONS.md)
- **Clock skew**: Sync clocks with NTP
  ```bash
  sudo ntpdate pool.ntp.org
  ```
- **Replay cache full**: Clear old entries
  ```bash
  ./target/release/aafp-agent replay-cache --clear-expired
  ```
- **PQ KEX mismatch**: Ensure both agents use same PQ setting
- **Trust model mismatch**: Ensure both agents use compatible trust policies

## DHT Lookup Fails

### Symptom
DHT lookup returns no results or stale data.

### Diagnosis

1. **Check DHT size:**
   ```bash
   ./target/release/aafp-agent dht-size
   ```

2. **Check bootstrap connectivity:**
   ```bash
   ./target/release/aafp-agent ping quic://seed:4433
   ```

3. **Check for stale records:**
   ```bash
   ./target/release/aafp-agent dht-check-stale
   ```

4. **Check record TTL:**
   ```bash
   ./target/release/aafp-agent dht-info <agent-id>
   ```

### Solutions

- **No seed nodes**: Configure seed nodes
  ```bash
  ./target/release/aafp-agent serve --seeds quic://seed1:4433,quic://seed2:4433
  ```
- **Stale records**: Wait for TTL expiration or manually clean
- **DHT partition**: Ensure network connectivity between agents
- **Record not announced**: Verify the target agent has announced itself
  ```bash
  # On the target agent:
  ./target/release/aafp-agent announce
  ```

## Agent Crashes

### Symptom
Agent process exits unexpectedly.

### Diagnosis

1. **Check logs:**
   ```bash
   journalctl -u aafp-agent --since "10 minutes ago" --no-pager
   ```

2. **Check core dump:**
   ```bash
   ls /var/lib/systemd/coredump/ | grep aafp
   ```

3. **Check resource limits:**
   ```bash
   systemctl show aafp-agent | grep -E "Memory|CPU|Limit"
   ```

### Solutions

- **OOM**: Increase memory limit or reduce connections
  ```bash
  sudo systemctl edit aafp-agent
  # Set MemoryMax=1G
  ```
- **FD limit**: Increase file descriptor limit
  ```bash
  # In service file:
  LimitNOFILE=65536
  ```
- **Panic**: Check for known bugs, update to latest version
- **Stack overflow**: Increase stack size
  ```bash
  # In service file:
  LimitSTACK=infinity
  ```

## Relay Not Forwarding

### Symptom
Relay node is running but connections through relay fail.

### Diagnosis

1. **Check relay mode:**
   ```bash
   ./target/release/aafp-agent config | grep relay
  ```

2. **Check relay connections:**
   ```bash
   ./target/release/aafp-agent metrics | grep relay
  ```

3. **Check relay logs:**
   ```bash
  journalctl -u aafp-relay --since "10 minutes ago" | grep -E "forward|relay"
  ```

### Solutions

- **Not in relay mode**: Enable relay mode
  ```bash
  ./target/release/aafp-agent serve --relay
  ```
- **Max connections reached**: Increase limit or deploy more relays
- **Firewall**: Ensure relay can reach both agents

## DCuTR Hole Punching Fails

### Symptom
Relayed connection doesn't upgrade to direct.

### Diagnosis

1. **Check DCuTR status:**
   ```bash
   ./target/release/aafp-agent dcutr-status
   ```

2. **Check NAT type:**
   ```bash
   ./target/release/aafp-agent nat-status
   # Symmetric NAT cannot be hole-punched
   ```

3. **Check both agents support DCuTR:**
   ```bash
   # On both agents:
   ./target/release/aafp-agent config | grep dcutr
   ```

### Solutions

- **Symmetric NAT**: Use relay (hole punching not possible)
- **DCuTR disabled**: Enable on both agents
  ```bash
  ./target/release/aafp-agent serve --dcutr
  ```
- **Firewall blocks simultaneous open**: Allow UDP from any source port
  ```bash
  sudo ufw allow from any to any port 4433 proto udp
  ```

## Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `connection refused` | Peer not running or firewall | Start peer, open port |
| `handshake timeout` | Network latency or clock skew | Check network, sync NTP |
| `session expired` | Keep-alive missed | Check keep-alive config |
| `frame too large` | Message > 1MB limit | Split into smaller messages |
| `replay detected` | Duplicate nonce | Check for network duplicates |
| `trust denied` | Peer not trusted | Check trust policy, add to WoT |
| `DHT not found` | No records in DHT | Check bootstrap, announce |
| `relay unavailable` | No relay configured or down | Configure relay |
