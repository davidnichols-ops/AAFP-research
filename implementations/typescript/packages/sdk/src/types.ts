/**
 * v2 Type Definitions — Params, Request, Response, and metadata.
 *
 * Mirrors `aafp_sdk::simple` from the Rust reference implementation.
 * These are the structured data containers used by all server-side handlers.
 *
 * @module types
 */

// ─── Core identity types ────────────────────────────────────────

/**
 * Agent identifier (hex string of SHA-256(publicKey)).
 */
export type AgentId = string;

/**
 * Multiaddr string identifying a transport endpoint.
 */
export type Multiaddr = string;

/**
 * Agent keypair interface — mirrors `AgentKeypair` from `@aafp/crypto`.
 */
export interface AgentKeypair {
  /** The 1952-byte public key. */
  readonly publicKey: Uint8Array;
  /** The 4032-byte secret key. */
  readonly secretKey: Uint8Array;
  /** Derive the agent's ID (hex of SHA-256(publicKey)). */
  agentId(): AgentId;
  /** Sign a message. */
  sign(msg: Uint8Array): Uint8Array;
  /** Verify a signature. */
  verify(msg: Uint8Array, sig: Uint8Array): boolean;
}

/**
 * Agent record for DHT registration.
 */
export interface AgentRecord {
  /** Agent identifier. */
  agentId: AgentId;
  /** List of endpoint addresses. */
  endpoints: Multiaddr[];
  /** Capabilities provided by this agent. */
  capabilities: string[];
  /** Agent public key. */
  publicKey: Uint8Array;
}

// ─── CborValue (discriminated union for CBOR items) ─────────────

/**
 * Discriminated union representing a CBOR value.
 *
 * Used as the backing store for {@link Params} and for encoding/decoding
 * request and response payloads on the wire.
 */
export type CborValue =
  | { type: "unsigned"; value: number }
  | { type: "negative"; value: number }
  | { type: "text"; value: string }
  | { type: "bytes"; value: Uint8Array }
  | { type: "array"; items: CborValue[] }
  | { type: "int-map"; entries: [number, CborValue][] }
  | { type: "text-map"; entries: [string, CborValue][] }
  | { type: "null" }
  | { type: "bool"; value: boolean };

// ─── Params (CBOR IntMap with integer keys) ─────────────────────

/**
 * Structured parameters backed by a CBOR IntMap with integer keys.
 *
 * Provides typed access to structured request/response data without
 * requiring JSON-in-text workarounds. Mirrors `aafp_sdk::simple::Params`
 * from the Rust reference.
 *
 * @example
 * ```typescript
 * const params = Params.create()
 *   .putStr(1, "hello")
 *   .putU64(2, 42)
 *   .putBytes(3, new Uint8Array([0x01, 0x02]));
 *
 * params.getStr(1); // "hello"
 * params.getU64(2); // 42
 * ```
 */
export class Params {
  /** Internal map of integer keys to CBOR values. */
  private readonly entries: Map<number, CborValue> = new Map();

  /** Private constructor — use {@link Params.create} instead. */
  private constructor() {}

  /**
   * Create an empty Params container.
   * @returns A new empty Params instance.
   */
  static create(): Params {
    return new Params();
  }

  /**
   * Add a string field with the given integer key.
   * @param key - Integer key.
   * @param value - String value.
   * @returns `this` for chaining.
   */
  putStr(key: number, value: string): this {
    this.entries.set(key, { type: "text", value });
    return this;
  }

  /**
   * Add a bytes field with the given integer key.
   * @param key - Integer key.
   * @param value - Byte array value.
   * @returns `this` for chaining.
   */
  putBytes(key: number, value: Uint8Array): this {
    this.entries.set(key, { type: "bytes", value });
    return this;
  }

  /**
   * Add an unsigned 64-bit integer field with the given integer key.
   * @param key - Integer key.
   * @param value - Unsigned integer value.
   * @returns `this` for chaining.
   */
  putU64(key: number, value: number): this {
    this.entries.set(key, { type: "unsigned", value });
    return this;
  }

  /**
   * Add a boolean field with the given integer key.
   * @param key - Integer key.
   * @param value - Boolean value.
   * @returns `this` for chaining.
   */
  putBool(key: number, value: boolean): this {
    this.entries.set(key, { type: "bool", value });
    return this;
  }

  /**
   * Get a string field by key.
   * @param key - Integer key to look up.
   * @returns The string value, or `undefined` if not present or not a string.
   */
  getStr(key: number): string | undefined {
    const v = this.entries.get(key);
    return v?.type === "text" ? v.value : undefined;
  }

  /**
   * Get a bytes field by key.
   * @param key - Integer key to look up.
   * @returns The byte array, or `undefined` if not present or not bytes.
   */
  getBytes(key: number): Uint8Array | undefined {
    const v = this.entries.get(key);
    return v?.type === "bytes" ? v.value : undefined;
  }

  /**
   * Get a u64 field by key.
   * @param key - Integer key to look up.
   * @returns The unsigned integer, or `undefined` if not present or not unsigned.
   */
  getU64(key: number): number | undefined {
    const v = this.entries.get(key);
    return v?.type === "unsigned" ? v.value : undefined;
  }

  /**
   * Get a boolean field by key.
   * @param key - Integer key to look up.
   * @returns The boolean value, or `undefined` if not present or not a bool.
   */
  getBool(key: number): boolean | undefined {
    const v = this.entries.get(key);
    return v?.type === "bool" ? v.value : undefined;
  }

  /** Whether the params container has no entries. */
  get isEmpty(): boolean {
    return this.entries.size === 0;
  }

  /** Number of entries in the params container. */
  get length(): number {
    return this.entries.size;
  }

  /**
   * Convert to a CBOR IntMap value, with entries sorted by key.
   * @returns A CBOR int-map value.
   */
  toCbor(): CborValue {
    const sorted = [...this.entries.entries()].sort((a, b) => a[0] - b[0]);
    return { type: "int-map", entries: sorted };
  }

  /**
   * Create a Params from a CBOR value.
   * @param val - CBOR value (expected to be an int-map).
   * @returns A Params populated from the int-map entries.
   */
  static fromCbor(val: CborValue): Params {
    const p = new Params();
    if (val.type === "int-map") {
      for (const [key, v] of val.entries) {
        p.entries.set(key, v);
      }
    }
    return p;
  }
}

// ─── RequestMetadata / ResponseMetadata ─────────────────────────

/**
 * Metadata carried with a request (v2).
 *
 * Contains information about the request that isn't part of the payload:
 * capability name, session ID, trace ID, deadline, and content type.
 */
export interface RequestMetadata {
  /** The capability name being invoked. */
  capability: string;
  /** Session ID (from handshake transcript, 32 bytes). */
  sessionId?: Uint8Array;
  /** Trace ID for distributed tracing. */
  traceId?: string;
  /** Request deadline (ISO 8601). */
  deadline?: string;
  /** Content type (for binary payloads). */
  contentType?: string;
}

/**
 * Metadata carried with a response (v2).
 *
 * Contains content type and additional metadata fields.
 */
export interface ResponseMetadata {
  /** Content type (for binary payloads). */
  contentType?: string;
  /** Additional metadata fields. */
  extra: Record<string, string>;
}

// ─── Request (v2) ───────────────────────────────────────────────

/**
 * A request from a caller to an agent.
 *
 * Carries structured {@link Params}, optional text body (v1 compat),
 * optional binary payload, and {@link RequestMetadata}.
 *
 * @example
 * ```typescript
 * // Text request (v1 compat)
 * const req = Request.text("hello");
 *
 * // Structured params (v2)
 * const req = Request.withParams(Params.create().putU64(1, 42));
 * ```
 */
export class Request {
  /** Structured parameters (CBOR IntMap, v2). */
  readonly params: Params;
  /** Optional text body (v1 compat / simple cases). */
  readonly text: string;
  /** Optional binary payload. */
  readonly data: Uint8Array | null;
  /** Request metadata (v2). */
  readonly metadata: RequestMetadata;

  private constructor(
    params: Params,
    text: string,
    data: Uint8Array | null,
    metadata: RequestMetadata,
  ) {
    this.params = params;
    this.text = text;
    this.data = data;
    this.metadata = metadata;
  }

  /**
   * Create a request with structured params (v2).
   * @param params - The structured parameters.
   * @returns A new Request.
   */
  static withParams(params: Params): Request {
    return new Request(params, "", null, { capability: "" });
  }

  /**
   * Create a text request (v1 compat).
   * @param body - The text body.
   * @returns A new Request with the given text.
   */
  static text(body: string): Request {
    return new Request(Params.create(), body, null, { capability: "" });
  }

  /**
   * Create a binary data request.
   * @param payload - The binary payload.
   * @returns A new Request with the given data.
   */
  static data(payload: Uint8Array): Request {
    return new Request(Params.create(), "", payload, { capability: "" });
  }

  /** Get the text body of the request (v1 compat). */
  get body(): string {
    return this.text;
  }

  /** Get the binary payload, if any. */
  get payload(): Uint8Array | null {
    return this.data;
  }

  /**
   * Return a new Request with metadata modified by the given function.
   * @param fn - Mutation function that receives a copy of the metadata.
   * @returns A new Request with updated metadata.
   */
  withMetadata(fn: (m: RequestMetadata) => void): Request {
    const m = { ...this.metadata };
    fn(m);
    return new Request(this.params, this.text, this.data, m);
  }
}

// ─── Response (v2) ──────────────────────────────────────────────

/**
 * A response from an agent to a caller.
 *
 * Carries structured {@link Params} result, optional text body (v1 compat),
 * optional binary payload, and {@link ResponseMetadata}.
 *
 * @example
 * ```typescript
 * // Text response (v1 compat)
 * const resp = Response.text("ok");
 *
 * // Structured result (v2)
 * const resp = Response.withResult(Params.create().putU64(1, 42));
 * ```
 */
export class Response {
  /** Structured result (CBOR IntMap, v2). */
  readonly result: Params;
  /** Optional text body (v1 compat). */
  readonly text: string;
  /** Optional binary payload. */
  readonly data: Uint8Array | null;
  /** Response metadata (v2). */
  readonly metadata: ResponseMetadata;

  private constructor(
    result: Params,
    text: string,
    data: Uint8Array | null,
    metadata: ResponseMetadata,
  ) {
    this.result = result;
    this.text = text;
    this.data = data;
    this.metadata = metadata;
  }

  /**
   * Create a response with structured result (v2).
   * @param result - The structured result params.
   * @returns A new Response.
   */
  static withResult(result: Params): Response {
    return new Response(result, "", null, { extra: {} });
  }

  /**
   * Create a text response (v1 compat).
   * @param body - The text body.
   * @returns A new Response with the given text.
   */
  static text(body: string): Response {
    return new Response(Params.create(), body, null, { extra: {} });
  }

  /**
   * Create a binary data response.
   * @param payload - The binary payload.
   * @returns A new Response with the given data.
   */
  static data(payload: Uint8Array): Response {
    return new Response(Params.create(), "", payload, { extra: {} });
  }

  /** Get the text body of the response (v1 compat). */
  get body(): string {
    return this.text;
  }

  /** Get the binary payload, if any. */
  get payload(): Uint8Array | null {
    return this.data;
  }

  /**
   * Return a new Response with metadata modified by the given function.
   * @param fn - Mutation function that receives a copy of the metadata.
   * @returns A new Response with updated metadata.
   */
  withMetadata(fn: (m: ResponseMetadata) => void): Response {
    const m = { ...this.metadata, extra: { ...this.metadata.extra } };
    fn(m);
    return new Response(this.result, this.text, this.data, m);
  }
}
