# Translation Pipeline

Three agents chained together: **uppercase** → **reverse** → **base64-encode**.

Each agent is independent and can be called on its own. The pipeline
demonstrates how to chain agents by feeding the output of one into the next.

## Run

```bash
cargo run
```

**Expected output:**

```
Starting translation pipeline (3 agents)...

[uppercase] listening at quic://127.0.0.1:53001
[reverse]   listening at quic://127.0.0.1:53002
[encode]    listening at quic://127.0.0.1:53003

Input:    hello
Uppercase: HELLO
Reverse:  OLLEH
Encoded:  T0xMRUg=

Pipeline complete: "hello" -> "T0xMRUg="
```

## How It Works

Each agent is created with `Agent::serve()` and a different capability:

```rust
// Agent 1: converts text to uppercase
Agent::serve()
    .capability("uppercase")
    .handler(|req| async move { Ok(Response::text(req.body().to_uppercase())) })
    .start().await?;

// Agent 2: reverses text
Agent::serve()
    .capability("reverse")
    .handler(|req| async move { Ok(Response::text(req.body().chars().rev().collect())) })
    .start().await?;

// Agent 3: base64 encodes text
Agent::serve()
    .capability("encode")
    .handler(|req| async move { Ok(Response::text(base64::encode(req.body()))) })
    .start().await?;
```

The pipeline calls each agent in sequence, passing the output of one
as the input to the next:

```rust
let step1 = client.call_at(uppercase.addr(), Request::text("hello")).await?;
let step2 = client.call_at(reverse.addr(), Request::text(step1.body())).await?;
let step3 = client.call_at(encode.addr(), Request::text(step2.body())).await?;
```

In a real system, these agents could run on different machines —
the pipeline works the same way regardless of where the agents live.
