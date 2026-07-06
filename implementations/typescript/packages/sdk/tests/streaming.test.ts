import { describe, it, expect } from "vitest";
import { Response } from "../src/types.js";
import { HandlerError, HandlerErrorCategory } from "../src/handler.js";
import { ResponseSender, ResponseStream, BidiSession } from "../src/streaming.js";
import type { QuicSendStream, QuicRecvStream } from "../src/streaming.js";

// Mock send stream
class MockSendStream implements QuicSendStream {
  written: Uint8Array[] = [];
  finished = false;
  resetCode: number | null = null;

  async write(data: Uint8Array): Promise<void> {
    this.written.push(data);
  }
  async finish(): Promise<void> {
    this.finished = true;
  }
  async reset(code?: number): Promise<void> {
    this.resetCode = code ?? 0;
  }
}

// Mock recv stream — yields pre-programmed chunks
class MockRecvStream implements QuicRecvStream {
  private chunks: Uint8Array[];
  private index = 0;

  constructor(chunks: Uint8Array[]) {
    this.chunks = chunks;
  }

  async read(): Promise<Uint8Array | null> {
    if (this.index >= this.chunks.length) return null;
    return this.chunks[this.index++]!;
  }
}

describe("ResponseSender", () => {
  it("send writes to stream", async () => {
    const send = new MockSendStream();
    const ctrl = new AbortController();
    const sender = new ResponseSender(send, 1, ctrl);
    await sender.send(Response.text("hello"));
    expect(send.written.length).toBe(1);
    expect(new TextDecoder().decode(send.written[0]!)).toBe("hello");
    expect(send.finished).toBe(false);
  });

  it("error writes error frame and closes", async () => {
    const send = new MockSendStream();
    const ctrl = new AbortController();
    const sender = new ResponseSender(send, 1, ctrl);
    await sender.error(new HandlerError(HandlerErrorCategory.Messaging, "bad params"));
    expect(send.written.length).toBe(1);
    expect(send.finished).toBe(true);
    expect(sender.isClosed).toBe(true);
  });

  it("close finishes stream", async () => {
    const send = new MockSendStream();
    const ctrl = new AbortController();
    const sender = new ResponseSender(send, 1, ctrl);
    await sender.close();
    expect(send.finished).toBe(true);
    expect(sender.isClosed).toBe(true);
  });

  it("double close is safe", async () => {
    const send = new MockSendStream();
    const ctrl = new AbortController();
    const sender = new ResponseSender(send, 1, ctrl);
    await sender.close();
    await sender.close(); // should not throw
    expect(send.finished).toBe(true);
  });

  it("send after close throws", async () => {
    const send = new MockSendStream();
    const ctrl = new AbortController();
    const sender = new ResponseSender(send, 1, ctrl);
    await sender.close();
    await expect(sender.send(Response.text("x"))).rejects.toThrow("already closed");
  });

  it("send after cancel throws", async () => {
    const send = new MockSendStream();
    const ctrl = new AbortController();
    const sender = new ResponseSender(send, 1, ctrl);
    ctrl.abort();
    await expect(sender.send(Response.text("x"))).rejects.toThrow("cancelled");
  });
});

describe("ResponseStream", () => {
  it("iterates over chunks", async () => {
    const chunks = [
      new TextEncoder().encode("chunk1"),
      new TextEncoder().encode("chunk2"),
    ];
    const recv = new MockRecvStream(chunks);
    const send = new MockSendStream();
    const ctrl = new AbortController();
    const stream = new ResponseStream(recv, send, ctrl.signal);

    const results: string[] = [];
    for await (const resp of stream) {
      results.push(resp.body);
    }
    expect(results).toEqual(["chunk1", "chunk2"]);
  });

  it("empty stream terminates immediately", async () => {
    const recv = new MockRecvStream([]);
    const send = new MockSendStream();
    const ctrl = new AbortController();
    const stream = new ResponseStream(recv, send, ctrl.signal);

    const results: string[] = [];
    for await (const resp of stream) {
      results.push(resp.body);
    }
    expect(results).toEqual([]);
  });

  it("double iteration throws", async () => {
    const recv = new MockRecvStream([]);
    const send = new MockSendStream();
    const ctrl = new AbortController();
    const stream = new ResponseStream(recv, send, ctrl.signal);

    for await (const _ of stream) { /* drain */ }
    await expect((async () => {
      for await (const _ of stream) { /* should throw */ }
    })()).rejects.toThrow("already consumed");
  });
});

describe("BidiSession", () => {
  it("send and finish", async () => {
    const send = new MockSendStream();
    const recv = new MockRecvStream([]);
    const ctrl = new AbortController();
    const session = new BidiSession(send, recv, ctrl.signal);

    session.send(Request.text("req1"));
    session.send(Request.text("req2"));
    session.finish();

    // Wait for flush
    await new Promise((r) => setTimeout(r, 50));
    expect(send.written.length).toBe(2);
    expect(send.finished).toBe(true);
  });

  it("send after finish throws", () => {
    const send = new MockSendStream();
    const recv = new MockRecvStream([]);
    const ctrl = new AbortController();
    const session = new BidiSession(send, recv, ctrl.signal);
    session.finish();
    expect(() => session.send(Request.text("x"))).toThrow("already closed");
  });

  it("cancel resets send stream", async () => {
    const send = new MockSendStream();
    const recv = new MockRecvStream([]);
    const ctrl = new AbortController();
    const session = new BidiSession(send, recv, ctrl.signal);
    session.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(send.resetCode).toBe(0);
  });
});

// Import Request for the BidiSession tests
import { Request } from "../src/types.js";
