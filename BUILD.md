# AAFP Build & Test Guide

Complete instructions for building, testing, and benchmarking the AAFP project
from a fresh clone. Designed for anyone — no prior AAFP knowledge required.

---

## 1. Prerequisites

### Required

| Tool | Version | Check |
|------|---------|-------|
| Rust | 1.75+ (stable) | `rustc --version` |
| Go | 1.22+ | `go version` |
| Python | 3.10+ | `python3 --version` |
| Git | 2.30+ | `git --version` |
| CMake | 3.10+ | `cmake --version` |
| Make | any | `make --version` |

### Rust toolchain

```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Ensure you have the stable toolchain
rustup default stable
rustup update stable
```

### Python tools (for PyO3 adapter and test dashboard)

```bash
pip install maturin pytest pytest-asyncio pytest-json-report
```

### System dependencies (macOS)

```bash
# Xcode command line tools (for CMake and compilers)
xcode-select --install

# Homebrew packages (if needed)
brew install cmake
```

### System dependencies (Linux/Ubuntu)

```bash
sudo apt update
sudo apt install -y build-essential cmake pkg-config libssl-dev
```

---

## 2. Clone the Repository

```bash
git clone --recurse-submodules https://github.com/davidnichols-ops/AAFP-research.git
cd AAFP-research
```

If you forgot `--recurse-submodules`:
```bash
git submodule update --init --recursive
```

### Verify clone

```bash
ls implementations/rust/Cargo.toml    # Rust workspace manifest
ls implementations/go/go.mod          # Go module
ls RFCs/0001-protocol-overview.md     # Protocol spec
```

---

## 3. Build the Rust Implementation

### Quick build (debug)

```bash
cd implementations/rust
cargo build --workspace
```

Expected: 0 warnings, 0 errors. ~2-5 minutes on first build.

### Release build (optimized)

```bash
cargo build --workspace --release
```

### Build specific crate

```bash
cargo build -p aafp-sdk
cargo build -p aafp-transport-mcp
cargo build -p aafp-transport-a2a
```

### Build the Python adapter (aafp-py)

The `aafp-py` crate is standalone (not in the workspace) because PyO3's
`extension-module` feature would affect all workspace members.

```bash
cd implementations/rust/crates/aafp-py

# Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install maturin and test deps
pip install maturin pytest pytest-asyncio

# Build and install the Python extension
maturin develop

# Verify it works
python -c "
import asyncio, aafp_py
async def main():
    agent = await aafp_py.Agent.bind('127.0.0.1:0')
    print(f'Agent ID: {agent.agent_id[:16]}...')
    await agent.shutdown()
asyncio.run(main())
print('OK — clean exit, no segfault')
"
```

---

## 4. Run Tests

### All Rust tests

```bash
cd implementations/rust
cargo test --workspace
```

Expected output:
```
test result: ok. 1011 passed; 0 failed; 2 ignored; ...
```

### Rust tests with verbose output

```bash
cargo test --workspace -- --nocapture
```

### Specific crate tests

```bash
cargo test -p aafp-crypto
cargo test -p aafp-messaging
cargo test -p aafp-sdk
cargo test -p aafp-transport-mcp
cargo test -p aafp-transport-a2a
```

### Go tests

```bash
cd implementations/go
go test ./...
```

Expected: all packages pass.

### Go tests with race detector

```bash
go test -race ./...
```

### Python interop tests

```bash
cd implementations/rust/crates/aafp-py
source .venv/bin/activate

# Run all Python tests
pytest tests/ -v

# Run specific test
pytest tests/test_aafp_mcp.py -v
pytest tests/test_cross_sdk.py -v
```

### Run everything + generate dashboard

```bash
cd /path/to/AAFP-research
python3 test-results/run_all_tests.py
python3 test-results/generate_dashboard.py
open test-results/dashboards/index.html
```

---

## 5. Run Examples

### MCP server over AAFP

```bash
cd implementations/rust
cargo run --example mcp_over_aafp
# Server prints: "Server agent listening on: quic://127.0.0.1:PORT"
```

### MCP client over AAFP

```bash
# In another terminal:
cargo run --example mcp_client -- quic://127.0.0.1:PORT
```

### A2A server over AAFP

```bash
cargo run --example a2a_over_aafp --package aafp-transport-a2a
```

### Basic agent

```bash
cargo run --example basic_agent --package aafp-sdk
```

---

## 6. Linting & Formatting

### Rust

```bash
cd implementations/rust

# Format check (0 diffs expected)
cargo fmt --all -- --check

# Format fix (if needed)
cargo fmt --all

# Clippy (0 warnings expected)
cargo clippy --workspace -- -D warnings

# Clippy with all targets (examples, benches, tests)
cargo clippy --workspace --all-targets -- -D warnings
```

### Go

```bash
cd implementations/go

# Format check (no output = all formatted)
gofmt -l .

# Format fix (if needed)
gofmt -w .

# Vet
go vet ./...
```

---

## 7. Benchmarks

### Run all benchmarks

```bash
cd implementations/rust
cargo bench --workspace
```

Results are saved to `target/criterion/`.

### Run specific benchmark

```bash
cargo bench -p aafp-crypto
cargo bench -p aafp-messaging
```

### Run benchmarks and save to test-results

```bash
# After Track F1 is implemented:
python3 test-results/run_all_tests.py --perf
python3 test-results/generate_dashboard.py
```

---

## 8. Golden Traces & Test Vectors

### Generate golden traces

```bash
cd implementations/rust
cargo run --bin generate_golden_traces
cargo run --bin generate_traces
cargo run --bin generate_vectors
```

### Generate interop fixtures

```bash
cargo run --bin generate_interop_fixtures
cargo run --bin verify_go_fixtures
```

### Verify Go can decode Rust-generated fixtures

```bash
cd implementations/go
go test ./interop/ -v
go test ./goldentrace/ -v
go test ./testvectors/ -v
```

---

## 9. Documentation

### Generate Rustdoc

```bash
cd implementations/rust
cargo doc --workspace --no-deps --open
```

Expected: 0 warnings. Opens in browser.

### Check for doc warnings

```bash
RUSTDOCFLAGS="-D rustdoc::broken-intra-doc-links" cargo doc --workspace --no-deps
```

### Run doc tests

```bash
cargo test --doc --workspace
```

---

## 10. CI (GitHub Actions)

CI workflows are in `.github/workflows/`:

- `rust-ci.yml` — `cargo fmt --check`, `cargo clippy`, `cargo test`, on every push/PR
- `go-ci.yml` — `gofmt -l`, `go vet`, `go test`, on every push/PR

CI runs on Ubuntu 22.04 with Rust stable and Go 1.22.

---

## 11. Project Structure

```
AAFP-research/                         Umbrella repo
├── RFCs/                              8 RFCs + amendments
├── implementations/
│   ├── rust/                          Rust implementation (15 crates)
│   │   ├── crates/
│   │   │   ├── aafp-cbor/             Canonical CBOR
│   │   │   ├── aafp-crypto/           ML-DSA-65, AEAD, HKDF, ReplayCache
│   │   │   ├── aafp-identity/         AgentId, AgentRecord, UCAN
│   │   │   ├── aafp-core/             Session state machine, traits
│   │   │   ├── aafp-transport-quic/   QUIC transport (quinn + rustls)
│   │   │   ├── aafp-messaging/        Framing, RPC, PubSub, CloseManager
│   │   │   ├── aafp-discovery/        Capability DHT
│   │   │   ├── aafp-nat/              NAT traversal (stubs → E4)
│   │   │   ├── aafp-sdk/              High-level Agent API
│   │   │   ├── aafp-transport-mcp/    MCP transport binding (RFC 0007)
│   │   │   ├── aafp-transport-a2a/    A2A transport binding (RFC 0008)
│   │   │   ├── aafp-py/               Python PyO3 adapter (standalone)
│   │   │   ├── aafp-cli/              CLI tool
│   │   │   ├── aafp-conformance/      RFC conformance tests
│   │   │   ├── aafp-benchmark/        Criterion benchmarks
│   │   │   └── aafp-tests/            Cross-crate integration tests
│   │   └── golden_traces/             17 canonical wire traces
│   └── go/                            Go implementation (13 packages)
├── test-results/                      Test results + dashboard
│   ├── generate_dashboard.py          Dashboard generator
│   ├── run_all_tests.py               Test runner
│   ├── dashboards/index.html          Auto-generated dashboard
│   ├── interop/                       Interop test results (JSON)
│   ├── performance/                   Benchmark results (JSON)
│   ├── conformance/                   Conformance results (JSON)
│   └── unit/                          Unit test results (JSON)
├── implementation-plans/              Track-based execution plans
├── research/                          Ecosystem analysis (16 phases)
├── ROADMAP.md                         Project roadmap
└── adr/                               Architectural Decision Records
```

---

## 12. Troubleshooting

### Build fails with "linker `cc` not found"

Install a C compiler:
```bash
# macOS
xcode-select --install

# Linux
sudo apt install build-essential
```

### Build fails with "could not find `aws-lc-rs`"

aws-lc-rs requires CMake and a C compiler:
```bash
brew install cmake          # macOS
sudo apt install cmake      # Linux
```

### `maturin develop` fails

Ensure you're in a virtual environment and have the right Python:
```bash
cd implementations/rust/crates/aafp-py
python3 -m venv .venv
source .venv/bin/activate
pip install maturin
maturin develop
```

### Python tests fail with "ModuleNotFoundError: No module named 'aafp_py'"

Run `maturin develop` first to build and install the extension.

### Python test segfaults on exit

This was fixed in C1. Ensure you have the latest build:
```bash
cd implementations/rust/crates/aafp-py
maturin develop --force
```

If it still segfaults, ensure you're calling `await agent.shutdown()` before
process exit.

### Go tests fail with "package not found"

Ensure Go modules are downloaded:
```bash
cd implementations/go
go mod download
go mod tidy
```

### Clippy warnings

Fix all warnings before committing:
```bash
cargo clippy --workspace --fix --allow-dirty --allow-staged
cargo fmt --all
```

### Cargo test hangs

Some tests start QUIC servers. If a test hangs, it may be waiting for a port:
```bash
# Run tests with a timeout
cargo test --workspace -- --test-threads=1
```

---

## 13. Quick Reference

| What | Command |
|------|---------|
| Build Rust | `cd implementations/rust && cargo build --workspace` |
| Build Python | `cd implementations/rust/crates/aafp-py && maturin develop` |
| Test Rust | `cargo test --workspace` |
| Test Go | `cd implementations/go && go test ./...` |
| Test Python | `cd implementations/rust/crates/aafp-py && pytest tests/ -v` |
| Lint Rust | `cargo clippy --workspace -- -D warnings` |
| Lint Go | `cd implementations/go && gofmt -l . && go vet ./...` |
| Bench | `cargo bench --workspace` |
| Docs | `cargo doc --workspace --no-deps --open` |
| Run all + dashboard | `python3 test-results/run_all_tests.py && python3 test-results/generate_dashboard.py` |
| Open dashboard | `open test-results/dashboards/index.html` |
