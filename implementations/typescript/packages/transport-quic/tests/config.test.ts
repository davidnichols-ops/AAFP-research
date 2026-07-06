import { describe, it, expect } from "vitest";
import {
  AAFP_ALPN,
  DEFAULT_CONFIG,
  lowLatencyConfig,
  bulkTransferConfig,
  CongestionController,
} from "../src/config.js";

describe("Transport config", () => {
  it("ALPN is aafp/1", () => {
    expect(AAFP_ALPN).toBe("aafp/1");
  });

  it("default config has expected values", () => {
    expect(DEFAULT_CONFIG.maxConcurrentStreams).toBe(100);
    expect(DEFAULT_CONFIG.maxPayloadSize).toBe(1024 * 1024);
    expect(DEFAULT_CONFIG.congestion).toBe(CongestionController.Cubic);
    expect(DEFAULT_CONFIG.enablePqKex).toBe(true);
  });

  it("lowLatencyConfig uses BBR", () => {
    const cfg = lowLatencyConfig();
    expect(cfg.congestion).toBe(CongestionController.Bbr);
    expect(cfg.initialRttMs).toBe(10);
    expect(cfg.maxIdleTimeoutMs).toBe(10_000);
  });

  it("bulkTransferConfig uses Cubic with large window", () => {
    const cfg = bulkTransferConfig();
    expect(cfg.congestion).toBe(CongestionController.Cubic);
    expect(cfg.streamInitialMaxData).toBe(10 * 1024 * 1024);
    expect(cfg.maxIdleTimeoutMs).toBe(300_000);
  });
});
