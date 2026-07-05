# Multi-Agent Chat

Three agents (Alice, Bob, Carol) that exchange messages with each other.

## Run

```bash
cargo run
```

**Expected output:**

```
Starting 3-agent chat demo...

Alice is at quic://127.0.0.1:53001
Bob is at   quic://127.0.0.1:53002
Carol is at quic://127.0.0.1:53003

Alice sends "Hello!" to Bob:
  [Bob]   received: "Hello!"
  -> Bob got: Hello!

Bob sends "Hi!" to Carol:
  [Carol] received: "Hi!"
  -> Carol got: Hi!

Carol sends "Hey!" to Alice:
  [Alice] received: "Hey!"
  -> Alice got: Hey!

Chat demo complete!
```

## How It Works

Three agents are created, each with the "chat" capability:

```rust
let alice = Agent::serve()
    .capability("chat")
    .handler(|req| async move {
        println!("Alice received: {}", req.body());
        Ok(Response::text(format!("Alice got: {}", req.body())))
    })
    .start().await?;
```

A client sends messages between them:

```rust
let client = Agent::connect().connect().await?;

// Alice sends to Bob
client.call_at(bob.addr(), Request::text("Hello!")).await?;

// Bob sends to Carol
client.call_at(carol.addr(), Request::text("Hi!")).await?;

// Carol sends to Alice
client.call_at(alice.addr(), Request::text("Hey!")).await?;
```

Each agent receives the message, prints it, and sends a confirmation back.
In a real app, each agent could run on a different machine — the code
is the same regardless of where the agents live.
