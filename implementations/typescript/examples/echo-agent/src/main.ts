/**
 * AAFP Echo Agent Example
 *
 * A minimal server that echoes back any request it receives.
 * Demonstrates the ServeBuilder API.
 */

import { ServeBuilder, Request, Response, HandlerContext } from "@aafp/sdk";

async function main(): Promise<void> {
  const server = await new ServeBuilder()
    .capability("echo")
    .onCapability("echo", async (req: Request, _ctx: HandlerContext) => {
      // Echo back the text body
      return Response.text(req.body);
    })
    .bind("127.0.0.1:0")
    .start();

  console.log(`Echo agent serving on ${server.addr}`);
  console.log(`Agent ID: ${server.id}`);
  console.log(`Capabilities: ${server.capabilities.join(", ")}`);

  // Keep running until interrupted
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await server.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
