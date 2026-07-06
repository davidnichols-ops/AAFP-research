/**
 * Integration test: full SDK API surface smoke test.
 *
 * Verifies that all public exports are accessible and functional.
 */

import { describe, it, expect } from "vitest";
import {
  // Types
  Params,
  Request,
  Response,
  // Handler
  HandlerContext,
  HandlerError,
  HandlerErrorCategory,
  // Server
  ServeBuilder,
  // Client
  ConnectBuilder,
  // Pool
  ConnectionPool,
  PoolConfig,
  // Discovery
  failoverLoop,
  // Session
  SessionStateMachine,
  // Metrics
  AgentMetrics,
  PrometheusExporter,
  HealthStatus,
} from "../src/index.js";

describe("SDK public API surface", () => {
  it("Params is constructable", () => {
    const p = Params.create().putStr(1, "hello").putU64(2, 42);
    expect(p.getStr(1)).toBe("hello");
    expect(p.getU64(2)).toBe(42);
  });

  it("Request/Response factories work", () => {
    expect(Request.text("hi").body).toBe("hi");
    expect(Response.text("ok").body).toBe("ok");
    expect(Request.data(new Uint8Array([1])).payload).toEqual(new Uint8Array([1]));
  });

  it("HandlerError has all 8 categories", () => {
    const categories = Object.values(HandlerErrorCategory);
    expect(categories.length).toBe(8);
    for (const cat of categories) {
      const err = new HandlerError(cat as HandlerErrorCategory, "test");
      expect(err.code).toBeGreaterThan(0);
    }
  });

  it("HandlerContext cancellation", () => {
    const ctrl = new AbortController();
    const ctx = new HandlerContext(ctrl.signal, "test");
    expect(ctx.cancelled).toBe(false);
    ctrl.abort();
    expect(ctx.cancelled).toBe(true);
  });

  it("ServeBuilder is chainable", () => {
    const builder = new ServeBuilder()
      .capability("echo")
      .onCapability("echo", async (req) => Response.text(req.body))
      .bind("127.0.0.1:0")
      .withMetrics("0.0.0.0:9090");

    expect(builder).toBeInstanceOf(ServeBuilder);
  });

  it("ConnectBuilder is chainable", () => {
    const builder = new ConnectBuilder()
      .withSeeds(["/ip4/127.0.0.1/udp/4001/quic-v1"])
      .withPoolConfig(PoolConfig.default());

    expect(builder).toBeInstanceOf(ConnectBuilder);
  });

  it("ConnectionPool works", async () => {
    const pool = new ConnectionPool(PoolConfig.default());
    await pool.getOrConnect("addr1");
    expect(pool.stats().total).toBe(1);
  });

  it("failoverLoop works", async () => {
    const result = await failoverLoop(["a", "b"], async (addr) => {
      if (addr === "a") throw new Error("fail");
      return "ok";
    });
    expect(result).toBe("ok");
  });

  it("SessionStateMachine transitions", () => {
    const s = new SessionStateMachine();
    expect(s.currentState).toBe("Idle");
    s.beginHandshake();
    expect(s.currentState).toBe("Handshaking");
    s.completeHandshake(new Uint8Array(32));
    expect(s.isMessagingEnabled).toBe(true);
  });

  it("AgentMetrics and PrometheusExporter", () => {
    const m = new AgentMetrics();
    m.recordConnection();
    m.recordSent(1024);
    expect(m.health).toBe(HealthStatus.Healthy);

    const exporter = new PrometheusExporter(m, "test-agent");
    const text = exporter.render();
    expect(text).toContain("aafp_connections_active");
    expect(text).toContain("aafp_bytes_sent");
  });

  it("PoolConfig presets", () => {
    expect(PoolConfig.default().maxSize).toBe(32);
    expect(PoolConfig.highThroughput().maxSize).toBe(256);
    expect(PoolConfig.conservative().maxSize).toBe(8);
  });
});
