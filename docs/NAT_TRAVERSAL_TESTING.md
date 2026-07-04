# Two-Machine Relay Test Guide (Track N7)

This document describes how to test the AAFP NAT traversal stack across
two real machines on different networks. The in-process tests (Track N6)
validate the protocol logic on localhost; this guide covers real-world
validation across NAT boundaries.

## Status

**Deferred.** The protocol implementation is complete and tested via
the N6 test harness (8 scenarios, all passing). Real two-machine testing
requires physical or virtual network infrastructure and is deferred until
deployment.

## Prerequisites

- Two machines on different networks (e.g., one on home WiFi, one on
  cellular hotspot, or two VMs in different cloud regions)
- Rust toolchain on both machines
- The AAFP Rust implementation built (`cargo build --release`)
- Network connectivity: at least one machine must be reachable from
  the other (or both behind NAT with a third relay machine)

## Test Scenarios

### Scenario A: Relay on public machine, agents behind NAT

```
Machine 1 (relay, public IP)    Machine 2 (agent A, NAT)    Machine 3 (agent B, NAT)
     |                               |                            |
     | <---- QUIC ---->              |                            |
     | <---- QUIC -----------------> |                            |
     |          (A connects to relay, reserves)                    |
     |                               |                            |
     | <---- QUIC ----------------------------------------->      |
     |          (B connects to relay, connects to A)              |
     |                                                            |
     | A <-- relay forwarding --> B                               |
```

1. Start relay on Machine 1:
   ```bash
   ./target/release/aafp-cli relay --bind 0.0.0.0:4433
   ```

2. Start agent A on Machine 2 (behind NAT):
   ```bash
   ./target/release/aafp-cli agent \
     --relay quic://<machine1-ip>:4433 \
     --capability inference
   ```
   Agent A connects to the relay and reserves.

3. Start agent B on Machine 3 (behind NAT):
   ```bash
   ./target/release/aafp-cli agent \
     --relay quic://<machine1-ip>:4433 \
     --capability training
   ```
   Agent B connects to the relay and connects to A through it.

4. Verify data flows: A and B should be able to exchange messages
   through the relay.

### Scenario B: DCuTR hole punching

After a relayed connection is established, both agents attempt a direct
connection via simultaneous open (hole punching). This works for cone
NAT types but not symmetric NAT.

1. Follow steps 1-3 from Scenario A.
2. After the relayed connection is established, the agents exchange
   coordinate messages (observed addresses) via the relay.
3. Both agents attempt to dial each other simultaneously.
4. If successful, the relayed connection is upgraded to a direct
   connection. If not, the relayed connection continues.

### Scenario C: AutoNAT dial-back

1. Agent A advertises its address to peers.
2. Peers attempt to dial A back at the advertised address.
3. If peers can reach A, A is public. If not, A is behind NAT.
4. If behind NAT, A requests a relay reservation.

## Metrics to Collect

- **Relay latency**: Round-trip time for data through relay vs direct.
- **Relay throughput**: Bytes/sec through relay (target: >10 MB/s).
- **Hole punch success rate**: Percentage of successful DCuTR upgrades.
- **Connection setup time**: Time from connect RPC to first data byte.
- **Relay capacity**: Max concurrent relayed connections before degradation.

## Known Limitations

1. **Symmetric NAT**: DCuTR hole punching does not work for symmetric
   NAT. The relayed connection continues.
2. **QUIC connection migration**: If an agent's local address changes
   (e.g., WiFi to cellular), the QUIC connection may break. The agent
   must re-establish the relayed connection.
3. **Relay capacity**: A single relay has configurable limits (default:
   100 reservations, 50 connections, 1 hour max duration).
4. **TLS identity**: The current implementation uses self-signed
   certificates. Production deployments should use proper PKI (Track P).

## Running the Tests

### Build

```bash
cd implementations/rust
cargo build --release
```

### Start relay

```bash
./target/release/aafp-cli relay --bind 0.0.0.0:4433
```

### Start agent (behind NAT)

```bash
./target/release/aafp-cli agent \
  --relay quic://<relay-ip>:4433 \
  --capability inference \
  --name "agent-behind-nat"
```

### Start agent (caller)

```bash
./target/release/aafp-cli agent \
  --relay quic://<relay-ip>:4433 \
  --capability training \
  --name "caller-agent" \
  --connect <target-agent-id>
```

### Verify

- Check relay logs for reservation and connection events.
- Check agent logs for data forwarding.
- Use `aafp-cli status` to see NAT status and relay connections.

## Troubleshooting

- **Connection refused**: Check firewall rules on the relay machine.
  QUIC uses UDP, so ensure port 4433 is open.
- **Hole punch failure**: If both agents are behind symmetric NAT,
  hole punching will not work. Use the relayed connection.
- **High latency**: Relay adds one hop. For latency-sensitive
  applications, prefer direct connections when possible.
- **Relay at capacity**: Increase `max_reservations` and
  `max_connections` in the relay config.
