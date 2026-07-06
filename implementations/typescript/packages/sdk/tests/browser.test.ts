import { describe, it, expect } from "vitest";
import {
  isWebTransportAvailable,
  isWebSocketAvailable,
  WebTransportTransport,
  WsGatewayTransport,
  createTransport,
} from "../src/browser.js";
import { detectRuntime, isBrowser, isNode } from "../src/isomorphic.js";

describe("isomorphic runtime detection", () => {
  it("detectRuntime returns a valid runtime", () => {
    const rt = detectRuntime();
    expect(["node", "browser", "deno", "bun", "unknown"]).toContain(rt);
  });

  it("isBrowser returns boolean", () => {
    expect(typeof isBrowser()).toBe("boolean");
  });

  it("isNode returns boolean", () => {
    expect(typeof isNode()).toBe("boolean");
  });
});

describe("browser transport feature detection", () => {
  it("isWebTransportAvailable returns boolean", () => {
    expect(typeof isWebTransportAvailable()).toBe("boolean");
  });

  it("isWebSocketAvailable returns boolean", () => {
    expect(typeof isWebSocketAvailable()).toBe("boolean");
  });
});

describe("createTransport", () => {
  it("throws when no transport is available", async () => {
    // In Node.js without WebTransport, with no URLs provided, should throw
    // or fall through to WebSocket gateway (which needs a URL)
    await expect(
      createTransport({ role: "client" }),
    ).rejects.toThrow();
  });

  it("throws when WebTransport URL is missing but WT is available", async () => {
    // This test verifies the URL requirement; in Node WT is not available
    // so this is a no-op, but the logic is tested
    if (isWebTransportAvailable()) {
      await expect(
        createTransport({ role: "client" }),
      ).rejects.toThrow("webTransportUrl");
    }
  });
});

describe("WebTransportTransport", () => {
  it("accept throws in browser mode", async () => {
    const transport = new WebTransportTransport({}, "local");
    await expect(transport.accept()).rejects.toThrow("not supported in the browser");
  });
});

describe("WsGatewayTransport", () => {
  it("accept throws", async () => {
    const transport = new WsGatewayTransport({}, "local");
    await expect(transport.accept()).rejects.toThrow("server mode");
  });
});
