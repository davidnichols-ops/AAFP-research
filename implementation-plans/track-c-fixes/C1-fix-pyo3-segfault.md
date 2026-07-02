# Plan C1: Fix pyo3 Segfault + Write B2.11 Interop Test

**Priority:** HIGH
**Track:** C (Fixes & Push)
**Estimated effort:** 4-6 hours
**Blocked by:** nothing
**Blocks:** C3 (don't push known bugs)

---

## Problem

The PyO3 Python adapter (`aafp-py` crate) has a known segfault on cleanup.
When the Python process exits, the pyo3-async-runtimes tokio runtime shutdown
crashes. This doesn't affect functionality during operation but makes the
adapter unsuitable for production use.

Additionally, B2.11 (Rust client → Python server interop test) was skipped
as a stretch goal. It should be written to complete the cross-SDK interop
proof point.

**Source:** STATUS.md B2 notes, session 1 final summary

---

## Prerequisites

- Working directory: `/Users/david/projects/AAFP-research`
- Python 3.10+ installed
- `maturin` installed (`pip install maturin`)
- Read `implementations/rust/crates/aafp-py/src/transport.rs` (164 lines)
- Read `implementations/rust/crates/aafp-py/src/agent.rs` (96 lines)
- Read `implementations/rust/crates/aafp-py/src/lib.rs` (16 lines)
- Read `implementations/rust/crates/aafp-py/Cargo.toml`

---

## Part 1: Fix the pyo3 Segfault

### C1.1: Diagnose the segfault

The segfault occurs during tokio runtime shutdown. The pyo3-async-runtimes
crate creates a tokio runtime to bridge Rust async futures to Python asyncio.
When Python exits, the runtime is dropped, and if there are pending tasks or
held resources (like QUIC connections), the drop order can cause a use-after-free.

**Investigation steps:**
1. Build the extension: `cd implementations/rust/crates/aafp-py && maturin develop`
2. Run a minimal test that connects and closes:
   ```python
   import asyncio, aafp_py
   async def main():
       agent = await aafp_py.Agent.bind("127.0.0.1:0")
       print("agent_id:", agent.agent_id)
   asyncio.run(main())
   ```
3. Run it and observe if it segfaults on exit
4. Run with `RUST_BACKTRACE=1 python script.py` to get a backtrace
5. Check if the crash is in tokio runtime drop, quinn connection drop, or pyo3 cleanup

### C1.2: Implement the fix

The most likely fix is to ensure graceful shutdown of the tokio runtime before
Python exits. There are two approaches:

**Approach A (preferred): Use a dedicated tokio runtime with controlled shutdown**

Modify `src/lib.rs` to initialize the tokio runtime explicitly and register
an `atexit` handler that shuts it down cleanly:

```rust
use pyo3::prelude::*;
use std::sync::OnceLock;
use tokio::runtime::Runtime;

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

fn get_runtime() -> &'static Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to create tokio runtime")
    })
}

#[pymodule]
fn aafp_py(m: &Bound<'_, PyModule>) -> PyResult<()> {
    // Initialize the runtime eagerly
    let _ = get_runtime();
    m.add_class::<agent::PyAgent>()?;
    m.add_class::<transport::PyAafpTransport>()?;
    Ok(())
}
```

Then update all `pyo3_async_runtimes::tokio::future_into_py` calls to use
the custom runtime. Check the pyo3-async-runtimes docs for how to specify
a custom runtime — it may require `pyo3_async_runtimes::tokio::with_runtime`
or similar.

**Approach B (fallback): Ensure all connections are closed before exit**

Add a `__del__` method to `PyAafpTransport` that closes the transport if
it's still open:

```rust
fn __del__(&self) {
    // Try to close gracefully — best effort, no blocking
    if let Ok(guard) = self.inner.try_lock() {
        if let Some(mut transport) = guard.as_ref() {
            // Spawn a close on the runtime — fire and forget
            // This may not complete but at least signals shutdown
        }
    }
}
```

**Approach C (if A and B don't work): Suppress the crash**

If the segfault is unavoidable in the pyo3-async-runtimes cleanup path,
register a `std::process::exit(0)` handler that bypasses the problematic
drop. This is a last resort — it skips Rust destructors but prevents the
crash:

```rust
#[pymodule]
fn aafp_py(m: &Bound<'_, PyModule>) -> PyResult<()> {
    // Register atexit to skip the crashing tokio runtime drop
    m.add("__atexit__", || {
        std::process::exit(0);
    })?;
    m.add_class::<agent::PyAgent>()?;
    m.add_class::<transport::PyAafpTransport>()?;
    Ok(())
}
```

**IMPORTANT:** Try Approach A first. If it doesn't work, try B. Only use C
as a last resort and document why.

### C1.3: Verify the fix

```bash
cd /Users/david/projects/AAFP-research/implementations/rust/crates/aafp-py
maturin develop
python -c "
import asyncio, aafp_py
async def main():
    agent = await aafp_py.Agent.bind('127.0.0.1:0')
    print('agent_id:', agent.agent_id)
asyncio.run(main())
print('clean exit')
"
```

**Expected:** "clean exit" printed, no segfault, exit code 0.

Also test with an actual connection:
```bash
# Start a Rust MCP server in background, then run the Python client
# from the existing test, and verify it exits cleanly
```

### C1.4: Commit the fix

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add crates/aafp-py/src/
git commit -m "$(cat <<'EOF'
fix: resolve pyo3 segfault on cleanup

The pyo3-async-runtimes tokio runtime was crashing during Python process
exit due to pending QUIC connections being dropped in an unsafe order.

Fix: <describe the approach you used — A, B, or C>

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

---

## Part 2: Write B2.11 Interop Test (Rust client → Python server)

### C1.5: Create the test file

Create `implementations/rust/crates/aafp-py/tests/test_cross_sdk.py`:

```python
"""Test: Rust rmcp client connects to Python MCP server over AAFP.

This is the reverse direction of test_aafp_mcp.py — a Python process
acts as the MCP server, and a Rust binary acts as the MCP client.
"""
import asyncio
import json
import os
import signal
import subprocess
import sys
import time

import pytest

pytestmark = pytest.mark.asyncio


async def test_rust_client_python_server():
    """Rust client connects to Python server, exchanges MCP messages."""
    import aafp_py
    from aafp_transport import AafpMcpTransport

    # 1. Start Python MCP server (in-process)
    agent = await aafp_py.Agent.bind("127.0.0.1:0")
    server_addr = agent.multiaddr
    print(f"[server] Python server listening on: {server_addr}")

    server_transport = AafpMcpTransport()

    # Accept in background
    accept_task = asyncio.create_task(
        server_transport.accept(agent)
    )

    # 2. Start Rust MCP client (subprocess)
    #    We need a Rust binary that connects to an AAFP server and sends
    #    MCP messages. Use a simple test binary or the CLI.
    #    For now, use the mcp_over_aafp example in client mode if it supports
    #    connecting to a specified address.
    #
    #    If no suitable Rust client binary exists, write a minimal one in
    #    crates/aafp-py/examples/rust_client.py or as a Rust example.
    #
    #    Alternative: use the aafp CLI: `aafp connect <addr> --mcp tools/list`

    # 3. Wait for the Rust client to connect and send a message
    # 4. Python server receives the message, responds
    request = await server_transport.read()
    assert request["jsonrpc"] == "2.0"
    assert "method" in request

    # 5. Python server sends a response
    await server_transport.write({
        "jsonrpc": "2.0",
        "id": request.get("id"),
        "result": {"status": "ok"},
    })

    # 6. Clean close
    await server_transport.close()
    await accept_task
```

**Note:** This test requires a Rust client binary that can connect to a
specified AAFP address and send MCP messages. If the existing
`mcp_over_aafp` example doesn't support client mode with a custom address,
you may need to:
1. Write a minimal Rust example `examples/rust_mcp_client.rs` that takes
   an address as argument, connects, sends `tools/list`, prints the response
2. Or use the `aafp` CLI if it supports MCP client mode

If writing a Rust example is too complex for this step, mark C1.5 as `[~]`
(in progress) with a note, and proceed. The key proof point (Python client →
Rust server) is already verified in B2.10.

### C1.6: Run the tests

```bash
cd /Users/david/projects/AAFP-research/implementations/rust/crates/aafp-py
pytest tests/ -v
```

**Expected:** All tests pass, no segfault on exit.

### C1.7: Commit

```bash
cd /Users/david/projects/AAFP-research/implementations/rust
git add crates/aafp-py/tests/
git commit -m "$(cat <<'EOF'
test: add Rust client → Python server interop test (B2.11)

Completes the cross-SDK interop proof point by testing the reverse
direction: a Rust MCP client connecting to a Python MCP server over
AAFP's post-quantum QUIC transport.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

Update umbrella submodule pointer:
```bash
cd /Users/david/projects/AAFP-research
git add implementations/rust
git commit -m "chore: update rust submodule — fix pyo3 segfault + B2.11 test"
```

---

## Verification

### C1.8: No segfault

```bash
cd /Users/david/projects/AAFP-research/implementations/rust/crates/aafp-py
maturin develop && python -c "
import asyncio, aafp_py
async def main():
    agent = await aafp_py.Agent.bind('127.0.0.1:0')
    print('OK:', agent.agent_id[:16])
asyncio.run(main())
print('clean exit')
" && echo "PASS: no segfault"
```

**Expected:** "PASS: no segfault", exit code 0.

### C1.9: Tests pass

```bash
pytest tests/ -v
```
**Expected:** All tests pass, clean exit.

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark C1.1 through C1.9 as `[x]`
- Set C1 status to `COMPLETE`
