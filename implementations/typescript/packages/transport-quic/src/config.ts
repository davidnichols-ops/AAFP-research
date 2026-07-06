/**
 * Transport configuration for the AAFP TypeScript SDK.
 *
 * Mirrors the Rust `QuicConfig` (see `aafp-transport-quic/src/config.rs`).
 * The TS config is transport-agnostic — each concrete transport maps it
 * to its native settings.
 *
 * @see RFC-0002 §2.3 (Configuration)
 * @see TYPESCRIPT_SDK_DESIGN.md §6.2 (Configuration)
 */

/**
 * ALPN protocol identifier for AAFP v1 (RFC-0002 §2.2, RFC-0006 §2.3).
 *
 * This MUST be negotiated on every QUIC connection. WebTransport uses
 * `h3` at the TLS layer and negotiates AAFP at the application layer.
 */
export const AAFP_ALPN = "aafp/1";

/**
 * Congestion controller type (Track J1).
 *
 * - `Cubic`: Standard TCP-friendly congestion control (default for bulk).
 * - `Bbr`: Bottleneck Bandwidth and Round-trip propagation time — better
 *   for low-latency RPC.
 */
export enum CongestionController {
  /** Cubic congestion control — TCP-friendly, good for bulk transfer. */
  Cubic = "cubic",
  /** BBR congestion control — low-latency, good for interactive RPC. */
  Bbr = "bbr",
}

/**
 * Transport configuration. Maps to `QuicConfig` in the Rust implementation.
 * Each concrete transport applies these settings to its native API.
 */
export interface TransportConfig {
  /**
   * Address to bind the transport (server).
   * Default: `"127.0.0.1:0"` (ephemeral port on localhost).
   */
  bindAddr: string;

  /**
   * Maximum concurrent streams per connection.
   * Default: 100.
   */
  maxConcurrentStreams: number;

  /**
   * Keep-alive interval in milliseconds.
   * Default: 30000 (30s). Set to 0 to disable.
   */
  keepAliveIntervalMs: number;

  /**
   * Maximum idle timeout in milliseconds.
   * Default: 30000 (30s). The connection is closed if no data is
   * exchanged within this period.
   */
  maxIdleTimeoutMs: number;

  /**
   * Initial RTT estimate in milliseconds.
   * Default: 10. Used for initial congestion window and retransmission timers.
   */
  initialRttMs: number;

  /**
   * Maximum ACK delay in milliseconds.
   * Default: 5.
   */
  maxAckDelayMs: number;

  /**
   * Stream initial max data (flow control window) in bytes.
   * Default: 1 MiB (1048576).
   */
  streamInitialMaxData: number;

  /**
   * Maximum payload size per frame (RFC-0002 §3.4).
   * Default: 1 MiB (1048576). Frames with larger payloads are rejected.
   */
  maxPayloadSize: number;

  /**
   * Maximum extension section size.
   * Default: 64 KiB (65536). Limits per-frame memory allocation (SA-0006).
   */
  maxExtensionSize: number;

  /**
   * Congestion controller.
   * Default: `Cubic`.
   */
  congestion: CongestionController;

  /**
   * Enable post-quantum key exchange (X25519MLKEM768).
   * Default: `true`. Protects against harvest-now-decrypt-later attacks.
   */
  enablePqKex: boolean;
}

/**
 * Default transport configuration.
 *
 * Matches the Rust `QuicConfig::default()` values.
 */
export const DEFAULT_CONFIG: TransportConfig = {
  bindAddr: "127.0.0.1:0",
  maxConcurrentStreams: 100,
  keepAliveIntervalMs: 30_000,
  maxIdleTimeoutMs: 30_000,
  initialRttMs: 10,
  maxAckDelayMs: 5,
  streamInitialMaxData: 1024 * 1024,
  maxPayloadSize: 1024 * 1024,
  maxExtensionSize: 64 * 1024,
  congestion: CongestionController.Cubic,
  enablePqKex: true,
};

/**
 * Low-latency preset for agent-to-agent RPC (Track J1-J4).
 *
 * BBR congestion control, 10ms RTT, 5ms ACK, 1MB window.
 * Optimized for interactive, low-latency communication.
 *
 * @returns A `TransportConfig` tuned for low-latency RPC.
 */
export function lowLatencyConfig(): TransportConfig {
  throw new Error("Not implemented");
}

/**
 * Bulk transfer preset for large payloads.
 *
 * Cubic congestion, 100ms RTT, 25ms ACK, 10MB window, 5-minute idle timeout.
 * Optimized for throughput over latency.
 *
 * @returns A `TransportConfig` tuned for bulk data transfer.
 */
export function bulkTransferConfig(): TransportConfig {
  throw new Error("Not implemented");
}
