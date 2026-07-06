/**
 * @aafp/transport-quic — QUIC transport abstraction for the AAFP TypeScript SDK.
 *
 * Re-exports the transport interfaces, configuration, and frame codec.
 *
 * @see RFC-0002 (AAFP Protocol)
 * @see TYPESCRIPT_SDK_DESIGN.md §6 (Transport Abstraction)
 */

export type {
  Multiaddr,
  BidiStream,
  UniSendStream,
  UniRecvStream,
  Connection,
  Transport,
  TransportCreateOptions,
  TransportFactory,
} from "./transport.js";

export {
  AAFP_ALPN,
  CongestionController,
  DEFAULT_CONFIG,
  lowLatencyConfig,
  bulkTransferConfig,
} from "./config.js";

export type { TransportConfig } from "./config.js";

export {
  AAFP_VERSION,
  MAX_PAYLOAD_SIZE,
  MAX_EXTENSION_SIZE,
  FRAME_HEADER_SIZE,
  FrameType,
  FrameFlags,
  FrameError,
  frameTypeFromU8,
  encodeFrame,
  decodeFrame,
  dataFrame,
  handshakeFrame,
  pingFrame,
  pongFrame,
  withMore,
  hasMore,
  wireSize,
} from "./frame.js";

export type { Frame, FrameErrorKind } from "./frame.js";
