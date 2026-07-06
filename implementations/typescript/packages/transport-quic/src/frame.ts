/**
 * AAFP v1 frame encoding/decoding (RFC-0002 §3, Rev 6).
 *
 * This codec MUST be byte-for-byte compatible with
 * `aafp-messaging::framing::encode_frame` / `decode_frame` in the Rust
 * implementation.
 *
 * Wire format:
 * ```
 * [28-byte header][extensions][payload]
 * ```
 *
 * Header layout (all big-endian):
 * - Version:       1 byte   (AAFP protocol version, 1 for v1)
 * - FrameType:     1 byte   (frame type, see §4)
 * - Flags:         1 byte   (frame-specific flags)
 * - Reserved:      1 byte   (MUST be 0, MUST be ignored by receivers)
 * - Stream ID:     8 bytes  (stream this frame belongs to)
 * - Payload Len:   8 bytes  (length of payload section)
 * - Extension Len: 8 bytes  (length of extension section)
 *
 * @see RFC-0002 §3 (Frame Format)
 * @see aafp-messaging/src/framing.rs (Rust reference)
 */

/**
 * AAFP protocol version 1.
 */
export const AAFP_VERSION = 1;

/**
 * Maximum payload size: 1 MiB (RFC-0002 §3.4).
 */
export const MAX_PAYLOAD_SIZE = 1024 * 1024;

/**
 * Maximum extension section size: 64 KiB (SA-0006).
 *
 * Without this limit, an attacker could double the per-frame memory
 * allocation (1 MiB payload + 1 MiB extensions = 2 MiB total).
 */
export const MAX_EXTENSION_SIZE = 64 * 1024;

/**
 * Frame header size: 28 bytes.
 *
 * Per RFC-0002 §3.1 field table:
 *   Version(1) + FrameType(1) + Flags(1) + Reserved(1) +
 *   StreamID(8) + PayloadLen(8) + ExtensionLen(8) = 28 bytes.
 */
export const FRAME_HEADER_SIZE = 28;

/**
 * Frame types (RFC-0002 §4).
 *
 * Unknown types are preserved as raw bytes for logging. Per RFC-0006 §4.2,
 * the receiver checks the critical bit (0x80) in the flags field to decide
 * whether to reject (critical) or skip (non-critical) unknown frame types.
 */
export enum FrameType {
  /** Application data frame (RFC-0002 §4.1). */
  Data = 0x01,
  /** Handshake frame for connection establishment (RFC-0002 §4.2). */
  Handshake = 0x02,
  /** RPC request frame (RFC-0002 §4.3). */
  RpcRequest = 0x03,
  /** RPC response frame (RFC-0002 §4.4). */
  RpcResponse = 0x04,
  /** Close frame for graceful connection shutdown (RFC-0002 §4.5). */
  Close = 0x05,
  /** Error frame for reporting protocol errors (RFC-0002 §4.6). */
  Error = 0x06,
  /** Ping frame for keepalive probes (RFC-0002 §4.7). */
  Ping = 0x07,
  /** Pong frame responding to a Ping (RFC-0002 §4.8). */
  Pong = 0x08,
}

/**
 * DATA frame flags (RFC-0002 §4.1).
 */
export const FrameFlags = {
  /** MORE flag: indicates more fragments will follow (RFC-0002 §4.1). */
  MORE: 0x01,
  /** COMPRESSED flag: indicates the payload is compressed (RFC-0002 §4.1). */
  COMPRESSED: 0x02,
  /** Critical bit for unknown frame types (RFC-0006 §4.2). */
  CRITICAL: 0x80,
} as const;

/**
 * An AAFP frame: header + extensions + payload.
 */
export interface Frame {
  /** The AAFP protocol version (always 1 for v1). */
  version: number;
  /** The frame type (e.g., `FrameType.Data`, `FrameType.RpcRequest`). */
  type: FrameType;
  /** Frame-specific flags (see `FrameFlags`). */
  flags: number;
  /** The stream ID this frame belongs to. */
  streamId: bigint;
  /** The frame payload bytes. */
  payload: Uint8Array;
  /** Raw extension section bytes. */
  extensions: Uint8Array;
}

/**
 * Error kinds that can occur during frame encoding/decoding.
 */
export type FrameErrorKind =
  | "PayloadTooLarge"
  | "ExtensionTooLarge"
  | "Incomplete"
  | "UnknownFrameType"
  | "InvalidVersion";

/**
 * Error thrown during frame encoding/decoding.
 */
export class FrameError extends Error {
  /**
   * @param kind - The error category.
   * @param message - Human-readable error message.
   * @param needed - Bytes needed (for `Incomplete` errors).
   * @param have - Bytes actually available (for `Incomplete` errors).
   */
  constructor(
    public readonly kind: FrameErrorKind,
    message: string,
    /** Number of bytes needed to complete the frame (Incomplete only). */
    public readonly needed?: number,
    /** Number of bytes actually available (Incomplete only). */
    public readonly have?: number,
  ) {
    super(message);
    this.name = "FrameError";
  }
}

/**
 * Convert a raw byte to a `FrameType`.
 *
 * Unknown types are preserved as raw numeric values for logging — the
 * caller should check the critical bit to decide whether to reject or skip.
 *
 * @param val - The raw frame type byte.
 * @returns The corresponding `FrameType` enum value, or the raw byte
 *   if the type is not in the v1 registry.
 */
export function frameTypeFromU8(val: number): FrameType {
  switch (val) {
    case 0x01:
      return FrameType.Data;
    case 0x02:
      return FrameType.Handshake;
    case 0x03:
      return FrameType.RpcRequest;
    case 0x04:
      return FrameType.RpcResponse;
    case 0x05:
      return FrameType.Close;
    case 0x06:
      return FrameType.Error;
    case 0x07:
      return FrameType.Ping;
    case 0x08:
      return FrameType.Pong;
    default:
      return val as FrameType; // unknown — caller checks critical bit
  }
}

/**
 * Encode a frame to bytes: `[28-byte header][extensions][payload]`.
 *
 * The header is written big-endian. Extensions come before the payload
 * in the body (RFC-0002 §3.2).
 *
 * @param frame - The frame to encode.
 * @returns The encoded bytes.
 * @throws {FrameError} If the payload or extensions exceed their maximum sizes.
 */
export function encodeFrame(frame: Frame): Uint8Array {
  throw new Error("Not implemented");
}

/**
 * Decode a frame from bytes.
 *
 * Parses the 28-byte header, validates the version and section lengths,
 * then extracts the extensions and payload. Returns the decoded frame
 * and the number of bytes consumed (for buffering multiple frames).
 *
 * @param data - The byte buffer to decode from.
 * @returns An object with the decoded `frame` and `consumed` byte count.
 * @throws {FrameError} On incomplete data, invalid version, oversized
 *   sections, or unknown frame type with critical bit set.
 */
export function decodeFrame(data: Uint8Array): { frame: Frame; consumed: number } {
  throw new Error("Not implemented");
}

/**
 * Create a new DATA frame.
 *
 * @param streamId - The stream this frame belongs to.
 * @param payload - The payload bytes.
 * @returns A `Frame` with type `Data`.
 */
export function dataFrame(streamId: bigint, payload: Uint8Array): Frame {
  throw new Error("Not implemented");
}

/**
 * Create a new HANDSHAKE frame (always on stream 0).
 *
 * @param payload - The handshake payload bytes.
 * @returns A `Frame` with type `Handshake` and stream ID 0.
 */
export function handshakeFrame(payload: Uint8Array): Frame {
  throw new Error("Not implemented");
}

/**
 * Create a PING frame.
 *
 * @param streamId - The stream this frame belongs to.
 * @returns A `Frame` with type `Ping` and empty payload.
 */
export function pingFrame(streamId: bigint): Frame {
  throw new Error("Not implemented");
}

/**
 * Create a PONG frame (same stream as the PING it responds to).
 *
 * @param streamId - The stream this frame belongs to.
 * @returns A `Frame` with type `Pong` and empty payload.
 */
export function pongFrame(streamId: bigint): Frame {
  throw new Error("Not implemented");
}

/**
 * Set the MORE flag on a frame (for DATA frame fragmentation).
 *
 * @param frame - The frame to modify.
 * @returns A new frame with the MORE flag set.
 */
export function withMore(frame: Frame): Frame {
  throw new Error("Not implemented");
}

/**
 * Check if the MORE flag is set on a frame.
 *
 * @param frame - The frame to check.
 * @returns `true` if the MORE flag is set.
 */
export function hasMore(frame: Frame): boolean {
  throw new Error("Not implemented");
}

/**
 * Total wire size of a frame (header + extensions + payload).
 *
 * @param frame - The frame to measure.
 * @returns The total number of bytes the frame occupies on the wire.
 */
export function wireSize(frame: Frame): number {
  throw new Error("Not implemented");
}
