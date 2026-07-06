/**
 * @aafp/transport-ws — WebSocket fallback transport for the AAFP TypeScript SDK.
 *
 * Re-exports the WebSocket gateway transport and stream multiplexing
 * frame protocol.
 *
 * @see RFC-0002 §2 (Transport)
 * @see TYPESCRIPT_SDK_DESIGN.md §3.3 (WebSocket Fallback)
 */

export {
  WsGatewayTransport,
  WsGatewayConnection,
  WsGatewayBidiStream,
  WsGatewayUniSendStream,
} from "./ws-transport.js";

export {
  WsStreamOp,
  WS_FRAME_HEADER_SIZE,
  encodeWsFrame,
  decodeWsFrame,
  wsDataFrame,
  wsFinFrame,
  wsResetFrame,
  wsPingFrame,
  wsPongFrame,
  wsOpenBidiFrame,
} from "./ws-frame.js";

export type { WsFrame } from "./ws-frame.js";
