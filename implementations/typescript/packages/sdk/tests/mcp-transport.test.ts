import { describe, it, expect } from "vitest";
import { AafpMcpTransport } from "../src/mcp-transport.js";

// Mock stream that collects written data and can be pre-loaded with read data
class MockStream {
  written: Uint8Array[] = [];
  private readQueue: Uint8Array[] = [];
  private readWaiters: Array<() => void> = [];
  private finished = false;

  async write(data: Uint8Array): Promise<void> {
    this.written.push(data);
  }
  async finish(): Promise<void> {
    this.finished = true;
    this.notifyWaiters();
  }
  async read(): Promise<Uint8Array | null> {
    if (this.readQueue.length > 0) return this.readQueue.shift()!;
    if (this.finished) return null;
    await new Promise<void>((r) => this.readWaiters.push(r));
    return this.readQueue.length > 0 ? this.readQueue.shift()! : null;
  }
  async reset(): Promise<void> {
    this.finished = true;
    this.notifyWaiters();
  }

  pushReadData(data: Uint8Array): void {
    this.readQueue.push(data);
    this.notifyWaiters();
  }

  private notifyWaiters(): void {
    for (const w of this.readWaiters) w();
    this.readWaiters.length = 0;
  }
}

function mockConn(stream: MockStream) {
  return {
    async openBidiStream() { return stream; },
    async acceptBidiStream() { return stream; },
    async close() {},
  };
}

describe("AafpMcpTransport", () => {
  it("connect creates a client transport", async () => {
    const stream = new MockStream();
    const conn = mockConn(stream);
    const transport = await AafpMcpTransport.connect(conn, true);
    expect(transport).toBeInstanceOf(AafpMcpTransport);
    expect(transport.peerId).toBeUndefined();
  });

  it("accept creates a server transport", () => {
    const stream = new MockStream();
    const conn = mockConn(stream);
    const transport = AafpMcpTransport.accept(conn);
    expect(transport).toBeInstanceOf(AafpMcpTransport);
  });

  it("send throws before start", async () => {
    const stream = new MockStream();
    const conn = mockConn(stream);
    const transport = await AafpMcpTransport.connect(conn);
    await expect(
      transport.send({ jsonrpc: "2.0", method: "ping", id: 1 } as never),
    ).rejects.toThrow("closed or not started");
  });

  it("send writes JSON to stream after start", async () => {
    const stream = new MockStream();
    const conn = mockConn(stream);
    const transport = await AafpMcpTransport.connect(conn);
    await transport.start();

    const msg = { jsonrpc: "2.0", method: "tools/list", id: 1 } as never;
    await transport.send(msg);

    expect(stream.written.length).toBe(1);
    const decoded = new TextDecoder().decode(stream.written[0]!);
    expect(JSON.parse(decoded).method).toBe("tools/list");

    await transport.close();
  });

  it("close is idempotent", async () => {
    const stream = new MockStream();
    const conn = mockConn(stream);
    const transport = await AafpMcpTransport.connect(conn);
    await transport.start();
    await transport.close();
    await transport.close(); // should not throw
  });

  it("onclose is called on close", async () => {
    const stream = new MockStream();
    const conn = mockConn(stream);
    const transport = await AafpMcpTransport.connect(conn);
    await transport.start();
    let closed = false;
    transport.onclose = () => { closed = true; };
    await transport.close();
    expect(closed).toBe(true);
  });

  it("read loop delivers messages to onmessage", async () => {
    const stream = new MockStream();
    const conn = mockConn(stream);
    const transport = await AafpMcpTransport.connect(conn);
    const received: unknown[] = [];
    transport.onmessage = (msg) => { received.push(msg); };
    await transport.start();

    // Push two messages
    stream.pushReadData(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 })));
    stream.pushReadData(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", result: {}, id: 1 })));

    // Wait for read loop to process
    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBe(2);
    expect((received[0] as { method: string }).method).toBe("ping");

    await transport.close();
  });

  it("read loop skips malformed JSON", async () => {
    const stream = new MockStream();
    const conn = mockConn(stream);
    const transport = await AafpMcpTransport.connect(conn);
    const received: unknown[] = [];
    transport.onmessage = (msg) => { received.push(msg); };
    await transport.start();

    stream.pushReadData(new TextEncoder().encode("{invalid json}"));
    stream.pushReadData(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 })));

    await new Promise((r) => setTimeout(r, 50));
    // Only the valid message should be delivered
    expect(received.length).toBe(1);

    await transport.close();
  });
});
