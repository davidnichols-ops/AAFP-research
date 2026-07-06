// AAFP SDK — MCP Tool & Resource Bridges (Phase 7, Parts 2 & 3)
//
// STUB FILE — Pre-build scaffolding. All method bodies throw
// `Error('Not implemented')`. Implementation deferred to Phase 7 build.
//
// Exposes an MCP tool server and/or resource provider as callable AAFP
// capabilities, so AAFP agents can call MCP tools / read MCP resources via
// the normal `client.discover(cap).call()` API without knowing MCP exists.
// See RFC-0007 and TS_PHASE_7_MCP.md Parts 2 & 3.

import type { AafpMcpTransport } from "./mcp-transport.js";

/**
 * Minimal structural type for an AAFP `Request` (params carrier).
 * Replaced by the real `Request` type from `./types.js` at build time.
 */
export interface Request {
  /** AAFP request parameters (CBOR-encoded key/value map). */
  params: {
    /** Get a string value by integer key, or `undefined`. */
    getStr(key: number): string | undefined;
  };
}

/**
 * Minimal structural type for an AAFP `Response` builder.
 * Replaced by the real `Response` type from `./types.js` at build time.
 */
export interface Response {
  // Marker — the real type has `params` and `body` accessors.
}

/**
 * Minimal structural type for the AAFP `Params` builder.
 * Replaced by the real `Params` type from `./types.js` at build time.
 */
export interface Params {
  /** Put a string value at an integer key. */
  putStr(key: number, value: string): Params;
  /** Put a boolean value at an integer key. */
  putBool(key: number, value: boolean): Params;
}

/** Minimal structural type for the AAFP handler context. */
export interface HandlerContext {
  // Marker — the real type carries session/auth metadata.
}

/**
 * Bridge that exposes an MCP tool server as AAFP capabilities.
 *
 * AAFP agents call this capability with:
 *   `Request.params`:
 *     key 1 (str): tool name
 *     key 2 (str): tool arguments — a JSON object encoded as a string
 *
 * The bridge looks up the tool via MCP `tools/call` and returns the result
 * as `Response.params`:
 *     key 1 (str): tool result text (or JSON-stringified structured content)
 *     key 2 (bool): `isError` flag from MCP
 *
 * A `tools/list` capability is also registered under `"{capPrefix}.list"`
 * so AAFP agents can enumerate available MCP tools.
 *
 * Capabilities registered:
 *   `"{capPrefix}.call"` — call a tool (params key 1 = name, key 2 = JSON args)
 *   `"{capPrefix}.list"` — list available tools (returns JSON array in key 1)
 */
export class McpToolBridge {
  /** Whether the bridge has connected to the MCP server. */
  private ready = false;

  /**
   * @param capPrefix The capability prefix (default `"mcp"`). The bridge
   *                  registers `"{prefix}.call"` and `"{prefix}.list"`.
   */
  constructor(private readonly capPrefix: string = "mcp") {}

  /**
   * Connect to the MCP server over the given AAFP-backed transport. Performs
   * the MCP `initialize` handshake. After this resolves, `onCall` / `onList`
   * are usable.
   *
   * @param transport An already-started `AafpMcpTransport`.
   */
  async connect(transport: AafpMcpTransport): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * AAFP handler for the `"{capPrefix}.call"` capability.
   *
   * Reads the tool name from params key 1 and the JSON arguments from
   * params key 2, calls the MCP tool via `tools/call`, and returns the
   * result text in params key 1 with the `isError` flag in params key 2.
   *
   * @throws Error if the bridge is not connected.
   * @throws Error if the tool name (key 1) is missing.
   */
  async onCall(req: Request, _ctx: HandlerContext): Promise<Response> {
    throw new Error("Not implemented");
  }

  /**
   * AAFP handler for the `"{capPrefix}.list"` capability.
   *
   * Calls MCP `tools/list` and returns the tools array as a JSON string in
   * params key 1.
   *
   * @throws Error if the bridge is not connected.
   */
  async onList(_req: Request, _ctx: HandlerContext): Promise<Response> {
    throw new Error("Not implemented");
  }

  /**
   * Register both the `"{capPrefix}.call"` and `"{capPrefix}.list"`
   * capabilities on an AAFP `ServeBuilder`.
   *
   * @param builder The serve builder (must expose `onCapability`).
   * @returns The same builder, for chaining.
   */
  register(builder: { onCapability: (...args: unknown[]) => unknown }): typeof builder {
    throw new Error("Not implemented");
  }

  /**
   * Close the underlying MCP client. Idempotent.
   */
  async close(): Promise<void> {
    throw new Error("Not implemented");
  }
}

/**
 * Bridge that exposes an MCP resource provider as AAFP capabilities.
 *
 * Capabilities:
 *   `"{prefix}.read"` — read a resource by URI (params key 1 = URI string)
 *   `"{prefix}.list"` — list all resources (returns JSON array in key 1)
 *
 * For `read`, text contents are concatenated (joined with `\n`) and returned
 * in params key 1. Blob contents would be base64-encoded in params key 2
 * (future work).
 */
export class McpResourceBridge {
  /** Whether the bridge has connected to the MCP server. */
  private ready = false;

  /**
   * @param capPrefix The capability prefix (default `"mcp.res"`). The bridge
   *                  registers `"{prefix}.read"` and `"{prefix}.list"`.
   */
  constructor(private readonly capPrefix: string = "mcp.res") {}

  /**
   * Connect to the MCP server over the given AAFP-backed transport. Performs
   * the MCP `initialize` handshake.
   *
   * @param transport An already-started `AafpMcpTransport`.
   */
  async connect(transport: AafpMcpTransport): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * AAFP handler for the `"{capPrefix}.read"` capability.
   *
   * Reads the resource URI from params key 1, calls MCP `resources/read`,
   * and returns the concatenated text contents in params key 1.
   *
   * @throws Error if the bridge is not connected.
   * @throws Error if the URI (key 1) is missing.
   */
  async onRead(req: Request, _ctx: HandlerContext): Promise<Response> {
    throw new Error("Not implemented");
  }

  /**
   * AAFP handler for the `"{capPrefix}.list"` capability.
   *
   * Calls MCP `resources/list` and returns the resources array as a JSON
   * string in params key 1.
   *
   * @throws Error if the bridge is not connected.
   */
  async onList(_req: Request, _ctx: HandlerContext): Promise<Response> {
    throw new Error("Not implemented");
  }

  /**
   * Register both the `"{capPrefix}.read"` and `"{capPrefix}.list"`
   * capabilities on an AAFP `ServeBuilder`.
   *
   * @param builder The serve builder (must expose `onCapability`).
   * @returns The same builder, for chaining.
   */
  register(builder: { onCapability: (...args: unknown[]) => unknown }): typeof builder {
    throw new Error("Not implemented");
  }

  /**
   * Close the underlying MCP client. Idempotent.
   */
  async close(): Promise<void> {
    throw new Error("Not implemented");
  }
}
