use aafp_sdk::simple::{Agent, Request, Response};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Starting echo agent...");

    let server = Agent::serve()
        .capability("echo")
        .handler(|req: Request| async move { Ok(Response::text(req.body().to_string())) })
        .start()
        .await?;

    println!("Agent ID:     {}", hex::encode(server.id()));
    println!("Address:      {}", server.addr());
    println!("Capabilities: echo");
    println!();
    println!("Call from another terminal:");
    println!("  aafp call echo \"hello\" --addr {}", server.addr());
    println!();
    println!("Press Ctrl+C to stop.");

    tokio::signal::ctrl_c().await?;
    server.stop();
    Ok(())
}
