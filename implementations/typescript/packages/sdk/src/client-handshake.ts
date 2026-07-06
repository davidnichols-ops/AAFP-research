/**
 * @aafp/sdk — Client-side handshake driver for the AAFP v1 handshake.
 *
 * The v1 handshake (RFC-0002 §5) is a 3-message exchange:
 * 1. **ClientHello** — client sends its AgentId, ML-DSA-65 public key, a
 *    random nonce, and supported protocol versions.
 * 2. **ServerHello** — server responds with its AgentId, public key, nonce,
 *    selected version, and an ML-DSA-65 signature over the transcript so far.
 * 3. **ClientFinished** — client sends its ML-DSA-65 signature over the full
 *    transcript, completing mutual authentication.
 *
 * After the handshake, both sides derive a 32-byte **session ID** via HKDF
 * from the handshake transcript. This session ID is used for session
 * affinity and is exposed in `PoolStats`.
 *
 * The driver is transport-agnostic — it only needs a `BidiStream` to
 * send/receive CBOR messages. It runs over stream 0 (the first bidi stream
 * opened on a freshly dialed QUIC connection).
 *
 * @packageDocumentation
 */

// NOTE: This is a pre-build scaffolding stub. All method bodies throw
// `Error('Not implemented')`. The real implementation will follow
// TS_PHASE_4_CLIENT.md §7 and mirror the Rust
// `aafp-sdk/src/handshake_driver.rs` and
// `aafp-crypto/src/handshake_v1.rs:343-362` (session ID derivation).

import type { AgentId, AgentKeypair } from "./types.ts";
import type { BidiStream } from "./transport/interface.ts";

// ─── Constants ────────────────────────────────────────────────────

/** Size of the random nonce in bytes (RFC-0002 §5). */
export const NONCE_SIZE = 32;

/** Size of the derived session ID in bytes. */
export const SESSION_ID_SIZE = 32;

/** AAFP v1 protocol version. */
export const PROTOCOL_VERSION = 1;

/** HKDF info string for session ID derivation (domain separator). */
export const SESSION_ID_INFO = "aafp-session-id-v1";

/** Default handshake timeout in milliseconds. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

// ─── HandshakeState ───────────────────────────────────────────────

/**
 * The state of the handshake state machine.
 *
 * Transitions:
 * ```
 * Idle → ClientHelloSent → ServerHelloReceived → Established
 * (any state) → Failed (on error)
 * ```
 */
export type HandshakeState =
  | "Idle"
  | "ClientHelloSent"
  | "ServerHelloReceived"
  | "Established"
  | "Failed";

// ─── HandshakeResult ──────────────────────────────────────────────

/**
 * Result of a completed handshake.
 *
 * Contains the peer's identity, their public key, and the derived session ID.
 */
export interface HandshakeResult {
  /** The peer's AgentId (hex string). */
  readonly peerAgentId: AgentId;
  /** The peer's ML-DSA-65 public key (1952 bytes). */
  readonly peerPublicKey: Uint8Array;
  /** The 32-byte session ID derived from the handshake transcript. */
  readonly sessionId: Uint8Array;
}

// ─── HandshakeError ───────────────────────────────────────────────

/**
 * Error thrown during the handshake protocol.
 *
 * Indicates a protocol violation, signature verification failure, timeout,
 * or unexpected message.
 */
export class HandshakeError extends Error {
  /**
   * @param message - Human-readable description of the handshake failure.
   */
  constructor(message: string) {
    super(message);
    this.name = "HandshakeError";
  }
}

// ─── SessionIdDerivation ──────────────────────────────────────────

/**
 * Parameters for session ID derivation via HKDF.
 *
 * The session ID is derived from the handshake transcript as follows
 * (mirrors `aafp-crypto/src/handshake_v1.rs:343-362`):
 *
 * ```
 * ikm  = h_after_client_hello (32 bytes, SHA-256) || server_agent_id (32 bytes)
 * salt = client_nonce (32 bytes) || server_nonce (32 bytes)
 * prk  = HKDF-Extract(salt, ikm)        // HMAC-SHA256 based
 * sid  = HKDF-Expand(prk, "aafp-session-id-v1", 32)
 * ```
 *
 * Key properties:
 * - 32 bytes, cryptographically derived from the full transcript.
 * - Bound to the server's AgentId (prevents session fixation).
 * - Unique per handshake (nonces are random).
 */
export interface SessionIdParams {
  /** SHA-256 of the ClientHello CBOR bytes (computed after sending ClientHello). */
  readonly hAfterClientHello: Uint8Array;
  /** The server's AgentId as raw bytes (hex-decoded). */
  readonly serverAgentId: Uint8Array;
  /** The client's 32-byte random nonce. */
  readonly clientNonce: Uint8Array;
  /** The server's 32-byte random nonce. */
  readonly serverNonce: Uint8Array;
}

/**
 * Derive the 32-byte session ID from the handshake transcript.
 *
 * Uses HKDF-SHA256 with:
 * - `salt` = `clientNonce || serverNonce`
 * - `IKM` = `hAfterClientHello || serverAgentId`
 * - `info` = `"aafp-session-id-v1"`
 * - `L` = 32
 *
 * The session ID is **not** sent on the wire — both sides derive it
 * independently from the transcript. It is stored in `PooledConnection`
 * and exposed via `PoolStats.peers[].sessionIdHex`.
 *
 * @param params - The transcript material for derivation.
 * @returns A 32-byte session ID.
 */
export function deriveSessionId(params: SessionIdParams): Uint8Array {
  throw new Error("Not implemented");
}

// ─── HandshakeDriver ──────────────────────────────────────────────

/**
 * Client-side handshake driver for the AAFP v1 handshake (RFC-0002 §5).
 *
 * The handshake runs over a bidirectional stream (stream 0) on a freshly
 * dialed QUIC connection. It is transport-agnostic — it only needs a
 * {@link BidiStream} to send/receive CBOR messages.
 *
 * State machine:
 * ```
 * Idle → ClientHelloSent → ServerHelloReceived → Established
 * (any state) → Failed (on error)
 * ```
 *
 * @example
 * ```typescript
 * const conn = await transport.dial(addr);
 * const controlStream = await conn.openBidi();
 * const driver = new HandshakeDriver(keypair, "client");
 * const result = await driver.runClientHandshake(controlStream);
 * // result.sessionId is the 32-byte session ID for affinity
 * ```
 */
export class HandshakeDriver {
  /** Current state of the handshake state machine. */
  private state: HandshakeState = "Idle";
  /** Accumulated transcript (CBOR-encoded messages, in order). */
  private transcript: Uint8Array[] = [];
  /** The client's random nonce (generated in constructor). */
  private clientNonce: Uint8Array;
  /** The server's random nonce (set when ServerHello is received). */
  private serverNonce: Uint8Array | null = null;
  /** SHA-256 of the ClientHello (computed after sending, before receiving). */
  private hAfterClientHello: Uint8Array | null = null;
  /** The peer's AgentId, stored during ServerHello processing. */
  private _peerAgentId: string | null = null;

  /**
   * @param keypair - This agent's keypair for signing and identity.
   * @param role - `"client"` or `"server"`. Phase 4 implements the client side.
   */
  constructor(
    private readonly keypair: AgentKeypair,
    private readonly role: "client" | "server",
  ) {
    this.clientNonce = new Uint8Array(0); // Will be randomBytes(NONCE_SIZE)
    throw new Error("Not implemented");
  }

  /**
   * Run the full client-side handshake over a bidi stream.
   *
   * Sends ClientHello, receives ServerHello, sends ClientFinished, and
   * derives the session ID.
   *
   * Steps:
   * 1. **Send ClientHello** — agent ID, public key, nonce, protocol version.
   * 2. **Receive ServerHello** — peer agent ID, peer public key, server
   *    nonce, selected version, server signature. Verify the server's
   *    signature over the transcript (excluding the ServerHello itself).
   * 3. **Send ClientFinished** — client signature over the full transcript
   *    (including ServerHello, excluding ClientFinished). Half-close the
   *    send side via `stream.send.finish()`.
   * 4. **Derive session ID** via HKDF from the transcript.
   *
   * @param stream - The bidirectional control stream (stream 0).
   * @returns The handshake result (peer ID, peer pubkey, session ID).
   * @throws {HandshakeError} If the handshake fails at any step.
   */
  async runClientHandshake(stream: BidiStream): Promise<HandshakeResult> {
    throw new Error("Not implemented");
  }

  /**
   * Build the ClientHello CBOR message.
   *
   * Fields (CBOR IntMap):
   * - `1`: agent_id (text)
   * - `2`: public_key (bytes)
   * - `3`: client_nonce (bytes)
   * - `4`: version (unsigned)
   *
   * @returns A CBOR IntMap representing the ClientHello.
   */
  private buildClientHello(): Map<number, unknown> {
    throw new Error("Not implemented");
  }

  /**
   * Derive the 32-byte session ID from the handshake transcript.
   *
   * Delegates to {@link deriveSessionId} with the stored transcript material.
   *
   * @returns A 32-byte session ID.
   * @throws {HandshakeError} If called before the handshake completes.
   */
  private deriveSessionId(): Uint8Array {
    throw new Error("Not implemented");
  }

  /**
   * Whether the handshake has completed successfully.
   */
  get established(): boolean {
    throw new Error("Not implemented");
  }

  /**
   * The current state of the handshake state machine.
   */
  get currentState(): HandshakeState {
    throw new Error("Not implemented");
  }
}
