# AAFP Test Results

This directory stores all test results from the AAFP project, structured for
both machine consumption (JSON) and human review (HTML dashboard).

## Directory Structure

```
test-results/
├── README.md                           This file
├── dashboards/
│   └── index.html                      Auto-generated dashboard (open in browser)
├── interop/                            Interoperability test results
│   ├── python-mcp-sdk.json             D1: Python MCP SDK ↔ Rust rmcp
│   ├── a2a-reference.json              D2: A2A transport ↔ reference impl
│   ├── rust-go-cross.json              D3: Rust ↔ Go cross-language
│   └── mcp-conformance.json            D4: MCP conformance suite
├── performance/                        Performance benchmark results
│   ├── crypto.json                     F1: Crypto benchmarks (keygen, sign, verify)
│   ├── framing.json                    F1: Framing benchmarks (encode, decode)
│   ├── transport.json                  F1: Transport benchmarks (handshake, throughput)
│   └── session.json                    F1: Session/memory benchmarks
├── conformance/                        RFC conformance test results
│   ├── rust-conformance.json           Rust conformance suite results
│   └── go-conformance.json             Go conformance suite results
└── unit/                               Unit test results
    ├── rust-unit.json                  Rust workspace test results
    └── go-unit.json                    Go test results
```

## Result JSON Schema

Every result file follows this schema:

```json
{
  "test_name": "python-mcp-sdk-interop",
  "test_category": "interop",
  "timestamp": "2026-07-02T14:30:00Z",
  "environment": {
    "os": "macOS 15.5.0",
    "cpu": "Apple M3 Pro",
    "rust_version": "1.88.0",
    "aafp_version": "rev6-rc1",
    "commit": "15665a2"
  },
  "status": "pass",
  "duration_ms": 4523,
  "summary": "Python MCP SDK client connected to Rust rmcp server over AAFP",
  "details": [
    {
      "step": "transport_connect",
      "status": "pass",
      "duration_ms": 120,
      "notes": "AAFP handshake completed"
    },
    {
      "step": "mcp_initialize",
      "status": "pass",
      "duration_ms": 15,
      "notes": "protocolVersion 2025-11-25 negotiated"
    }
  ],
  "metrics": {}
}
```

## Generating the Dashboard

```bash
cd /Users/david/projects/AAFP-research
python3 test-results/generate_dashboard.py
# Open test-results/dashboards/index.html in a browser
```

The dashboard reads all JSON files in `interop/`, `performance/`, `conformance/`,
and `unit/`, and renders a modern single-page dashboard with:
- Pass/fail cards per test category
- Performance charts (bar charts for benchmarks)
- Interop matrix (which SDKs have been tested)
- Environment info
- Timestamps and commit SHAs for reproducibility

## Adding New Results

Test plans (D1-D4, F1) write JSON result files to the appropriate subdirectory
after each test run. The dashboard is regenerated to include the new results.

```bash
# After running any test:
python3 test-results/generate_dashboard.py
git add test-results/
git commit -m "test: update test results dashboard"
```
