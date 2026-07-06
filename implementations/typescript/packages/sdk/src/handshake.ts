/**
 * Server-side handshake driver and state machine types.
 *
 * Mirrors the Rust `drive_server_handshake` logic. Transport-agnostic —
 * operates on CBOR messages exchanged over stream 0. The state machine
 * tracks server-side sub-states per RFC-0002 §5.10.
 *
 * Server-side states:
 * ```
 * Listening → TransportReady → ChVerified → ShSent → CfVerified →
 * Authorized → Messaging → Closing → Closed
 * ```
 *
 * @module handshake
 */

import { HandlerError, HandlerErrorCategory } from "./handler.js";

// ─── ServerHandshakeState ───────────────────────────────────────

/**
 * Server-side handshake sub-states per RFC-0002 §5.10.
 *
 * Valid transitions (server side):
 * ```
 * Listening      → TransportReady
 * TransportReady → ChVerified
 * ChVerified     → ShSent
 * ShSent         → CfVerified
 * CfVerified     → Authorized
 * Authorized     → Messaging
 * Messaging      → Closing
 * Closing        → Closed
 * ```
 *
 * Graceful shutdown: any active state (`TransportReady` through
 * `Messaging`) can transition to `Closing`. Abort: any non-terminal
 * state can transition to `Closed`.
 */
export type ServerHandshakeState =
  | "Listening"
  | "TransportReady"
  | "ChVerified"
  | "ShSent"
  | "CfVerified"
  | "Authorized"
  | "Messaging"
  | "Closing"
  | "Closed";

// ─── Placeholder types (to be replaced by real implementations) ──

/**
 * Agent keypair placeholder.
 * Will be replaced by the real `AgentKeypair` type from the identity module.
 */
export interface AgentKeypair {
  /** Agent identifier. */
  agentId(): string;
  /** Public key bytes. */
  publicKey: Uint8Array;
  /**
   * Sign a message.
   * @param msg - Message bytes to sign.
   * @returns Signature bytes.
   */
  sign(msg: Uint8Array): Uint8Array;
}

/**
 * Bidirectional stream placeholder.
 * Will be replaced by the real `BidiStream` type from the transport module.
 */
export interface BidiStream {
  /**
   * Read data from the stream.
   * @returns A chunk of bytes, or null on EOF.
   */
  read(): Promise<Uint8Array | null>;
  /**
   * Write data to the stream.
   * @param data - Bytes to write.
   */
  write(data: Uint8Array): Promise<void>;
  /** Signal that the write side is finished. */
  finish(): Promise<void>;
}

/**
 * Decoded frame placeholder.
 * Will be replaced by the real `Frame` type from the framing module.
 */
export interface Frame {
  /** Frame version. */
  version: number;
  /** Frame type byte. */
  type: number;
  /** Frame flags. */
  flags: number;
  /** Stream ID. */
  streamId: bigint;
  /** Frame payload. */
  payload: Uint8Array;
  /** Frame extensions. */
  extensions: Uint8Array;
}

// ─── HandshakeDriver ────────────────────────────────────────────

/**
 * Server-side handshake driver.
 *
 * Drives the AAFP v1 handshake protocol over stream 0. Tracks the
 * server-side state machine, maintains the transcript for signature
 * verification, and derives the session ID on completion.
 *
 * Flow:
 * 1. `TransportReady` — wait for ClientHello on stream 0.
 * 2. Verify ClientHello signature (ML-DSA-65), extract peer AgentId.
 * 3. `ChVerified` → generate ServerHello, sign over transcript, send.
 * 4. `ShSent` → wait for ClientFinished.
 * 5. `CfVerified` → verify ClientFinished signature.
 * 6. `Authorized` → derive session ID from transcript hash.
 * 7. `Messaging` — handshake complete.
 */
export class HandshakeDriver {
  /** Current handshake state. */
  private state: ServerHandshakeState = "Listening";
  /** Transcript of handshake messages for signature verification. */
  private transcript: Uint8Array[] = [];
  /** Agent keypair for signing. */
  private readonly keypair: AgentKeypair;
  /** Derived session ID (32 bytes), or null if handshake not complete. */
  private sessionId: Uint8Array | null = null;

  /**
   * @param keypair - The agent's keypair for signing ServerHello.
   */
  constructor(keypair: AgentKeypair) {
    this.keypair = keypair;
  }

  /** Current handshake state. */
  get currentState(): ServerHandshakeState {
    throw new Error("Not implemented");
  }

  /** Whether the handshake is complete (state is `Messaging`). */
  get established(): boolean {
    throw new Error("Not implemented");
  }

  /** Session ID (32 bytes), or null if handshake not complete. */
  get sessionIdentifier(): Uint8Array | null {
    throw new Error("Not implemented");
  }

  /**
   * Check if a transition to the given state is valid.
   * @param next - The target state.
   * @returns `true` if the transition is allowed.
   */
  canTransitionTo(next: ServerHandshakeState): boolean {
    throw new Error("Not implemented");
  }

  /**
   * Enforce a state transition.
   * @param next - The target state.
   * @throws {Error} If the transition is illegal.
   */
  transitionTo(next: ServerHandshakeState): void {
    throw new Error("Not implemented");
  }

  /**
   * Check if a frame type is allowed in the current state.
   * @param frameType - The frame type byte.
   * @returns `true` if the frame type is allowed.
   */
  isFrameAllowed(frameType: number): boolean {
    throw new Error("Not implemented");
  }

  /**
   * Drive the server-side handshake to completion over stream 0.
   *
   * Returns the session ID (32 bytes) on success.
   *
   * Flow:
   * 1. `TransportReady` — wait for ClientHello on stream 0.
   * 2. Verify ClientHello signature (ML-DSA-65), extract peer AgentId.
   * 3. `ChVerified` → generate ServerHello, sign over transcript, send.
   * 4. `ShSent` → wait for ClientFinished.
   * 5. `CfVerified` → verify ClientFinished signature.
   * 6. `Authorized` → derive session ID from transcript hash.
   * 7. `Messaging` — handshake complete.
   *
   * @param stream - The bidirectional stream (stream 0) for handshake messages.
   * @returns The 32-byte session ID.
   * @throws {HandlerError} On signature verification failure or transport error.
   */
  async driveServerHandshake(stream: BidiStream): Promise<Uint8Array> {
    throw new Error("Not implemented");
  }
}
