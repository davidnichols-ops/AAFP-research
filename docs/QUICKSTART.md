# AAFP Quickstart

Get a working agent running in 5 minutes. No prior knowledge needed.

---

## 1. Install (30 seconds)

```bash
git clone https://github.com/davidnichols-ops/AAFP-research.git
cd AAFP-research/implementations/rust
cargo build --release
```

The CLI is now at `./target/release/aafp`. Add it to your PATH (optional):

```bash
export PATH="$PWD/target/release:$PATH"
```

**Expected output:**

```
Finished `release` profile [optimized] target(s)
```

---

## 2. Start an Agent (1 minute)

Open a terminal and run:

```bash
aafp serve --capability echo
```

This starts an agent that responds with whatever you send it.

**Expected output:**

```
  AAFP Agent Serving

  Agent ID:     c31810a6
  Address:      quic://127.0.0.1:52069
  Capabilities: echo

  Press Ctrl+C to stop.
```

Note the **Address** line — you'll need it in the next step.

---

## 3. Call the Agent (30 seconds)

Open a **new terminal** in the same directory. Use the address from step 2:

```bash
aafp call echo "hello" --addr quic://127.0.0.1:52069
```

**Expected output:**

```
hello
```

That's it — you just sent a message to an agent and got a response.

---

## 4. Build Your Own Agent (2 minutes)

Create a new Rust project:

```bash
cargo new my-agent
cd my-agent
```

Add `aafp-sdk` and `tokio` to `Cargo.toml`:

```toml
[dependencies]
aafp-sdk = { path = "../../AAFP-research/implementations/rust/crates/aafp-sdk" }
tokio = { version = "1", features = ["full"] }
```

Replace `src/main.rs` with:

```rust
use aafp_sdk::simple::{Agent, Request, Response};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    Agent::serve()
        .capability("greet")
        .handler(|req: Request| async move {
            Ok(Response::text(format!("Hello, {}!", req.body())))
        })
        .start()
        .await?;
    Ok(())
}
```

Run it:

```bash
cargo run
```

**Expected output:**

```
  AAFP Agent Serving

  Agent ID:     a1b2c3d4
  Address:      quic://127.0.0.1:54321
  Capabilities: greet

  Press Ctrl+C to stop.
```

In another terminal, call it:

```bash
aafp call greet "World" --addr quic://127.0.0.1:54321
```

**Expected output:**

```
Hello, World!
```

---

## 5. Docker (30 seconds)

Run 3 agents that can discover and talk to each other:

```bash
cd AAFP-research
docker compose up
```

**Expected output:**

```
[+] Running 3/3
 ✔ Container aafp-relay    Started
 ✔ Container aafp-agent-1  Started
 ✔ Container aafp-agent-2  Started
```

The three containers can find and talk to each other automatically.

---

## 6. What's Next?

| Command | What it does |
|---------|-------------|
| `aafp quickstart` | Interactive setup wizard |
| `aafp peers` | See who's on the network |
| `aafp metrics` | Check agent health and stats |
| `aafp health` | Quick health check (exit 0 = healthy) |
| `aafp serve --help` | See all serve options |
| `aafp call --help` | See all call options |

---

## Tips

- **No identity file?** The CLI auto-generates one and saves it as `aafp-identity.bin`.
- **Want a custom handler?** Use the Rust API (section 4) — your handler gets the request text and returns a response.
- **Calling from code?** Use `agent.call_at(addr, Request::text("hello"))` to call any agent by address.
- **Multiple capabilities?** `aafp serve --capability echo --capability translate --capability summarize`
