# Builder Prompt: TS Phase 7 — MCP Integration + Ecosystem Adapters

## Objective

Implement MCP (Model Context Protocol) integration for the TypeScript AAFP SDK
(`@aafp/sdk`). AAFP becomes a post-quantum secure transport for the official MCP
TypeScript SDK (`@modelcontextprotocol/sdk`), replacing stdio and Streamable
HTTP. Additionally, expose MCP tool servers and resource providers as AAFP
capabilities, and bridge bidirectionally so AAFP agents can call MCP tools and
MCP tools can be exposed as AAFP agents. Finally, ship ecosystem adapters for
LangChain.js and the Vercel AI SDK so AAFP-discovered agents drop into the two
most popular TS agent frameworks.

This is the TypeScript analog of the verified Rust `aafp-transport-mcp` crate
(RFC-0007) and the Python MCP interop, plus the framework adapters called out
in `TYPESCRIPT_SDK_DESIGN.md` §9 and Phase 8.

## Context

Read these documents before starting:
- `TYPESCRIPT_SDK_DESIGN.md` — §9.1 (LangChain.js), §9.2 (Vercel AI SDK),
  §9.3 (MCP TypeScript SDK), §14 Phase 7 & Phase 8 checklists
- `RFCs/0007-mcp-transport-binding.md` — Full MCP-over-AAFP transport binding
  (mandatory/recommended/prohibited requirements, framing, security)
- `implementations/rust/crates/aafp-transport-mcp/src/lib.rs` — Reference
  implementation of `AafpMcpTransport` for the Rust `rmcp` SDK
- `INTEROPERABILITY_PLAN.md` — MCP cross-SDK interop plan, §2.2 Transport interface

The Rust reference (`aafp-transport-mcp`) is the source of truth for behavior.
The TS implementation must be wire-compatible: an MCP TS SDK client over AAFP
must interoperate with an MCP Rust SDK server over AAFP, and vice versa.

## Architectural Layers

```text
┌─────────────────────────────────────────────────────┐
│  Application Protocol Layer (MCP)                    │
│  - JSON-RPC 2.0 message format                       │
│  - Method dispatch (tools/list, tools/call, etc.)    │
│  - Capability negotiation (initialize handshake)     │
│  - Owned by: @modelcontextprotocol/sdk, app code     │
├─────────────────────────────────────────────────────┤
│  Transport Binding Layer (this phase)                │
│  - AafpMcpTransport: implements MCP Transport iface  │
│  - Carries JSON-RPC messages in AAFP DATA frames     │
│  - Manages QUIC/WebTransport stream lifecycle        │
│  - Performs AAFP handshake + authorization           │
│  - Owned by: @aafp/sdk (./mcp subpath export)        │
├─────────────────────────────────────────────────────┤
│  AAFP Core Protocol Layer (@aafp/sdk core)           │
│  - Frame format (28-byte header, 8 frame types)      │
│  - Handshake (ML-DSA-65 identity, PQ TLS)            │
│  - Session state machine                             │
│  - Control frames (CLOSE, ERROR, PING/PONG)          │
├─────────────────────────────────────────────────────┤
│  Transport Layer (QUIC / WebTransport)               │
│  - node:quic (Node 25+) or WebTransport (browser)    │
│  - X25519MLKEM768 hybrid KEX                         │
└─────────────────────────────────────────────────────┘
```

**Where MCP ends:** The MCP protocol defines JSON-RPC 2.0 messages
(`initialize`, `tools/list`, `tools/call`, `resources/read`, etc.). These are
produced and consumed by the MCP TS SDK's service layer. The AAFP transport
does NOT interpret or modify MCP message content.

**Where AAFP begins:** AAFP provides the secure transport: post-quantum TLS,
ML-DSA-65 agent identity verification, length-delimited framing, and session
state enforcement. The transport uses AAFP's public APIs (`Agent.connect()`,
`Connection.openBidiStream()`, `encodeFrame`, `decodeFrame`) to carry MCP
messages securely.

**The boundary:** The AAFP DATA frame (frame type 0x01). Each MCP JSON-RPC
message is serialized to JSON and carried as the opaque payload of one DATA
frame. AAFP does not interpret the payload; MCP does not know about AAFP
framing.

## What to Build

### Part 1: `AafpMcpTransport` — MCP TS SDK `Transport` interface

Implement the MCP TS SDK `Transport` interface
([RFC-0007](../RFCs/0007-mcp-transport-binding.md), TYPESCRIPT_SDK_DESIGN.md
§9.3). The interface:

```typescript
interface Transport {
  start(): Promise<void>;
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
}
```

Create `src/mcp-transport.ts`:

```typescript
import type { Transport, JSONRPCMessage, TransportSendOptions } from
  "@modelcontextprotocol/sdk/types.js";
import { Connection, BidiStream } from "./transport.js";
import { encodeFrame, decodeFrame, FrameType, FRAME_HEADER_SIZE } from
  "./framing.js";

/**
 * AAFP-backed transport for the MCP TypeScript SDK.
 *
 * Implements the MCP `Transport` interface, carrying JSON-RPC 2.0 messages
 * as payloads of AAFP DATA frames over a bidirectional QUIC/WebTransport
 * stream. The AAFP v1 handshake (ML-DSA-65 identity verification, PQ KEX)
 * is performed during construction via `AafpMcpTransport.connect()` or
 * `AafpMcpTransport.accept()`.
 *
 * Wire format per RFC-0007:
 *   [AAFP Frame Header (28 bytes)] [JSON-RPC message (UTF-8 JSON)]
 *
 * Each MCP message is exactly one DATA frame. JSON is preserved byte-for-byte
 * (no CBOR transcoding, no reordering, no coalescing).
 */
export class AafpMcpTransport implements Transport {
  private stream?: BidiStream;
  private closed = false;
  private readAbort = new AbortController();

  // MCP Transport callbacks (set by the MCP SDK after connect())
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;

  private constructor(
    private readonly conn: Connection,
    private readonly peerAgentId?: string,
    private readonly isClient: boolean,
  ) {}

  /**
   * Client-side: dial an AAFP agent, perform the v1 handshake, open a bidi
   * stream for MCP JSON-RPC. `addr` is `quic://host:port` or
   * `webtransport://host:port`.
   */
  static async connect(
    conn: Connection,
    isClient = true,
  ): Promise<AafpMcpTransport> {
    const peerAgentId = conn.peerAgentId; // verified during handshake
    return new AafpMcpTransport(conn, peerAgentId, isClient);
  }

  /** Server-side: wrap an already-accepted AAFP connection. */
  static accept(conn: Connection): AafpMcpTransport {
    return new AafpMcpTransport(conn, conn.peerAgentId, false);
  }

  /** The verified peer AgentId (ML-DSA-65), captured from the handshake. */
  get peerId(): string | undefined {
    return this.peerAgentId;
  }

  /**
   * Called by the MCP SDK. Opens the bidirectional application stream
   * (stream ID ≥ 4 per RFC-0002 §7.1) and starts the read loop.
   */
  async start(): Promise<void> {
    // Client opens the stream; server accepts it. The Connection abstraction
    // handles both roles — openBidiStream() on the server side accepts the
    // client-initiated stream.
    this.stream = this.isClient
      ? await this.conn.openBidiStream()
      : await this.conn.acceptBidiStream();
    void this.readLoop();
  }

  /**
   * Send a JSON-RPC message as one AAFP DATA frame.
   * JSON is NOT modified, transcoded, or reordered.
   */
  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    if (this.closed || !this.stream) {
      throw new Error("AafpMcpTransport: send after close");
    }
    const json = new TextEncoder().encode(JSON.stringify(message));
    const frame = encodeFrame({
      version: 1,
      type: FrameType.Data, // 0x01 — RFC-0007 mandatory requirement #4
      flags: 0,
      streamId: 4n, // first client-initiated application stream (RFC-0002 §7.1)
      payload: json,
      extensions: new Uint8Array(0),
    });
    await this.stream.write(frame);
  }

  /** Graceful close: finish send side, close connection, notify MCP SDK. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.readAbort.abort();
    try {
      await this.stream?.finish();
    } catch { /* stream may already be closed */ }
    try {
      await this.conn.close();
    } catch { /* connection may already be closed */ }
    this.onclose?.();
  }

  /**
   * Read loop: read AAFP DATA frames, decode JSON, deliver to onmessage.
   * Returns None (EOF) when the peer closes/resets the stream — per
   * RFC-0007 failure behavior table. JSON parse errors are logged at warn
   * and the frame is skipped (transport continues), per RFC-0007 §"Runtime
   * Failures".
   */
  private async readLoop(): Promise<void> {
    if (!this.stream) return;
    try {
      while (!this.readAbort.signal.aborted) {
        const header = await this.readExact(FRAME_HEADER_SIZE);
        if (!header) break; // peer closed stream → EOF
        const { payload } = await this.readFullFrame(header);
        let msg: JSONRPCMessage;
        try {
          msg = JSON.parse(new TextDecoder().decode(payload)) as JSONRPCMessage;
        } catch (e) {
          // RFC-0007: log at warn, skip frame, continue (do NOT error out)
          console.warn("AafpMcpTransport: JSON parse error, skipping frame", e);
          continue;
        }
        this.onmessage?.(msg);
      }
    } catch (e) {
      if (!this.closed) this.onerror?.(e as Error);
    }
    if (!this.closed) {
      this.closed = true;
      this.onclose?.();
    }
  }

  private async readExact(n: number): Promise<Uint8Array | null> {
    if (!this.stream) return null;
    return this.stream.readExact(n, this.readAbort.signal);
  }

  private async readFullFrame(header: Uint8Array): Promise<{ payload: Uint8Array }> {
    const decoded = decodeFrame(header);
    const payload = await this.readExact(decoded.payloadLength);
    if (!payload) throw new Error("AafpMcpTransport: truncated frame");
    return { payload };
  }
}
```

Add a convenience method on `Agent` / `ConnectedAgent`:

```typescript
// src/agent.ts (addition)
import { AafpMcpTransport } from "./mcp-transport.js";

export class ConnectedAgent {
  /** Dial an AAFP agent and return an MCP Transport bound to it. */
  async dialMcp(addr: string): Promise<AafpMcpTransport> {
    const conn = await this.transport.dial(addr);
    await this.establishSession(conn); // v1 handshake + auth
    return AafpMcpTransport.connect(conn, true);
  }
}

export class ServingAgent {
  /** Accept an inbound AAFP connection and return an MCP Transport. */
  async acceptMcp(): Promise<AafpMcpTransport> {
    const conn = await this.transport.accept();
    await this.establishSession(conn, /* isClient= */ false);
    return AafpMcpTransport.accept(conn);
  }
}
```

### Part 2: MCP Tool Server as an AAFP Capability

Expose an MCP tool server (a set of MCP tools) as a callable AAFP capability.
This lets AAFP agents call MCP tools via the normal `client.discover(cap).call()`
API without knowing MCP exists. The bridge translates AAFP RPC ↔ MCP JSON-RPC.

Create `src/mcp-tool-bridge.ts`:

```typescript
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { AafpMcpTransport } from "./mcp-transport.js";
import { Request, Response, Params, HandlerContext } from "./types.js";

/**
 * Bridge that exposes an MCP tool server as an AAFP capability.
 *
 * AAFP agents call this capability with:
 *   Request.params:
 *     key 1 (str): tool name
 *     key 2 (map): tool arguments (JSON object, encoded as CBOR map)
 *
 * The bridge looks up the tool via MCP `tools/call`, returns the result
 * as Response.params:
 *     key 1 (str): tool result text (or JSON-stringified structured content)
 *     key 2 (bool): isError flag from MCP
 *
 * A `tools/list` capability is also registered under "{capPrefix}.list"
 * so AAFP agents can enumerate available MCP tools.
 */
export class McpToolBridge {
  private mcp: McpClient;
  private ready = false;

  constructor(private readonly capPrefix: string = "mcp") {}

  /** Connect to the MCP server over AAFP. */
  async connect(transport: AafpMcpTransport): Promise<void> {
    this.mcp = new McpClient(
      { name: "aafp-mcp-bridge", version: "1.0.0" },
      { capabilities: {} },
    );
    await this.mcp.connect(transport);
    this.ready = true;
  }

  /** AAFP handler for the "{capPrefix}.call" capability. */
  async onCall(req: Request, _ctx: HandlerContext): Promise<Response> {
    if (!this.ready) throw new Error("McpToolBridge: not connected");
    const toolName = req.params.getStr(1);
    const argsRaw = req.params.getStr(2); // JSON string of arguments
    if (!toolName) throw new Error("McpToolBridge: missing tool name (key 1)");
    const args = argsRaw ? JSON.parse(argsRaw) : {};

    const result = await this.mcp.callTool({ name: toolName, arguments: args });
    const text = typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content);

    return Response.withResult(
      Params.create()
        .putStr(1, text)
        .putBool(2, result.isError ?? false),
    );
  }

  /** AAFP handler for the "{capPrefix}.list" capability. */
  async onList(_req: Request, _ctx: HandlerContext): Promise<Response> {
    if (!this.ready) throw new Error("McpToolBridge: not connected");
    const { tools } = await this.mcp.listTools();
    return Response.withResult(
      Params.create().putStr(1, JSON.stringify(tools)),
    );
  }

  /** Register both capabilities on a ServeBuilder. */
  register(builder: { onCapability: Function }) {
    return builder
      .onCapability(`${this.capPrefix}.call`, (r: Request, c: HandlerContext) =>
        this.onCall(r, c))
      .onCapability(`${this.capPrefix}.list`, (r: Request, c: HandlerContext) =>
        this.onList(r, c));
  }

  async close(): Promise<void> {
    if (this.ready) await this.mcp.close();
  }
}
```

Usage — an AAFP agent serving an MCP tool server:

```typescript
import { Agent } from "@aafp/sdk";
import { McpToolBridge } from "@aafp/sdk/mcp";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// 1. Start an MCP tool server (e.g., a filesystem tool server) on stdio
const mcpServer = new McpServer({ name: "fs-tools", version: "1.0.0" });
// ... register tools on mcpServer ...
await mcpServer.connect(new StdioServerTransport());

// 2. Wrap it as an AAFP capability
const bridge = new McpToolBridge("fs");
const agent = await Agent.serve()
  .capability("fs.call")
  .capability("fs.list")
  .onCapability("fs.call", (r, c) => bridge.onCall(r, c))
  .onCapability("fs.list", (r, c) => bridge.onList(r, c))
  .start();

console.log("AAFP agent serving MCP tools at:", agent.addr);
```

### Part 3: MCP Resource Provider as an AAFP Capability

Expose MCP resources (files, database records, contextual data) as an AAFP
capability. AAFP agents read resources via the normal call API.

Create `src/mcp-resource-bridge.ts`:

```typescript
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { AafpMcpTransport } from "./mcp-transport.js";
import { Request, Response, Params, HandlerContext } from "./types.js";

/**
 * Bridge exposing an MCP resource provider as AAFP capabilities.
 *
 * Capabilities:
 *   "{prefix}.read"  — read a resource by URI (params key 1 = URI string)
 *   "{prefix}.list"  — list all resources (returns JSON array in key 1)
 */
export class McpResourceBridge {
  private mcp: McpClient;
  private ready = false;

  constructor(private readonly capPrefix: string = "mcp.res") {}

  async connect(transport: AafpMcpTransport): Promise<void> {
    this.mcp = new McpClient(
      { name: "aafp-mcp-resource-bridge", version: "1.0.0" },
      { capabilities: {} },
    );
    await this.mcp.connect(transport);
    this.ready = true;
  }

  async onRead(req: Request, _ctx: HandlerContext): Promise<Response> {
    if (!this.ready) throw new Error("McpResourceBridge: not connected");
    const uri = req.params.getStr(1);
    if (!uri) throw new Error("McpResourceBridge: missing URI (key 1)");
    const { contents } = await this.mcp.readResource({ uri });
    // Concatenate text contents; encode blobs as base64 in key 2
    const text = contents
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("\n");
    return Response.withResult(Params.create().putStr(1, text));
  }

  async onList(_req: Request, _ctx: HandlerContext): Promise<Response> {
    if (!this.ready) throw new Error("McpResourceBridge: not connected");
    const { resources } = await this.mcp.listResources();
    return Response.withResult(
      Params.create().putStr(1, JSON.stringify(resources)),
    );
  }

  async close(): Promise<void> {
    if (this.ready) await this.mcp.close();
  }
}
```

### Part 4: Bidirectional — AAFP Agents Calling MCP Tools

The reverse direction: an AAFP agent (running an LLM or workflow) discovers and
calls MCP tools exposed by other agents. The `McpToolBridge` from Part 2 is
used as a *client* — the AAFP agent dials a remote MCP-over-AAFP server and
calls tools through the bridge.

```typescript
import { Agent } from "@aafp/sdk";
import { McpToolBridge } from "@aafp/sdk/mcp";

const client = await Agent.connect();

// Discover an agent that serves the "fs.call" capability (an MCP tool server
// exposed via AAFP). Two options:

// Option A: Call through the AAFP capability API directly (no MCP SDK needed
// on the caller side — the bridge on the server side translates).
const fsAgent = await client.discover("fs.call");
const result = await fsAgent.call(
  Request.withParams(
    Params.create()
      .putStr(1, "read_file")        // MCP tool name
      .putStr(2, JSON.stringify({ path: "/etc/hosts" })),
  ),
);
const fileContent = result.params.getStr(1);
console.log(fileContent);

// Option B: Dial the remote agent's MCP-over-AAFP transport directly and use
// the full MCP TS SDK client API (tools/list, tools/call with typed schemas).
const transport = await client.dialMcp("quic://fs-agent.example:4433");
const mcp = new McpClient(
  { name: "aafp-agent", version: "1.0.0" },
  { capabilities: {} },
);
await mcp.connect(transport);

const tools = await mcp.listTools();
console.log("Available MCP tools:", tools.tools.map((t) => t.name));
const callResult = await mcp.callTool({
  name: "read_file",
  arguments: { path: "/etc/hosts" },
});
console.log(callResult.content);
```

### Part 5: MCP Tools Exposed as AAFP Agents (Server Side)

Run an MCP server *over AAFP* (replacing stdio) so that MCP clients — whether
they use AAFP transport or, via a gateway, stdio — can reach the tools. This is
the direct use of `AafpMcpTransport.accept()`:

```typescript
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { Agent } from "@aafp/sdk";
import { AafpMcpTransport } from "@aafp/sdk/mcp";

// 1. Define an MCP tool server using the official SDK
const mcpServer = new McpServer({ name: "calculator", version: "1.0.0" });
mcpServer.tool("add", { a: { type: "number" }, b: { type: "number" } },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  }));

// 2. Serve it over AAFP instead of stdio
const agent = await Agent.serve().bind("127.0.0.1:4433").start();
console.log("MCP-over-AAFP server listening at quic://127.0.0.1:4433");

while (true) {
  const transport = await agent.acceptMcp();
  await mcpServer.connect(transport); // each connection gets its own transport
}
```

### Part 6: LangChain.js Adapter (`@aafp/langchain`)

Expose AAFP-discovered agents as LangChain.js tools. Create a separate package
`@aafp/langchain` (or a subpath export `@aafp/sdk/langchain`) implementing the
LangChain.js `Tool` interface.

```typescript
// packages/aafp-langchain/src/index.ts
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { ConnectedAgent, Request, Params } from "@aafp/sdk";

/**
 * A LangChain.js Tool backed by an AAFP-discovered agent capability.
 *
 * The tool calls the AAFP capability with the input (JSON-encoded in params
 * key 1) and returns the response text. This lets LangChain agents use AAFP
 * agents as tools without knowing about AAFP, QUIC, or post-quantum crypto.
 */
export class AafpTool extends StructuredTool {
  name: string;
  description: string;
  schema = z.object({ input: z.string() });

  private discovered?: Awaited<ReturnType<ConnectedAgent["discover"]>>;

  constructor(
    private readonly client: ConnectedAgent,
    private readonly capability: string,
    description: string,
  ) {
    super();
    this.name = capability.replace(/\./g, "_");
    this.description = description;
  }

  protected async _call(input: { input: string }): Promise<string> {
    if (!this.discovered) {
      this.discovered = await this.client.discover(this.capability);
    }
    const res = await this.discovered.call(
      Request.withParams(Params.create().putStr(1, input.input)),
    );
    return res.params.getStr(1) ?? res.body ?? "";
  }
}

/**
 * A toolkit that discovers all capabilities matching a prefix and exposes
 * them as LangChain tools. Useful for wrapping an MCP tool server exposed
 * via AAFP (Part 2) — each "mcp.*.call" capability becomes a LangChain tool.
 */
export class AafpToolkit {
  tools: AafpTool[] = [];

  constructor(
    private readonly client: ConnectedAgent,
    private readonly capabilities: { name: string; description: string }[],
  ) {
    this.tools = capabilities.map(
      (c) => new AafpTool(client, c.name, c.description),
    );
  }
}
```

Usage in a LangChain.js agent:

```typescript
import { Agent } from "@aafp/sdk";
import { AafpToolkit } from "@aafp/langchain";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";

const client = await Agent.connect();
const toolkit = new AafpToolkit(client, [
  { name: "fs.call", description: "Access the filesystem MCP tool server" },
  { name: "translate", description: "Translate text between languages" },
]);

const llm = new ChatOpenAI({});
const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You are a helpful assistant with access to AAFP tools."],
  ["human", "{input}"],
  ["placeholder", "{agent_scratchpad}"],
]);
const agent = await createToolCallingAgent({ llm, tools: toolkit.tools, prompt });
const executor = new AgentExecutor({ agent, tools: toolkit.tools });
const result = await executor.invoke({ input: "Read /etc/hosts and summarize" });
console.log(result.output);
```

### Part 7: Vercel AI SDK Adapter (`@aafp/vercel-ai`)

Expose AAFP-discovered inference agents as a Vercel AI SDK provider. Create
`@aafp/vercel-ai` implementing the `LanguageModelProvider` / `LanguageModel`
interface so `streamText()` and `generateText()` route to AAFP agents.

```typescript
// packages/aafp-vercel-ai/src/index.ts
import type { LanguageModel, LanguageModelProvider } from "ai";
import { ConnectedAgent, Request, Params } from "@aafp/sdk";

/**
 * A Vercel AI SDK LanguageModel backed by an AAFP agent with an "inference"
 * or "chat" capability. The agent receives the prompt in params key 1 and
 * returns generated text in params key 1 of the response.
 *
 * For streaming, the AAFP agent should serve a streaming capability
 * (RFC-0002 §4.1 MORE flag). The adapter consumes the AsyncIterable and
 * yields Vercel AI SDK stream parts.
 */
export class AafpLanguageModel implements LanguageModel {
  specificationVersion = "v1" as const;
  provider = "aafp";

  constructor(
    private readonly client: ConnectedAgent,
    private readonly capability: string,
    private readonly modelId: string = capability,
  ) {}

  async doGenerate(options: {
    prompt: { content: Array<{ text?: string }> };
  }): Promise<{ text: string; usage: unknown; finishReason: string }> {
    const promptText = options.prompt.content
      .map((c) => c.text ?? "")
      .join("");
    const agent = await this.client.discover(this.capability);
    const res = await agent.call(
      Request.withParams(Params.create().putStr(1, promptText)),
    );
    return {
      text: res.params.getStr(1) ?? res.body ?? "",
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: "stop",
    };
  }

  async doStream(options: {
    prompt: { content: Array<{ text?: string }> };
  }): Promise<ReadableStream<Uint8Array>> {
    const promptText = options.prompt.content
      .map((c) => c.text ?? "")
      .join("");
    const agent = await this.client.discover(this.capability);
    const stream = await agent.callStreaming(
      Request.withParams(Params.create().putStr(1, promptText)),
    );
    const encoder = new TextEncoder();
    return new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) {
          const text = chunk.params.getStr(1) ?? chunk.body ?? "";
          if (text) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "text-delta", textDelta: text })}\n\n`,
              ),
            );
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }
}

/**
 * Provider factory: `aafpProvider("chat")` discovers an agent with the
 * "chat" capability and returns a LanguageModel for use with streamText /
 * generateText.
 */
export function aafpProvider(
  client: ConnectedAgent,
  capability: string,
): AafpLanguageModel {
  return new AafpLanguageModel(client, capability);
}
```

Usage with the Vercel AI SDK:

```typescript
import { streamText, generateText } from "ai";
import { Agent } from "@aafp/sdk";
import { aafpProvider } from "@aafp/vercel-ai";

const client = await Agent.connect();

// Streaming
const { textStream } = await streamText({
  model: aafpProvider(client, "chat"),
  prompt: "Explain post-quantum cryptography in one paragraph.",
});
for await (const delta of textStream) {
  process.stdout.write(delta);
}

// Non-streaming
const { text } = await generateText({
  model: aafpProvider(client, "translate"),
  prompt: "Translate 'hello world' to French.",
});
console.log(text);
```

### Part 8: Package Layout & Exports

Update `package.json` exports map (TYPESCRIPT_SDK_DESIGN.md §13):

```jsonc
{
  "name": "@aafp/sdk",
  "exports": {
    ".": "./dist/index.js",
    "./mcp": "./dist/mcp-transport.js",
    "./mcp/tools": "./dist/mcp-tool-bridge.js",
    "./mcp/resources": "./dist/mcp-resource-bridge.js",
    "./langchain": "./dist/langchain.js",
    "./vercel-ai": "./dist/vercel-ai.js"
  },
  "optionalDependencies": {
    "@modelcontextprotocol/sdk": "^1.7.0",
    "@langchain/core": "^0.3.0",
    "ai": "^4.0.0",
    "zod": "^3.23.0"
  }
}
```

The MCP, LangChain, and Vercel AI dependencies are **optional** — users who
only need core AAFP don't pay the install cost. The subpath imports lazily
require the peer dependency and throw a helpful error if missing.

Add separate publishable packages for the adapters if dependency isolation is
preferred:
- `@aafp/langchain` — depends on `@aafp/sdk` + `@langchain/core`
- `@aafp/vercel-ai` — depends on `@aafp/sdk` + `ai`

## Constraints

1. **RFC-0007 compliance is mandatory.** The implementation MUST satisfy all
   "Mandatory" requirements and MUST NOT violate any "Prohibited" requirements
   from `RFCs/0007-mcp-transport-binding.md`:
   - AAFP v1 handshake before any MCP message (no unauthenticated connections)
   - ML-DSA-65 identity verification; AgentId derived from verified public key
   - Session in `MessagingEnabled` state before opening application streams
   - DATA frames (type 0x01) for MCP messages — NOT RPC_REQUEST/RPC_RESPONSE
   - JSON preserved byte-for-byte — no CBOR transcoding, no reordering
   - Stream IDs ≥ 4 for application data (stream 0 = handshake, 1-2 reserved)
   - AuthorizationProvider called before MessagingEnabled
   - No X.509 certificates for agent identity
   - No HTTP fallback if AAFP handshake fails
   - No message modification / coalescing — one MCP message = one DATA frame

2. **Wire compatibility with the Rust reference.** An MCP TS SDK client over
   AAFP must interoperate with an MCP Rust SDK (`rmcp`) server over AAFP, and
   vice versa. The framing (28-byte header + JSON payload) is identical. Add
   cross-language interop tests to CI (TS client ↔ Rust server, TS server ↔
   Rust client).

3. **MCP protocol version compatibility.** Support MCP protocol versions
   supported by `@modelcontextprotocol/sdk` 1.7+ (2025-11-25, 2025-06-18). The
   transport does NOT participate in MCP version negotiation — the `initialize`
   request is handled by the MCP SDK service layer. The transport carries
   whatever JSON-RPC the service layer produces.

4. **JSON parse errors are non-fatal.** Per RFC-0007 §"Runtime Failures": log
   at `warn`/`debug` (NOT `error`), skip the frame, continue the read loop.
   Do not tear down the transport on a single malformed message.

5. **Peer stream close = EOF, not error.** When the peer closes/resets the
   stream or connection, `receive()` returns `None` (the read loop exits
   cleanly and calls `onclose`). Do not throw.

6. **No automatic reconnection.** If the connection is lost, the application
   must create a new `AafpMcpTransport` via `connect()` / `accept()`. The AAFP
   replay cache prevents nonce reuse across reconnections.

7. **Lazy-load optional dependencies.** The MCP, LangChain, and Vercel AI
   integrations must not be imported by the core `@aafp/sdk` entry point. Use
   dynamic `import()` or subpath exports so users who don't need them pay zero
   bundle cost.

8. **Follow existing code conventions.** Use the project's TypeScript config,
   ESLint, Prettier. Run `npm test` / `npm run build` / `npm run lint`. Match
   the style of the existing `src/` modules (transport abstraction, framing,
   agent).

9. **Authorization default is permissive but documented.** Like the Rust
   reference, the default uses a permissive auth provider (allows all).
   Production deployments MUST use a custom authorization provider — document
   this prominently in JSDoc and the README.

## Verification

```bash
npm run build          # 0 errors, 0 warnings
npm run lint           # 0 errors
npm test               # all tests pass
npm run test:interop   # cross-language MCP interop (TS ↔ Rust)
```

Specific test targets:

1. **Unit tests** (`src/mcp-transport.test.ts`):
   - `AafpMcpTransport.connect()` performs handshake, opens stream 4
   - `send()` encodes one DATA frame with correct header (version=1, type=0x01)
   - `send()` preserves JSON byte-for-byte (round-trip a complex JSON-RPC msg)
   - `close()` finishes stream, closes connection, calls `onclose`
   - Read loop delivers messages to `onmessage` in order
   - JSON parse error → logged at warn, frame skipped, loop continues
   - Peer close → read loop exits, `onclose` called, no throw

2. **Integration test** (`tests/mcp-roundtrip.test.ts`):
   - TS MCP client ↔ TS MCP server over AAFP (loopback)
   - `tools/list` returns expected tools
   - `tools/call` returns expected result
   - `resources/read` returns expected content

3. **Cross-language interop** (`tests/mcp-cross-lang.test.ts`):
   - TS MCP client ↔ Rust MCP server (rmcp over AAFP) — run Rust example
     `mcp_over_aafp.rs` as server, TS as client
   - Rust MCP client ↔ TS MCP server — TS serves, Rust `rmcp` client dials
   - Verify `tools/list` and `tools/call` work in both directions

4. **Bridge tests** (`tests/mcp-bridge.test.ts`):
   - `McpToolBridge` exposes MCP tools as AAFP `*.call` / `*.list` capabilities
   - AAFP agent calls `fs.call` with tool name + args, gets result back
   - `McpResourceBridge` exposes `*.read` / `*.list` capabilities

5. **Adapter tests**:
   - `AafpTool` (LangChain) calls AAFP capability, returns text
   - `AafpLanguageModel` (Vercel AI) `doGenerate` returns text
   - `AafpLanguageModel` `doStream` yields text-delta chunks

6. **Conformance**: Run the official MCP conformance suite
   (`@modelcontextprotocol/conformance`) against the AAFP transport once an
   AAFP endpoint is available in the conformance harness.

## Files to Create / Modify

| File | Changes |
|------|---------|
| `src/mcp-transport.ts` | NEW — `AafpMcpTransport` implementing MCP `Transport` |
| `src/mcp-tool-bridge.ts` | NEW — `McpToolBridge` (MCP tools → AAFP capability) |
| `src/mcp-resource-bridge.ts` | NEW — `McpResourceBridge` (MCP resources → AAFP capability) |
| `src/langchain.ts` | NEW — `AafpTool`, `AafpToolkit` (LangChain.js adapter) |
| `src/vercel-ai.ts` | NEW — `AafpLanguageModel`, `aafpProvider` (Vercel AI SDK) |
| `src/agent.ts` | Add `dialMcp()` / `acceptMcp()` convenience methods |
| `src/index.ts` | Re-export MCP types (lazy) |
| `package.json` | Add subpath exports, optional peer deps |
| `tests/mcp-transport.test.ts` | NEW — unit tests |
| `tests/mcp-roundtrip.test.ts` | NEW — TS↔TS integration |
| `tests/mcp-cross-lang.test.ts` | NEW — TS↔Rust interop |
| `tests/mcp-bridge.test.ts` | NEW — bridge tests |
| `tests/langchain-adapter.test.ts` | NEW — LangChain adapter test |
| `tests/vercel-ai-adapter.test.ts` | NEW — Vercel AI adapter test |
| `examples/mcp-over-aafp.ts` | NEW — full client-server example |
| `examples/mcp-tool-bridge.ts` | NEW — MCP tools as AAFP capabilities |
| `examples/langchain-aafp.ts` | NEW — LangChain.js + AAFP |
| `examples/vercel-ai-aafp.ts` | NEW — Vercel AI SDK + AAFP |

## Success Criteria

- [ ] `AafpMcpTransport` implements the MCP TS SDK `Transport` interface
- [ ] AAFP v1 handshake performed before any MCP message (mandatory #1)
- [ ] ML-DSA-65 peer identity verified; `peerId` exposed (mandatory #2)
- [ ] Session in `MessagingEnabled` before stream open (mandatory #3)
- [ ] DATA frames (type 0x01) used for MCP messages (mandatory #4)
- [ ] JSON preserved byte-for-byte — round-trip test with complex JSON-RPC (mandatory #5)
- [ ] Stream ID 4 used for application data (mandatory #6)
- [ ] AuthorizationProvider called before MessagingEnabled (mandatory #7)
- [ ] No X.509, no HTTP fallback, no message coalescing (prohibited #1-3)
- [ ] JSON parse errors logged at warn, frame skipped, loop continues
- [ ] Peer stream close → clean EOF, `onclose` called, no throw
- [ ] TS MCP client ↔ TS MCP server round-trip (tools/list, tools/call)
- [ ] TS MCP client ↔ Rust MCP server cross-language interop (CI)
- [ ] Rust MCP client ↔ TS MCP server cross-language interop (CI)
- [ ] `McpToolBridge` exposes MCP tools as AAFP `*.call` / `*.list` capabilities
- [ ] `McpResourceBridge` exposes MCP resources as AAFP `*.read` / `*.list` capabilities
- [ ] AAFP agent calls MCP tools via `client.discover("fs.call").call(...)` (bidirectional)
- [ ] MCP server runs over AAFP (replacing stdio) via `agent.acceptMcp()`
- [ ] `AafpTool` / `AafpToolkit` LangChain.js adapter works with `AgentExecutor`
- [ ] `AafpLanguageModel` / `aafpProvider` Vercel AI SDK adapter works with `streamText` / `generateText`
- [ ] Optional deps (MCP SDK, LangChain, Vercel AI) are lazy-loaded — core bundle unaffected
- [ ] `npm run build` clean (0 errors, 0 warnings)
- [ ] `npm run lint` clean
- [ ] `npm test` all pass
- [ ] Examples run: `mcp-over-aafp`, `mcp-tool-bridge`, `langchain-aafp`, `vercel-ai-aafp`

## References

- `RFCs/0007-mcp-transport-binding.md` — MCP-over-AAFP transport binding (normative)
- `TYPESCRIPT_SDK_DESIGN.md` §9.3 — MCP TS SDK integration design
- `TYPESCRIPT_SDK_DESIGN.md` §9.1 — LangChain.js integration design
- `TYPESCRIPT_SDK_DESIGN.md` §9.2 — Vercel AI SDK integration design
- `TYPESCRIPT_SDK_DESIGN.md` §14 Phase 7 & Phase 8 — implementation checklist
- `implementations/rust/crates/aafp-transport-mcp/src/lib.rs` — Rust reference (`AafpMcpTransport` for `rmcp`)
- `INTEROPERABILITY_PLAN.md` §2.2 — MCP Transport interface cross-SDK plan
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP Specification, Transports: https://modelcontextprotocol.io/specification/draft/basic/transports
- LangChain.js: https://js.langchain.com
- Vercel AI SDK: https://sdk.vercel.ai
