import { describe, it, expect } from "vitest";
import {
  encodeWsFrame,
  decodeWsFrame,
  wsDataFrame,
  wsFinFrame,
  wsResetFrame,
  wsPingFrame,
  wsPongFrame,
  wsOpenBidiFrame,
  WsStreamOp,
  WS_FRAME_HEADER_SIZE,
} from "../src/ws-frame.js";

describe("WebSocket stream multiplexing frame codec", () => {
  it("encodes a DATA frame correctly", () => {
    const frame = wsDataFrame(42n, new TextEncoder().encode("hello"));
    const bytes = encodeWsFrame(frame);
    // 13-byte header + 5-byte payload
    expect(bytes.length).toBe(WS_FRAME_HEADER_SIZE + 5);
    expect(bytes[0]).toBe(WsStreamOp.DATA);
    const view = new DataView(bytes.buffer);
    expect(view.getBigUint64(1, false)).toBe(42n);
    expect(view.getUint32(9, false)).toBe(5);
  });

  it("roundtrips a DATA frame", () => {
    const original = wsDataFrame(123n, new TextEncoder().encode("post-quantum"));
    const encoded = encodeWsFrame(original);
    const { frame, consumed } = decodeWsFrame(encoded);
    expect(consumed).toBe(encoded.length);
    expect(frame.op).toBe(WsStreamOp.DATA);
    expect(frame.streamId).toBe(123n);
    expect(frame.payload).toEqual(original.payload);
  });

  it("roundtrips FIN, RESET, PING, PONG, OPEN_BIDI", () => {
    const frames = [
      wsFinFrame(1n),
      wsResetFrame(2n),
      wsPingFrame(0n),
      wsPongFrame(0n),
      wsOpenBidiFrame(3n),
    ];
    for (const f of frames) {
      const encoded = encodeWsFrame(f);
      const { frame, consumed } = decodeWsFrame(encoded);
      expect(consumed).toBe(encoded.length);
      expect(frame.op).toBe(f.op);
      expect(frame.streamId).toBe(f.streamId);
      expect(frame.payload.length).toBe(0);
    }
  });

  it("rejects incomplete frame", () => {
    const frame = wsDataFrame(0n, new Uint8Array(100));
    const bytes = encodeWsFrame(frame);
    const truncated = bytes.slice(0, 5);
    expect(() => decodeWsFrame(truncated)).toThrow();
  });

  it("decodes multiple frames from a buffer", () => {
    const f1 = wsDataFrame(1n, new TextEncoder().encode("a"));
    const f2 = wsPingFrame(0n);
    const e1 = encodeWsFrame(f1);
    const e2 = encodeWsFrame(f2);
    const buf = new Uint8Array(e1.length + e2.length);
    buf.set(e1, 0);
    buf.set(e2, e1.length);
    const { consumed: c1 } = decodeWsFrame(buf);
    const { consumed: c2 } = decodeWsFrame(buf.slice(c1));
    expect(c1 + c2).toBe(buf.length);
  });
});
