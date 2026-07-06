// AAFP SDK — LangChain.js Adapter (Phase 7, Part 6)
//
// STUB FILE — Pre-build scaffolding. All method bodies throw
// `Error('Not implemented')`. Implementation deferred to Phase 7 build.
//
// Exposes AAFP-discovered agent capabilities as LangChain.js `StructuredTool`
// instances, so LangChain agents can use AAFP agents as tools without
// knowing about AAFP, QUIC, or post-quantum crypto. See TS_PHASE_7_MCP.md
// Part 6 and TYPESCRIPT_SDK_DESIGN.md §9.1.

import type { StructuredTool } from "@langchain/core/tools";
import type { z } from "zod";

/**
 * Minimal structural type for a connected AAFP agent (client side).
 * Replaced by the real `ConnectedAgent` type from `./agent.js` at build time.
 */
export interface ConnectedAgent {
  /** Discover a remote agent serving the given capability. */
  discover(capability: string): Promise<{
    /** Call the discovered capability with a request. */
    call(req: unknown): Promise<{
      params: { getStr(key: number): string | undefined };
      body?: string;
    }>;
  }>;
}

/**
 * A LangChain.js `StructuredTool` backed by an AAFP-discovered agent
 * capability.
 *
 * The tool calls the AAFP capability with the input (JSON-encoded in params
 * key 1) and returns the response text. This lets LangChain agents use AAFP
 * agents as tools without knowing about AAFP, QUIC, or post-quantum crypto.
 *
 * The capability name is converted to a LangChain tool name by replacing
 * dots with underscores (e.g. `fs.call` → `fs_call`).
 */
export class AafpTool extends StructuredTool {
  /** LangChain tool name (capability with dots → underscores). */
  declare name: string;
  /** Human-readable description of what the tool does. */
  declare description: string;
  /** Zod schema — accepts `{ input: string }`. */
  declare schema: z.ZodObject<{ input: z.ZodString }>;

  /** Lazily-discovered remote capability handle. */
  private discovered?: Awaited<ReturnType<ConnectedAgent["discover"]>>;

  /**
   * @param client      A connected AAFP agent.
   * @param capability  The AAFP capability to call (e.g. `"fs.call"`).
   * @param description Human-readable description for the LLM.
   */
  constructor(
    private readonly client: ConnectedAgent,
    private readonly capability: string,
    description: string,
  ) {
    super();
    this.name = capability.replace(/\./g, "_");
    this.description = description;
  }

  /**
   * Internal LangChain entry point. Lazily discovers the AAFP capability,
   * calls it with the input string in params key 1, and returns the
   * response text (params key 1, falling back to the response body).
   *
   * @param input The structured input (`{ input: string }`).
   * @returns The response text from the AAFP agent.
   */
  protected async _call(input: { input: string }): Promise<string> {
    throw new Error("Not implemented");
  }
}

/**
 * A toolkit that exposes a set of AAFP capabilities as LangChain.js tools.
 *
 * Useful for wrapping an MCP tool server exposed via AAFP (Phase 7 Part 2) —
 * each `mcp.*.call` capability becomes a LangChain tool. The toolkit
 * pre-constructs one {@link AafpTool} per capability.
 */
export class AafpToolkit {
  /** The LangChain tools, one per capability. */
  tools: AafpTool[] = [];

  /**
   * @param client       A connected AAFP agent.
   * @param capabilities The capabilities to expose, each with a name and
   *                     description.
   */
  constructor(
    private readonly client: ConnectedAgent,
    private readonly capabilities: { name: string; description: string }[],
  ) {
    this.tools = capabilities.map(
      (c) => new AafpTool(client, c.name, c.description),
    );
  }
}
