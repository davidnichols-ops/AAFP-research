use aafp_sdk::simple::{Agent, Request, Response};
use base64::Engine;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Starting translation pipeline (3 agents)...");
    println!();

    // Agent 1: uppercase
    let uppercase = Agent::serve()
        .capability("uppercase")
        .handler(|req: Request| async move {
            Ok(Response::text(req.body().to_uppercase()))
        })
        .start()
        .await?;
    println!("[uppercase] listening at {}", uppercase.addr());

    // Agent 2: reverse
    let reverse = Agent::serve()
        .capability("reverse")
        .handler(|req: Request| async move {
            let reversed: String = req.body().chars().rev().collect();
            Ok(Response::text(reversed))
        })
        .start()
        .await?;
    println!("[reverse]   listening at {}", reverse.addr());

    // Agent 3: base64 encode
    let encode = Agent::serve()
        .capability("encode")
        .handler(|req: Request| async move {
            let encoded = base64::engine::general_purpose::STANDARD.encode(req.body());
            Ok(Response::text(encoded))
        })
        .start()
        .await?;
    println!("[encode]    listening at {}", encode.addr());
    println!();

    // Give agents time to bind
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Create a client to call the agents
    let client = Agent::connect().connect().await?;

    // Pipeline: "hello" -> uppercase -> reverse -> encode
    let input = "hello";
    println!("Input:    {}", input);

    // Step 1: uppercase
    let step1 = client
        .call_at(uppercase.addr(), Request::text(input))
        .await?;
    println!("Uppercase: {}", step1.body());

    // Step 2: reverse
    let step2 = client
        .call_at(reverse.addr(), Request::text(step1.body()))
        .await?;
    println!("Reverse:  {}", step2.body());

    // Step 3: base64 encode
    let step3 = client
        .call_at(encode.addr(), Request::text(step2.body()))
        .await?;
    println!("Encoded:  {}", step3.body());

    println!();
    println!("Pipeline complete: \"{}\" -> \"{}\"", input, step3.body());

    // Clean up
    uppercase.stop();
    reverse.stop();
    encode.stop();

    Ok(())
}
