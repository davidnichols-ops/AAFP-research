/**
 * Agent metrics and Prometheus exporter.
 *
 * Mirrors `aafp_sdk::metrics::AgentMetrics` and
 * `aafp_sdk::prometheus::PrometheusExporter` from the Rust reference.
 * The Rust version uses lock-free `AtomicU64` counters; in TypeScript
 * (single-threaded event loop), plain number fields suffice.
 *
 * @module metrics
 */

// ─── MetricsSnapshot ────────────────────────────────────────────

/**
 * Point-in-time snapshot of all agent metrics.
 *
 * Returned by {@link AgentMetrics.snapshot} for serialization (e.g.
 * Prometheus export).
 */
export interface MetricsSnapshot {
  /** Current active connections. */
  connectionsActive: number;
  /** Total connections established. */
  connectionsTotal: number;
  /** Total messages sent. */
  messagesSent: number;
  /** Total messages received. */
  messagesReceived: number;
  /** Total bytes sent. */
  bytesSent: number;
  /** Total bytes received. */
  bytesReceived: number;
  /** Total handshakes completed. */
  handshakesCompleted: number;
  /** Total handshakes failed. */
  handshakesFailed: number;
  /** DHT records stored. */
  dhtRecords: number;
  /** Active relay connections. */
  relayConnections: number;
  /** Total messages that failed. */
  messagesFailed: number;
  /** Agent uptime in seconds. */
  uptimeSeconds: number;
}

// ─── HealthStatus ───────────────────────────────────────────────

/**
 * Agent health status.
 *
 * - `Healthy` — normal operation.
 * - `Degraded` — error rate > 10%.
 * - `Unhealthy` — no active connections but had connections previously.
 */
export enum HealthStatus {
  /** Normal operation. */
  Healthy = "healthy",
  /** Error rate > 10%. */
  Degraded = "degraded",
  /** No active connections but had connections previously. */
  Unhealthy = "unhealthy",
}

// ─── AgentMetrics ───────────────────────────────────────────────

/**
 * Agent metrics with plain number counters.
 *
 * Tracks connections, messages, bytes, handshakes, DHT records, relay
 * connections, and uptime. The {@link snapshot} method returns a
 * point-in-time copy for serialization.
 */
export class AgentMetrics {
  /** Current active connections. */
  connectionsActive = 0;
  /** Total connections established. */
  connectionsTotal = 0;
  /** Total messages sent. */
  messagesSent = 0;
  /** Total messages received. */
  messagesReceived = 0;
  /** Total bytes sent. */
  bytesSent = 0;
  /** Total bytes received. */
  bytesReceived = 0;
  /** Total handshakes completed. */
  handshakesCompleted = 0;
  /** Total handshakes failed. */
  handshakesFailed = 0;
  /** DHT records stored. */
  dhtRecords = 0;
  /** Active relay connections. */
  relayConnections = 0;
  /** Total messages that failed. */
  messagesFailed = 0;
  /** Start time (epoch milliseconds). */
  private readonly startTime: number = Date.now();

  /** Record a new connection (increments active and total). */
  recordConnection(): void {
    this.connectionsActive++;
    this.connectionsTotal++;
  }

  /** Record a disconnection (decrements active, floored at 0). */
  recordDisconnect(): void {
    if (this.connectionsActive > 0) this.connectionsActive--;
  }

  /**
   * Record bytes sent (increments message count and byte count).
   * @param bytes - Number of bytes sent.
   */
  recordSent(bytes: number): void {
    this.messagesSent++;
    this.bytesSent += bytes;
  }

  /**
   * Record bytes received (increments message count and byte count).
   * @param bytes - Number of bytes received.
   */
  recordReceived(bytes: number): void {
    this.messagesReceived++;
    this.bytesReceived += bytes;
  }

  /** Record a message failure. */
  recordMessageFailure(): void {
    this.messagesFailed++;
  }

  /** Record a successful handshake. */
  recordHandshake(): void {
    this.handshakesCompleted++;
  }

  /** Record a failed handshake. */
  recordHandshakeFailure(): void {
    this.handshakesFailed++;
  }

  /** Record a DHT record stored. */
  recordDhtRecord(): void {
    this.dhtRecords++;
  }

  /** Record a relay connection established. */
  recordRelayConnection(): void {
    this.relayConnections++;
  }

  /** Record a relay disconnection (decrements, floored at 0). */
  recordRelayDisconnect(): void {
    if (this.relayConnections > 0) this.relayConnections--;
  }

  /** Agent uptime in seconds. */
  get uptimeSeconds(): number {
    return (Date.now() - this.startTime) / 1000;
  }

  /**
   * Take a point-in-time snapshot of all metrics.
   * @returns A {@link MetricsSnapshot} copy.
   */
  snapshot(): MetricsSnapshot {
    return {
      connectionsActive: this.connectionsActive,
      connectionsTotal: this.connectionsTotal,
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      handshakesCompleted: this.handshakesCompleted,
      handshakesFailed: this.handshakesFailed,
      dhtRecords: this.dhtRecords,
      relayConnections: this.relayConnections,
      messagesFailed: this.messagesFailed,
      uptimeSeconds: this.uptimeSeconds,
    };
  }

  /**
   * Compute the current health status.
   *
   * - `Unhealthy` if no active connections but had connections previously.
   * - `Degraded` if error rate > 10%.
   * - `Healthy` otherwise.
   * @returns The current {@link HealthStatus}.
   */
  get health(): HealthStatus {
    if (this.connectionsActive === 0 && this.connectionsTotal > 0) {
      return HealthStatus.Unhealthy;
    }
    const totalMessages = this.messagesSent + this.messagesReceived;
    if (totalMessages > 0) {
      const errorRate = this.messagesFailed / totalMessages;
      if (errorRate > 0.1) return HealthStatus.Degraded;
    }
    return HealthStatus.Healthy;
  }
}

// ─── PrometheusExporter ─────────────────────────────────────────

/**
 * Prometheus text-format metrics exporter.
 *
 * Serves `GET /metrics` in Prometheus text format over HTTP. Only handles
 * `GET /metrics`; returns 404 for anything else. Uses the Node.js `http`
 * module.
 *
 * @example
 * ```typescript
 * const exporter = new PrometheusExporter(metrics, agentId);
 * await exporter.serve("0.0.0.0:9090");
 * ```
 */
export class PrometheusExporter {
  /**
   * @param metrics - The AgentMetrics to export.
   * @param agentId - The agent ID for metric labels.
   */
  constructor(
    private readonly metrics: AgentMetrics,
    private readonly agentId: string,
  ) {}

  /**
   * Start serving Prometheus metrics on the given HTTP address.
   * @param addr - Bind address in `host:port` format.
   * @returns A promise that resolves when the server closes.
   */
  async serve(addr: string): Promise<void> {
    const http = await import("node:http");
    const [host, port] = addr.split(":");
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
        res.end(this.render());
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
    return new Promise<void>((resolve, reject) => {
      server.listen(Number(port) || 9090, host || "0.0.0.0", () => {
        // Server is listening; keep running until closed externally
      });
      server.on("error", reject);
      server.on("close", resolve);
    });
  }

  /**
   * Generate Prometheus-format text for the current metrics.
   *
   * Produces 12 metrics with `# HELP`, `# TYPE`, and value lines,
   * each labeled with `agent_id`.
   * @returns Prometheus text-format string.
   */
  render(): string {
    const s = this.metrics.snapshot();
    const id = this.agentId;
    const lines: string[] = [];

    const metric = (name: string, help: string, type: string, value: number) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name}{agent_id="${id}"} ${value}`);
    };

    metric("aafp_connections_active", "Current active connections", "gauge", s.connectionsActive);
    metric("aafp_connections_total", "Total connections established", "counter", s.connectionsTotal);
    metric("aafp_messages_sent", "Total messages sent", "counter", s.messagesSent);
    metric("aafp_messages_received", "Total messages received", "counter", s.messagesReceived);
    metric("aafp_bytes_sent", "Total bytes sent", "counter", s.bytesSent);
    metric("aafp_bytes_received", "Total bytes received", "counter", s.bytesReceived);
    metric("aafp_handshakes_completed", "Total handshakes completed", "counter", s.handshakesCompleted);
    metric("aafp_handshakes_failed", "Total handshakes failed", "counter", s.handshakesFailed);
    metric("aafp_dht_records", "DHT records stored", "gauge", s.dhtRecords);
    metric("aafp_relay_connections", "Active relay connections", "gauge", s.relayConnections);
    metric("aafp_messages_failed", "Total messages that failed", "counter", s.messagesFailed);
    metric("aafp_uptime_seconds", "Agent uptime in seconds", "gauge", s.uptimeSeconds);

    return lines.join("\n") + "\n";
  }
}
