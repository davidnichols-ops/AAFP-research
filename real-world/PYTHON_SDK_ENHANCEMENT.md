# AAFP Python SDK Enhancement Plan

**Status:** Design / Planning Document
**Date:** 2025-07-05
**Scope:** `crates/aafp-py/` PyO3 bindings + `python/aafp/` high-level API
**Depends on:** `SIMPLE_API_V2_DESIGN.md` (Rust v2 API), `aafp-sdk` crate
**Target Python:** 3.11+ (3.13+ recommended for `TaskGroup` + `ExceptionGroup` ergonomics)

---

## 1. Current Python SDK State

The Python SDK today is a thin PyO3 shim over the Rust `aafp-sdk` simple API
(v1). It works — the MCP interop is fully functional (see `INTEROP_RESULTS.md`)
— but it exposes only a fraction of the protocol's power and is not yet
idiomatic Python.

### 1.1 Module layout

```
crates/aafp-py/
├── Cargo.toml                 # standalone crate (NOT in workspace)
├── pyproject.toml             # maturin build backend, package name "aafp"
├── src/
│   ├── lib.rs                 # #[pymodule], tokio runtime, class registration
│   ├── agent.rs               # PyAgent — low-level Agent.bind()/from_keyfile()
│   ├── simple.rs              # PyRequest/PyResponse/PyServeBuilder/PyConnectedAgent
│   └── transport.rs           # PyAafpTransport — JSON-RPC over QUIC for MCP
├── python/
│   ├── aafp/                  # high-level package (re-exports aafp_py)
│   │   ├── __init__.py        # from aafp_py import Request, Response, Agent, ...
│   │   ├── __init__.pyi       # type stubs
│   │   └── py.typed
│   ├── aafp_py/               # native extension package (.so + __init__.py)
│   │   ├── __init__.py
│   │   └── aafp_py.cpython-314-darwin.so
│   └── aafp_transport/        # MCP transport adapter
│       ├── transport.py       # AafpTransport (async wrapper)
│       └── mcp_adapter.py     # aafp_mcp_client() context manager for MCP SDK
└── tests/
    ├── test_simple.py         # high-level API tests (pytest-asyncio)
    ├── test_aafp_mcp.py       # raw JSON-RPC transport tests
    ├── test_cross_sdk.py      # cross-language interop
    └── test_mcp_sdk_interop.py # real MCP SDK client → Rust rmcp server
```

### 1.2 What is exposed today

From `src/lib.rs` (the `#[pymodule]` registration):

```rust
m.add_class::<agent::PyAgent>()?;            // low-level Agent
m.add_class::<transport::PyAafpTransport>()?; // JSON-RPC transport

// Simple API (v1)
m.add_class::<simple::PyRequest>()?;
m.add_class::<simple::PyResponse>()?;
m.add_class::<simple::PySimpleAgent>()?;     // exposed as "Agent"
m.add_class::<simple::PyServeBuilder>()?;
m.add_class::<simple::PyServingAgent>()?;
m.add_class::<simple::PyConnectedAgent>()?;
m.add_class::<simple::PyDiscoveryBuilder>()?;
```

The high-level `aafp` package (`python/aafp/__init__.py`) re-exports these:

```python
from aafp import Agent, Request, Response, ServeBuilder, ServingAgent, ConnectedAgent, DiscoveryBuilder
```

### 1.3 What works

- **Agent lifecycle**: `Agent.bind(addr)`, `Agent.from_keyfile(path)`,
  `agent.shutdown()`, `agent.__del__()` safety net (see segfault mitigation
  notes in `src/lib.rs`).
- **Serving**: `Agent.serve(capability)` → `ServeBuilder` → `.handler(coro)`
  → `.bind(addr)` → `await builder.start()` → `ServingAgent`.
- **Calling**: `await Agent.connect()` → `ConnectedAgent`; `agent.call_at(addr,
  req)` and `agent.discover(cap).call(req)`.
- **Request/Response**: `Request.text(s)`, `Request.data(b)`, `Response.text(s)`,
  `Response.data(b)`. Text XOR binary only.
- **MCP transport**: `AafpTransport` with concurrent send/receive (separate
  locks via `send_handle()`), and `aafp_mcp_client()` async context manager
  that bridges to the Python MCP SDK's anyio streams.
- **Type stubs**: `python/aafp/__init__.pyi` ships hand-written stubs and
  `py.typed` marker.

### 1.4 What is missing (gaps vs. v2 design)

| Gap | v2 Rust feature | Python status |
|-----|-----------------|---------------|
| Structured params | `Params` (CBOR IntMap) | **Not exposed** — only text/binary |
| Capability forwarding | `RequestMetadata.capability` | **Not exposed** — handler can't see cap |
| Per-capability handlers | `on_capability(cap, fn)` | **Not exposed** — only single `handler()` |
| Handler context | `HandlerContext { cancel, capability }` | **Not exposed** — no cancellation token |
| Typed errors | `HandlerError` enum (RFC-0005 codes) | **Not exposed** — errors are flat strings |
| Streaming | `on_streaming`, `ResponseStream`, `ResponseSender` | **Not exposed** — unary only |
| Connection pooling | `PoolConfig`, `PoolStats`, `connect_with_pool` | **Not exposed** — every call dials |
| Discovery failover | loops all candidates | **Not exposed** — tries `[0]` only |
| `discover_by_id` | `DirectCallBuilder` | **Not exposed** |
| Request/response metadata | `trace_id`, `deadline`, `content_type`, `session_id` | **Not exposed** |
| Pythonic ergonomics | — | No decorators, no async generators, no `async with` |
| PyPI packaging | — | Not published; built only via `maturin develop` |
| Python 3.11+ features | — | `requires-python = ">=3.10"`; no `tomllib`/`TaskGroup` use |

### 1.5 Known sharp edges

1. **`ServeBuilder.handler()` mutates in place** — `builder.capability("x")`
   returns `None` and mutates, so it can't be chained. This is un-Pythonic.
2. **Handler signature is `(request) -> Response`** — no context, no
   cancellation, no capability name. Forces body-prefix dispatch hacks
   (the exact problem v2 solves in Rust).
3. **`discover().call()` is not `'static`** — the `PyDiscoveryBuilder` holds an
   `Arc<SdkAgent>` (good), but the underlying Rust v1 `DiscoveryBuilder` borrows
   `&SdkAgent`, so it can't be `tokio::spawn`'d from Python.
4. **Errors surface as generic `PyException`** — `HandlerError` categories are
   lost; Python callers can't distinguish auth from discovery failures.
5. **No streaming** — token-by-token LLM output, progress pushes, and SSE-style
   streaming are impossible without falling back to raw `AafpTransport`.
6. **No connection reuse** — a 5-step agent chain pays 5 ML-DSA-65 handshakes
   (~240µs each) because `call_at`/`discover().call()` always dials fresh.

---

## 2. v2 API Exposure in Python

The v2 Rust API (`SIMPLE_API_V2_DESIGN.md`) adds 10 features. Each maps to a
Python-facing class or method on the PyO3 boundary. The goal: a Python
developer gets the full v2 power without reading any Rust docs.

### 2.1 New PyO3 classes to register

```rust
// src/lib.rs (v2 additions)
m.add_class::<simple::PyParams>()?;
m.add_class::<simple::PyRequestMetadata>()?;
m.add_class::<simple::PyResponseMetadata>()?;
m.add_class::<simple::PyHandlerContext>()?;
m.add_class::<simple::PyHandlerError>()?;
m.add_class::<simple::PyPoolConfig>()?;
m.add_class::<simple::PyPoolStats>()?;
m.add_class::<simple::PyResponseStream>()?;      // async iterator
m.add_class::<simple::PyDirectCallBuilder>()?;   // discover_by_id
```

### 2.2 Params — structured CBOR fields

`Params` wraps a CBOR `IntMap` (integer keys). Python exposure uses builder
chaining plus dict-like access for ergonomics.

```python
from aafp import Params, Request, Response

# Builder style (mirrors Rust)
params = (Params.new()
    .put_str(1, "hello")
    .put_u64(2, 42)
    .put_bytes(3, b"\x00\x01"))

# Dict-like read access
assert params.get_str(1) == "hello"
assert params.get_u64(2) == 42
assert params.get_bytes(3) == b"\x00\x01"

# Build a structured request
req = Request.with_params(params)
resp = await client.discover("greet").call(req)
print(resp.result.get_str(1))
```

**PyO3 design** (`src/simple.rs`):

```rust
#[pyclass(name = "Params", module = "aafp")]
#[derive(Clone)]
pub struct PyParams { inner: aafp_sdk::simple::Params }

#[pymethods]
impl PyParams {
    #[staticmethod]
    fn new() -> Self { Self { inner: Params::new() } }

    fn put_str(mut self, key: i64, value: &str) -> Self { /* ... */ }
    fn put_u64(mut self, key: i64, value: u64) -> Self { /* ... */ }
    fn put_bytes(mut self, key: i64, value: &[u8]) -> Self { /* ... */ }

    fn get_str(&self, key: i64) -> Option<String> { /* ... */ }
    fn get_u64(&self, key: i64) -> Option<u64> { /* ... */ }
    fn get_bytes<'py>(&self, py: Python<'py>, key: i64) -> Option<Bound<'py, PyBytes>> { /* ... */ }

    fn __repr__(&self) -> String { format!("Params({} fields)", self.inner.len()) }
}
```

### 2.3 HandlerContext — cancellation + capability

The v2 handler signature changes from `(request)` to `(request, ctx)`. The
context exposes a cancellation token (fired on client disconnect) and the
capability name.

```python
from aafp import Agent, Request, Response, HandlerError

async def long_task(request, ctx):
    for i in range(100):
        if ctx.cancelled:           # poll-friendly check
            raise HandlerError.cancelled("client disconnected")
        await asyncio.sleep(0.1)
        # ... do work ...
    return Response.text("done")

builder = Agent.serve()
builder.on_capability("long_task", long_task)
server = await builder.start()
```

**PyO3 design**: `PyHandlerContext` wraps the Rust `HandlerContext`. The
`CancellationToken` is exposed as a polled boolean (`ctx.cancelled`) plus an
async `await ctx.cancelled_async()` for `select`-style waiting. Because Python
can't `tokio::select!`, we expose a polling property and an `asyncio.Event`
bridge.

```rust
#[pyclass(name = "HandlerContext", module = "aafp")]
pub struct PyHandlerContext {
    cancel: CancellationToken,
    capability: String,
}

#[pymethods]
impl PyHandlerContext {
    #[getter] fn capability(&self) -> &str { &self.capability }
    #[getter] fn cancelled(&self) -> bool { self.cancel.is_cancelled() }
    fn cancel(&self) { self.cancel.cancel(); }
    // async version: resolves when the token fires
    fn cancelled_async<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> { /* ... */ }
}
```

### 2.4 HandlerError — typed RFC-0005 codes

```python
from aafp import HandlerError

async def sum_handler(request, ctx):
    try:
        a = request.params.get_u64(1)
        b = request.params.get_u64(2)
        if a is None or b is None:
            raise HandlerError.messaging("missing param a or b")
        return Response.with_result(Params.new().put_u64(1, a + b))
    except HandlerError:
        raise
    except Exception as e:
        raise HandlerError.application(str(e)) from e
```

The Python `HandlerError` is a subclass of `Exception` with a `code` property
and classmethod constructors for each RFC-0005 category:

```python
class HandlerError(Exception):
    code: int
    @classmethod
    def transport(cls, msg: str) -> "HandlerError": ...      # 1xxx
    @classmethod
    def authentication(cls, msg: str) -> "HandlerError": ... # 2xxx
    @classmethod
    def authorization(cls, msg: str) -> "HandlerError": ...  # 3xxx
    @classmethod
    def discovery(cls, msg: str) -> "HandlerError": ...      # 4xxx
    @classmethod
    def messaging(cls, msg: str) -> "HandlerError": ...      # 5xxx
    @classmethod
    def capability(cls, msg: str) -> "HandlerError": ...     # 6xxx
    @classmethod
    def protocol(cls, msg: str) -> "HandlerError": ...       # 8xxx
    @classmethod
    def application(cls, msg: str) -> "HandlerError": ...    # 9xxx
    @classmethod
    def cancelled(cls, msg: str = "cancelled") -> "HandlerError": ...
```

On the wire, the Rust side maps `HandlerError` → `RpcErrorObject::new(code,
msg)`. On the client side, a failed call raises the matching `HandlerError`
subclass so Python callers can `except HandlerError.authentication:`.

### 2.5 on_capability — per-capability routing

```python
builder = Agent.serve()
builder.capability("echo")
builder.on_capability("echo", echo_handler)
builder.capability("sum")
builder.on_capability("sum", sum_handler)
builder.capability("uppercase")
builder.on_capability("uppercase", upper_handler)
server = await builder.start()
```

A fallback `handler()` (v1 style) is kept for backward compat and dispatches
based on `ctx.capability`.

---

## 3. Pythonic API Design

The current API is a literal translation of the Rust builder. Python developers
expect decorators, async context managers, and chaining. We add a pure-Python
facade layer in `python/aafp/` that wraps the PyO3 classes.

### 3.1 Decorator-based capability registration

The flagship ergonomic: register handlers with a decorator on an `Agent`
instance, mirroring FastAPI's `@app.get(...)`.

```python
from aafp import Agent, Request, Response, Params

agent = Agent.serve()

@agent.capability("translate")
async def translate(request: Request, ctx) -> Response:
    src = request.params.get_str(1)
    target = request.params.get_str(2)
    text = request.body
    # ... call an LLM ...
    return Response.with_result(
        Params.new().put_str(1, translated_text)
    )

@agent.capability("sum")
async def sum(request: Request, ctx) -> Response:
    a = request.params.get_u64(1)
    b = request.params.get_u64(2)
    return Response.with_result(Params.new().put_u64(1, a + b))

server = await agent.start(bind="127.0.0.1:0")
print(f"serving at {server.addr}")
```

**Implementation** (`python/aafp/decorators.py`):

```python
from typing import Callable, Awaitable
from . import ServeBuilder

class AgentServer:
    """Pythonic facade over ServeBuilder."""
    def __init__(self) -> None:
        self._builder = ServeBuilder()
        self._caps: list[str] = []

    def capability(self, name: str) -> Callable:
        """Decorator: register an async handler for a capability."""
        def decorator(fn: Callable[[Request, "HandlerContext"], Awaitable[Response]]):
            self._builder.capability(name)
            self._builder.on_capability(name, fn)
            self._caps.append(name)
            return fn
        return decorator

    def handler(self, fn: Callable) -> Callable:
        """Register a fallback handler (v1 compat)."""
        self._builder.handler(fn)
        return fn

    def bind(self, addr: str) -> "AgentServer":
        self._builder.bind(addr)
        return self

    def start(self) -> Awaitable["ServingAgent"]:
        return self._builder.start()

def serve() -> AgentServer:
    return AgentServer()
```

### 3.2 Async context manager for serving lifecycle

```python
from aafp import serve

async with serve() as agent:
    @agent.capability("echo")
    async def echo(request, ctx):
        return Response.text(request.body)

    await agent.start(bind="127.0.0.1:0")
    # ... run until cancelled ...
# __aexit__ calls server.stop() automatically
```

### 3.3 Async context manager for clients

```python
async with await Agent.connect() as client:
    resp = await client.discover("echo").call(Request.text("hi"))
    print(resp.body)
# __aexit__ shuts down the underlying QUIC endpoint + pool
```

This wraps `ConnectedAgent` with `__aenter__`/`__aexit__` and calls
`shutdown()` on exit — the same shutdown that prevents the documented
segfault during interpreter teardown.

### 3.4 Type hints + `ParamSpec` for handlers

The stubs (`__init__.pyi`) are extended with full generics. Handler functions
are typed as `Callable[[Request, HandlerContext], Awaitable[Response |
HandlerError]]`. We ship a `Protocol` so user code can be checked with mypy/pyright:

```python
from typing import Protocol, Awaitable

class Handler(Protocol):
    def __call__(self, request: Request, ctx: HandlerContext) -> Awaitable[Response]: ...
```

### 3.5 Chaining builders (fix the mutation sharp edge)

The current `ServeBuilder.capability()` returns `None`. The Pythonic facade
returns `self` so calls chain:

```python
server = await (serve()
    .capability("echo", echo_handler)
    .capability("sum", sum_handler)
    .bind("127.0.0.1:0")
    .start())
```

The PyO3 `ServeBuilder` methods should also be updated to return `&mut Self`
(`#[pyo3(name = "capability")] fn capability(&mut self, ...) -> Self`) so the
raw binding chains too.

---

## 4. Streaming in Python

v2 adds server-streaming and bidirectional handlers. Python's natural fit is
**async generators** (`yield`) on the server and **`async for`** on the client.

### 4.1 Server-side: async generator handler

```python
from aafp import Agent, Request, Response

agent = Agent.serve()

@agent.streaming("token_stream")
async def token_stream(request, ctx):
    """Yield tokens one at a time. Client disconnect cancels ctx."""
    for token in llm_generate(request.body):
        if ctx.cancelled:
            break
        yield Response.text(token)
        await asyncio.sleep(0.05)

server = await agent.start()
```

The PyO3 layer detects that the Python callable is an async generator
(`inspect.isasyncgenfunction`) and bridges it to the Rust
`ServerStreamingHandler` by spawning a task that pumps `__anext__()` into the
`ResponseSender`:

```rust
// Pseudocode for the generator bridge
let py_handler = handler.clone();
builder = builder.on_streaming(cap, move |req, ctx| {
    let locals = task_locals.clone();
    Box::pin(async move {
        Python::attach(|py| {
            // Call the generator factory -> async generator object
            let gen = py_handler.call1(py, (PyRequest{inner:req}, PyHandlerContext{...}))?;
            // Spawn a pump task that loops __anext__ and ctx.sender.send()
        })?;
        // pump loop: while let Some(resp) = gen.__anext__().await { sender.send(resp).await?; }
        Ok(())
    })
});
```

### 4.2 Client-side: `async for` consumption

```python
async with await Agent.connect() as client:
    stream = await client.discover("token_stream").call_streaming(Request.text("Once upon a time"))
    async for chunk in stream:
        print(chunk.body, end="", flush=True)
    # stream closes automatically when the generator exhausts or the loop breaks
```

`PyResponseStream` implements `__aiter__` / `__anext__`, wrapping the Rust
`ResponseStream` (an `mpsc::Receiver`). Each `__anext__` awaits the next frame
and raises `StopAsyncIteration` when the stream ends, or `HandlerError` if the
server sent an error frame.

```rust
#[pyclass(name = "ResponseStream", module = "aafp")]
pub struct PyResponseStream { inner: tokio::sync::Mutex<ResponseStream> }

#[pymethods]
impl PyResponseStream {
    fn __aiter__(slf: Py<Self>) -> Py<Self> { slf }

    fn __anext__<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let inner = self.inner.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut guard = inner.lock().await;
            match guard.next().await {
                Some(Ok(resp)) => Ok(PyResponse { inner: resp }),
                Some(Err(e)) => Err(PyHandlerError::from(e).into()),
                None => Err(pyo3::exceptions::PyStopAsyncIteration::new_err("")),
            }
        })
    }
}
```

### 4.3 Bidirectional streaming

For bidirectional (stream of requests → stream of responses), the server
handler receives an `async for` over incoming requests and yields responses:

```python
@agent.bidirectional("chat")
async def chat(requests, ctx):
    async for req in requests:
        yield Response.text(await respond(req.body))
```

This maps to the Rust `BidirectionalHandler` that takes an
`mpsc::Receiver<Request>` and a `ResponseSender`.

---

## 5. Connection Pooling from Python

v2 integrates `ConnectionPool` into `ConnectedAgent`. Python exposes
`PoolConfig` and `PoolStats` so users can tune and observe the pool.

### 5.1 PoolConfig

```python
from aafp import Agent, PoolConfig

config = PoolConfig(
    max_size=50,              # max connections per peer
    idle_timeout=120.0,       # seconds before idle conn is closed
    health_check_interval=30.0,
)

client = await Agent.connect().connect_with_pool(config)
# First call: establishes connection (~240µs handshake)
r1 = await client.discover("echo").call(Request.text("hello"))
# Second call: reuses connection (~14µs)
r2 = await client.discover("echo").call(Request.text("world"))
```

**PyO3**:

```rust
#[pyclass(name = "PoolConfig", module = "aafp")]
#[derive(Clone)]
pub struct PyPoolConfig { inner: aafp_sdk::simple::PoolConfig }

#[pymethods]
impl PyPoolConfig {
    #[new]
    #[pyo3(signature = (max_size=32, idle_timeout=60.0, health_check_interval=30.0))]
    fn new(max_size: usize, idle_timeout: f64, health_check_interval: f64) -> Self { /* ... */ }
}
```

### 5.2 PoolStats

```python
stats = client.pool_stats()
print(stats.active_connections)   # 3
print(stats.idle_connections)     # 2
print(stats.total_handshakes)     # 5
print(stats.handshake_failures)   # 0
print(stats.avg_handshake_us)     # 241
```

`PoolStats` is a `#[pyclass]` with `#[getter]`s backed by the lock-free
`AtomicU64` counters in `AgentMetrics`.

### 5.3 Session affinity

The pool routes by session ID so the same logical session reuses the same
connection. This is transparent to Python callers — they just call
`discover().call()` repeatedly and get the speedup.

---

## 6. Discovery from Python

### 6.1 Failover

v2 `DiscoveryBuilderV2` loops all candidates. Python exposes this directly:

```python
async with await Agent.connect() as client:
    # Tries all discovered agents for "translate" until one succeeds
    resp = await client.discover("translate").call(Request.text("hello"))
```

If all candidates fail, a `HandlerError.discovery("all candidates failed")` is
raised carrying the last error in `__cause__`.

### 6.2 discover_by_id

```python
from aafp import AgentId

agent_id = AgentId.from_hex("deadbeef...")  # 32 bytes
async with await Agent.connect() as client:
    resp = await client.discover_by_id(agent_id).call(Request.text("hi"))
```

`PyDirectCallBuilder` wraps the Rust `DirectCallBuilder`. `AgentId` is a small
`#[pyclass]` around `[u8; 32]` with `from_hex`/`to_hex`/`from_bytes`.

### 6.3 'static discovery (spawnable)

Because v2 uses `Arc<SdkAgent>`, the `DiscoveryBuilder` is `'static` and can be
moved into a `asyncio.create_task`:

```python
async with await Agent.connect() as client:
    discover = client.discover("echo")  # 'static, owns Arc
    task = asyncio.create_task(discover.call(Request.text("hi")))
    resp = await task
```

This was impossible in v1 because the builder borrowed `&SdkAgent`.

---

## 7. FastAPI / Flask Integration

A common deployment: expose an AAFP agent as an HTTP web service for browser
clients or non-AAFP backends. We provide an optional `aafp.web` integration
package.

### 7.1 FastAPI bridge

```python
from fastapi import FastAPI
from aafp import Agent, Request
from aafp.web import AafpClient

app = FastAPI()

@app.on_event("startup")
async def startup():
    app.state.aafp = await Agent.connect()

@app.on_event("shutdown")
async def shutdown():
    await app.state.aafp.shutdown()

@app.post("/translate")
async def translate(body: dict):
    client: AafpClient = app.state.aafp
    req = Request.with_params(
        Params.new().put_str(1, body["text"]).put_str(2, body["target"])
    )
    resp = await client.discover("translate").call(req)
    return {"translation": resp.result.get_str(1)}
```

### 7.2 Streaming via SSE

```python
from fastapi.responses import StreamingResponse

@app.get("/stream/{prompt}")
async def stream(prompt: str):
    client = app.state.aafp
    async def gen():
        stream = await client.discover("token_stream").call_streaming(Request.text(prompt))
        async for chunk in stream:
            yield f"data: {chunk.body}\n\n"
        yield "data: [DONE]\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")
```

### 7.3 Flask (sync wrapper)

For Flask, a thread-pool adapter runs the async AAFP calls:

```python
from flask import Flask, jsonify
from aafp.web.sync import AafpSyncClient

app = Flask(__name__)
aafp = AafpSyncClient()  # starts a background asyncio loop

@app.route("/translate", methods=["POST"])
def translate():
    resp = aafp.discover("translate").call(Request.text(request.json["text"]))
    return jsonify({"translation": resp.result.get_str(1)})
```

`AafpSyncClient` runs an asyncio event loop on a daemon thread and bridges
sync calls via `asyncio.run_coroutine_threadsafe`.

### 7.4 Serving an AAFP agent behind a web framework

The reverse direction — a FastAPI app that *is* an AAFP agent — uses the
decorator API and runs the AAFP server in a background task:

```python
from fastapi import FastAPI
from aafp import serve

app = FastAPI()
aafp_server = serve()

@aafp_server.capability("search")
async def search(request, ctx):
    return Response.text(do_search(request.body))

@app.on_event("startup")
async def startup():
    app.state.server = await aafp_server.start(bind="127.0.0.1:0")

@app.on_event("shutdown")
async def shutdown():
    app.state.server.stop()
```

---

## 8. Jupyter Notebook Integration

Notebooks are a key audience for agent-to-agent calls (researchers prototyping
LLM pipelines). Two ergonomics matter: top-level `await` and rich display.

### 8.1 Top-level await

Because `aafp` uses `asyncio`, and Jupyter runs an event loop, top-level
`await` works out of the box:

```python
# In [1]:
from aafp import Agent, Request
client = await Agent.connect()

# In [2]:
resp = await client.discover("echo").call(Request.text("hello notebook"))
print(resp.body)
```

### 8.2 `aafp.notebook` helpers

A small helper module for common notebook patterns:

```python
from aafp.notebook import discover, call, stream

# One-liner discovery + call
print(await call("echo", "hello"))

# Stream tokens into the notebook output cell
await stream("token_stream", "Once upon a time", display=True)
```

`display=True` uses `IPython.display.display` with `update=True` to render
tokens incrementally in the cell output.

### 8.3 Connection persistence across cells

The `client` object persists across cells (it's just a module-level variable).
The connection pool keeps the QUIC connection warm, so repeated `discover`
calls in successive cells reuse the same connection — no repeated handshakes.

### 8.4 Cleanup hook

Notebooks don't run `__aexit__` reliably. We register an IPython shutdown hook
to call `client.shutdown()` on kernel exit, preventing the segfault documented
in `src/lib.rs`:

```python
# aafp/notebook.py
def _register_cleanup(client):
    import atexit, IPython
    atexit.register(lambda: asyncio.run(client.shutdown()))
    try:
        IPython.get_ipython().events.register("shutdown", lambda: asyncio.run(client.shutdown()))
    except Exception:
        pass
```

---

## 9. PyPI Packaging

### 9.1 Package name and layout

- **PyPI name**: `aafp`
- **Import name**: `aafp` (high-level), `aafp_py` (native ext), `aafp_transport` (MCP adapter)
- **Wheel**: `maturin` builds a Python wheel containing the `.so`/`.pyd` plus
  the pure-Python facade.

`pyproject.toml` (updated):

```toml
[build-system]
requires = ["maturin>=1.5,<2.0"]
build-backend = "maturin"

[project]
name = "aafp"
version = "0.2.0"
description = "AAFP — Agent-Agent First Networking Protocol (Python SDK)"
requires-python = ">=3.11"
license = { text = "MIT OR Apache-2.0" }
classifiers = [
    "Programming Language :: Python :: 3",
    "Programming Language :: Python :: 3.11",
    "Programming Language :: Python :: 3.12",
    "Programming Language :: Python :: 3.13",
    "Programming Language :: Rust",
    "License :: OSI Approved :: MIT License",
    "License :: OSI Approved :: Apache Software License",
    "Operating System :: POSIX :: Linux",
    "Operating System :: MacOS :: MacOS X",
    "Operating System :: Microsoft :: Windows",
    "Topic :: Internet",
    "Topic :: Software Development :: Libraries",
]
dependencies = [
    "typing_extensions>=4.7; python_version < '3.12'",
]

[project.optional-dependencies]
mcp = ["mcp>=1.0", "anyio>=4.0", "pydantic>=2.0"]
web = ["fastapi>=0.100", "starlette"]
notebook = ["ipython>=8.0", "anyio>=4.0"]
dev = ["pytest>=7.0", "pytest-asyncio>=0.21", "mypy", "ruff"]

[tool.maturin]
features = ["pyo3/extension-module"]
python-source = "python"
module-name = "aafp_py.aafp_py"
```

### 9.2 Wheel building

```bash
# Local dev install
maturin develop --release

# Build wheels for current platform
maturin build --release

# Build + publish
maturin build --release --out dist
twine upload dist/*
```

### 9.3 manylinux / cross-platform CI

Use `maturin`'s GitHub Action with the `manylinux` Docker images for Linux
wheels. ML-DSA-65 (`aafp-crypto`) depends on `liboqs`-based routines compiled
into the Rust crate, so the wheel is self-contained (no system liboqs needed).

```yaml
# .github/workflows/wheels.yml
jobs:
  linux:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        target: [x86_64, aarch64]
    steps:
      - uses: actions/checkout@v4
      - uses: PyO3/maturin-action@v1
        with:
          target: ${{ matrix.target }}
          manylinux: auto
          command: build
          args: --release --out dist
      - uses: actions/upload-artifact@v4
        with: { name: wheels, path: dist/ }
  macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: PyO3/maturin-action@v1
        with: { command: build, args: --release --out dist --universal2 }
  windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: PyO3/maturin-action@v1
        with: { command: build, args: --release --out dist }
```

### 9.4 abi3 / stable ABI

Consider building with `pyo3/abi3-py311` to produce a single abi3 wheel that
works on Python 3.11+ without per-version rebuilds. This reduces the wheel
matrix from (3.11, 3.12, 3.13, 3.14) × (linux, mac, win) × (x86_64, aarch64)
= 24 wheels down to 6. Trade-off: abi3 cannot use CPython internals not in the
stable ABI; PyO3 supports this well for 3.11+.

```toml
[tool.maturin]
features = ["pyo3/extension-module", "pyo3/abi3-py311"]
```

### 9.5 sdist

Ship an sdist too (`maturin build --sdist`) so downstream packagers (Conda,
Nix) can build from source. The sdist includes the Rust crate source.

---

## 10. Python 3.11+ Features

### 10.1 `tomllib` for config

Python 3.11 ships `tomllib` in the stdlib. Use it for agent config files
instead of adding a dependency:

```python
# aafp/config.py
import tomllib
from pathlib import Path
from aafp import PoolConfig

def load_config(path: str | Path) -> "AgentConfig":
    with open(path, "rb") as f:
        data = tomllib.load(f)
    return AgentConfig(
        bind=data.get("bind", "127.0.0.1:0"),
        seeds=data.get("seeds", []),
        pool=PoolConfig(**data.get("pool", {})),
        capabilities=data.get("capabilities", []),
    )
```

Example `aafp.toml`:

```toml
bind = "127.0.0.1:0"
seeds = ["quic://bootstrap.aafp.io:4433"]

[pool]
max_size = 50
idle_timeout = 120.0

[capabilities]
translate = "aafp_agents.translate:translate"
sum = "aafp_agents.math:sum"
```

### 10.2 `ExceptionGroup` for multi-agent failures

When a `TaskGroup` runs several agent calls and some fail, Python 3.11+ raises
an `ExceptionGroup`. We map AAFP `HandlerError`s into the group so callers can
inspect per-agent failures:

```python
import asyncio
from aafp import Agent, Request, HandlerError

async with await Agent.connect() as client:
    async with asyncio.TaskGroup() as tg:
        t1 = tg.create_task(client.discover("a").call(Request.text("1")))
        t2 = tg.create_task(client.discover("b").call(Request.text("2")))
        t3 = tg.create_task(client.discover("c").call(Request.text("3")))
    # If b and c fail, tg raises ExceptionGroup with two HandlerError instances
# Catch the group:
try:
    await run_all()
except* HandlerError as eg:
    for e in eg.exceptions:
        print(f"capability failed: {e.code} {e}")
```

The `except*` syntax (3.11+) splits the group by type, so callers can handle
`HandlerError.discovery` separately from `HandlerError.messaging`.

### 10.3 `TaskGroup` for agent management

A long-running service that fans out to many agents can use `TaskGroup` to
manage them with structured concurrency:

```python
import asyncio
from aafp import Agent, Request

async def fan_out(client, cap, items):
    async with asyncio.TaskGroup() as tg:
        tasks = [tg.create_task(client.discover(cap).call(Request.text(item)))
                 for item in items]
    return [t.result() for t in tasks]
```

If one call is cancelled (client disconnect), the `TaskGroup` cancels the
siblings — matching the v2 `HandlerContext.cancel` semantics on the server
side.

### 10.4 `Self` type for builder chaining

Use `typing.Self` (3.11+) in the stubs for fluent builders:

```python
# aafp/__init__.pyi
from typing import Self

class ServeBuilder:
    def capability(self, cap: str) -> Self: ...
    def on_capability(self, cap: str, fn: Handler) -> Self: ...
    def bind(self, addr: str) -> Self: ...
    def start(self) -> Awaitable[ServingAgent]: ...
```

### 10.5 `asyncio.timeout` for deadlines

Python 3.11 adds `asyncio.timeout`. Map it to the v2 `RequestMetadata.deadline`:

```python
async with asyncio.timeout(5.0):
    resp = await client.discover("slow").call(Request.text("x"))
```

The client can also set the wire deadline so the server enforces it:

```python
req = Request.text("x").with_deadline("2025-07-05T12:00:05Z")
resp = await client.discover("slow").call(req)
```

---

## 11. Testing Python Agents

### 11.1 pytest fixtures

Ship a `aafp.testing` module with fixtures that spin up ephemeral agents:

```python
# conftest.py
import pytest
from aafp.testing import agent_factory, echo_agent

@pytest.fixture
async def client():
    async with await Agent.connect() as c:
        yield c

@pytest.fixture
async def echo_server():
    async with echo_agent(bind="127.0.0.1:0") as srv:
        yield srv
```

`echo_agent` is a built-in fixture agent that echoes `request.body` — useful as
a known-good peer for testing your own client logic.

### 11.2 Mock agents

`aafp.testing.MockAgent` records calls and returns canned responses, so you
can test handlers without a real network:

```python
from aafp.testing import MockAgent

async def test_translate_handler():
    mock = MockAgent()
    mock.set_response("translate", Response.with_result(Params.new().put_str(1, "hola")))

    # Inject the mock as the discovery backend
    handler = make_translate_handler(mock)
    resp = await handler(Request.text("hello"), ctx=mock.ctx())
    assert resp.result.get_str(1) == "hola"
    assert mock.calls[0].capability == "translate"
```

### 11.3 Conformance from Python

The Rust `aafp-conformance` crate defines RFC golden traces. We expose a
Python runner so conformance can be checked from Python:

```python
from aafp.conformance import run_conformance, ConformanceReport

report: ConformanceReport = await run_conformance(
    agent=client,
    suite="rfc-0002-handshake",
)
assert report.passed
print(report.summary)
# → 42/42 passed, 0 failed, 0 skipped
```

This wraps the Rust conformance harness via PyO3 and lets CI run both Rust and
Python conformance from a single `pytest` invocation.

### 11.4 pytest-asyncio config

`pyproject.toml` already sets `asyncio_mode = "auto"`. Keep that so all
`async def test_*` functions are automatically awaited.

### 11.5 Example test suite

```python
import pytest
from aafp import Agent, Request, Response, Params, HandlerError
from aafp.testing import echo_agent

@pytest.mark.asyncio
async def test_structured_params_roundtrip():
    async with echo_agent(structured=True) as srv, await Agent.connect() as c:
        req = Request.with_params(Params.new().put_str(1, "hi").put_u64(2, 42))
        resp = await c.call_at(srv.addr, req)
        assert resp.result.get_str(1) == "hi"
        assert resp.result.get_u64(2) == 42

@pytest.mark.asyncio
async def test_streaming():
    async with token_stream_agent() as srv, await Agent.connect() as c:
        stream = await c.discover("token_stream").call_streaming(Request.text("go"))
        tokens = [chunk.body async for chunk in stream]
        assert tokens == ["t0", "t1", "t2"]

@pytest.mark.asyncio
async def test_typed_error():
    async with failing_agent() as srv, await Agent.connect() as c:
        with pytest.raises(HandlerError) as ei:
            await c.discover("fail").call(Request.text("x"))
        assert ei.value.code == 9000  # application error

@pytest.mark.asyncio
async def test_connection_reuse():
    async with echo_agent() as srv, await Agent.connect() as c:
        await c.discover("echo").call(Request.text("a"))  # handshake
        stats_before = c.pool_stats()
        await c.discover("echo").call(Request.text("b"))  # reuse
        stats_after = c.pool_stats()
        assert stats_after.total_handshakes == stats_before.total_handshakes
```

---

## 12. Implementation Phases

### Phase A — v2 surface (weeks 1–2)
- Add `PyParams`, `PyRequestMetadata`, `PyResponseMetadata`, `PyHandlerContext`,
  `PyHandlerError` to `src/simple.rs`.
- Update `PyRequest`/`PyResponse` to carry `params` and `metadata`.
- Add `on_capability()` to `PyServeBuilder`; keep `handler()` as v1 fallback.
- Update handler bridge to pass `(request, ctx)` and convert `HandlerError`.
- Update `__init__.pyi` stubs.

### Phase B — pooling + discovery (weeks 3–4)
- Add `PyPoolConfig`, `PyPoolStats`, `PyAgentId`, `PyDirectCallBuilder`.
- Wire `connect_with_pool(config)` and `discover_by_id(agent_id)`.
- Expose failover (already in Rust v2) — just ensure errors surface as
  `HandlerError.discovery`.

### Phase C — streaming (weeks 5–6)
- Add `PyResponseStream` with `__aiter__`/`__anext__`.
- Add `on_streaming()` to `PyServeBuilder` with async-generator bridge.
- Add `call_streaming()` to `PyDiscoveryBuilder`.
- Add bidirectional support (`on_bidirectional`).

### Phase D — Pythonic facade (week 7)
- `python/aafp/decorators.py`: `serve()`, `@agent.capability(...)`,
  `@agent.streaming(...)`.
- `python/aafp/async_cm.py`: `__aenter__`/`__aexit__` wrappers for
  `ConnectedAgent` and `ServingAgent`.
- Fix `ServeBuilder` chaining (return `Self`).

### Phase E — integrations (week 8)
- `aafp.web` (FastAPI + Flask bridges).
- `aafp.notebook` (Jupyter helpers, cleanup hook).
- `aafp.testing` (fixtures, `MockAgent`, conformance runner).

### Phase F — packaging + release (week 9)
- Bump `requires-python` to `>=3.11`; enable `abi3-py311`.
- Set up `manylinux` CI workflow.
- Publish `aafp 0.2.0` to PyPI.
- Update `INTEROP_RESULTS.md` with v2 Python interop results.

### Phase G — testing (week 10)
- Extend `tests/test_simple.py` with v2 cases (params, ctx, errors).
- Add `tests/test_streaming.py`, `tests/test_pool.py`, `tests/test_discovery.py`.
- Add `tests/test_decorators.py` for the facade.
- Run full MCP interop suite against v2.

---

## 13. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Async generator bridge across GIL/tokio boundary is complex | Prototype in Phase C first; fall back to callback-based `sender.send()` API if `yield` bridge is unstable |
| `abi3-py311` may miss needed CPython APIs | Validate against `TaskGroup`/`ExceptionGroup` usage in Phase F; fall back to per-version wheels |
| ML-DSA-65 build complexity on Windows | Pre-build `aafp-crypto` deps; use `maturin` cross-compile; provide Windows wheel in CI |
| Segfault on teardown (documented in `src/lib.rs`) | Keep the `shutdown()` + `__del__` safety net; add `aafp.notebook` cleanup hook; add `pytest` fixture finalizers |
| Breaking v1 users | Keep `handler()` and `Request.text()` working; v2 is additive; deprecation warnings only in 0.3 |

---

## 14. Success Criteria

- A Python developer can build a multi-capability streaming agent in <20 lines
  using `@agent.capability(...)` and `yield`.
- `pip install aafp` works on Linux/macOS/Windows for Python 3.11–3.14.
- A 5-call chain reuses connections (handshake count = 1, not 5).
- `HandlerError` subclasses let callers `except
  HandlerError.authentication:` instead of parsing strings.
- Jupyter notebook can `await client.discover("...").call(...)` at top level
  with no boilerplate.
- Full MCP SDK interop (Python client → Rust rmcp server) still passes on v2.
- Conformance suite runs from `pytest` and reports pass/fail per RFC.

---

## Appendix A — Full Decorator Example

```python
"""A complete AAFP agent using the v2 Pythonic API."""
from __future__ import annotations
import asyncio
from aafp import serve, Agent, Request, Response, Params, HandlerError

agent = serve()

@agent.capability("translate")
async def translate(request: Request, ctx) -> Response:
    text = request.body
    target = request.params.get_str(1) or "en"
    if not text:
        raise HandlerError.messaging("empty text")
    # ... call an LLM ...
    return Response.with_result(Params.new().put_str(1, f"[{target}] {text}"))

@agent.capability("sum")
async def sum(request: Request, ctx) -> Response:
    a = request.params.get_u64(1)
    b = request.params.get_u64(2)
    if a is None or b is None:
        raise HandlerError.messaging("missing a or b")
    return Response.with_result(Params.new().put_u64(1, a + b))

@agent.streaming("token_stream")
async def token_stream(request, ctx):
    for token in request.body.split():
        if ctx.cancelled:
            break
        yield Response.text(token)
        await asyncio.sleep(0.05)

async def main():
    server = await agent.start(bind="127.0.0.1:0")
    print(f"serving at {server.addr} (id={server.id})")

    async with await Agent.connect() as client:
        # Unary
        r = await client.discover("sum").call(
            Request.with_params(Params.new().put_u64(1, 5).put_u64(2, 7))
        )
        assert r.result.get_u64(1) == 12

        # Streaming
        stream = await client.discover("token_stream").call_streaming(
            Request.text("once upon a time")
        )
        async for chunk in stream:
            print(chunk.body, end=" ")
        print()

    server.stop()

asyncio.run(main())
```

## Appendix B — PyO3 Handler Bridge (reference)

```rust
// src/simple.rs — v2 on_capability bridge
fn on_capability(&mut self, cap: &str, handler: Py<PyAny>) {
    let handler = handler.clone_ref(self.py());  // captured per-call instead
    // ... store in capability_handlers ...
}

// At start(), wrap each Python handler:
builder = builder.on_capability(cap.clone(), move |req, ctx| {
    let py_handler = handler.clone();
    let locals = task_locals.clone();
    Box::pin(async move {
        let coro = Python::attach(|py| {
            let py_req = PyRequest { inner: req };
            let py_ctx = PyHandlerContext { cancel: ctx.cancel.clone(), capability: ctx.capability.clone() };
            let args = PyTuple::new(py, [Py::new(py, py_req)?, Py::new(py, py_ctx)?])?;
            pyo3_async_runtimes::into_future_with_locals(
                &locals,
                py_handler.call1(py, args)?.into_bound(py),
            )
        })??;
        let result = coro.await.map_err(|e| e.to_string())?;
        Python::attach(|py| {
            let resp: PyRef<PyResponse> = result.bind(py).extract()
                .map_err(|e| format!("handler must return Response: {e}"))?;
            Ok::<_, String>(resp.inner.clone())
        })
    })
});
```

## Appendix C — Migration Cheatsheet

| v1 (today) | v2 (target) |
|------------|-------------|
| `builder.handler(fn)` | `builder.on_capability("cap", fn)` or `@agent.capability("cap")` |
| `async def fn(req)` | `async def fn(req, ctx)` |
| `Request.text(s)` | `Request.text(s)` (still works) or `Request.with_params(...)` |
| `resp.body` | `resp.body` (text) or `resp.result.get_str(1)` (structured) |
| `raise Exception("x")` | `raise HandlerError.messaging("x")` |
| `await client.discover("c").call(req)` | same (now with failover + pooling) |
| `await client.call_at(addr, req)` | same |
| — | `await client.discover("c").call_streaming(req)` → `async for` |
| — | `await client.discover_by_id(agent_id).call(req)` |
| — | `client.pool_stats()` |
| — | `async with await Agent.connect() as client:` |

---

**End of document.** Target: ship `aafp 0.2.0` to PyPI with the above within
10 weeks of v2 Rust API landing.
