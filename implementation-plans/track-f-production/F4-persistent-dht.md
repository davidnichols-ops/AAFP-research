# Plan F4: Persistent DHT Backend (LevelDB or SQLite)

**Priority:** MEDIUM (outstanding item from PROTOCOL_CANDIDATE_CHECKLIST.md)
**Track:** F (Production Readiness)
**Estimated effort:** 6-8 hours
**Blocked by:** E2 (discovery over QUIC must be implemented first)
**Blocks:** nothing

---

## Objective

Replace the in-memory capability DHT with a persistent backend so
AgentRecords survive process restarts. This implements the "Persistent/
networked DHT: NOT IMPLEMENTED" outstanding item from
PROTOCOL_CANDIDATE_CHECKLIST.md.

**Current state:** `aafp-discovery/src/capability_dht.rs` is an in-memory
`HashMap`. Records are lost when the process exits.

**Source:** PROTOCOL_CANDIDATE_CHECKLIST.md, ROADMAP.md long-term extension #2

---

## Design

### Backend choice: SQLite

SQLite is preferred over LevelDB because:
1. Rust has excellent SQLite bindings (`rusqlite` crate)
2. SQLite is ubiquitous and well-understood
3. Better for structured queries (lookup by capability, expiry, etc.)
4. No external native library issues (SQLite is bundled with `libsqlite3-sys`)

### Schema

```sql
CREATE TABLE agent_records (
    agent_id BLOB PRIMARY KEY,      -- 32 bytes
    cbor_data BLOB NOT NULL,        -- Full AgentRecord as CBOR
    capabilities TEXT NOT NULL,     -- Comma-separated capability names (for lookup)
    expires_at INTEGER NOT NULL,    -- Unix timestamp
    updated_at INTEGER NOT NULL     -- Unix timestamp
);

CREATE INDEX idx_capabilities ON agent_records(capabilities);
CREATE INDEX idx_expires_at ON agent_records(expires_at);
```

### API

The `CapabilityDht` trait stays the same. Add a `PersistentCapabilityDht`
implementation that backs the same API with SQLite:

```rust
pub trait CapabilityDht: Send + Sync {
    fn insert(&mut self, record: AgentRecord) -> Result<()>;
    fn lookup(&self, capability: &str) -> Vec<AgentRecord>;
    fn remove(&mut self, agent_id: &AgentId);
    fn evict_expired(&mut self);
}
```

---

## Prerequisites

- E2 complete (discovery over QUIC)
- Read `crates/aafp-discovery/src/capability_dht.rs` (current in-memory impl)
- Read `crates/aafp-discovery/src/discovery_v1.rs`

---

## Steps

### F4.1: Add rusqlite dependency

Edit `crates/aafp-discovery/Cargo.toml`:
```toml
[dependencies]
rusqlite = { version = "0.31", features = ["bundled"] }
```

**Note:** Check the latest `rusqlite` version. Use `bundled` feature to
avoid system SQLite dependency issues. Verify the version is >7 days old.

### F4.2: Create trait for DHT backends

Edit `crates/aafp-discovery/src/capability_dht.rs`:

```rust
/// Trait for capability DHT backends.
pub trait CapabilityDhtBackend: Send + Sync {
    fn insert(&mut self, record: &AgentRecord) -> Result<(), DhtError>;
    fn lookup(&self, capability: &str) -> Result<Vec<AgentRecord>, DhtError>;
    fn remove(&mut self, agent_id: &AgentId) -> Result<(), DhtError>;
    fn evict_expired(&mut self) -> Result<(), DhtError>;
    fn count(&self) -> Result<usize, DhtError>;
}

/// In-memory DHT backend (existing implementation, now implements trait).
pub struct InMemoryDht { ... }

impl CapabilityDhtBackend for InMemoryDht { ... }
```

### F4.3: Implement SQLite backend

Create `crates/aafp-discovery/src/persistent_dht.rs`:

```rust
//! Persistent capability DHT backed by SQLite.
//!
//! AgentRecords are stored in a SQLite database and survive
//! process restarts.

use rusqlite::{Connection, params};
use aafp_identity::{AgentId, AgentRecord};
use crate::capability_dht::{CapabilityDhtBackend, DhtError};

pub struct PersistentDht {
    conn: Connection,
}

impl PersistentDht {
    pub fn open(path: &str) -> Result<Self, DhtError> {
        let conn = Connection::open(path)?;
        conn.execute_batch(r#"
            CREATE TABLE IF NOT EXISTS agent_records (
                agent_id BLOB PRIMARY KEY,
                cbor_data BLOB NOT NULL,
                capabilities TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_capabilities ON agent_records(capabilities);
            CREATE INDEX IF NOT EXISTS idx_expires_at ON agent_records(expires_at);
        "#)?;
        Ok(Self { conn })
    }

    pub fn in_memory() -> Result<Self, DhtError> {
        let conn = Connection::open_in_memory()?;
        // Same schema setup
        Ok(Self { conn })
    }
}

impl CapabilityDhtBackend for PersistentDht {
    fn insert(&mut self, record: &AgentRecord) -> Result<(), DhtError> {
        let cbor = record.to_cbor();
        let caps: Vec<String> = record.capabilities.iter()
            .map(|c| c.name.clone())
            .collect();
        let caps_str = caps.join(",");
        let expires = record.expires_at;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        self.conn.execute(
            "INSERT OR REPLACE INTO agent_records (agent_id, cbor_data, capabilities, expires_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![record.agent_id.as_slice(), cbor, caps_str, expires, now],
        )?;
        Ok(())
    }

    fn lookup(&self, capability: &str) -> Result<Vec<AgentRecord>, DhtError> {
        let mut stmt = self.conn.prepare(
            "SELECT cbor_data FROM agent_records WHERE capabilities LIKE ?1 AND expires_at > ?2"
        )?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let pattern = format!("%{}%", capability);
        let rows = stmt.query_map(params![pattern, now], |row| {
            let cbor: Vec<u8> = row.get(0)?;
            AgentRecord::from_cbor(&cbor)
                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, Box::new(e)))
        })?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }

    fn remove(&mut self, agent_id: &AgentId) -> Result<(), DhtError> {
        self.conn.execute(
            "DELETE FROM agent_records WHERE agent_id = ?1",
            params![agent_id.as_slice()],
        )?;
        Ok(())
    }

    fn evict_expired(&mut self) -> Result<(), DhtError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        self.conn.execute(
            "DELETE FROM agent_records WHERE expires_at < ?1",
            params![now],
        )?;
        Ok(())
    }

    fn count(&self) -> Result<usize, DhtError> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM agent_records", [], |row| row.get(0)
        )?;
        Ok(count as usize)
    }
}
```

### F4.4: Make CapabilityDht generic over backend

Edit `crates/aafp-discovery/src/capability_dht.rs`:

```rust
pub struct CapabilityDht {
    backend: Box<dyn CapabilityDhtBackend>,
}

impl CapabilityDht {
    pub fn new_in_memory() -> Self {
        Self { backend: Box::new(InMemoryDht::new()) }
    }

    pub fn new_persistent(path: &str) -> Result<Self, DhtError> {
        Ok(Self { backend: Box::new(PersistentDht::open(path)?) })
    }

    pub fn insert(&mut self, record: AgentRecord) -> Result<(), DhtError> {
        self.backend.insert(&record)
    }

    pub fn lookup(&self, capability: &str) -> Result<Vec<AgentRecord>, DhtError> {
        self.backend.lookup(capability)
    }
    // ... etc
}
```

### F4.5: Add DhtError type

```rust
#[derive(Debug, thiserror::Error)]
pub enum DhtError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("CBOR error: {0}")]
    Cbor(String),
    #[error("Record not found")]
    NotFound,
    #[error("Record expired")]
    Expired,
}
```

### F4.6: Write tests

```rust
#[test]
fn test_persistent_dht_insert_and_lookup() {
    let mut dht = PersistentDht::in_memory().unwrap();
    let record = AgentRecord::new(/* ... */);
    dht.insert(&record).unwrap();
    let results = dht.lookup("test-capability").unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn test_persistent_dht_survives_reopen() {
    let path = "/tmp/aafp_test_dht.sqlite";
    std::fs::remove_file(path).ok(); // clean up from previous run

    // Insert
    {
        let mut dht = PersistentDht::open(path).unwrap();
        let record = AgentRecord::new(/* ... */);
        dht.insert(&record).unwrap();
    }

    // Reopen and verify
    {
        let dht = PersistentDht::open(path).unwrap();
        let results = dht.lookup("test-capability").unwrap();
        assert_eq!(results.len(), 1);
    }

    std::fs::remove_file(path).ok();
}

#[test]
fn test_persistent_dht_eviction() {
    let mut dht = PersistentDht::in_memory().unwrap();
    // Insert a record that's already expired
    let mut record = AgentRecord::new(/* ... */);
    record.expires_at = 1; // expired in 1970
    dht.insert(&record).unwrap();
    dht.evict_expired().unwrap();
    assert_eq!(dht.count().unwrap(), 0);
}
```

### F4.7: Update AgentBuilder to support persistent DHT

```rust
impl AgentBuilder {
    pub fn with_persistent_dht(mut self, path: &str) -> Self {
        self.dht_path = Some(path.to_string());
        self
    }
}
```

### F4.8: Commit

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add -A
git commit -m "$(cat <<'EOF'
feat: persistent DHT backend with SQLite (outstanding item)

Replaces the in-memory-only capability DHT with a pluggable backend:
- CapabilityDhtBackend trait: abstract interface for DHT backends
- InMemoryDht: existing in-memory implementation (now implements trait)
- PersistentDht: SQLite-backed implementation that survives restarts
- AgentBuilder.with_persistent_dht(path) for configuration
- Records stored in SQLite with indexes on capabilities and expiry
- Automatic eviction of expired records

Closes PROTOCOL_CANDIDATE_CHECKLIST.md outstanding item: "Persistent/networked DHT".

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

---

## Verification

### F4.9: Tests pass

```bash
cargo test -p aafp-discovery -v
cargo test --workspace
```

### F4.10: Clippy clean

```bash
cargo clippy --workspace -- -D warnings
```

### F4.11: Persistence verified

The `test_persistent_dht_survives_reopen` test proves records survive
across database reopens.

---

## Risks & Mitigations

1. **SQLite concurrency:** SQLite has limited write concurrency (one writer
   at a time). **Mitigation:** Use WAL mode (`PRAGMA journal_mode=WAL`)
   for better read concurrency. For high-write scenarios, batch inserts.

2. **Database file corruption:** If the process crashes during a write,
   the database could be corrupted. **Mitigation:** SQLite is ACID-
   compliant — writes are atomic. Use `PRAGMA synchronous=NORMAL` for
   a good balance of safety and performance.

3. **`rusqlite` version compatibility:** Check that the `rusqlite` version
   works with the system's SQLite (or use `bundled` feature to avoid
   system dependency).

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark F4.1 through F4.11 as `[x]`
- Set F4 status to `COMPLETE`
