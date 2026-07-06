# AAFP CLI & Tooling Roadmap

> **Status:** Design / Roadmap
> **Target crate:** `aafp-cli` (`implementations/rust/crates/aafp-cli/`)
> **Current version:** 0.1.0
> **Goal:** Evolve the AAFP CLI from a minimal agent-management tool into a
> full-featured developer platform that covers the entire agent lifecycle:
> scaffold → develop → test → benchmark → trace → debug → publish → operate.

---

## Table of Contents

1. [Current State](#1-current-state)
2. [Design Principles](#2-design-principles)
3. [Proposed Command Tree](#3-proposed-command-tree)
4. [Existing Commands (Reference)](#4-existing-commands-reference)
5. [New Commands](#5-new-commands)
   - 5.1 [`aafp init` — Project Scaffolding](#51-aafp-init--project-scaffolding)
   - 5.2 [`aafp dev` — Development Server](#52-aafp-dev--development-server)
   - 5.3 [`aafp test` — Conformance Testing](#53-aafp-test--conformance-testing)
   - 5.4 [`aafp bench` — Benchmarking](#54-aafp-bench--benchmarking)
   - 5.5 [`aafp trace` — Frame Capture](#55-aafp-trace--frame-capture)
   - 5.6 [`aafp replay` — Trace Replay](#56-aafp-replay--trace-replay)
   - 5.7 [`aafp inspect` — Live Frame Inspector](#57-aafp-inspect--live-frame-inspector)
   - 5.8 [`aafp topology` — Network Graph](#58-aafp-topology--network-graph-visualization)
   - 5.9 [`aafp discover` — Capability Search](#59-aafp-discover--capability-search)
   - 5.10 [`aafp publish` — Registry Publishing](#510-aafp-publish--registry-publishing)
   - 5.11 [`aafp relay` — Relay Node](#511-aafp-relay--relay-node)
   - 5.12 [`aafp keygen` — Key Generation](#512-aafp-keygen--key-generation)
   - 5.13 [`aafp certify` — UCAN Delegations](#513-aafp-certify--ucan-capability-delegations)
   - 5.14 [`aafp verify` — Identity Verification](#514-aafp-verify--identity--capability-verification)
6. [Shell Completions](#6-shell-completions)
7. [Configuration File](#7-configuration-file)
8. [Plugin System](#8-plugin-system)
9. [TUI Dashboard](#9-tui-dashboard)
10. [Global Flags & Environment](#10-global-flags--environment)
11. [Implementation Phases](#11-implementation-phases)
12. [Appendix: Full `clap` Definition](#12-appendix-full-clap-definition)

---

## 1. Current State

The `aafp-cli` crate (`src/main.rs`, 181 lines) currently defines 13
subcommands via a single `clap`-derived `Commands` enum. Each command is
implemented in its own module under `src/commands/`. The CLI uses
`colored` for terminal output, `tokio` for async runtime, and
`tracing-subscriber` for logging.

### Current command inventory

| Command | Module | Purpose |
|---------|--------|---------|
| `init` | `init.rs` (23 lines) | Generate ML-DSA-65 keypair, save to file |
| `start` | `start.rs` | Start an agent node with seeds |
| `discover` | `discover.rs` (36 lines) | Find agents by capability via DHT |
| `connect` | `connect.rs` | Connect to a specific peer address |
| `send` | `send.rs` | Send a one-shot message to a peer |
| `status` | `status.rs` (35 lines) | Show identity file details + keypair verification |
| `relay` | `relay.rs` (36 lines) | Start a relay node |
| `serve` | `serve.rs` (73 lines) | One-command agent server with echo handler |
| `call` | `call.rs` (77 lines) | Call an agent by capability (discovery or direct) |
| `peers` | `peers.rs` (48 lines) | List discovered peers in a table |
| `metrics` | `metrics.rs` (59 lines) | Display agent metrics (connections, messages, bytes) |
| `health` | `health.rs` (24 lines) | Health check with exit code |
| `quickstart` | `quickstart.rs` (111 lines) | Interactive 3-step wizard |

### Current limitations

1. **No project scaffolding** — `init` only generates a raw keypair file;
   it does not create a project directory, `Cargo.toml`, handler stubs, or
   configuration.
2. **No development workflow** — no hot reload, no file watching, no
   integrated test runner.
3. **No observability tooling** — no frame capture, trace replay, or live
   inspector. Developers must read raw logs.
4. **No conformance integration** — the `aafp-conformance` crate exists
   but is not wired into the CLI.
5. **No benchmarking interface** — the `aafp-benchmark` crate uses
   Criterion but has no CLI entry point.
6. **No registry/publishing** — agents cannot be announced to a central
   registry for discovery.
7. **No shell completions** — no `clap_complete` integration.
8. **No config file** — all settings are CLI flags or env vars; no
   `.aafp/config.toml`.
9. **No plugin system** — cannot extend the CLI with custom subcommands.
10. **No TUI** — all output is one-shot text; no live dashboard.
11. **Identity commands are minimal** — `init` generates keys but there is
    no `keygen`, `certify` (UCAN delegation), or `verify` command.

---

## 2. Design Principles

1. **Progressive disclosure.** New users run `aafp quickstart` and get a
   working agent. Power users discover `aafp dev`, `aafp trace`, `aafp
   bench` through `--help` and documentation.
2. **Consistent flag vocabulary.** `--identity` always means the keypair
   file path. `--bind` always means a socket address. `--json` always
   switches to machine-readable output.
3. **Machine-readable output everywhere.** Every command supports
   `--json` for scripting and piping. Human output uses `colored`.
4. **Composable.** Commands pipe into each other: `aafp trace --json |
   aafp replay --stdin`. `aafp discover --json | jq`.
5. **Zero-config defaults.** Every command works with no arguments using
   sensible defaults (identity in `.aafp/identity.bin`, bind on
   `127.0.0.1`, etc.).
6. **Exit codes matter.** `0` = success, `1` = runtime error,
   `2` = unhealthy, `3` = conformance failure, `10+` = protocol error.
7. **Offline-first.** Commands that don't need the network (keygen,
   certify, verify, replay) work without any connectivity.

---

## 3. Proposed Command Tree

```
aafp
├── quickstart          # [existing] Interactive wizard
├── init                # [enhanced] Scaffold agent project (Rust/Python/TS)
├── dev                 # [new] Development server with hot reload
├── serve               # [existing] Production agent server
├── call                # [existing] Call an agent by capability
├── discover            # [existing→enhanced] Search agents by capability
├── peers               # [existing] List discovered peers
├── metrics             # [existing] Show agent metrics
├── health              # [existing] Health check
├── status              # [existing] Show identity status
├── test                # [new] Run conformance tests
├── bench               # [new] Benchmark agent performance
├── trace               # [new] Capture and display frames
├── replay              # [new] Replay captured traces
├── inspect             # [new] Live frame inspector
├── topology            # [new] Network graph visualization
├── publish             # [new] Publish agent to registry
├── relay               # [existing] Run a relay node
├── keygen              # [new] Generate ML-DSA-65 keypairs
├── certify             # [new] Create UCAN capability delegations
├── verify              # [new] Verify agent identity and capabilities
├── tui                 # [new] Interactive TUI dashboard
├── completions         # [new] Generate shell completions
├── config              # [new] View/edit configuration
└── plugin              # [new] Manage CLI plugins
```

---

## 4. Existing Commands (Reference)

These commands already exist and work. They are documented here for
completeness and to note planned enhancements.

### `aafp serve`

Start a serving agent with one or more capabilities and an echo handler.

```
$ aafp serve --capability echo --capability translate --bind 0.0.0.0:4433

  AAFP Agent Serving

  Agent ID:      aafp:7f3a:9c2e
  Address:       0.0.0.0:4433
  Capabilities:  echo, translate

  Press Ctrl+C to stop.
```

**Flags:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--capability` | `Vec<String>` (repeatable) | *required* | Capabilities to serve |
| `--bind` | `String` | `0.0.0.0:0` | Bind address |
| `--identity` | `String` | `aafp-identity.bin` | Identity file path |

**Planned enhancements:**
- `--handler <path>` — specify a handler function from a dynamic library
  or WASM module instead of the built-in echo.
- `--config <file>` — load agent configuration from a TOML file.
- `--metrics-addr <addr>` — replace the `AAFP_METRICS` env var with an
  explicit flag.

### `aafp call`

Call an agent by capability (via DHT discovery) or by direct address.

```
$ aafp call echo "hello world" --json
{
  "capability": "echo",
  "request": "hello world",
  "response": "hello world"
}
```

**Arguments:**

| Arg | Position | Description |
|-----|----------|-------------|
| `capability` | 1 | Capability to call |
| `message` | 2 | Message body |

**Flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--identity` | `aafp-identity.bin` | Identity file |
| `--json` | `false` | JSON output |
| `--addr` | *none* | Direct address (skip discovery) |

**Planned enhancements:**
- `--stream` — stream response chunks for streaming RPC.
- `--timeout <duration>` — explicit timeout (default 30s).
- `--metadata key=value` (repeatable) — attach frame metadata.

### `aafp peers`

List discovered peers in a formatted table.

```
$ aafp peers

  Discovered Peers

  Agent ID        Capabilities          Multiaddr                       NAT Status
  -----------------------------------------------------------------------------------------
  aafp:7f3a:9c2e  echo, translate       /ip4/10.0.0.3/udp/4433/quic     Unknown
  aafp:b1d4:fe88  summarize             /ip4/10.0.0.5/udp/4433/quic     Unknown
```

**Planned enhancements:**
- `--json` output.
- `--watch` — continuously refresh (like `watch`).
- `--filter capability=echo` — filter by capability.
- `--sort latency|capability|agent-id` — sort options.

### `aafp metrics`

Display agent metrics snapshot.

```
$ aafp metrics

  AAFP Agent Metrics

  ========================================
  Agent ID:      aafp:7f3a:9c2e
  Status:        Healthy
  Uptime:        3600s
  Connections:   3 active (15 total)
  Messages:      142 sent, 138 received
  Handshakes:    15 completed, 0 failed
  DHT Records:   8
  Bytes:         24576 sent, 38912 received
  ========================================
```

**Planned enhancements:**
- `--json` output.
- `--watch <interval>` — live-updating metrics display.
- `--prometheus` — output in Prometheus exposition format.

### `aafp health`

Health check with exit-code semantics (0=healthy, 1=degraded, 2=unhealthy).

```
$ aafp health
Agent aafp:7f3a:9c2e is Healthy
```

**Planned enhancements:**
- `--endpoint <url>` — check a remote agent's health endpoint rather than
  a local identity file.
- `--timeout <duration>` — health check timeout.

### `aafp quickstart`

Interactive 3-step wizard: generate identity → choose capability → start
serving. Already well-implemented (111 lines).

**Planned enhancements:**
- Add a 4th step: "Open TUI dashboard? (y/n)".
- Support `--template <name>` to skip prompts non-interactively for CI.

### `aafp status`

Show identity file details and verify keypair integrity.

```
$ aafp status
=== AAFP Agent Status ===
Identity file: aafp-identity.bin
Agent ID: aafp:7f3a:9c2e:...
Agent ID (short): aafp:7f3a:9c2e
Public key: 1952 bytes (ML-DSA-65)
Secret key: 4032 bytes (ML-DSA-65)
Keypair verification: PASS
```

### `aafp discover` (existing → enhanced)

Currently searches the DHT for a single capability. Will be enhanced with
richer filtering, JSON output, and registry integration (see §5.9).

### `aafp relay` (existing)

Start a relay node for NAT traversal. Already implemented (36 lines).

**Planned enhancements:**
- `--max-clients <n>` — connection limit.
- `--metrics-addr` — Prometheus endpoint.
- `--identity` — use a persistent identity instead of generating ephemeral.

### `aafp start` (existing)

Start an agent node with optional seed peers. Lower-level than `serve`.

### `aafp connect` / `aafp send` (existing)

Low-level peer connection and one-shot message sending. Useful for
debugging.

---

## 5. New Commands

### 5.1 `aafp init` — Project Scaffolding

The existing `init` command only generates a keypair file. The enhanced
`init` becomes a full project scaffolding tool, similar to `cargo init`
or `npm init`, that creates a complete agent project with handler stubs,
configuration, and a build setup.

#### Usage

```
$ aafp init my-agent --template rust --capability echo --capability summarize

  AAFP Project Scaffolding

  ✓ Created directory: my-agent/
  ✓ Generated identity: my-agent/.aafp/identity.bin
    Agent ID: aafp:7f3a:9c2e
  ✓ Created Cargo.toml
  ✓ Created src/main.rs (handler stub)
  ✓ Created .aafp/config.toml
  ✓ Created .gitignore

  Next steps:
    cd my-agent
    aafp dev
```

#### Arguments

| Arg | Position | Description |
|-----|----------|-------------|
| `[name]` | 1 | Project directory name (default: current dir) |

#### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--template` | `String` | `rust` | Project template: `rust`, `python`, `typescript` |
| `--capability` | `Vec<String>` (repeatable) | `["echo"]` | Capabilities to register |
| `--identity` | `String` | `.aafp/identity.bin` | Identity output path |
| `--force` | `bool` | `false` | Overwrite existing files |
| `--no-git` | `bool` | `false` | Skip `git init` |

#### Templates

**Rust template** generates:

```
my-agent/
├── Cargo.toml
├── src/
│   └── main.rs          # Handler stub using aafp-sdk
├── .aafp/
│   ├── config.toml      # Agent configuration
│   └── identity.bin     # ML-DSA-65 keypair
├── .gitignore
└── README.md
```

`src/main.rs` stub:

```rust
use aafp_sdk::simple::{Agent, Request, Response};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let keypair = aafp_identity::AgentKeypair::from_bytes_full(
        &std::fs::read(".aafp/identity.bin")?,
    )?;

    Agent::serve()
        .with_keypair(keypair)
        .capability("echo")
        .capability("summarize")
        .handler(|req: Request| async move {
            // TODO: implement your handler logic
            Ok(Response::text(req.body().to_string()))
        })
        .start()
        .await?
        .await_ctrl_c()
        .await
}
```

**Python template** generates:

```
my-agent/
├── pyproject.toml
├── src/
│   └── my_agent/
│       ├── __init__.py
│       └── handler.py   # Handler stub using aafp-py
├── .aafp/
│   ├── config.toml
│   └── identity.bin
└── .gitignore
```

**TypeScript template** generates:

```
my-agent/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts         # Handler stub using @aafp/sdk
├── .aafp/
│   ├── config.toml
│   └── identity.bin
└── .gitignore
```

#### Implementation notes

- Templates are embedded via `include_str!` or `rust-embed`.
- The `--template` flag selects which set of embedded files to write.
- After scaffolding, `aafp init` runs `git init` (unless `--no-git`).
- The identity is generated using `AgentKeypair::generate()` and saved to
  `.aafp/identity.bin` within the project directory.

---

### 5.2 `aafp dev` — Development Server

A development server with hot reload that watches source files and
restarts the agent on changes. Designed for the inner-loop development
cycle: edit → save → auto-restart → test.

#### Usage

```
$ aafp dev

  AAFP Dev Server

  Agent ID:      aafp:7f3a:9c2e
  Address:       127.0.0.1:4433
  Capabilities:  echo, summarize
  Watch paths:   src/, .aafp/config.toml

  Hot reload: enabled
  Press Ctrl+C to stop.

  [12:00:01] Agent started
  [12:00:15] Change detected in src/main.rs → rebuilding...
  [12:00:17] Rebuild complete → restarting agent
  [12:00:18] Agent restarted
```

#### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--bind` | `String` | `127.0.0.1:4433` | Bind address |
| `--identity` | `String` | `.aafp/identity.bin` | Identity file |
| `--watch` | `Vec<String>` | `["src/", ".aafp/config.toml"]` | Paths to watch |
| `--no-reload` | `bool` | `false` | Disable hot reload |
| `--build-cmd` | `String` | `cargo build` | Build command (auto-detected from template) |
| `--run-cmd` | `String` | `cargo run` | Run command |
| `--debounce` | `Duration` | `500ms` | Debounce window for file changes |

#### Implementation

- Uses the `notify` crate for filesystem watching.
- For Rust projects: runs `cargo build` then executes the binary.
- For Python projects: runs `python -m my_agent.handler` and restarts on
  `.py` file changes (no build step).
- For TypeScript projects: runs `npx tsx src/index.ts`.
- The agent is started as a child process; on file change, the child is
  killed and restarted after a successful build.
- Graceful shutdown: SIGTERM to child, wait 5s, then SIGKILL.
- The dev server itself maintains the identity and DHT presence so that
  peers see a stable agent ID across reloads.

#### Hot reload sequence

```
┌─────────┐     file change      ┌──────────┐
│  notify  │────────────────────▶│ debounce │
│  watcher │                     │  500ms   │
└─────────┘                      └────┬─────┘
                                      │
                                      ▼
                                ┌──────────┐
                                │  build   │
                                │ (cargo)  │
                                └────┬─────┘
                                     │ success
                                     ▼
                              ┌──────────────┐
                              │ kill old     │
                              │ child process│
                              └──────┬───────┘
                                     │
                                     ▼
                              ┌──────────────┐
                              │ start new    │
                              │ child process│
                              └──────────────┘
```

---

### 5.3 `aafp test` — Conformance Testing

Runs the RFC conformance test suite from `aafp-conformance` against a
running agent. This brings the existing conformance crate into the CLI.

#### Usage

```
$ aafp test --target 127.0.0.1:4433 --suite handshake

  AAFP Conformance Tests

  Target:     127.0.0.1:4433
  Suite:      handshake
  RFC:        RFC-0002 §5

  ✓ handshake_v1_init                    (12ms)
  ✓ handshake_v1_response                (18ms)
  ✓ handshake_v1_key_exchange            (25ms)
  ✓ handshake_v1_replay_protection       (31ms)
  ✗ handshake_v1_nonce_uniqueness        (22ms)
    Expected: REJECT duplicate nonce
    Actual:   ACCEPTED duplicate nonce
    RFC:      RFC-0002 §6.7 (Rev 6 A-9)
  ✓ handshake_v1_timeout                 (5000ms)
  ✓ handshake_v1_unexpected_frame        (15ms)

  Results: 7 passed, 1 failed, 0 skipped
  Duration: 5.123s

  Exit code: 3 (conformance failure)
```

#### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--target` | `String` | `127.0.0.1:4433` | Agent address to test |
| `--suite` | `String` | `all` | Test suite: `all`, `handshake`, `messaging`, `discovery`, `nat`, `security` |
| `--rfc` | `String` | *none* | Filter by RFC number (e.g. `0002`) |
| `--json` | `bool` | `false` | JSON output (TAP-compatible) |
| `--junit` | `String` | *none* | Write JUnit XML report to file |
| `--timeout` | `Duration` | `30s` | Per-test timeout |
| `--include-ignored` | `bool` | `false` | Run ignored tests |
| `--bail` | `bool` | `false` | Stop on first failure |

#### Exit codes

| Code | Meaning |
|------|---------|
| 0 | All tests passed |
| 3 | One or more conformance tests failed |
| 4 | Could not connect to target |

#### Implementation

- Wraps `aafp-conformance` test runner.
- Connects to the target agent as a test client.
- Each test case maps to a specific RFC section requirement.
- `--json` output is structured for CI ingestion:

```json
{
  "target": "127.0.0.1:4433",
  "suite": "handshake",
  "results": [
    {
      "name": "handshake_v1_init",
      "status": "pass",
      "duration_ms": 12,
      "rfc": "RFC-0002 §5.2"
    },
    {
      "name": "handshake_v1_nonce_uniqueness",
      "status": "fail",
      "duration_ms": 22,
      "rfc": "RFC-0002 §6.7",
      "expected": "REJECT duplicate nonce",
      "actual": "ACCEPTED duplicate nonce"
    }
  ],
  "summary": { "passed": 7, "failed": 1, "skipped": 0 },
  "duration_ms": 5123
}
```

---

### 5.4 `aafp bench` — Benchmarking

Run performance benchmarks against a running agent, leveraging the
`aafp-benchmark` crate's Criterion infrastructure but exposing it via
the CLI with a simpler interface.

#### Usage

```
$ aafp bench --target 127.0.0.1:4433 --scenario call-throughput --duration 30s

  AAFP Benchmark

  Target:     127.0.0.1:4433
  Scenario:   call-throughput
  Duration:   30s
  Concurrency: 10

  Progress: [████████████████████] 100%

  ┌─────────────────────────────────────────────────┐
  │  Metric              │  Value                    │
  ├───────────────────────┼───────────────────────────┤
  │  Requests sent        │  45,231                   │
  │  Responses received   │  45,228                   │
  │  Success rate         │  99.99%                   │
  │  Latency (p50)        │  0.65 ms                  │
  │  Latency (p95)        │  1.82 ms                  │
  │  Latency (p99)        │  3.41 ms                  │
  │  Throughput           │  1,507 req/s              │
  │  Bandwidth            │  2.4 MB/s                 │
  └─────────────────────────────────────────────────┘

  Report saved to: bench-report-20240115-120000.json
```

#### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--target` | `String` | `127.0.0.1:4433` | Agent to benchmark |
| `--scenario` | `String` | `call-throughput` | `call-throughput`, `handshake-latency`, `discovery-lookup`, `stream-throughput`, `concurrent-connections` |
| `--duration` | `Duration` | `10s` | Benchmark duration |
| `--concurrency` | `usize` | `10` | Concurrent workers |
| `--payload-size` | `usize` | `1024` | Payload size in bytes |
| `--json` | `bool` | `false` | JSON output |
| `--save` | `String` | *auto* | Save report to file |
| `--compare` | `String` | *none* | Compare against a previous report |

#### Scenarios

| Scenario | What it measures |
|----------|-----------------|
| `call-throughput` | Request/response round-trips per second |
| `handshake-latency` | v1 handshake completion time |
| `discovery-lookup` | DHT lookup latency for capability resolution |
| `stream-throughput` | Streaming RPC bytes per second |
| `concurrent-connections` | Max concurrent connections before degradation |

#### Comparison mode

```
$ aafp bench --compare bench-report-baseline.json

  Benchmark Comparison (current vs baseline)

  Metric              Current     Baseline     Delta
  ─────────────────────────────────────────────────────
  Throughput          1,507/s     1,200/s      +25.6% ▲
  Latency p50         0.65ms      0.80ms       -18.8% ▼ (better)
  Latency p99         3.41ms      4.20ms       -18.8% ▼ (better)
  Success rate        99.99%      99.95%       +0.04%
```

---

### 5.5 `aafp trace` — Frame Capture

Capture AAFP frames from a running agent's traffic and display them in a
human-readable or machine-readable format. This is the foundation for
debugging and protocol analysis.

#### Usage

```
$ aafp trace --target 127.0.0.1:4433 --duration 60s --filter capability=echo

  AAFP Frame Trace

  Target:   127.0.0.1:4433
  Filter:   capability=echo
  Duration: 60s

  #  │ Time     │ Direction │ Frame Type     │ Size  │ Agent ID
  ───┼──────────┼───────────┼────────────────┼───────┼──────────────────
  1  │ 12:00:01 │ → OUT     │ HANDSHAKE_INIT │ 1024B │ aafp:7f3a:9c2e
  2  │ 12:00:01 │ ← IN      │ HANDSHAKE_RESP │ 2048B │ aafp:b1d4:fe88
  3  │ 12:00:02 │ → OUT     │ RPC_REQUEST    │ 256B  │ aafp:7f3a:9c2e
  4  │ 12:00:02 │ ← IN      │ RPC_RESPONSE   │ 512B  │ aafp:b1d4:fe88
  5  │ 12:00:03 │ → OUT     │ CLOSE          │ 64B   │ aafp:7f3a:9c2e

  Captured: 5 frames
  Saved to: trace-20240115-120001.aafp-trace
```

#### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--target` | `String` | `127.0.0.1:4433` | Agent to trace |
| `--duration` | `Duration` | *until Ctrl+C* | Capture duration |
| `--filter` | `String` | *none* | Filter expression: `capability=X`, `type=HANDSHAKE_INIT`, `direction=in`, `agent=ID` |
| `--output` | `String` | *auto* | Output file (`.aafp-trace` format) |
| `--json` | `bool` | `false` | Stream JSONL frames to stdout |
| `--no-save` | `bool` | `false` | Don't save to file (display only) |
| `--decrypt` | `bool` | `false` | Decrypt frame payloads (requires identity) |
| `--identity` | `String` | `.aafp/identity.bin` | Identity for decryption |

#### Trace file format

The `.aafp-trace` file is a CBOR-encoded sequence of frame records:

```cbor
; Each record:
{
  "seq": 1,
  "timestamp_ns": 1705312801000000000,
  "direction": "out",
  "frame_type": "HANDSHAKE_INIT",
  "size": 1024,
  "source_agent": "aafp:7f3a:9c2e",
  "dest_agent": "aafp:b1d4:fe88",
  "raw_cbor": h'A101...';  hex-encoded raw frame bytes
  "decoded": { ... };      ; decoded payload if --decrypt
}
```

#### JSON streaming mode

```
$ aafp trace --json --no-save | jq '.frame_type'
"HANDSHAKE_INIT"
"HANDSHAKE_RESP"
"RPC_REQUEST"
"RPC_RESPONSE"
"CLOSE"
```

---

### 5.6 `aafp replay` — Trace Replay

Replay a captured trace file, either for debugging (step through frames)
or for re-sending frames to a target agent (load testing / regression).

#### Usage

```
$ aafp replay trace-20240115-120001.aafp-trace --target 127.0.0.1:4433

  AAFP Trace Replay

  Trace:    trace-20240115-120001.aafp-trace
  Target:   127.0.0.1:4433
  Frames:   5
  Speed:    1x (real-time)

  [1/5] HANDSHAKE_INIT  →  sent ✓ (12ms)
  [2/5] HANDSHAKE_RESP  ←  received ✓ (18ms)
  [3/5] RPC_REQUEST     →  sent ✓ (8ms)
  [4/5] RPC_RESPONSE    ←  received ✓ (12ms)
  [5/5] CLOSE           →  sent ✓ (2ms)

  Replay complete: 5/5 frames, 0 errors
```

#### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `<trace>` | positional | *required* | Trace file path |
| `--target` | `String` | *none* | Replay to a live agent (omit for dry-run display) |
| `--speed` | `f64` | `1.0` | Replay speed multiplier (0 = instant) |
| `--filter` | `String` | *none* | Only replay matching frames |
| `--step` | `bool` | `false` | Interactive step mode (press Enter for next frame) |
| `--json` | `bool` | `false` | JSON output |
| `--diff` | `bool` | `false` | Compare replay responses to original trace |

#### Interactive step mode

```
$ aafp replay trace.aafp-trace --step

  [1/5] HANDSHAKE_INIT → 12:00:01
  Frame details:
    Type:       HANDSHAKE_INIT
    Direction:  OUT
    Size:       1024 bytes
    Agent:      aafp:7f3a:9c2e

  [Enter] next  [b] back  [q] quit  [d] decode  [s] skip
```

---

### 5.7 `aafp inspect` — Live Frame Inspector

A live, scrolling view of frames as they flow through a running agent.
Think of it as `tcpdump` for AAFP, but with protocol-aware decoding.

#### Usage

```
$ aafp inspect --target 127.0.0.1:4433

  AAFP Live Frame Inspector — 127.0.0.1:4433

  [12:00:01.123] → HANDSHAKE_INIT    aafp:7f3a:9c2e → aafp:b1d4:fe88
    protocol: v1, cipher: ML-KEM-768+X25519, sig: ML-DSA-65
  [12:00:01.141] ← HANDSHAKE_RESP    aafp:b1d4:fe88 → aafp:7f3a:9c2e
    protocol: v1, accepted, kex_complete: true
  [12:00:02.003] → RPC_REQUEST       aafp:7f3a:9c2e → aafp:b1d4:fe88
    capability: "echo", method: "text", body: 11 bytes
  [12:00:02.015] ← RPC_RESPONSE      aafp:b1d4:fe88 → aafp:7f3a:9c2e
    status: 200, body: 11 bytes
  [12:00:03.000] → CLOSE             aafp:7f3a:9c2e → aafp:b1d4:fe88
    reason: "shutdown"

  ── 5 frames captured ── Press [q] to quit, [f] to filter, [d] to toggle decode ──
```

#### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--target` | `String` | `127.0.0.1:4433` | Agent to inspect |
| `--filter` | `String` | *none* | Initial filter expression |
| `--decode` | `bool` | `true` | Decode frame payloads |
| `--color` | `bool` | `true` | Colorize output |
| `--follow` | `bool` | `true` | Keep scrolling (like `tail -f`) |
| `--max-frames` | `usize` | `10000` | Ring buffer size |

#### Implementation

- Uses a ring buffer for frame history.
- Supports filter expressions: `type=X`, `capability=X`, `agent=X`,
  `direction=in|out`.
- Toggle decode with `d` key to switch between raw hex and decoded view.
- `f` key opens an inline filter prompt.
- Uses `crossterm` for raw terminal input.

---

### 5.8 `aafp topology` — Network Graph Visualization

Visualize the agent network as a graph, showing nodes (agents), edges
(connections), and capabilities. Output as ASCII art, SVG, or JSON for
external graph tools.

#### Usage

```
$ aafp topology --identity .aafp/identity.bin

  AAFP Network Topology

         ┌──────────────┐
         │  aafp:7f3a   │  (you)
         │  caps: echo  │
         └──────┬───────┘
                │
       ┌────────┼────────┐
       │        │        │
       ▼        ▼        ▼
  ┌─────────┐ ┌─────────┐ ┌─────────┐
  │aafp:b1d4│ │aafp:c5e2│ │aafp:d9f1│
  │caps:    │ │caps:    │ │caps:    │
  │summarize│ │translate│ │  search │
  └─────────┘ └────┬────┘ └─────────┘
                   │
                   ▼
              ┌─────────┐
              │aafp:e3a7│
              │caps:    │
              │ embed   │
              └─────────┘

  Nodes: 5  Edges: 4  Capabilities: 5
```

#### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--identity` | `String` | `.aafp/identity.bin` | Your identity |
| `--format` | `String` | `ascii` | `ascii`, `svg`, `dot`, `json` |
| `--depth` | `usize` | `3` | BFS depth from your node |
| `--output` | `String` | *stdout* | Output file |
| `--layout` | `String` | `hierarchical` | `hierarchical`, `force`, `circular` |

#### DOT output

```
$ aafp topology --format dot | dot -Tpng -o topology.png

digraph aafp {
  "aafp:7f3a" [label="7f3a\necho", shape=box, style=filled, fillcolor=lightblue];
  "aafp:b1d4" [label="b1d4\nsummarize", shape=box];
  "aafp:c5e2" [label="c5e2\ntranslate", shape=box];
  "aafp:7f3a" -> "aafp:b1d4";
  "aafp:7f3a" -> "aafp:c5e2";
}
```

#### JSON output

```json
{
  "nodes": [
    { "agent_id": "aafp:7f3a:9c2e", "capabilities": ["echo"], "self": true },
    { "agent_id": "aafp:b1d4:fe88", "capabilities": ["summarize"] }
  ],
  "edges": [
    { "from": "aafp:7f3a:9c2e", "to": "aafp:b1d4:fe88", "latency_ms": 12 }
  ]
}
```

---

### 5.9 `aafp discover` — Capability Search

Enhanced version of the existing `discover` command with richer
filtering, multiple output formats, and optional registry search.

#### Usage

```
$ aafp discover --capability echo --capability summarize --json

{
  "query": { "capabilities": ["echo", "summarize"] },
  "results": [
    {
      "agent_id": "aafp:7f3a:9c2e",
      "capabilities": ["echo", "translate"],
      "endpoints": ["/ip4/10.0.0.3/udp/4433/quic"],
      "latency_ms": 12,
      "source": "dht"
    },
    {
      "agent_id": "aafp:b1d4:fe88",
      "capabilities": ["summarize"],
      "endpoints": ["/ip4/10.0.0.5/udp/4433/quic"],
      "latency_ms": 45,
      "source": "registry"
    }
  ],
  "total": 2
}
```

#### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--capability` | `Vec<String>` (repeatable) | *required* | Capabilities to search |
| `--identity` | `String` | `.aafp/identity.bin` | Identity file |
| `--registry` | `String` | *none* | Also search a registry URL |
| `--dht` | `bool` | `true` | Search the DHT |
| `--limit` | `usize` | `20` | Max results |
| `--sort` | `String` | `latency` | `latency`, `capability`, `agent-id` |
| `--json` | `bool` | `false` | JSON output |
| `--watch` | `bool` | `false` | Continuous refresh |

#### Semantic capability matching

Future enhancement: support semantic capability graphs (per
`SEMANTIC_CAPABILITY_GRAPHS.md`) so that `aafp discover --capability
"summarize"` also finds agents with `digest`, `condense`, or `abstract`.

```
$ aafp discover --capability "summarize" --semantic

  Found 5 agents (3 exact, 2 semantic matches):

  Exact matches:
    aafp:b1d4:fe88  caps: [summarize]         latency: 45ms
    aafp:c5e2:a1b3  caps: [summarize, embed]  latency: 120ms
    aafp:e3a7:f09c  caps: [summarize]         latency: 200ms

  Semantic matches (similarity > 0.8):
    aafp:f1b2:d4e5  caps: [digest]            similarity: 0.92  latency: 80ms
    aafp:a2c3:e6f7  caps: [condense]          similarity: 0.87  latency: 95ms
```

---

### 5.10 `aafp publish` — Registry Publishing

Publish an agent's record (AgentId, capabilities, endpoints) to a
registry for centralized discovery. Complements the DHT-based discovery.

#### Usage

```
$ aafp publish --registry https://registry.aafp.io --capability echo --endpoint /ip4/10.0.0.3/udp/4433/quic

  AAFP Registry Publish

  Registry:    https://registry.aafp.io
  Agent ID:    aafp:7f3a:9c2e
  Capabilities: echo, summarize
  Endpoint:    /ip4/10.0.0.3/udp/4433/quic

  ✓ Publishing agent record...
  ✓ Signed with ML-DSA-65
  ✓ Published (version: 3)

  Record URL: https://registry.aafp.io/agents/aafp:7f3a:9c2e
  TTL: 3600s
```

#### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--registry` | `String` | *from config* | Registry URL |
| `--identity` | `String` | `.aafp/identity.bin` | Identity file |
| `--capability` | `Vec<String>` (repeatable) | *required* | Capabilities to publish |
| `--endpoint` | `Vec<String>` (repeatable) | *required* | Reachable endpoints |
| `--ttl` | `Duration` | `3600s` | Record time-to-live |
| `--metadata` | `String` | *none* | JSON metadata blob |
| `--json` | `bool` | `false` | JSON output |

#### Implementation

- Constructs an `AgentRecord` (from `aafp-identity`) with the agent's
  capabilities, endpoints, and metadata.
- Signs the record with the agent's ML-DSA-65 keypair.
- PUTs the record to the registry via HTTPS.
- The registry verifies the signature before accepting.
- Rate-limited per `KeyDirectory` rules (1 publish/AgentId/hour).

---

### 5.11 `aafp relay` — Relay Node

The existing `relay` command starts a relay node. Enhancements planned:

#### Enhanced usage

```
$ aafp relay --bind 0.0.0.0:4434 --max-clients 1000 --metrics-addr 127.0.0.1:9090

  AAFP Relay Node

  Agent ID:     aafp:relay:a1b2
  Bind:         0.0.0.0:4434
  Max clients:  1000
  Metrics:      http://127.0.0.1:9090/metrics

  [12:00:05] Client connected: aafp:7f3a:9c2e
  [12:00:10] Forwarding: aafp:7f3a → aafp:b1d4 (relay hop)
  [12:00:15] Client disconnected: aafp:7f3a:9c2e

  Active clients: 3  Total forwarded: 142
  Press Ctrl+C to stop.
```

#### New flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--max-clients` | `usize` | `1000` | Max concurrent relay clients |
| `--metrics-addr` | `String` | *none* | Prometheus metrics endpoint |
| `--identity` | `String` | *ephemeral* | Persistent identity file |
| `--allow-list` | `String` | *none* | File of allowed AgentIds (one per line) |
| `--bandwidth-limit` | `String` | *none* | Per-client bandwidth limit (e.g. `10MB/s`) |

---

### 5.12 `aafp keygen` — Key Generation

Dedicated key generation command, separated from `init` (which now
scaffolds projects). Generates ML-DSA-65 keypairs with various output
formats.

#### Usage

```
$ aafp keygen --output .aafp/identity.bin --format binary

  AAFP Key Generation

  Algorithm:  ML-DSA-65 (FIPS 204)
  Agent ID:   aafp:7f3a:9c2e
  Public key: 1952 bytes
  Secret key: 4032 bytes

  ✓ Saved to: .aafp/identity.bin
```

#### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--output` | `String` | `.aafp/identity.bin` | Output file |
| `--format` | `String` | `binary` | `binary`, `pem`, `json`, `hex` |
| `--seed` | `String` | *none* | Deterministic keypair from seed (hex) |
| `--capabilities` | `Vec<String>` | *none* | Capabilities to embed |
| `--json` | `bool` | `false` | JSON output |

#### Deterministic mode

```
$ aafp keygen --seed 0x1234...abcd --format json
{
  "algorithm": "ML-DSA-65",
  "agent_id": "aafp:7f3a:9c2e",
  "public_key_hex": "a1b2c3d4...",
  "secret_key_hex": "e5f6a7b8...",
  "seed": "1234...abcd"
}
```

Uses `MlDsa65::keypair_from_seed()` from `aafp-crypto::dsa` for
deterministic, reproducible keypairs (useful for testing).

#### PEM output

```
$ aafp keygen --format pem --output identity.pem
-----BEGIN AAFP ML-DSA-65 PUBLIC KEY-----
MIIDQzBCBiw...
-----END AAFP ML-DSA-65 PUBLIC KEY-----
-----BEGIN AAFP ML-DSA-65 SECRET KEY-----
MIIEUDCCAiS...
-----END AAFP ML-DSA-65 SECRET KEY-----
```

---

### 5.13 `aafp certify` — UCAN Capability Delegations

Create UCAN (User Controlled Authorization Networks) capability
delegations, allowing one agent to authorize another to act on its
behalf for specific capabilities.

#### Usage

```
$ aafp certify \
    --issuer .aafp/identity.bin \
    --subject aafp:b1d4:fe88 \
    --capability echo \
    --capability summarize \
    --expiry 24h

  AAFP UCAN Certification

  Issuer:      aafp:7f3a:9c2e
  Subject:     aafp:b1d4:fe88
  Capabilities: echo, summarize
  Expiry:      24h (expires 2024-01-16T12:00:00Z)

  ✓ Signed with ML-DSA-65
  ✓ UCAN token created

  Token: eyJhbGciOiJNTC1EU0EtNjUiLCJ0eXAiOiJ1Y2FuL2p3dCJ9...
  Saved to: .aafp/delegations/aafp-b1d4-fe88.ucan
```

#### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--issuer` | `String` | `.aafp/identity.bin` | Issuer identity file |
| `--subject` | `String` | *required* | Subject AgentId (hex) |
| `--capability` | `Vec<String>` (repeatable) | *required* | Capabilities to delegate |
| `--expiry` | `Duration` | `1h` | Token expiry |
| `--output` | `String` | *auto* | Output file |
| `--proof` | `String` | *none* | Parent UCAN token (for chaining) |
| `--json` | `bool` | `false` | JSON output |

#### UCAN token structure

```json
{
  "ucv": 1,
  "iss": "aafp:7f3a:9c2e",
  "sub": "aafp:b1d4:fe88",
  "aud": "aafp:b1d4:fe88",
  "att": [
    { "cap": "echo", "with": "aafp:7f3a:9c2e" },
    { "cap": "summarize", "with": "aafp:7f3a:9c2e" }
  ],
  "exp": 1705399200,
  "nbf": 1705312800,
  "prf": [],
  "fct": []
}
```

The token is CBOR-encoded and signed with the issuer's ML-DSA-65 key.
The `--proof` flag allows chaining delegations (attenuation).

---

### 5.14 `aafp verify` — Identity & Capability Verification

Verify an agent's identity, signature, and capability claims. Can verify
a local identity file, a remote agent's record, or a UCAN delegation
chain.

#### Usage

```
$ aafp verify --identity .aafp/identity.bin

  AAFP Identity Verification

  Identity file:  .aafp/identity.bin
  Agent ID:       aafp:7f3a:9c2e
  Algorithm:      ML-DSA-65

  ✓ Public key format: valid (1952 bytes)
  ✓ Secret key format: valid (4032 bytes)
  ✓ Keypair consistency: PASS
  ✓ Self-signature: PASS
  ✓ Agent ID derivation: matches public key

  All checks passed.
```

#### Verify a remote agent

```
$ aafp verify --agent aafp:b1d4:fe88 --registry https://registry.aafp.io

  AAFP Agent Verification

  Agent ID:    aafp:b1d4:fe88
  Source:      registry

  ✓ Agent record found
  ✓ Record signature: valid (ML-DSA-65)
  ✓ Record version: 3 (current)
  ✓ Capabilities: [summarize, embed]
  ✓ Endpoints: [/ip4/10.0.0.5/udp/4433/quic]
  ✓ Not revoked

  All checks passed.
```

#### Verify a UCAN delegation chain

```
$ aafp verify --ucan .aafp/delegations/aafp-b1d4-fe88.ucan

  AAFP UCAN Verification

  Token:     .aafp/delegations/aafp-b1d4-fe88.ucan
  Issuer:    aafp:7f3a:9c2e
  Subject:   aafp:b1d4:fe88

  Chain depth: 2
  [0] aafp:7f3a:9c2e → aafp:c5e2:a1b3  caps: [echo, summarize, translate]
      ✓ Signature valid
      ✓ Not expired (expires in 23h)
  [1] aafp:c5e2:a1b3 → aafp:b1d4:fe88  caps: [echo, summarize]
      ✓ Signature valid
      ✓ Not expired (expires in 20h)
      ✓ Attenuation valid (subset of parent)

  ✓ Delegation chain valid
  Effective capabilities for aafp:b1d4:fe88: [echo, summarize]
```

#### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--identity` | `String` | *none* | Local identity file to verify |
| `--agent` | `String` | *none* | Remote AgentId to verify |
| `--ucan` | `String` | *none* | UCAN token file to verify |
| `--registry` | `String` | *from config* | Registry URL for remote verification |
| `--trusted-roots` | `String` | *none* | File of trusted root AgentIds |
| `--json` | `bool` | `false` | JSON output |

---

## 6. Shell Completions

Generate shell completion scripts using `clap_complete`.

### Usage

```
$ aafp completions bash > /etc/bash_completion.d/aafp
$ aafp completions zsh  > ~/.zsh/completions/_aafp
$ aafp completions fish > ~/.config/fish/completions/aafp.fish
$ aafp completions powershell > $PROFILE/AafpCompletion.ps1
```

### Implementation

```rust
#[derive(Subcommand)]
enum Commands {
    /// Generate shell completions
    Completions {
        #[arg(value_enum)]
        shell: Shell,
    },
    // ...
}

#[derive(clap::ValueEnum, Clone)]
enum Shell {
    Bash,
    Zsh,
    Fish,
    PowerShell,
    Elvish,
}

// In match:
Commands::Completions { shell } => {
    use clap_complete::generate;
    use clap::CommandFactory;
    let mut cmd = Cli::command();
    let bin_name = "aafp";
    generate(shell.into(), &mut cmd, bin_name, &mut io::stdout());
}
```

### `--install` flag

```
$ aafp completions zsh --install
  ✓ Installed completions to ~/.zsh/completions/_aafp
  ℹ Add ~/.zsh/completions to your fpath if not already.
```

Detects the shell from `$SHELL` and installs to the appropriate path.

---

## 7. Configuration File

AAFP uses a layered configuration system with a TOML file at
`.aafp/config.toml` (project-local) and `~/.aafp/config.toml`
(user-global).

### Example `.aafp/config.toml`

```toml
# AAFP Agent Configuration
# Generated by: aafp init

[agent]
identity = ".aafp/identity.bin"
# capabilities = ["echo", "summarize"]   # set by init, editable

[network]
bind = "127.0.0.1:4433"
# seeds = ["bootstrap.aafp.io:4433"]
# relay = "relay.aafp.io:4434"

[discovery]
dht_enabled = true
bootstrap_nodes = []
# registry = "https://registry.aafp.io"

[security]
# trusted_roots = []                      # AgentIds of trusted root CAs
# require_ucan = false                    # Require UCAN for all calls
# min_protocol_version = 1

[metrics]
enabled = false
addr = "127.0.0.1:9090"
path = "/metrics"

[dev]
watch_paths = ["src/", ".aafp/config.toml"]
debounce_ms = 500
build_cmd = "cargo build"
run_cmd = "cargo run"

[trace]
default_duration = "60s"
decrypt = false
output_dir = ".aafp/traces"

[log]
level = "info"                            # trace, debug, info, warn, error
format = "pretty"                         # pretty, json, compact
```

### `aafp config` command

```
$ aafp config list

  AAFP Configuration

  Source: .aafp/config.toml (project) + ~/.aafp/config.toml (global)

  agent.identity       = .aafp/identity.bin
  network.bind         = 127.0.0.1:4433
  discovery.dht        = true
  metrics.enabled      = false
  log.level            = info
```

```
$ aafp config get network.bind
127.0.0.1:4433
```

```
$ aafp config set log.level debug
  ✓ Set log.level = "debug" in .aafp/config.toml
```

#### `aafp config` subcommands

| Subcommand | Description |
|------------|-------------|
| `aafp config list` | Show all config values (merged) |
| `aafp config get <key>` | Get a single value |
| `aafp config set <key> <value>` | Set a value |
| `aafp config path` | Print the config file path |
| `aafp config init` | Create a default config file |
| `aafp config validate` | Validate config file syntax |

### Configuration precedence

1. CLI flags (highest)
2. Environment variables (`AAFP_*`)
3. Project config (`.aafp/config.toml`)
4. User config (`~/.aafp/config.toml`)
5. Built-in defaults (lowest)

### Environment variable mapping

Every config key has an env var equivalent:

| Config key | Env var |
|------------|---------|
| `agent.identity` | `AAFP_AGENT_IDENTITY` |
| `network.bind` | `AAFP_NETWORK_BIND` |
| `discovery.registry` | `AAFP_DISCOVERY_REGISTRY` |
| `log.level` | `AAFP_LOG_LEVEL` |

---

## 8. Plugin System

Allow extending the CLI with custom subcommands via external executables
or WASM modules.

### Convention: `aafp-<name>` executables

Following the `git-<name>` and `cargo-<name>` convention, any executable
named `aafp-foo` on `$PATH` becomes available as `aafp foo`.

```
$ aafp foo --bar baz
```

The CLI searches `$PATH` for `aafp-foo`, executes it with the remaining
arguments, and passes context via environment variables:

| Env var | Value |
|---------|-------|
| `AAFP_PLUGIN` | `1` |
| `AAFP_CONFIG_PATH` | Path to active config file |
| `AAFP_IDENTITY` | Path to identity file |
| `AAFP_AGENT_ID` | Current agent ID (hex) |
| `AAFP_VERSION` | CLI version |

### `aafp plugin` command

```
$ aafp plugin list

  AAFP Plugins

  Name        Version   Path
  ──────────────────────────────────────────
  deploy      0.2.1     /usr/local/bin/aafp-deploy
  visualize   0.1.0     ~/.cargo/bin/aafp-visualize
  migrate     1.0.0     /usr/local/bin/aafp-migrate
```

```
$ aafp plugin install deploy
  ✓ Installed aafp-deploy v0.2.1 from crates.io
```

```
$ aafp plugin run deploy --target prod
```

#### `aafp plugin` subcommands

| Subcommand | Description |
|------------|-------------|
| `aafp plugin list` | List installed plugins |
| `aafp plugin install <name>` | Install from crates.io or URL |
| `aafp plugin uninstall <name>` | Remove a plugin |
| `aafp plugin run <name> [args]` | Explicitly run a plugin |
| `aafp plugin path` | Print the plugin search path |

### WASM plugins (future)

For sandboxed, cross-platform plugins, a WASM-based plugin system is
planned. Plugins would export a `run()` function that receives the CLI
arguments as CBOR and returns output as CBOR. This requires a WASM
runtime (e.g. `wasmtime`) embedded in the CLI.

---

## 9. TUI Dashboard

A ratatui-based terminal user interface that provides a live, interactive
view of the agent network. This is the "operations console" for AAFP.

### Usage

```
$ aafp tui

  ┌─ AAFP Dashboard ──────────────────────────────────────────────────────┐
  │                                                                       │
  │  ┌─ Agent ──────────────────┐  ┌─ Network ─────────────────────────┐ │
  │  │ ID: aafp:7f3a:9c2e       │  │ Peers: 5    DHT records: 12       │ │
  │  │ Status: ● Healthy        │  │ Relays: 1   Active conns: 3       │ │
  │  │ Uptime: 1h 23m           │  │ Bandwidth: ↑2.4MB/s ↓1.8MB/s     │ │
  │  │ Caps: echo, summarize    │  │                                   │ │
  │  └──────────────────────────┘  └───────────────────────────────────┘ │
  │                                                                       │
  │  ┌─ Peers ──────────────────────────────────────────────────────────┐ │
  │  │ Agent ID         Capabilities          Latency   NAT    Status   │ │
  │  │ ─────────────────────────────────────────────────────────────── │ │
  │  │ aafp:b1d4:fe88   summarize             12ms      open   ● online │ │
  │  │ aafp:c5e2:a1b3   translate             45ms      relay  ● online │ │
  │  │ aafp:d9f1:c3d4   search                200ms     open   ● online │ │
  │  │ aafp:e3a7:f09c   embed                 80ms      relay  ◐ degr.  │ │
  │  │ aafp:f1b2:d4e5   digest                95ms      open   ○ idle   │ │
  │  └──────────────────────────────────────────────────────────────────┘ │
  │                                                                       │
  │  ┌─ Frame Stream ───────────────────────────────────────────────────┐ │
  │  │ 12:00:01 → RPC_REQUEST  echo       aafp:7f3a → aafp:b1d4  256B  │ │
  │  │ 12:00:01 ← RPC_RESPONSE echo       aafp:b1d4 → aafp:7f3a  512B  │ │
  │  │ 12:00:02 → RPC_REQUEST  summarize  aafp:7f3a → aafp:b1d4  1.2KB │ │
  │  │ 12:00:03 ← RPC_RESPONSE summarize  aafp:b1d4 → aafp:7f3a  4.5KB │ │
  │  └──────────────────────────────────────────────────────────────────┘ │
  │                                                                       │
  │  [q] quit  [t] trace  [m] metrics  [p] peers  [r] relay  [?] help    │
  └──────────────────────────────────────────────────────────────────────┘
```

### TUI panes

| Pane | Content | Interactions |
|------|---------|-------------|
| **Agent** | Current agent ID, status, uptime, capabilities | Static |
| **Network** | Peer count, DHT records, relay count, bandwidth | Static |
| **Peers** | Live peer table with latency, NAT status, health | Sort by column, select to inspect |
| **Frame Stream** | Scrolling live frame log (like `inspect`) | Filter with `f`, pause with `space` |
| **Metrics Chart** | Sparkline of throughput / latency over time | Toggle metric with `m` |
| **Log** | Agent log output (from tracing) | Filter level with `l` |

### Key bindings

| Key | Action |
|-----|--------|
| `q` | Quit |
| `Tab` | Cycle panes |
| `t` | Toggle frame trace pane |
| `m` | Toggle metrics chart |
| `p` | Focus peers pane |
| `r` | Toggle relay view |
| `f` | Open filter dialog |
| `l` | Cycle log level |
| `space` | Pause/resume frame stream |
| `Enter` | Inspect selected item |
| `?` | Help overlay |

### Implementation

- Uses `ratatui` for rendering and `crossterm` for terminal backend.
- Runs an async event loop with `tokio::select!` over:
  - Terminal input events (keystrokes)
  - Agent metric updates (via `AgentMetrics` polling)
  - Frame events (via trace subscriber)
  - Peer discovery updates (via DHT event stream)
- The TUI connects to a local or remote agent via the same SDK APIs
  used by other CLI commands.
- Supports `--remote <addr>` to connect to a remote agent's TUI server
  (a lightweight WebSocket-based protocol for streaming metrics and
  frames).

### TUI modes

```
$ aafp tui                          # full dashboard (default)
$ aafp tui --mode metrics           # metrics-only view (compact)
$ aafp tui --mode trace             # frame trace only (like inspect)
$ aafp tui --mode topology          # topology graph only
$ aafp tui --remote 10.0.0.3:4433   # connect to remote agent
```

---

## 10. Global Flags & Environment

### Global flags (apply to all commands)

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--config <file>` | `AAFP_CONFIG` | `.aafp/config.toml` | Config file path |
| `--identity <file>` | `AAFP_IDENTITY` | `.aafp/identity.bin` | Identity file |
| `--verbose` / `-v` | `AAFP_VERBOSE` | `false` | Verbose output (can repeat: `-vv`) |
| `--quiet` / `-q` | `AAFP_QUIET` | `false` | Suppress non-error output |
| `--json` | `AAFP_JSON` | `false` | JSON output (command-specific schema) |
| `--no-color` | `NO_COLOR` | `false` | Disable colored output |
| `--log-level <level>` | `AAFP_LOG_LEVEL` | `info` | Log level: trace/debug/info/warn/error |
| `--timeout <dur>` | `AAFP_TIMEOUT` | `30s` | Default timeout for network operations |

### Updated `Cli` struct

```rust
#[derive(Parser)]
#[command(name = "aafp")]
#[command(about = "AAFP: Agent-Agent First Networking Protocol CLI")]
#[command(version = "0.2.0")]
#[command(long_about = "AAFP CLI — scaffold, develop, test, debug, and operate AAFP agents.")]
struct Cli {
    #[command(flatten)]
    global: GlobalArgs,

    #[command(subcommand)]
    command: Commands,
}

#[derive(clap::Args)]
struct GlobalArgs {
    /// Configuration file path
    #[arg(long, global = true, env = "AAFP_CONFIG")]
    config: Option<PathBuf>,

    /// Identity file path
    #[arg(long, global = true, env = "AAFP_IDENTITY")]
    identity: Option<PathBuf>,

    /// Verbose output (repeat for more: -vv)
    #[arg(short, long, global = true, action = clap::ArgAction::Count)]
    verbose: u8,

    /// Quiet mode (suppress non-error output)
    #[arg(short, long, global = true)]
    quiet: bool,

    /// JSON output
    #[arg(long, global = true, env = "AAFP_JSON")]
    json: bool,

    /// Disable colored output
    #[arg(long, global = true, env = "NO_COLOR")]
    no_color: bool,

    /// Log level
    #[arg(long, global = true, env = "AAFP_LOG_LEVEL")]
    log_level: Option<LevelFilter>,
}
```

---

## 11. Implementation Phases

### Phase 1: Foundation (CLI v0.2.0)

**Goal:** Restructure the CLI for extensibility and add config + completions.

- [ ] Refactor `Cli` struct to use `GlobalArgs` (flattened)
- [ ] Add `.aafp/config.toml` support with layered config
- [ ] Add `aafp config` subcommands (list, get, set, path, init, validate)
- [ ] Add `aafp completions` command with `clap_complete`
- [ ] Enhance `aafp init` with project scaffolding (Rust template first)
- [ ] Add `--json` output to all existing commands
- [ ] Add `aafp keygen` (extract from `init`)
- [ ] Update `aafp relay` with `--max-clients`, `--metrics-addr`, `--identity`

### Phase 2: Development Workflow (CLI v0.3.0)

**Goal:** Enable the edit-save-test inner loop.

- [ ] Add `aafp dev` with hot reload (`notify` crate)
- [ ] Add Python and TypeScript templates to `aafp init`
- [ ] Add `aafp test` wrapping `aafp-conformance`
- [ ] Add `aafp bench` wrapping `aafp-benchmark`
- [ ] Add `--watch` flag to `aafp peers` and `aafp metrics`

### Phase 3: Observability (CLI v0.4.0)

**Goal:** Make AAFP traffic visible and debuggable.

- [ ] Add `aafp trace` with frame capture
- [ ] Add `aafp replay` with trace file support
- [ ] Add `aafp inspect` with live frame viewer
- [ ] Define `.aafp-trace` file format (CBOR)
- [ ] Add `aafp topology` with ASCII/SVG/DOT/JSON output

### Phase 4: Identity & Trust (CLI v0.5.0)

**Goal:** Full UCAN and trust management from the CLI.

- [ ] Add `aafp certify` for UCAN delegation creation
- [ ] Add `aafp verify` for identity/record/UCAN verification
- [ ] Enhance `aafp discover` with `--semantic` and registry search
- [ ] Add `aafp publish` for registry publishing
- [ ] Integrate `TrustManager` into `aafp verify`

### Phase 5: TUI & Plugins (CLI v0.6.0)

**Goal:** Interactive operations and extensibility.

- [ ] Add `aafp tui` with ratatui dashboard
- [ ] Add plugin system (`aafp-<name>` convention)
- [ ] Add `aafp plugin` subcommands (list, install, uninstall, run)
- [ ] Add TUI remote mode (`--remote`)
- [ ] Investigate WASM plugin runtime

### Phase 6: Polish (CLI v1.0.0)

**Goal:** Production-ready developer experience.

- [ ] Comprehensive man pages (`aafp.1`, `aafp-serve.1`, etc.)
- [ ] Interactive `aafp help` with paging
- [ ] `aafp doctor` — diagnose common setup issues
- [ ] `aafp upgrade` — self-update from GitHub releases
- [ ] Full integration test suite for CLI commands
- [ ] Documentation site (mdbook) with CLI reference

---

## 12. Appendix: Full `clap` Definition

The following is the complete proposed `Commands` enum in `clap` derive
form, showing all commands, arguments, and flags. This is the target
structure for CLI v0.6.0.

```rust
use clap::{Parser, Subcommand, Args};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "aafp")]
#[command(about = "AAFP: Agent-Agent First Networking Protocol CLI")]
#[command(version = "0.6.0")]
#[command(long_about = "AAFP CLI — scaffold, develop, test, debug, and operate AAFP agents.")]
#[command(propagate_version = true)]
struct Cli {
    #[command(flatten)]
    global: GlobalArgs,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Args)]
struct GlobalArgs {
    /// Configuration file path
    #[arg(long, global = true, env = "AAFP_CONFIG")]
    config: Option<PathBuf>,

    /// Identity file path
    #[arg(long, global = true, env = "AAFP_IDENTITY")]
    identity: Option<PathBuf>,

    /// Verbose output (repeat for more: -vv)
    #[arg(short, long, global = true, action = clap::ArgAction::Count)]
    verbose: u8,

    /// Quiet mode (suppress non-error output)
    #[arg(short, long, global = true, conflicts_with = "verbose")]
    quiet: bool,

    /// JSON output (machine-readable)
    #[arg(long, global = true, env = "AAFP_JSON")]
    json: bool,

    /// Disable colored output
    #[arg(long, global = true, env = "NO_COLOR")]
    no_color: bool,

    /// Log level
    #[arg(long, global = true, env = "AAFP_LOG_LEVEL", value_name = "LEVEL")]
    log_level: Option<String>,

    /// Default timeout for network operations
    #[arg(long, global = true, env = "AAFP_TIMEOUT", value_name = "DURATION")]
    timeout: Option<humantime::Duration>,
}

#[derive(Subcommand)]
enum Commands {
    /// Interactive quickstart wizard
    Quickstart {
        /// Non-interactive template (for CI)
        #[arg(long)]
        template: Option<String>,
    },

    /// Scaffold a new agent project
    Init {
        /// Project directory name (default: current directory)
        name: Option<String>,

        /// Project template
        #[arg(long, value_enum, default_value = "rust")]
        template: Template,

        /// Capabilities to register
        #[arg(long, value_delimiter = ',')]
        capabilities: Option<Vec<String>>,

        /// Identity output path
        #[arg(long, default_value = ".aafp/identity.bin")]
        identity: String,

        /// Overwrite existing files
        #[arg(long)]
        force: bool,

        /// Skip git initialization
        #[arg(long)]
        no_git: bool,
    },

    /// Development server with hot reload
    Dev {
        /// Bind address
        #[arg(long, default_value = "127.0.0.1:4433")]
        bind: String,

        /// Paths to watch for changes
        #[arg(long, value_delimiter = ',')]
        watch: Option<Vec<String>>,

        /// Disable hot reload
        #[arg(long)]
        no_reload: bool,

        /// Custom build command
        #[arg(long)]
        build_cmd: Option<String>,

        /// Custom run command
        #[arg(long)]
        run_cmd: Option<String>,

        /// Debounce window for file changes
        #[arg(long, default_value = "500ms")]
        debounce: humantime::Duration,
    },

    /// Start a production agent server
    Serve {
        /// Capabilities to serve
        #[arg(long, value_delimiter = ',')]
        capability: Vec<String>,

        /// Bind address
        #[arg(long, default_value = "0.0.0.0:0")]
        bind: String,

        /// Handler function path (dynamic library or WASM)
        #[arg(long)]
        handler: Option<String>,

        /// Prometheus metrics endpoint
        #[arg(long)]
        metrics_addr: Option<String>,
    },

    /// Call an agent by capability
    Call {
        /// Capability to call
        capability: String,

        /// Message body
        message: String,

        /// Direct address (skip discovery)
        #[arg(long)]
        addr: Option<String>,

        /// Stream response (streaming RPC)
        #[arg(long)]
        stream: bool,

        /// Request timeout
        #[arg(long, default_value = "30s")]
        timeout: humantime::Duration,

        /// Attach metadata (key=value, repeatable)
        #[arg(long, value_name = "KEY=VALUE")]
        metadata: Option<Vec<String>>,
    },

    /// Search for agents by capability
    Discover {
        /// Capabilities to search for
        #[arg(long, value_delimiter = ',')]
        capability: Vec<String>,

        /// Also search a registry
        #[arg(long)]
        registry: Option<String>,

        /// Search the DHT
        #[arg(long, default_value = "true")]
        dht: bool,

        /// Maximum results
        #[arg(long, default_value = "20")]
        limit: usize,

        /// Sort order
        #[arg(long, default_value = "latency")]
        sort: String,

        /// Semantic capability matching
        #[arg(long)]
        semantic: bool,

        /// Continuous refresh
        #[arg(long)]
        watch: bool,
    },

    /// List discovered peers
    Peers {
        /// Filter expression (e.g. capability=echo)
        #[arg(long)]
        filter: Option<String>,

        /// Sort order
        #[arg(long, default_value = "agent-id")]
        sort: String,

        /// Continuous refresh
        #[arg(long)]
        watch: bool,
    },

    /// Show agent metrics
    Metrics {
        /// Continuous refresh with interval
        #[arg(long, value_name = "DURATION")]
        watch: Option<humantime::Duration>,

        /// Prometheus exposition format
        #[arg(long)]
        prometheus: bool,
    },

    /// Health check
    Health {
        /// Check a remote agent endpoint
        #[arg(long)]
        endpoint: Option<String>,

        /// Health check timeout
        #[arg(long, default_value = "10s")]
        timeout: humantime::Duration,
    },

    /// Show identity status
    Status,

    /// Run conformance tests against a running agent
    Test {
        /// Target agent address
        #[arg(long, default_value = "127.0.0.1:4433")]
        target: String,

        /// Test suite
        #[arg(long, default_value = "all")]
        suite: String,

        /// Filter by RFC number
        #[arg(long)]
        rfc: Option<String>,

        /// Write JUnit XML report
        #[arg(long)]
        junit: Option<String>,

        /// Per-test timeout
        #[arg(long, default_value = "30s")]
        timeout: humantime::Duration,

        /// Run ignored tests
        #[arg(long)]
        include_ignored: bool,

        /// Stop on first failure
        #[arg(long)]
        bail: bool,
    },

    /// Benchmark agent performance
    Bench {
        /// Target agent address
        #[arg(long, default_value = "127.0.0.1:4433")]
        target: String,

        /// Benchmark scenario
        #[arg(long, default_value = "call-throughput")]
        scenario: String,

        /// Benchmark duration
        #[arg(long, default_value = "10s")]
        duration: humantime::Duration,

        /// Concurrent workers
        #[arg(long, default_value = "10")]
        concurrency: usize,

        /// Payload size in bytes
        #[arg(long, default_value = "1024")]
        payload_size: usize,

        /// Save report to file
        #[arg(long)]
        save: Option<String>,

        /// Compare against a previous report
        #[arg(long)]
        compare: Option<String>,
    },

    /// Capture and display frames
    Trace {
        /// Target agent address
        #[arg(long, default_value = "127.0.0.1:4433")]
        target: String,

        /// Capture duration
        #[arg(long)]
        duration: Option<humantime::Duration>,

        /// Filter expression
        #[arg(long)]
        filter: Option<String>,

        /// Output file
        #[arg(long)]
        output: Option<String>,

        /// Don't save to file
        #[arg(long)]
        no_save: bool,

        /// Decrypt frame payloads
        #[arg(long)]
        decrypt: bool,
    },

    /// Replay captured traces
    Replay {
        /// Trace file path
        trace: String,

        /// Replay to a live agent
        #[arg(long)]
        target: Option<String>,

        /// Replay speed multiplier (0 = instant)
        #[arg(long, default_value = "1.0")]
        speed: f64,

        /// Only replay matching frames
        #[arg(long)]
        filter: Option<String>,

        /// Interactive step mode
        #[arg(long)]
        step: bool,

        /// Compare replay responses to original
        #[arg(long)]
        diff: bool,
    },

    /// Live frame inspector
    Inspect {
        /// Target agent address
        #[arg(long, default_value = "127.0.0.1:4433")]
        target: String,

        /// Initial filter expression
        #[arg(long)]
        filter: Option<String>,

        /// Disable frame payload decoding
        #[arg(long)]
        no_decode: bool,

        /// Ring buffer size
        #[arg(long, default_value = "10000")]
        max_frames: usize,
    },

    /// Network graph visualization
    Topology {
        /// Output format
        #[arg(long, value_enum, default_value = "ascii")]
        format: TopologyFormat,

        /// BFS depth from your node
        #[arg(long, default_value = "3")]
        depth: usize,

        /// Output file
        #[arg(long)]
        output: Option<String>,

        /// Graph layout
        #[arg(long, default_value = "hierarchical")]
        layout: String,
    },

    /// Publish agent to a registry
    Publish {
        /// Registry URL
        #[arg(long)]
        registry: String,

        /// Capabilities to publish
        #[arg(long, value_delimiter = ',')]
        capability: Vec<String>,

        /// Reachable endpoints
        #[arg(long, value_delimiter = ',')]
        endpoint: Vec<String>,

        /// Record time-to-live
        #[arg(long, default_value = "1h")]
        ttl: humantime::Duration,

        /// JSON metadata blob
        #[arg(long)]
        metadata: Option<String>,
    },

    /// Run a relay node
    Relay {
        /// Bind address
        #[arg(long, default_value = "0.0.0.0:4434")]
        bind: String,

        /// Max concurrent relay clients
        #[arg(long, default_value = "1000")]
        max_clients: usize,

        /// Prometheus metrics endpoint
        #[arg(long)]
        metrics_addr: Option<String>,

        /// Persistent identity file
        #[arg(long)]
        identity: Option<String>,

        /// Allowed AgentIds file (one per line)
        #[arg(long)]
        allow_list: Option<String>,

        /// Per-client bandwidth limit
        #[arg(long)]
        bandwidth_limit: Option<String>,
    },

    /// Generate ML-DSA-65 keypairs
    Keygen {
        /// Output file
        #[arg(long, default_value = ".aafp/identity.bin")]
        output: String,

        /// Output format
        #[arg(long, value_enum, default_value = "binary")]
        format: KeygenFormat,

        /// Deterministic keypair from seed (hex)
        #[arg(long)]
        seed: Option<String>,

        /// Capabilities to embed
        #[arg(long, value_delimiter = ',')]
        capabilities: Option<Vec<String>>,
    },

    /// Create UCAN capability delegations
    Certify {
        /// Issuer identity file
        #[arg(long, default_value = ".aafp/identity.bin")]
        issuer: String,

        /// Subject AgentId (hex)
        #[arg(long)]
        subject: String,

        /// Capabilities to delegate
        #[arg(long, value_delimiter = ',')]
        capability: Vec<String>,

        /// Token expiry
        #[arg(long, default_value = "1h")]
        expiry: humantime::Duration,

        /// Output file
        #[arg(long)]
        output: Option<String>,

        /// Parent UCAN token (for chaining)
        #[arg(long)]
        proof: Option<String>,
    },

    /// Verify agent identity and capabilities
    Verify {
        /// Local identity file to verify
        #[arg(long, conflicts_with_all = ["agent", "ucan"])]
        identity: Option<String>,

        /// Remote AgentId to verify
        #[arg(long, conflicts_with_all = ["identity", "ucan"])]
        agent: Option<String>,

        /// UCAN token file to verify
        #[arg(long, conflicts_with_all = ["identity", "agent"])]
        ucan: Option<String>,

        /// Registry URL for remote verification
        #[arg(long)]
        registry: Option<String>,

        /// Trusted root AgentIds file
        #[arg(long)]
        trusted_roots: Option<String>,
    },

    /// Interactive TUI dashboard
    Tui {
        /// TUI mode
        #[arg(long, default_value = "full")]
        mode: String,

        /// Connect to a remote agent
        #[arg(long)]
        remote: Option<String>,
    },

    /// Generate shell completions
    Completions {
        /// Shell type
        shell: Shell,

        /// Install to the default location for the detected shell
        #[arg(long)]
        install: bool,
    },

    /// View and edit configuration
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },

    /// Manage CLI plugins
    Plugin {
        #[command(subcommand)]
        action: PluginAction,
    },
}

#[derive(clap::ValueEnum, Clone)]
enum Template { Rust, Python, Typescript }

#[derive(clap::ValueEnum, Clone)]
enum Shell { Bash, Zsh, Fish, PowerShell, Elvish }

#[derive(clap::ValueEnum, Clone)]
enum KeygenFormat { Binary, Pem, Json, Hex }

#[derive(clap::ValueEnum, Clone)]
enum TopologyFormat { Ascii, Svg, Dot, Json }

#[derive(Subcommand)]
enum ConfigAction {
    /// Show all config values
    List,
    /// Get a single value
    Get { key: String },
    /// Set a value
    Set { key: String, value: String },
    /// Print the config file path
    Path,
    /// Create a default config file
    Init,
    /// Validate config file syntax
    Validate,
}

#[derive(Subcommand)]
enum PluginAction {
    /// List installed plugins
    List,
    /// Install a plugin
    Install { name: String },
    /// Uninstall a plugin
    Uninstall { name: String },
    /// Run a plugin explicitly
    Run { name: String, #[arg(trailing_var_arg = true)] args: Vec<String> },
    /// Print the plugin search path
    Path,
}
```

### New dependencies required

```toml
[dependencies]
# Existing
clap = { workspace = true }
tokio = { workspace = true }
tracing = { workspace = true }
tracing-subscriber = "0.3"
hex = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
anyhow = { workspace = true }
colored = "2"

# New for Phase 1
clap_complete = "4"          # shell completions
toml = "0.8"                 # config file parsing
humantime = "2"              # duration parsing
rust-embed = "8"             # embed project templates
dirs = "5"                   # config/identity directory paths

# New for Phase 2
notify = "6"                 # filesystem watching for aafp dev

# New for Phase 3
# (trace/replay/inspect use existing aafp-messaging + aafp-cbor)

# New for Phase 5
ratatui = "0.26"             # TUI dashboard
crossterm = "0.27"           # terminal backend for TUI and inspect
```

---

*This document is a living roadmap. Command signatures and flags may
evolve during implementation. Each phase should be accompanied by
integration tests for the new commands and updates to the CLI's own
`--help` output.*
