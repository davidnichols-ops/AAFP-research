import { describe, it, expect } from "vitest";
import { AgentMetrics, PrometheusExporter, HealthStatus } from "../src/metrics.js";
import { SessionStateMachine } from "../src/session.js";
import { HandlerError } from "../src/handler.js";

describe("AgentMetrics", () => {
  it("starts at zero", () => {
    const m = new AgentMetrics();
    const s = m.snapshot();
    expect(s.connectionsActive).toBe(0);
    expect(s.connectionsTotal).toBe(0);
    expect(s.messagesSent).toBe(0);
    expect(s.bytesSent).toBe(0);
  });

  it("recordConnection / recordDisconnect", () => {
    const m = new AgentMetrics();
    m.recordConnection();
    m.recordConnection();
    expect(m.snapshot().connectionsActive).toBe(2);
    expect(m.snapshot().connectionsTotal).toBe(2);
    m.recordDisconnect();
    expect(m.snapshot().connectionsActive).toBe(1);
    // floored at 0
    m.recordDisconnect();
    m.recordDisconnect();
    expect(m.snapshot().connectionsActive).toBe(0);
  });

  it("recordSent / recordReceived", () => {
    const m = new AgentMetrics();
    m.recordSent(100);
    m.recordSent(200);
    m.recordReceived(50);
    const s = m.snapshot();
    expect(s.messagesSent).toBe(2);
    expect(s.bytesSent).toBe(300);
    expect(s.messagesReceived).toBe(1);
    expect(s.bytesReceived).toBe(50);
  });

  it("handshake tracking", () => {
    const m = new AgentMetrics();
    m.recordHandshake();
    m.recordHandshake();
    m.recordHandshakeFailure();
    expect(m.snapshot().handshakesCompleted).toBe(2);
    expect(m.snapshot().handshakesFailed).toBe(1);
  });

  it("health: healthy by default", () => {
    const m = new AgentMetrics();
    expect(m.health).toBe(HealthStatus.Healthy);
  });

  it("health: degraded when error rate > 10%", () => {
    const m = new AgentMetrics();
    m.recordSent(100); // 1 message sent
    m.recordReceived(100); // 1 message received
    // 2 total messages, need > 0.2 failures for > 10%
    m.recordMessageFailure();
    m.recordMessageFailure();
    m.recordMessageFailure();
    expect(m.health).toBe(HealthStatus.Degraded);
  });

  it("health: unhealthy when no active but had connections", () => {
    const m = new AgentMetrics();
    m.recordConnection();
    m.recordDisconnect();
    expect(m.health).toBe(HealthStatus.Unhealthy);
  });

  it("uptime increases", async () => {
    const m = new AgentMetrics();
    await new Promise((r) => setTimeout(r, 50));
    expect(m.uptimeSeconds).toBeGreaterThan(0);
  });
});

describe("PrometheusExporter", () => {
  it("render produces valid Prometheus format", () => {
    const m = new AgentMetrics();
    m.recordConnection();
    m.recordSent(1024);
    const exporter = new PrometheusExporter(m, "test-agent-id");
    const text = exporter.render();

    // Should contain HELP and TYPE lines
    expect(text).toContain("# HELP aafp_connections_active");
    expect(text).toContain("# TYPE aafp_connections_active gauge");
    expect(text).toContain('agent_id="test-agent-id"');
    expect(text).toContain("aafp_connections_active{agent_id=\"test-agent-id\"} 1");
    expect(text).toContain("aafp_bytes_sent{agent_id=\"test-agent-id\"} 1024");
  });

  it("render includes all 12 metrics", () => {
    const m = new AgentMetrics();
    const exporter = new PrometheusExporter(m, "agent");
    const text = exporter.render();
    const metricLines = text.split("\n").filter((l) => l.startsWith("aafp_"));
    expect(metricLines.length).toBe(12);
  });
});

describe("SessionStateMachine", () => {
  it("starts in Idle", () => {
    const s = new SessionStateMachine();
    expect(s.currentState).toBe("Idle");
    expect(s.isMessagingEnabled).toBe(false);
    expect(s.sessionIdentifier).toBeNull();
  });

  it("transitions Idle → Handshaking → MessagingEnabled", () => {
    const s = new SessionStateMachine();
    s.beginHandshake();
    expect(s.currentState).toBe("Handshaking");
    const sessionId = new Uint8Array(32).fill(0x42);
    s.completeHandshake(sessionId);
    expect(s.currentState).toBe("MessagingEnabled");
    expect(s.isMessagingEnabled).toBe(true);
    expect(s.sessionIdentifier).toEqual(sessionId);
  });

  it("transitions MessagingEnabled → Closing → Closed", () => {
    const s = new SessionStateMachine();
    s.beginHandshake();
    s.completeHandshake(new Uint8Array(32));
    s.beginClose();
    expect(s.currentState).toBe("Closing");
    s.completeClose();
    expect(s.currentState).toBe("Closed");
  });

  it("failHandshake goes to Closed", () => {
    const s = new SessionStateMachine();
    s.beginHandshake();
    s.failHandshake();
    expect(s.currentState).toBe("Closed");
  });

  it("assertMessagingEnabled throws when not enabled", () => {
    const s = new SessionStateMachine();
    expect(() => s.assertMessagingEnabled()).toThrow(HandlerError);
  });

  it("assertMessagingEnabled succeeds when enabled", () => {
    const s = new SessionStateMachine();
    s.beginHandshake();
    s.completeHandshake(new Uint8Array(32));
    expect(() => s.assertMessagingEnabled()).not.toThrow();
  });

  it("invalid transitions throw", () => {
    const s = new SessionStateMachine();
    expect(() => s.completeHandshake(new Uint8Array(32))).toThrow();
    expect(() => s.beginClose()).toThrow();
  });

  it("uptime increases", async () => {
    const s = new SessionStateMachine();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.uptimeMs).toBeGreaterThan(0);
  });
});
