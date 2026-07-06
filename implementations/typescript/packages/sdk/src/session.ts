/**
 * Server-side session state machine.
 *
 * Wraps the handshake state machine and tracks the higher-level session
 * lifecycle. Enforces that all messaging requires a completed handshake
 * (Session in `MessagingEnabled` state). No unauthenticated code path
 * exists — mirroring the Rust `Session` enforcement.
 *
 * @module session
 */

import { HandlerError, HandlerErrorCategory } from "./handler.js";

// ─── SessionState ───────────────────────────────────────────────

/**
 * High-level session lifecycle states.
 *
 * - `Idle` — no connection yet.
 * - `Handshaking` — handshake in progress.
 * - `MessagingEnabled` — handshake complete, RPC allowed.
 * - `Closing` — graceful close initiated.
 * - `Closed` — session terminated.
 *
 * Valid transitions:
 * ```
 * Idle → Handshaking → MessagingEnabled → Closing → Closed
 * Handshaking → Closed (handshake failure)
 * ```
 */
export type SessionState =
  | "Idle"
  | "Handshaking"
  | "MessagingEnabled"
  | "Closing"
  | "Closed";

// ─── SessionStateMachine ────────────────────────────────────────

/**
 * Session state machine enforcing the session lifecycle.
 *
 * All messaging requires a completed handshake. Call
 * {@link assertMessagingEnabled} before any RPC processing to enforce
 * authentication.
 *
 * @example
 * ```typescript
 * const session = new SessionStateMachine();
 * session.beginHandshake();
 * // ... perform handshake ...
 * session.completeHandshake(sessionId);
 * session.assertMessagingEnabled(); // OK
 * ```
 */
export class SessionStateMachine {
  /** Current session state. */
  private state: SessionState = "Idle";
  /** Session ID (32 bytes, derived from handshake transcript). */
  private sessionId: Uint8Array | null = null;
  /** Session creation timestamp (epoch milliseconds). */
  private readonly createdAt: number = Date.now();

  /** Current session state. */
  get currentState(): SessionState {
    throw new Error("Not implemented");
  }

  /** Session ID (32 bytes), or null if handshake not complete. */
  get sessionIdentifier(): Uint8Array | null {
    throw new Error("Not implemented");
  }

  /** Whether the session is in the `MessagingEnabled` state. */
  get isMessagingEnabled(): boolean {
    throw new Error("Not implemented");
  }

  /**
   * Begin the handshake phase.
   *
   * Transitions from `Idle` → `Handshaking`.
   * @throws {Error} If not in the `Idle` state.
   */
  beginHandshake(): void {
    throw new Error("Not implemented");
  }

  /**
   * Complete the handshake with a derived session ID.
   *
   * Transitions from `Handshaking` → `MessagingEnabled`.
   * @param sessionId - The 32-byte session ID derived from the handshake transcript.
   * @throws {Error} If not in the `Handshaking` state.
   */
  completeHandshake(sessionId: Uint8Array): void {
    throw new Error("Not implemented");
  }

  /**
   * Fail the handshake.
   *
   * Transitions directly to `Closed`.
   */
  failHandshake(): void {
    throw new Error("Not implemented");
  }

  /**
   * Begin graceful close.
   *
   * Transitions from `MessagingEnabled` → `Closing`.
   * @throws {Error} If not in the `MessagingEnabled` state.
   */
  beginClose(): void {
    throw new Error("Not implemented");
  }

  /**
   * Complete the close.
   *
   * Transitions to `Closed`.
   */
  completeClose(): void {
    throw new Error("Not implemented");
  }

  /**
   * Assert that messaging is enabled (enforces authentication).
   *
   * Must be called before any RPC processing. No unauthenticated code
   * path may bypass this check.
   * @throws {HandlerError} If not in the `MessagingEnabled` state.
   */
  assertMessagingEnabled(): void {
    throw new Error("Not implemented");
  }

  /** Session uptime in milliseconds. */
  get uptimeMs(): number {
    throw new Error("Not implemented");
  }
}
