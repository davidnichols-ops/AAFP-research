import { describe, it, expect } from "vitest";
import { Params, Request, Response } from "../src/types.js";
import { HandlerError, HandlerErrorCategory, HandlerContext } from "../src/handler.js";
import { failoverLoop } from "../src/discovery.js";
import { ConnectionPool, PoolConfig } from "../src/pool.js";

describe("Params", () => {
  it("create empty", () => {
    const p = Params.create();
    expect(p.isEmpty).toBe(true);
    expect(p.length).toBe(0);
  });

  it("putStr / getStr", () => {
    const p = Params.create().putStr(1, "hello");
    expect(p.getStr(1)).toBe("hello");
    expect(p.getStr(2)).toBeUndefined();
  });

  it("putU64 / getU64", () => {
    const p = Params.create().putU64(1, 42);
    expect(p.getU64(1)).toBe(42);
  });

  it("putBytes / getBytes", () => {
    const data = new Uint8Array([1, 2, 3]);
    const p = Params.create().putBytes(1, data);
    expect(p.getBytes(1)).toEqual(data);
  });

  it("putBool / getBool", () => {
    const p = Params.create().putBool(1, true);
    expect(p.getBool(1)).toBe(true);
  });

  it("type mismatch returns undefined", () => {
    const p = Params.create().putStr(1, "hello");
    expect(p.getU64(1)).toBeUndefined();
    expect(p.getBool(1)).toBeUndefined();
  });

  it("chaining", () => {
    const p = Params.create()
      .putStr(1, "name")
      .putU64(2, 100)
      .putBool(3, false);
    expect(p.length).toBe(3);
    expect(p.getStr(1)).toBe("name");
    expect(p.getU64(2)).toBe(100);
    expect(p.getBool(3)).toBe(false);
  });

  it("toCbor / fromCbor roundtrip", () => {
    const p = Params.create().putStr(1, "hello").putU64(2, 42);
    const cbor = p.toCbor();
    expect(cbor.type).toBe("int-map");
    const p2 = Params.fromCbor(cbor);
    expect(p2.getStr(1)).toBe("hello");
    expect(p2.getU64(2)).toBe(42);
  });
});

describe("Request", () => {
  it("text request", () => {
    const req = Request.text("hello");
    expect(req.body).toBe("hello");
    expect(req.payload).toBeNull();
    expect(req.params.isEmpty).toBe(true);
  });

  it("data request", () => {
    const data = new Uint8Array([1, 2, 3]);
    const req = Request.data(data);
    expect(req.payload).toEqual(data);
    expect(req.body).toBe("");
  });

  it("params request", () => {
    const params = Params.create().putU64(1, 42);
    const req = Request.withParams(params);
    expect(req.params.getU64(1)).toBe(42);
  });

  it("withMetadata", () => {
    const req = Request.text("hello").withMetadata((m) => {
      m.capability = "echo";
      m.traceId = "trace-123";
    });
    expect(req.metadata.capability).toBe("echo");
    expect(req.metadata.traceId).toBe("trace-123");
  });
});

describe("Response", () => {
  it("text response", () => {
    const resp = Response.text("ok");
    expect(resp.body).toBe("ok");
    expect(resp.payload).toBeNull();
  });

  it("data response", () => {
    const data = new Uint8Array([4, 5, 6]);
    const resp = Response.data(data);
    expect(resp.payload).toEqual(data);
  });

  it("result response", () => {
    const params = Params.create().putStr(1, "result");
    const resp = Response.withResult(params);
    expect(resp.result.getStr(1)).toBe("result");
  });

  it("withMetadata", () => {
    const resp = Response.text("ok").withMetadata((m) => {
      m.contentType = "text/plain";
      m.extra["x-custom"] = "value";
    });
    expect(resp.metadata.contentType).toBe("text/plain");
    expect(resp.metadata.extra["x-custom"]).toBe("value");
  });
});

describe("HandlerError", () => {
  it("default code for category", () => {
    const err = new HandlerError(HandlerErrorCategory.Transport, "conn reset");
    expect(err.code).toBe(1001);
    expect(err.category).toBe(HandlerErrorCategory.Transport);
  });

  it("explicit code", () => {
    const err = new HandlerError(HandlerErrorCategory.Messaging, "bad params", 5001);
    expect(err.code).toBe(5001);
  });

  it("fromCode infers category", () => {
    const err = HandlerError.fromCode(3001, "unauthorized");
    expect(err.category).toBe(HandlerErrorCategory.Authorization);
    expect(err.code).toBe(3001);
  });

  it("all 8 categories have default codes", () => {
    const expected: Record<HandlerErrorCategory, number> = {
      Transport: 1001,
      Authentication: 2001,
      Authorization: 3001,
      Discovery: 4005,
      Messaging: 5004,
      Capability: 6003,
      Protocol: 8009,
      Application: 9000,
    };
    for (const cat of Object.keys(expected) as HandlerErrorCategory[]) {
      const err = new HandlerError(cat, "test");
      expect(err.code, `category ${cat}`).toBe(expected[cat]);
    }
  });
});

describe("HandlerContext", () => {
  it("cancelled reflects signal", () => {
    const ctrl = new AbortController();
    const ctx = new HandlerContext(ctrl.signal, "echo");
    expect(ctx.cancelled).toBe(false);
    expect(ctx.capability).toBe("echo");
    ctrl.abort();
    expect(ctx.cancelled).toBe(true);
  });

  it("throwIfCancelled throws when aborted", () => {
    const ctrl = new AbortController();
    const ctx = new HandlerContext(ctrl.signal, "echo");
    expect(() => ctx.throwIfCancelled()).not.toThrow();
    ctrl.abort();
    expect(() => ctx.throwIfCancelled()).toThrow(HandlerError);
  });
});

describe("ConnectionPool", () => {
  it("config presets", () => {
    expect(PoolConfig.default().maxSize).toBe(32);
    expect(PoolConfig.highThroughput().maxSize).toBe(256);
    expect(PoolConfig.conservative().maxSize).toBe(8);
  });

  it("getOrConnect tracks hits and misses", async () => {
    const pool = new ConnectionPool({ maxSize: 10, idleTimeoutMs: 60_000 });
    await pool.getOrConnect("addr1");
    await pool.getOrConnect("addr1"); // hit
    const stats = pool.stats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.total).toBe(1);
    expect(stats.hitRate).toBe(0.5);
  });

  it("LRU eviction when full", async () => {
    const pool = new ConnectionPool({ maxSize: 2, idleTimeoutMs: 60_000 });
    await pool.getOrConnect("a");
    await pool.getOrConnect("b");
    await pool.getOrConnect("c"); // should evict "a"
    const stats = pool.stats();
    expect(stats.total).toBe(2);
    expect(stats.evictions).toBe(1);
  });

  it("registerRecord and getRecord", () => {
    const pool = new ConnectionPool({ maxSize: 10, idleTimeoutMs: 60_000 });
    pool.registerRecord({
      agentId: "abc123",
      endpoints: ["quic://1.2.3.4:443"],
      capabilities: ["echo"],
      publicKey: new Uint8Array(32),
    });
    const record = pool.getRecord("abc123");
    expect(record).toBeDefined();
    expect(record?.capabilities).toEqual(["echo"]);
  });

  it("closeAll clears everything", async () => {
    const pool = new ConnectionPool({ maxSize: 10, idleTimeoutMs: 60_000 });
    await pool.getOrConnect("a");
    await pool.closeAll();
    expect(pool.stats().total).toBe(0);
  });
});

describe("failoverLoop", () => {
  it("returns first success", async () => {
    const result = await failoverLoop(["a", "b", "c"], async (addr) => {
      if (addr === "a") throw new Error("fail a");
      if (addr === "b") throw new Error("fail b");
      return `ok-${addr}`;
    });
    expect(result).toBe("ok-c");
  });

  it("throws last error if all fail", async () => {
    await expect(
      failoverLoop(["a", "b"], async () => {
        throw new Error("all fail");
      }),
    ).rejects.toThrow("all fail");
  });

  it("respects maxAttempts", async () => {
    let attempts = 0;
    await expect(
      failoverLoop(["a", "b", "c"], async () => {
        attempts++;
        throw new Error("fail");
      }, { maxAttempts: 2 }),
    ).rejects.toThrow("fail");
    expect(attempts).toBe(2);
  });
});
