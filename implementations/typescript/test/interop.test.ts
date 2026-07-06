// TS <-> Rust integration tests over real QUIC.
//
// On Node 25+ use `node:quic` (behind --experimental-quic). The Rust side
// runs as a subprocess spawned by the test. The scripts/run-interop.sh
// helper builds the Rust binaries and exports their paths.
//
// See TS_PHASE_8_TESTING.md §7.
//
// NOTE: This is a pre-build scaffold. Test bodies are TODO stubs. These
// tests are excluded from the default `vitest run` invocation (see
// vitest.config.ts) and run in a separate CI job with --pool=forks.
import { describe, it } from "vitest";

describe("TS client <-> Rust server interop", () => {
  it.todo("completes v1 handshake and echoes a message");
  it.todo("v2 Params round-trip across languages");
  it.todo("streaming: TS client consumes tokens from Rust streaming server");
  it.todo("large payload (> 64KiB) fragmented across QUIC streams");
  it.todo("error response: Rust server HandlerError decodes in TS client");
});

describe("TS server <-> Rust client interop", () => {
  it.todo("Rust client completes v1 handshake against TS server");
  it.todo("Rust client RPC echoes via TS echo agent (stdout contains payload)");
  it.todo("Rust client streaming consume from TS streaming server");
});

describe("TS <-> TS interop (sanity)", () => {
  it.todo("TS server <-> TS client echo over localhost QUIC");
  it.todo("TS server <-> TS client streaming round-trip");
});
