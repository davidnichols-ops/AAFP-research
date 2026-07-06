/**
 * WebSocket stream multiplexing frame protocol.
 *
 * Each AAFP stream is multiplexed over a single WebSocket connection
 * using a simple framing protocol:
 * ```
 * [1 byte: stream op][8 bytes: stream ID][4 bytes: payload length][payload]
 * ```
 *
 * Stream ops:
 * - `OPEN_BIDI` (0x01): Open a new bidirectional stream.
 * - `DATA`      (0x02): Data frame for a stream.
 * - `FIN`       (0x03): Finish (half-close) the send side of a stream.
 * - `RESET`     (0x04): Reset/abort a stream with an error code.
 * - `PING`      (0x05): Keepalive ping.
 * - `PONG`      (0x06): Keepalive pong response.
 *
 * @see TYPESCRIPT_SDK_DESIGN.md §3.3 (WebSocket Fallback)
 */

/**
 * WebSocket stream multiplexing operations.
 */
export enum WsStreamOp {
  /** Open a new bidirectional stream. */
  OPEN_BIDI = 0x01,
  /** Data frame for a stream. */
  DATA = 0x02,
  /** Finish (half-close) the send side of a stream. */
  FIN = 0x03,
  /** Reset/abort a stream with an error code. */
  RESET = 0x04,
  /** Keepalive ping. */
  PING = 0x05,
  /** Keepalive pong response. */
  PONG = 0x06,
}

/**
 * WebSocket frame header size: 1 (op) + 8 (stream ID) + 4 (payload len) = 13 bytes.
 */
export const WS_FRAME_HEADER_SIZE = 13;

/**
 * A WebSocket stream multiplexing frame.
 */
export interface WsFrame {
  /** The stream operation (OPEN_BIDI, DATA, FIN, RESET, PING, PONG). */
  op: WsStreamOp;
  /** The virtual stream ID. */
  streamId: bigint;
  /** The payload bytes (may be empty for FIN/RESET/PING/PONG). */
  payload: Uint8Array;
}

/**
 * Encode a WebSocket stream frame to bytes.
 *
 * Format: `[1 byte: op][8 bytes: stream ID][4 bytes: payload len][payload]`
 *
 * @param frame - The `WsFrame` to encode.
 * @returns The encoded bytes (13-byte header + payload).
 */
export function encodeWsFrame(frame: WsFrame): Uint8Array {
  throw new Error("Not implemented");
}

/**
 * Decode a WebSocket stream frame from bytes.
 *
 * @param data - The byte buffer to decode from (must be at least 13 bytes).
 * @returns An object with the decoded `frame` and `consumed` byte count.
 * @throws {Error} If the buffer is too short for a complete frame.
 */
export function decodeWsFrame(data: Uint8Array): { frame: WsFrame; consumed: number } {
  throw new Error("Not implemented");
}

/**
 * Create a DATA frame for a stream.
 *
 * @param streamId - The virtual stream ID.
 * @param payload - The data bytes.
 * @returns A `WsFrame` with op `DATA`.
 */
export function wsDataFrame(streamId: bigint, payload: Uint8Array): WsFrame {
  throw new Error("Not implemented");
}

/**
 * Create a FIN frame for a stream (half-close the send side).
 *
 * @param streamId - The virtual stream ID.
 * @returns A `WsFrame` with op `FIN` and empty payload.
 */
export function wsFinFrame(streamId: bigint): WsFrame {
  throw new Error("Not implemented");
}

/**
 * Create a RESET frame for a stream (abort with error code).
 *
 * @param streamId - The virtual stream ID.
 * @returns A `WsFrame` with op `RESET` and empty payload.
 */
export function wsResetFrame(streamId: bigint): WsFrame {
  throw new Error("Not implemented");
}

/**
 * Create a PING frame for keepalive.
 *
 * @param streamId - The virtual stream ID (typically 0 for control).
 * @returns A `WsFrame` with op `PING` and empty payload.
 */
export function wsPingFrame(streamId: bigint): WsFrame {
  throw new Error("Not implemented");
}

/**
 * Create a PONG frame responding to a PING.
 *
 * @param streamId - The virtual stream ID (matches the PING).
 * @returns A `WsFrame` with op `PONG` and empty payload.
 */
export function wsPongFrame(streamId: bigint): WsFrame {
  throw new Error("Not implemented");
}

/**
 * Create an OPEN_BIDI frame to open a new bidirectional stream.
 *
 * @param streamId - The virtual stream ID to open.
 * @returns A `WsFrame` with op `OPEN_BIDI` and empty payload.
 */
export function wsOpenBidiFrame(streamId: bigint): WsFrame {
  throw new Error("Not implemented");
}
