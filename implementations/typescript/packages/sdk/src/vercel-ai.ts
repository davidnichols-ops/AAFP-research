// AAFP SDK — Vercel AI SDK Adapter (Phase 7, Part 7)
//
// STUB FILE — Pre-build scaffolding. All method bodies throw
// `Error('Not implemented')`. Implementation deferred to Phase 7 build.
//
// Exposes AAFP-discovered inference agents as a Vercel AI SDK
// `LanguageModel`, so `streamText()` and `generateText()` route to AAFP
// agents. See TS_PHASE_7_MCP.md Part 7 and TYPESCRIPT_SDK_DESIGN.md §9.2.

import type { LanguageModel } from "ai";

/**
 * Minimal structural type for a connected AAFP agent (client side).
 * Replaced by the real `ConnectedAgent` type from `./agent.js` at build time.
 */
export interface ConnectedAgent {
  /** Discover a remote agent serving the given capability. */
  discover(capability: string): Promise<{
    /** Non-streaming call. */
    call(req: unknown): Promise<{
      params: { getStr(key: number): string | undefined };
      body?: string;
    }>;
    /** Streaming call — returns an async iterable of response chunks. */
    callStreaming(req: unknown): Promise<
      AsyncIterable<{
        params: { getStr(key: number): string | undefined };
        body?: string;
      }>
    >;
  }>;
}

/**
 * A Vercel AI SDK `LanguageModel` backed by an AAFP agent with an
 * "inference" or "chat" capability.
 *
 * The agent receives the prompt in params key 1 and returns generated text
 * in params key 1 of the response.
 *
 * For streaming, the AAFP agent should serve a streaming capability
 * (RFC-0002 §4.1 MORE flag). The adapter consumes the `AsyncIterable` and
 * yields Vercel AI SDK stream parts (`text-delta` chunks followed by
 * `[DONE]`).
 */
export class AafpLanguageModel implements LanguageModel {
  /** Vercel AI SDK specification version. */
  readonly specificationVersion = "v1" as const;
  /** Provider identifier. */
  readonly provider = "aafp";

  /**
   * @param client     A connected AAFP agent.
   * @param capability The AAFP capability to call (e.g. `"chat"`).
   * @param modelId    The model id reported to the Vercel AI SDK (defaults
   *                   to the capability name).
   */
  constructor(
    private readonly client: ConnectedAgent,
    private readonly capability: string,
    private readonly modelId: string = capability,
  ) {}

  /**
   * Non-streaming generation. Concatenates the prompt text, calls the AAFP
   * capability, and returns the response text.
   *
   * @param options Vercel AI SDK generate options (carries the prompt).
   * @returns `{ text, usage, finishReason }`.
   */
  async doGenerate(options: {
    prompt: { content: Array<{ text?: string }> };
  }): Promise<{ text: string; usage: unknown; finishReason: string }> {
    throw new Error("Not implemented");
  }

  /**
   * Streaming generation. Concatenates the prompt text, calls the AAFP
   * streaming capability, and returns a `ReadableStream` of Vercel AI SDK
   * stream parts (`data: { type: "text-delta", textDelta }` lines followed
   * by `data: [DONE]`).
   *
   * @param options Vercel AI SDK stream options (carries the prompt).
   * @returns A `ReadableStream<Uint8Array>` of SSE-encoded stream parts.
   */
  async doStream(options: {
    prompt: { content: Array<{ text?: string }> };
  }): Promise<ReadableStream<Uint8Array>> {
    throw new Error("Not implemented");
  }
}

/**
 * Provider factory: `aafpProvider(client, "chat")` returns an
 * {@link AafpLanguageModel} that discovers an agent with the `"chat"`
 * capability, for use with the Vercel AI SDK's `streamText` / `generateText`.
 *
 * @param client     A connected AAFP agent.
 * @param capability The AAFP capability to route to (e.g. `"chat"`).
 * @returns A new `AafpLanguageModel`.
 */
export function aafpProvider(
  client: ConnectedAgent,
  capability: string,
): AafpLanguageModel {
  throw new Error("Not implemented");
}
