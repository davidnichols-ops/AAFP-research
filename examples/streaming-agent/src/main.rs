//! Streaming agent example (v2).
//!
//! A server that streams "token_0", "token_1", ..., "token_9" with 100ms delay.
//! A client that connects and prints each token as it arrives.
//!
//! Run with: `cargo run -p streaming-agent`

use aafp_sdk::simple::{Agent, HandlerError, Request, Response};
use std::time::Duration;

#[tokio::main]
async fn main() {
    // Start the streaming server
    let serving = Agent::serve()
        .capability("token-stream")
        .on_streaming("token-stream", |_req, ctx| async move {
            println!("[server] streaming started");
            for i in 0..10 {
                if ctx.cancel.is_cancelled() {
                    println!("[server] cancelled at token {i}");
                    return Ok(());
                }
                let token = format!("token_{i}");
                println!("[server] sending {token}");
                ctx.sender
                    .send(Response::text(token))
                    .await
                    .map_err(|_| HandlerError::Application("stream closed".to_string()))?;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            println!("[server] streaming complete");
            Ok(())
        })
        .start()
        .await
        .expect("failed to start serving agent");

    println!("[server] listening at {}", serving.addr());
    println!("[server] agent id: {}", hex::encode(serving.id()));
    println!();

    // Give the server time to bind
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Connect a client
    let mut client = Agent::connect().connect().await.expect("connect failed");
    client
        .register(serving.record())
        .expect("failed to register server record");

    println!("[client] calling token-stream...");

    // Call with streaming (using direct address for the example)
    let mut stream = client
        .call_streaming_at(serving.addr(), "token-stream", Request::text("generate"))
        .await
        .expect("streaming call failed");

    println!("[client] streaming response:");
    let mut count = 0;
    while let Some(result) = stream.next().await {
        match result {
            Ok(resp) => {
                println!("  -> {}", resp.body());
                count += 1;
            }
            Err(e) => {
                eprintln!("  [error] {e}");
                break;
            }
        }
    }

    println!();
    println!("[client] received {count} tokens total");

    // Clean up
    serving.stop();
    println!("[server] stopped");
}
