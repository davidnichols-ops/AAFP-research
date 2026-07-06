// AAFP SDK — MCP Tools Exposed as AAFP Agents (Phase 7, Part 5)
//
// STUB FILE — Pre-build scaffolding. All function bodies throw
// `Error('Not implemented')`. Implementation deferred to Phase 7 build.
//
// Server-side helper: accept an inbound AAFP connection and return an
// MCP-over-AAFP transport, so an MCP server (defined with the official
// `@modelcontextprotocol/sdk` `Server`) can be served over AAFP instead of
// stdio. See RFC-0007 and TS_PHASE_7_MCP.md Part 5.

import type { AafpMcpTransport } from "./mcp-transport.js";

/**
 * Accept an inbound AAFP connection and return an `AafpMcpTransport`
 * suitable for handing to an MCP `Server.connect()`.
 *
 * This is the server-side convenience for running an MCP server *over AAFP*
 * (replacing stdio). Each accepted connection gets its own transport; the
 * caller is expected to loop:
 *
 * ```typescript
 * while (true) {
 *   const transport = await acceptMcp(agent);
 *   await mcpServer.connect(transport);
 * }
 * ```
 *
 * The AAFP v1 handshake (ML-DSA-65 identity verification, PQ KEX) and
 * authorization are performed before the transport is returned — no
 * unauthenticated connections reach the MCP layer (RFC-0007 mandatory #1,
 * #2, #7).
 *
 * @param agent A serving AAFP agent (must expose `accept` / `establishSession`).
 * @returns A new `AafpMcpTransport` (not yet started).
 */
export async function acceptMcp(agent: unknown): Promise<AafpMcpTransport> {
  throw new Error("Not implemented");
}
