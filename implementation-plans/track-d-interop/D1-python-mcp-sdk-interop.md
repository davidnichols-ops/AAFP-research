# Plan D1: Test Against Real Python MCP SDK

**Priority:** HIGH (last release criterion)
**Track:** D (External Interop)
**Estimated effort:** 6-8 hours
**Blocked by:** C3 (repos must be pushed for external access)
**Blocks:** D4 (conformance suite builds on this)

---

## Objective

Prove that the AAFP Python transport adapter works with the **real** Python
MCP SDK (`@modelcontextprotocol/python-sdk`), not just raw JSON-RPC messages.
This is the key interop milestone: a Python MCP client using the official SDK
connects to a Rust rmcp server over AAFP's post-quantum QUIC transport.

**Source:** INTEROPERABILITY_PLAN.md §5.3 (Phase 3: Cross-SDK interop)

---

## Prerequisites

- C3 complete (repos pushed, or at minimum local clone available)
- C1 complete (pyo3 segfault fixed)
- Python 3.10+ with `pip`
- `maturin` installed
- Read the Python MCP SDK source: https://github.com/modelcontextprotocol/python-sdk
- Read `implementations/rust/crates/aafp-py/python/aafp_transport/mcp_adapter.py`

---

## Critical: Verify the Python MCP SDK Transport Interface

Before writing any code, you MUST verify the actual Transport interface
of the Python MCP SDK. The adapter in `mcp_adapter.py` assumes `read`/`write`
methods, but the real SDK may use a different interface.

### D1.1: Install and inspect the Python MCP SDK

```bash
pip install mcp
python -c "
import inspect
from mcp.client.session import ClientSession
from mcp.client.transport import Transport
print(inspect.getsource(Transport))
"
```

**Read the actual Transport protocol/interface.** It may be:
- An abstract class with `read()` / `write()` methods
- A protocol with `send()` / `receive()` methods
- A context manager with `__aenter__` / `__aexit__`
- Something else entirely

**Do NOT proceed until you know the exact interface.** The adapter must
match the real SDK, not assumptions.

### D1.2: Update the adapter if needed

Read `implementations/rust/crates/aafp-py/python/aafp_transport/mcp_adapter.py`.
Compare its interface to the real SDK's Transport protocol. If they don't
match, rewrite the adapter to match the real interface.

Common patterns in MCP SDKs:
- `async def read(self) -> str | dict` — read a message
- `async def write(self, message: str | dict) -> None` — write a message
- Messages may be JSON strings (not dicts) — check if the SDK expects
  strings or dicts

If the SDK expects JSON strings, update `PyAafpTransport::receive()` to
return a string (it already does this — the Python wrapper parses it).
If it expects dicts, parse the JSON in the Python wrapper.

### D1.3: Write a real interop test

Create `implementations/rust/crates/aafp-py/tests/test_mcp_sdk_interop.py`:

```python
"""Test: Real Python MCP SDK client connects to Rust rmcp server over AAFP.

This test uses the official @modelcontextprotocol/python-sdk to create
a real MCP client session that connects to a Rust rmcp server via AAFP.
"""
import asyncio
import os
import signal
import subprocess
import sys

import pytest

pytestmark = pytest.mark.asyncio


async def test_mcp_sdk_client_to_rust_server():
    """Python MCP SDK client → Rust rmcp server over AAFP."""
    from mcp.client.session import ClientSession
    from aafp_transport import AafpMcpTransport
    import aafp_py

    # 1. Start Rust MCP server (mcp_over_aafp example)
    rust_dir = os.path.join(
        os.path.dirname(__file__), "..", "..", "implementations", "rust"
    )
    rust_dir = os.path.abspath(rust_dir)

    proc = subprocess.Popen(
        ["cargo", "run", "--example", "mcp_over_aafp"],
        cwd=rust_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    try:
        # Wait for server to print its address
        addr = None
        for _ in range(100):
            line = proc.stdout.readline()
            if line and "listening on:" in line:
                addr = line.split("listening on:")[1].strip()
                break
            else:
                await asyncio.sleep(0.1)

        if addr is None:
            stderr = proc.stderr.read()
            pytest.skip(f"Could not start Rust MCP server: {stderr}")

        # 2. Create AAFP transport and connect
        agent = await aafp_py.Agent.bind("127.0.0.1:0")
        transport = AafpMcpTransport()
        await transport.connect(agent, addr)

        # 3. Create MCP client session using the real SDK
        #    The exact API depends on the SDK version — check the docs
        async with ClientSession(
            read_transport=transport.read,
            write_transport=transport.write,
        ) as session:
            # 4. Initialize the MCP session
            await session.initialize()

            # 5. List tools
            tools = await session.list_tools()
            assert len(tools.tools) > 0
            print(f"Available tools: {[t.name for t in tools.tools]}")

            # 6. Call a tool (if the server has any)
            #    The mcp_over_aafp example should have at least one tool
            # result = await session.call_tool("example_tool", {})
            # assert result.isError == False

        # 7. Clean close
        await transport.close()

    finally:
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=5)
```

**IMPORTANT:** The exact `ClientSession` constructor arguments depend on
the Python MCP SDK version. Check the SDK docs/source for the correct way
to create a session with a custom transport. The code above is a template —
adapt it to the real API.

### D1.4: Run the interop test

```bash
cd /Users/david/projects/AAFP-research/implementations/rust/crates/aafp-py
maturin develop
pip install mcp pytest pytest-asyncio
pytest tests/test_mcp_sdk_interop.py -v
```

**Expected:** Test passes — Python MCP SDK client successfully connects to
Rust rmcp server, initializes, lists tools, and closes cleanly.

If the test fails, debug the failure:
- Is the transport interface correct? (D1.1/D1.2)
- Is the Rust server starting correctly?
- Is the AAFP handshake completing?
- Are the JSON-RPC messages correctly formatted?

### D1.5: Document the interop result

Write a JSON result file to `test-results/interop/python-mcp-sdk.json`:

```python
import json
from datetime import datetime

result = {
    "test_name": "python-mcp-sdk-interop",
    "test_category": "interop",
    "timestamp": datetime.now().isoformat(),
    "environment": {
        "os": "<from uname>",
        "cpu": "<from sysctl>",
        "rust_version": "<from rustc --version>",
        "aafp_version": "rev6-rc1",
        "commit": "<from git rev-parse HEAD>",
    },
    "status": "pass",  # or "fail"
    "duration_ms": <measured>,
    "summary": "Python MCP SDK client connected to Rust rmcp server over AAFP",
    "details": [
        {"step": "transport_connect", "status": "pass", "duration_ms": 120, "notes": "AAFP handshake completed"},
        {"step": "mcp_initialize", "status": "pass", "duration_ms": 15, "notes": "protocolVersion 2025-11-25 negotiated"},
        {"step": "tools_list", "status": "pass", "duration_ms": 8, "notes": "1 tool returned"},
        {"step": "graceful_close", "status": "pass", "duration_ms": 5, "notes": "No segfault"},
    ],
    "metrics": {},
}

with open("test-results/interop/python-mcp-sdk.json", "w") as f:
    json.dump(result, f, indent=2)
```

Then regenerate the dashboard:
```bash
python3 test-results/generate_dashboard.py
```

Also create or update `implementations/rust/crates/aafp-py/INTEROP_RESULTS.md`:

```markdown
# AAFP Python ↔ Rust MCP Interop Results

## Test: Python MCP SDK client → Rust rmcp server over AAFP

**Date:** 2026-07-XX
**Python MCP SDK version:** X.X.X
**rmcp version:** X.X.X
**AAFP version:** rev6-rc1

### Results
- [x] Transport connects (AAFP handshake completes)
- [x] MCP initialize succeeds
- [x] tools/list returns tools
- [x] tools/call executes (if tested)
- [x] Graceful close

### Verified
- Python MCP SDK client can use AAFP as a transport
- JSON-RPC messages are correctly carried in AAFP DATA frames
- ML-DSA-65 identity verification works across the PyO3 boundary
- Post-quantum QUIC transport works end-to-end

### Limitations
- <any issues found>
```

### D1.6: Commit

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add crates/aafp-py/tests/test_mcp_sdk_interop.py crates/aafp-py/python/aafp_transport/mcp_adapter.py crates/aafp-py/INTEROP_RESULTS.md
git commit -m "$(cat <<'EOF'
test: verify Python MCP SDK interop with Rust rmcp server over AAFP

Adds a real interop test using the official @modelcontextprotocol/python-sdk
to create an MCP client session that connects to a Rust rmcp server via
AAFP's post-quantum QUIC transport.

This proves AAFP works with real external MCP software, not just our own
implementations — the last remaining release criterion.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

Update umbrella:
```bash
cd /Users/david/projects/AAFP-research
git add implementations/rust
git commit -m "test: Python MCP SDK ↔ Rust rmcp interop verified over AAFP"
```

---

## Verification

### D1.7: Test passes

```bash
cd /Users/david/projects/AAFP-research/implementations/rust/crates/aafp-py
pytest tests/test_mcp_sdk_interop.py -v
```
**Expected:** PASS

### D1.8: Clean exit (no segfault)

The test should exit cleanly after C1's fix. If it segfaults, C1's fix
is incomplete — go back and fix it.

---

## Risks & Mitigations

1. **Python MCP SDK Transport interface differs:** This is the most likely
   issue. **Mitigation:** D1.1 inspects the real interface before writing
   the adapter. If the interface is fundamentally different (e.g., requires
   a context manager or a different async pattern), the adapter needs a
   rewrite.

2. **Python MCP SDK doesn't support custom transports:** Some SDKs only
   support stdio and HTTP. **Mitigation:** Check the SDK source. If custom
   transports aren't supported, document this as a limitation and test
   with raw JSON-RPC instead (B2.10 already does this).

3. **Rust MCP server example doesn't have tools:** The `mcp_over_aafp`
   example may not register any tools. **Mitigation:** Read the example
   source. If it has no tools, either add a simple tool to the example
   or skip the `tools/call` test.

4. **Version incompatibility:** The Python MCP SDK may use a different
   protocol version than the Rust rmcp crate. **Mitigation:** Check both
   versions and use the `protocolVersion` that both support.

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark D1.1 through D1.8 as `[x]`
- Set D1 status to `COMPLETE`
