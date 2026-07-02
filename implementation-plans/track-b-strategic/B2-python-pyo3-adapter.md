# Plan B2: Python AAFP Transport Adapter (PyO3)

**Priority:** HIGH (key interop milestone)
**Track:** B (Strategic)
**Estimated effort:** 6-8 hours
**Blocked by:** B1 (A2A crate should land first to validate the transport pattern)
**Blocks:** nothing

---

## Objective

Create a Python package that wraps the AAFP MCP transport via PyO3, enabling
a Python MCP client to connect to a Rust rmcp server over AAFP's post-quantum
QUIC transport. This is Phase 2 of the INTEROPERABILITY_PLAN.md — the key
milestone proving the AAFP transport works outside the Rust ecosystem.

**Why PyO3 (not pure Python):** AAFP requires QUIC (quinn) + ML-DSA-65
(fips204) + rustls PQ TLS. Reimplementing these in Python would be a massive
effort. PyO3 wraps the existing Rust crate, keeping all crypto in Rust and
exposing a clean Python async API.

---

## Prerequisites

- B1 complete (the transport pattern is validated)
- Working directory: `/Users/david/projects/AAFP-research`
- Python 3.10+ installed
- `maturin` installed (`pip install maturin`)
- Read `INTEROPERABILITY_PLAN.md` §5.2-5.3 (Python interop plan)
- Read `aafp-transport-mcp/src/lib.rs` (the crate being wrapped)

---

## Architecture

```
Python MCP Client (application code)
    ↓
aafp_transport Python package (mcp_adapter.py)
    ↓  (implements Python MCP SDK Transport protocol)
PyO3 binding (aafp_py extension module)
    ↓  (calls Rust functions via PyO3)
aafp-transport-mcp Rust crate
    ↓
AAFP Core (handshake, framing, session)
    ↓
QUIC (quinn + rustls PQ TLS)
```

---

## Steps

### B2.1: Create crates/aafp-py/Cargo.toml

**IMPORTANT:** This crate is NOT in the main workspace. It has different
dependencies (pyo3) that would force all workspace members to compile PyO3.
Create it as a standalone crate:

```toml
[package]
name = "aafp-py"
version = "0.1.0"
edition = "2021"
license = "MIT OR Apache-2.0"
description = "Python bindings for AAFP transport"

[lib]
name = "aafp_py"
crate-type = ["cdylib"]

[dependencies]
aafp-transport-mcp = { path = "../aafp-transport-mcp" }
aafp-sdk = { path = "../aafp-sdk" }
aafp-core = { path = "../aafp-core" }
aafp-identity = { path = "../aafp-identity" }
aafp-crypto = { path = "../aafp-crypto" }
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
pyo3 = { version = "0.22", features = ["extension-module"] }
pyo3-asyncio = { version = "0.22", features = ["tokio-runtime"] }
tracing = "0.1"
```

**Note:** Check the latest pyo3 version. As of 2026-07, pyo3 0.22 should be
stable. If a newer version is available and published >7 days ago, use it.
Do NOT use floating ranges like `pyo3 = "*"`.

### B2.2: Create src/lib.rs — PyO3 module

```rust
use pyo3::prelude::*;

mod agent;
mod transport;

#[pymodule]
fn aafp_py(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_class::<agent::PyAgent>()?;
    m.add_class::<transport::PyAafpTransport>()?;
    Ok(())
}
```

### B2.3: Create src/agent.rs — PyAgent wrapper

Wraps `aafp_sdk::Agent`. The Python API:

```python
agent = aafp_py.Agent.bind("127.0.0.1:0")  # create + bind
agent = aafp_py.Agent.from_keyfile("path/to/key.json")  # load existing
```

```rust
use pyo3::prelude::*;
use pyo3::exceptions::PyException;
use aafp_sdk::AgentBuilder;
use std::sync::Arc;

#[pyclass]
pub struct PyAgent {
    pub inner: Arc<aafp_sdk::Agent>,
}

#[pymethods]
impl PyAgent {
    #[staticmethod]
    pub fn bind(addr: &str) -> PyResult<Self> {
        // This needs to be async in Python. Use pyo3-asyncio to run the
        // async AgentBuilder in a tokio runtime.
        // ...
    }

    #[staticmethod]
    pub fn from_keyfile(path: &str) -> PyResult<Self> {
        // Load keypair from file, create Agent
        // ...
    }

    #[getter]
    pub fn agent_id(&self) -> String {
        // Return hex-encoded AgentId
        hex::encode(&self.inner.keypair.agent_id().0)
    }
}
```

**Key challenge:** `AgentBuilder::new().bind().build()` is async. PyO3 needs
to run this in a tokio runtime. Use `pyo3_asyncio::tokio::future_into_py` or
a dedicated runtime. Research the current pyo3-asyncio API before implementing.

### B2.4: Create src/transport.rs — PyAafpTransport wrapper

Wraps `AafpMcpTransport`. Python API:

```python
transport = aafp_py.AafpTransport()
await transport.connect(agent, "quic://127.0.0.1:4433")
await transport.send({"jsonrpc": "2.0", "method": "tools/list", "id": 1})
response = await transport.receive()
await transport.close()
```

```rust
use pyo3::prelude::*;
use pyo3::exceptions::PyException;
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::agent::PyAgent;

#[pyclass]
pub struct PyAafpTransport {
    inner: Arc<Mutex<Option<aafp_transport_mcp::AafpMcpTransport>>>,
}

#[pymethods]
impl PyAafpTransport {
    #[new]
    fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(None)) }
    }

    fn connect<'py>(&self, py: Python<'py>, agent: &PyAgent, addr: &str) -> PyResult<&'py PyAny> {
        // Return a coroutine that performs the async connect
        let inner = self.inner.clone();
        let agent_inner = agent.inner.clone();
        pyo3_asyncio::tokio::future_into_py(py, async move {
            let transport = aafp_transport_mcp::AafpMcpTransport::connect(&agent_inner, addr)
                .await
                .map_err(|e| PyException::new_err(e.to_string()))?;
            *inner.lock().await = Some(transport);
            Ok(())
        })
    }

    fn accept<'py>(&self, py: Python<'py>, agent: &PyAgent) -> PyResult<&'py PyAny> {
        // Similar to connect but server-side
    }

    fn send<'py>(&self, py: Python<'py>, message: &PyAny) -> PyResult<&'py PyAny> {
        // Serialize Python dict to JSON, send as DATA frame
    }

    fn receive<'py>(&self, py: Python<'py>) -> PyResult<&'py PyAny> {
        // Read DATA frame, parse JSON, return Python dict
    }

    fn close<'py>(&self, py: Python<'py>) -> PyResult<&'py PyAny> {
        // Close the transport
    }

    #[getter]
    fn peer_agent_id(&self) -> PyResult<Option<String>> {
        // Return peer AgentId as hex string, or None
    }
}
```

**Critical implementation notes:**
- `send`: Accept a Python dict (or any JSON-serializable object). Convert to
  `serde_json::Value` via `pyo3` types, serialize to JSON bytes, send as DATA
  frame via the transport.
- `receive`: Read a DATA frame from the transport, parse JSON bytes to
  `serde_json::Value`, convert to Python object via pyo3.
- All async methods return coroutines (`&'py PyAny`) that Python can `await`.
- Use `pyo3_asyncio::tokio::future_into_py` to bridge tokio futures to Python
  asyncio. The tokio runtime must be initialized — use
  `pyo3_asyncio::tokio::init` or a dedicated runtime.

### B2.5: Create pyproject.toml

```toml
[build-system]
requires = ["maturin>=1.5,<2.0"]
build-backend = "maturin"

[project]
name = "aafp-transport"
version = "0.1.0"
description = "AAFP post-quantum transport for Python MCP clients"
requires-python = ">=3.10"
classifiers = [
    "Programming Language :: Python :: 3",
    "Programming Language :: Rust",
    "License :: OSI Approved :: MIT License",
]

[tool.maturin]
features = ["pyo3/extension-module"]
python-source = "python"
module-name = "aafp_py"
```

### B2.6: Create python/aafp_transport/__init__.py

```python
"""AAFP post-quantum transport for Python MCP clients.

This package provides a transport adapter that allows Python MCP clients
to connect to MCP servers over AAFP's post-quantum QUIC transport.
"""
from .transport import AafpTransport
from .mcp_adapter import AafpMcpTransport

__all__ = ["AafpTransport", "AafpMcpTransport"]
__version__ = "0.1.0"
```

### B2.7: Create python/aafp_transport/transport.py

Low-level wrapper around the PyO3 binding:

```python
"""Low-level AAFP transport wrapper.

This wraps the aafp_py PyO3 extension module and provides a clean
async Python API for connecting, sending, and receiving AAFP frames.
"""
import asyncio
from typing import Any, Optional
import aafp_py


class AafpTransport:
    """Async AAFP transport for JSON-RPC messages."""

    def __init__(self):
        self._inner = aafp_py.AafpTransport()
        self._closed = False

    async def connect(self, agent: "aafp_py.Agent", addr: str) -> None:
        """Connect to an AAFP server (client side)."""
        await self._inner.connect(agent, addr)

    async def accept(self, agent: "aafp_py.Agent") -> None:
        """Accept an AAFP connection (server side)."""
        await self._inner.accept(agent)

    async def send(self, message: dict) -> None:
        """Send a JSON-RPC message as an AAFP DATA frame."""
        if self._closed:
            raise RuntimeError("Transport is closed")
        await self._inner.send(message)

    async def receive(self) -> dict:
        """Receive a JSON-RPC message from an AAFP DATA frame."""
        if self._closed:
            raise RuntimeError("Transport is closed")
        return await self._inner.receive()

    async def close(self) -> None:
        """Close the transport gracefully."""
        if not self._closed:
            await self._inner.close()
            self._closed = True

    @property
    def peer_agent_id(self) -> Optional[str]:
        """The verified peer AgentId (hex string), or None."""
        return self._inner.peer_agent_id
```

### B2.8: Create python/aafp_transport/mcp_adapter.py

Adapter that implements the Python MCP SDK's Transport protocol:

```python
"""MCP SDK Transport adapter for AAFP.

This adapter allows the Python MCP SDK (modelcontextprotocol/python-sdk)
to use AAFP as a transport. It implements the SDK's Transport protocol.
"""
import asyncio
import json
from typing import Any, Optional
from .transport import AafpTransport


class AafpMcpTransport:
    """AAFP transport implementing the MCP SDK Transport protocol.

    Usage with the Python MCP SDK:

        from mcp.client.session import ClientSession
        from aafp_transport import AafpMcpTransport, AafpTransport
        import aafp_py

        agent = await aafp_py.Agent.bind("127.0.0.1:0")
        transport = AafpMcpTransport()
        await transport.connect(agent, "quic://127.0.0.1:4433")

        async with ClientSession(transport.read, transport.write) as session:
            await session.initialize()
            tools = await session.list_tools()
    """

    def __init__(self):
        self._transport = AafpTransport()
        self._read_queue: asyncio.Queue = asyncio.Queue()

    async def connect(self, agent, addr: str) -> None:
        """Connect to an AAFP MCP server."""
        await self._transport.connect(agent, addr)

    async def accept(self, agent) -> None:
        """Accept an AAFP MCP connection (server side)."""
        await self._transport.accept(agent)

    async def read(self) -> dict:
        """Read a message (MCP SDK Transport protocol)."""
        return await self._transport.receive()

    async def write(self, message: dict) -> None:
        """Write a message (MCP SDK Transport protocol)."""
        await self._transport.send(message)

    async def close(self) -> None:
        """Close the transport."""
        await self._transport.close()

    @property
    def peer_agent_id(self) -> Optional[str]:
        return self._transport.peer_agent_id
```

**IMPORTANT:** The exact interface of the Python MCP SDK's Transport protocol
may differ from this. Before finalizing, check the actual python-sdk source at
https://github.com/modelcontextprotocol/python-sdk to verify the expected
method signatures (`read`, `write`, or `send`, `receive`, etc.). Adapt the
adapter to match the real interface.

### B2.9: Create python/aafp_transport/py.typed

Empty file (PEP 561 marker for type-checked packages):
```bash
touch python/aafp_transport/py.typed
```

### B2.10: Create tests/test_aafp_mcp.py

Test: Python MCP client → Rust rmcp server over AAFP.

```python
"""Test: Python MCP client connects to Rust rmcp server over AAFP."""
import asyncio
import pytest
import aafp_py
from aafp_transport import AafpMcpTransport


@pytest.mark.asyncio
async def test_python_client_rust_server():
    """Python client connects to Rust server, calls tools/list and tools/call."""
    # 1. Start Rust rmcp server (as subprocess or in-process)
    #    Use the mcp_over_aafp example from aafp-transport-mcp
    # 2. Create Python agent
    agent = await aafp_py.Agent.bind("127.0.0.1:0")
    # 3. Connect via AafpMcpTransport
    transport = AafpMcpTransport()
    await transport.connect(agent, "quic://127.0.0.1:4433")
    # 4. Send initialize request
    await transport.write({
        "jsonrpc": "2.0",
        "method": "initialize",
        "params": {"protocolVersion": "2025-11-25", "capabilities": {}},
        "id": 1,
    })
    response = await transport.read()
    assert response["jsonrpc"] == "2.0"
    assert response["id"] == 1
    assert "result" in response
    # 5. Send tools/list
    await transport.write({"jsonrpc": "2.0", "method": "tools/list", "id": 2})
    response = await transport.read()
    assert "result" in response
    assert "tools" in response["result"]
    # 6. Clean close
    await transport.close()
```

### B2.11: Create tests/test_cross_sdk.py

Test: Rust rmcp client → Python MCP server over AAFP.

```python
"""Test: Rust rmcp client connects to Python MCP server over AAFP."""
import asyncio
import pytest
import aafp_py
from aafp_transport import AafpMcpTransport


@pytest.mark.asyncio
async def test_rust_client_python_server():
    """Rust client connects to Python server, exchanges MCP messages."""
    # 1. Start Python MCP server with AafpMcpTransport
    # 2. Start Rust rmcp client (as subprocess)
    # 3. Verify messages exchange correctly
    # 4. Clean close
```

This test is harder because it requires starting a Rust subprocess. Consider
using the `aafp` CLI or a test binary. Alternatively, test only the
Python-client → Rust-server direction (B2.10) and mark B2.11 as a stretch goal.

### B2.12-B2.14: Verification

```bash
# B2.12: Build the extension
cd /Users/david/projects/AAFP-research/implementations/rust/crates/aafp-py
maturin develop

# B2.13: Run tests
cd /Users/david/projects/AAFP-research
pytest tests/ -v

# B2.14: Manual interop test
# Start the Rust MCP server example in one terminal:
cd implementations/rust
cargo run --example mcp_over_aafp  # note the port it binds to

# In another terminal, run a Python client:
python -c "
import asyncio
import aafp_py
from aafp_transport import AafpMcpTransport

async def main():
    agent = await aafp_py.Agent.bind('127.0.0.1:0')
    transport = AafpMcpTransport()
    await transport.connect(agent, 'quic://127.0.0.1:<port>')
    await transport.write({'jsonrpc': '2.0', 'method': 'tools/list', 'id': 1})
    print(await transport.read())
    await transport.close()

asyncio.run(main())
"
```

---

## Risks & Mitigations

1. **PyO3 async bridging:** The hardest part. `pyo3-asyncio` has known rough
   edges with tokio runtimes. **Mitigation:** Use a dedicated tokio runtime
   thread. If `pyo3-asyncio` doesn't work, try `pyo3::coroutine` (newer API)
   or run tokio in a background thread and use channels.

2. **Python MCP SDK interface:** The adapter (B2.8) assumes the SDK uses
   `read`/`write` methods. The actual interface may differ. **Mitigation:**
   Before implementing B2.8, check the real python-sdk source. Adapt to match.

3. **ML-DSA-65 key management:** All crypto stays in Rust. Python never
   touches raw keys. The `PyAgent` wraps keygen/signing. This is the correct
   design — do NOT expose crypto primitives to Python.

4. **Build complexity:** `maturin develop` requires a Rust toolchain + Python
   dev headers. This may not work in all environments. **Mitigation:**
   Document build requirements clearly. Consider providing pre-built wheels
   in the future.

5. **The `aafp-py` crate is NOT in the workspace:** This is intentional —
   pyo3's `extension-module` feature would affect all workspace members.
   Build it separately with `maturin`. Do NOT add it to the workspace
   `members` list.

---

## Status Update

After completing this plan, update `STATUS.md`:
- Mark B2.1 through B2.14 as `[x]`
- Set B2 status to `COMPLETE`
- If B2.11 (Rust client → Python server) is too complex, mark it `[~]` with
  a note and complete B2.10 first.
