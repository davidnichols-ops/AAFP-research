import { describe, it, expect } from "vitest";
import {
  encodeFrame,
  decodeFrame,
  dataFrame,
  handshakeFrame,
  pingFrame,
  pongFrame,
  withMore,
  hasMore,
  wireSize,
  FrameType,
  FrameFlags,
  AAFP_VERSION,
  FRAME_HEADER_SIZE,
  FrameError,
} from "../src/frame.js";

describe("AAFP frame codec", () => {
  it("encodes a DATA frame correctly", () => {
    const frame = dataFrame(42n, new TextEncoder().encode("hello"));
    const bytes = encodeFrame(frame);
    // 28-byte header + 5-byte payload
    expect(bytes.length).toBe(28 + 5);

    // Check header fields
    expect(bytes[0]).toBe(AAFP_VERSION); // version
    expect(bytes[1]).toBe(FrameType.Data); // type
    expect(bytes[2]).toBe(0); // flags
    expect(bytes[3]).toBe(0); // reserved

    // Stream ID (big-endian, 8 bytes)
    const view = new DataView(bytes.buffer);
    expect(view.getBigUint64(4, false)).toBe(42n);
    // Payload length
    expect(view.getBigUint64(12, false)).toBe(5n);
    // Extension length
    expect(view.getBigUint64(20, false)).toBe(0n);

    // Payload at offset 28
    expect(new TextDecoder().decode(bytes.slice(28))).toBe("hello");
  });

  it("roundtrips a DATA frame", () => {
    const original = dataFrame(123n, new TextEncoder().encode("post-quantum"));
    const encoded = encodeFrame(original);
    const { frame, consumed } = decodeFrame(encoded);
    expect(consumed).toBe(encoded.length);
    expect(frame.version).toBe(original.version);
    expect(frame.type).toBe(original.type);
    expect(frame.flags).toBe(original.flags);
    expect(frame.streamId).toBe(original.streamId);
    expect(frame.payload).toEqual(original.payload);
    expect(frame.extensions).toEqual(original.extensions);
  });

  it("roundtrips a HANDSHAKE frame (stream 0)", () => {
    const original = handshakeFrame(new TextEncoder().encode("handshake-data"));
    expect(original.streamId).toBe(0n);
    const encoded = encodeFrame(original);
    const { frame } = decodeFrame(encoded);
    expect(frame.type).toBe(FrameType.Handshake);
    expect(frame.streamId).toBe(0n);
    expect(frame.payload).toEqual(original.payload);
  });

  it("roundtrips PING and PONG frames", () => {
    const ping = pingFrame(7n);
    const pingBytes = encodeFrame(ping);
    const { frame: decodedPing } = decodeFrame(pingBytes);
    expect(decodedPing.type).toBe(FrameType.Ping);
    expect(decodedPing.streamId).toBe(7n);
    expect(decodedPing.payload.length).toBe(0);

    const pong = pongFrame(7n);
    const pongBytes = encodeFrame(pong);
    const { frame: decodedPong } = decodeFrame(pongBytes);
    expect(decodedPong.type).toBe(FrameType.Pong);
  });

  it("roundtrips a frame with extensions", () => {
    const frame = {
      version: AAFP_VERSION,
      type: FrameType.Data,
      flags: 0,
      streamId: 99n,
      payload: new TextEncoder().encode("payload"),
      extensions: new TextEncoder().encode("ext"),
    };
    const encoded = encodeFrame(frame);
    const { frame: decoded, consumed } = decodeFrame(encoded);
    expect(consumed).toBe(encoded.length);
    expect(decoded.extensions).toEqual(frame.extensions);
    expect(decoded.payload).toEqual(frame.payload);
  });

  it("MORE flag set and check", () => {
    const frame = dataFrame(1n, new Uint8Array(0));
    expect(hasMore(frame)).toBe(false);
    const withMoreFrame = withMore(frame);
    expect(hasMore(withMoreFrame)).toBe(true);
    expect(withMoreFrame.flags & FrameFlags.MORE).toBe(FrameFlags.MORE);
  });

  it("wireSize returns header + ext + payload", () => {
    const frame = {
      version: AAFP_VERSION,
      type: FrameType.Data,
      flags: 0,
      streamId: 0n,
      payload: new Uint8Array(100),
      extensions: new Uint8Array(50),
    };
    expect(wireSize(frame)).toBe(FRAME_HEADER_SIZE + 50 + 100);
  });

  it("rejects payload too large", () => {
    const frame = dataFrame(0n, new Uint8Array(1024 * 1024 + 1));
    expect(() => encodeFrame(frame)).toThrow(FrameError);
  });

  it("rejects invalid version", () => {
    const frame = dataFrame(0n, new Uint8Array(0));
    const bytes = encodeFrame(frame);
    bytes[0] = 99; // invalid version
    expect(() => decodeFrame(bytes)).toThrow(FrameError);
  });

  it("rejects incomplete frame", () => {
    const frame = dataFrame(0n, new Uint8Array(100));
    const bytes = encodeFrame(frame);
    const truncated = bytes.slice(0, 50);
    expect(() => decodeFrame(truncated)).toThrow(FrameError);
  });

  it("decodes multiple frames from a buffer", () => {
    const f1 = dataFrame(1n, new TextEncoder().encode("first"));
    const f2 = dataFrame(2n, new TextEncoder().encode("second"));
    const buf = new Uint8Array(encodeFrame(f1).length + encodeFrame(f2).length);
    buf.set(encodeFrame(f1), 0);
    buf.set(encodeFrame(f2), encodeFrame(f1).length);

    const { frame: d1, consumed: c1 } = decodeFrame(buf);
    expect(d1.streamId).toBe(1n);
    const { frame: d2, consumed: c2 } = decodeFrame(buf.slice(c1));
    expect(d2.streamId).toBe(2n);
    expect(c1 + c2).toBe(buf.length);
  });
});
