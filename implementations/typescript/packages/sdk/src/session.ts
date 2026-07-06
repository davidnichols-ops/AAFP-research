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
    return this.state;
  }

  /** Session ID (32 bytes), or null if handshake not complete. */
  get sessionIdentifier(): Uint8Array | null {
    return this.sessionId;
  }

  /** Whether the session is in the `MessagingEnabled` state. */
  get isMessagingEnabled(): boolean {
    return this.state === "MessagingEnabled";
  }

  /**
   * Begin the handshake phase.
   *
   * Transitions from `Idle` → `Handshaking`.
   * @throws {Error} If not in the `Idle` state.
   */
  beginHandshake(): void {
    if (this.state !== "Idle") {
      throw new Error(`cannot begin handshake from state ${this.state}`);
    }
    this.state = "Handshaking";
  }

  /**
   * Complete the handshake with a derived session ID.
   *
   * Transitions from `Handshaking` → `MessagingEnabled`.
   * @param sessionId - The 32-byte session ID derived from the handshake transcript.
   * @throws {Error} If not in the `Handshaking` state.
   */
  completeHandshake(sessionId: Uint8Array): void {
    if (this.state !== "Handshaking") {
      throw new Error(`cannot complete handshake from state ${this.state}`);
    }
    this.sessionId = sessionId;
    this.state = "MessagingEnabled";
  }

  /**
   * Fail the handshake.
   *
   * Transitions directly to `Closed`.
   */
  failHandshake(): void {
    this.state = "Closed";
  }

  /**
   * Begin graceful close.
   *
   * Transitions from `MessagingEnabled` → `Closing`.
   * @throws {Error} If not in the `MessagingEnabled` state.
   */
  beginClose(): void {
    if (this.state !== "MessagingEnabled") {
      throw new Error(`cannot begin close from state ${this.state}`);
    }
    this.state = "Closing";
  }

  /**
   * Complete the close.
   *
   * Transitions to `Closed`.
   */
  completeClose(): void {
    this.state = "Closed";
  }

  /**
   * Assert that messaging is enabled (enforces authentication).
   *
   * Must be called before any RPC processing. No unauthenticated code
   * path may bypass this check.
   * @throws {HandlerError} If not in the `MessagingEnabled` state.
   */
  assertMessagingEnabled(): void {
    if (this.state !== "MessagingEnabled") {
      throw new HandlerError(
        HandlerErrorCategory.Authentication,
        `messaging not enabled: session state is ${this.state}`,
        2001,
      );
    }
  }

  /** Session uptime in milliseconds. */
  get uptimeMs(): number {
    return Date.now() - this.createdAt;
  }
}
