# Echo Agent

A minimal AAFP agent that echoes back whatever you send it. ~15 lines of Rust.

## Run

**Terminal 1 — start the agent:**

```bash
cargo run
```

Wait for it to print the address, e.g. `quic://127.0.0.1:52069`.

**Terminal 2 — call it:**

```bash
# From the AAFP repo root:
./implementations/rust/target/release/aafp call echo "hello" --addr quic://127.0.0.1:52069
```

**Expected output:**

```
hello
```

## How It Works

The agent uses the AAFP simple API:

```rust
Agent::serve()
    .capability("echo")
    .handler(|req| async move { Ok(Response::text(req.body())) })
    .start().await?;
```

- `Agent::serve()` creates a serving agent
- `.capability("echo")` declares what this agent can do
- `.handler(...)` sets the function that handles requests
- `.start()` binds to a local port and begins accepting calls

That's it. No network configuration, no certificates, no boilerplate.
