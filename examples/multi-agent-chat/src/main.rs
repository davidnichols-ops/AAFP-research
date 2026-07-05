use aafp_sdk::simple::{Agent, Request, Response};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Starting 3-agent chat demo...");
    println!();

    // Create three agents: Alice, Bob, Carol
    // Each has the "chat" capability and prints messages it receives

    let alice = Agent::serve()
        .capability("chat")
        .handler(|req: Request| async move {
            let msg = req.body().to_string();
            println!("  [Alice] received: \"{}\"", msg);
            Ok(Response::text(format!("Alice got: {}", msg)))
        })
        .start()
        .await?;
    println!("Alice is at {}", alice.addr());

    let bob = Agent::serve()
        .capability("chat")
        .handler(|req: Request| async move {
            let msg = req.body().to_string();
            println!("  [Bob]   received: \"{}\"", msg);
            Ok(Response::text(format!("Bob got: {}", msg)))
        })
        .start()
        .await?;
    println!("Bob is at   {}", bob.addr());

    let carol = Agent::serve()
        .capability("chat")
        .handler(|req: Request| async move {
            let msg = req.body().to_string();
            println!("  [Carol] received: \"{}\"", msg);
            Ok(Response::text(format!("Carol got: {}", msg)))
        })
        .start()
        .await?;
    println!("Carol is at {}", carol.addr());
    println!();

    // Give agents time to bind
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Create a client to send messages on behalf of each agent
    let client = Agent::connect().connect().await?;

    // Alice sends "Hello!" to Bob
    println!("Alice sends \"Hello!\" to Bob:");
    let r = client
        .call_at(bob.addr(), Request::text("Hello!"))
        .await?;
    println!("  -> {}", r.body());
    println!();

    tokio::time::sleep(Duration::from_millis(200)).await;

    // Bob sends "Hi!" to Carol
    println!("Bob sends \"Hi!\" to Carol:");
    let r = client
        .call_at(carol.addr(), Request::text("Hi!"))
        .await?;
    println!("  -> {}", r.body());
    println!();

    tokio::time::sleep(Duration::from_millis(200)).await;

    // Carol sends "Hey!" to Alice
    println!("Carol sends \"Hey!\" to Alice:");
    let r = client
        .call_at(alice.addr(), Request::text("Hey!"))
        .await?;
    println!("  -> {}", r.body());
    println!();

    println!("Chat demo complete!");

    // Clean up
    alice.stop();
    bob.stop();
    carol.stop();

    Ok(())
}
