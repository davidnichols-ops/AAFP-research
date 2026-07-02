# Plan E1: PING/PONG Keep-Alive (RFC-0002 §4.7-4.8)

**Priority:** HIGH (P1-1, required before public release)
**Track:** E (Protocol Features)
**Estimated effort:** 4-6 hours
**Blocked by:** nothing
**Blocks:** E2 (discovery needs keep-alive for long-lived connections)

---

## Objective

Implement application-layer PING/PONG keep-alive per RFC-0002 §4.7-4.8.
This prevents idle QUIC connections from dying silently when NAT mappings
expire, and provides application-layer liveness checks.

**Current state:** Frame types 0x07 (PING) and 0x08 (PONG) are defined in
`aafp-messaging/src/framing.rs` (encoding/decoding works), but there is no
keep-alive logic — no periodic PING sending, no PONG response handling, no
timeout on missed PONGs.

**Source:** ROADMAP.md P1-1, RFC-0002 §4.7-4.8

---

## RFC Requirements (read RFC-0002 §4.7-4.8 before starting)

1. PING frame (0x07): application-layer keepalive probe
2. PONG frame (0x08): response to PING, MUST be sent on same stream
3. PING MAY be sent on any open stream, including stream 0
4. Sending PING on stream 0 is RECOMMENDED for connection-level keepalive
5. PING/PONG are distinct from QUIC's keepalive (application-layer)
6. PONG payload SHOULD echo PING payload (if any)
7. Outstanding PING: a PING that has not received a PONG
8. If PONG not received within timeout → connection considered dead

---

## Prerequisites

- Working directory: `/Users/david/projects/AAFP-research/implementations/rust`
- Read `crates/aafp-messaging/src/framing.rs` (PING/PONG frame types)
- Read `crates/aafp-sdk/src/` (PeerConnection, AgentClient, AgentServer)
- Read `RFCs/0002-transport-framing.md` §4.7, §4.8, §6 (state machine)

---

## Steps

### E1.1: Create keep-alive module

Create `crates/aafp-messaging/src/keepalive.rs`:

```rust
//! PING/PONG keep-alive (RFC-0002 §4.7-4.8).
//!
//! Provides application-layer liveness checks for AAFP connections.
//! Periodic PING frames are sent on stream 0; PONG responses are
//! expected within a configurable timeout. Missed PONGs trigger
//! connection close.

use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use aafp_identity::AgentId;

/// Configuration for keep-alive behavior.
#[derive(Clone, Debug)]
pub struct KeepAliveConfig {
    /// Interval between PING frames (default: 30 seconds).
    pub interval: Duration,
    /// Timeout for PONG response (default: 10 seconds).
    pub timeout: Duration,
    /// Maximum consecutive missed PONGs before closing (default: 3).
    pub max_missed: u32,
}

impl Default for KeepAliveConfig {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(30),
            timeout: Duration::from_secs(10),
            max_missed: 3,
        }
    }
}

/// Tracks outstanding PING frames for a connection.
pub struct PingTracker {
    config: KeepAliveConfig,
    /// Outstanding PINGs: ping_id → sent timestamp
    outstanding: HashMap<u64, Instant>,
    /// Consecutive missed PONGs
    missed_count: u32,
    /// Next ping ID to use
    next_id: u64,
}

impl PingTracker {
    pub fn new(config: KeepAliveConfig) -> Self {
        Self {
            config,
            outstanding: HashMap::new(),
            missed_count: 0,
            next_id: 1,
        }
    }

    /// Record a sent PING. Returns the ping ID.
    pub fn record_ping(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.outstanding.insert(id, Instant::now());
        id
    }

    /// Record a received PONG. Returns true if the PONG matched an outstanding PING.
    pub fn record_pong(&mut self, ping_id: u64) -> bool {
        if self.outstanding.remove(&ping_id).is_some() {
            self.missed_count = 0;
            true
        } else {
            false
        }
    }

    /// Check for timed-out PINGs. Returns true if the connection should be closed.
    pub fn check_timeouts(&mut self) -> bool {
        let now = Instant::now();
        let timed_out: Vec<u64> = self.outstanding
            .iter()
            .filter(|(_, sent)| now.duration_since(**sent) > self.config.timeout)
            .map(|(id, _)| *id)
            .collect();

        for id in timed_out {
            self.outstanding.remove(&id);
            self.missed_count += 1;
        }

        self.missed_count >= self.config.max_missed
    }

    /// Check if it's time to send the next PING.
    pub fn should_ping(&self) -> bool {
        self.outstanding.is_empty()
    }
}
```

### E1.2: Add module to aafp-messaging

Edit `crates/aafp-messaging/src/lib.rs`:
```rust
pub mod keepalive;
pub use keepalive::{KeepAliveConfig, PingTracker};
```

### E1.3: Implement PING/PONG frame handling in SDK

Edit `crates/aafp-sdk/src/` to add:

1. **PONG response on receiving PING:** When the SDK receives a PING frame
   on any stream, it MUST immediately send a PONG frame on the same stream
   with the same payload.

2. **Periodic PING sending:** A background task that sends PING frames on
   stream 0 at the configured interval.

3. **PONG tracking:** When a PONG is received, match it to an outstanding
   PING and update the PingTracker.

4. **Timeout handling:** If `check_timeouts()` returns true, close the
   connection with an ERROR frame (code 2010 or similar — check RFC-0005
   for the appropriate error code).

The implementation should be in `PeerConnection` or a new `KeepAliveManager`
struct that `PeerConnection` holds.

### E1.4: Add keep-alive configuration to AgentBuilder

Edit `crates/aafp-sdk/src/agent.rs` (or wherever AgentBuilder is):

```rust
impl AgentBuilder {
    pub fn with_keepalive(mut self, config: KeepAliveConfig) -> Self {
        self.keepalive_config = Some(config);
        self
    }
}
```

Default: keep-alive enabled with `KeepAliveConfig::default()`.
Can be disabled with `.with_keepalive(KeepAliveConfig { interval: Duration::MAX, .. })`
or a `.disable_keepalive()` method.

### E1.5: Write tests

Create `crates/aafp-messaging/src/keepalive.rs` tests (in the same file):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ping_pong_cycle() {
        let mut tracker = PingTracker::new(KeepAliveConfig::default());
        let id = tracker.record_ping();
        assert!(tracker.should_ping() == false); // outstanding ping
        assert!(tracker.record_pong(id)); // matched
        assert!(tracker.should_ping() == true); // no outstanding
    }

    #[test]
    fn test_timeout_detection() {
        let config = KeepAliveConfig {
            timeout: Duration::from_millis(1),
            max_missed: 2,
            ..Default::default()
        };
        let mut tracker = PingTracker::new(config);
        tracker.record_ping();
        std::thread::sleep(Duration::from_millis(10));
        assert!(!tracker.check_timeouts()); // 1 missed, not enough
        tracker.record_ping();
        std::thread::sleep(Duration::from_millis(10));
        assert!(tracker.check_timeouts()); // 2 missed, close
    }

    #[test]
    fn test_unsolicited_pong() {
        let mut tracker = PingTracker::new(KeepAliveConfig::default());
        assert!(!tracker.record_pong(999)); // no matching ping
    }
}
```

Create integration test `crates/aafp-tests/tests/keepalive.rs`:

```rust
#[tokio::test]
async fn test_ping_pong_over_quic() {
    // 1. Start server agent with short keep-alive interval
    // 2. Connect client agent
    // 3. Wait for PING to be sent and PONG received
    // 4. Verify connection stays alive
}

#[tokio::test]
async fn test_connection_dies_on_missed_pong() {
    // 1. Start server with very short timeout
    // 2. Connect client but don't respond to PINGs
    //    (may need a way to suppress PONG responses for testing)
    // 3. Verify connection is closed after max_missed PINGs
}
```

### E1.6: Update RFC-0002 implementation status

Edit `RFCs/0002-transport-framing.md` — if there's an implementation
status section, update PING/PONG from "defined" to "implemented".

### E1.7: Commit

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add -A
git commit -m "$(cat <<'EOF'
feat: implement PING/PONG keep-alive (RFC-0002 §4.7-4.8, P1-1)

Adds application-layer keep-alive for AAFP connections:
- PingTracker tracks outstanding PINGs and detects missed PONGs
- SDK sends periodic PING on stream 0 and responds to PING with PONG
- Configurable interval (default 30s), timeout (default 10s), max_missed (default 3)
- Connection closed with ERROR frame after max_missed consecutive timeouts
- AgentBuilder.with_keepalive() for custom configuration

Closes ROADMAP.md P1-1.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

Update umbrella:
```bash
cd /Users/david/projects/AAFP-research
git add implementations/rust
git commit -m "feat: PING/PONG keep-alive implemented (P1-1)"
```

---

## Verification

### E1.8: Unit tests pass

```bash
cargo test -p aafp-messaging keepalive -v
```

### E1.9: Integration tests pass

```bash
cargo test --test keepalive -v
```

### E1.10: Full workspace tests pass

```bash
cargo test --workspace
```
**Expected:** All tests pass (existing + new keep-alive tests).

### E1.11: Clippy clean

```bash
cargo clippy --workspace -- -D warnings
```

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark E1.1 through E1.11 as `[x]`
- Set E1 status to `COMPLETE`
