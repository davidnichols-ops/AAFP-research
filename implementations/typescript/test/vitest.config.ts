// Vitest configuration for the AAFP TypeScript SDK test + conformance suite.
//
// This is the Node.js primary config (see TS_PHASE_8_TESTING.md §2).
// Deno/Bun overrides live in vitest.config.deno.ts / vitest.config.bun.ts
// (to be added in a later phase).
//
// NOTE: This is a pre-build scaffold. Dependencies are NOT installed yet.
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Allow tests to import source via the workspace package names once
      // the packages are built, and via relative paths during scaffolding.
      "@aafp/cbor": resolve(root, "../packages/cbor/src/index.ts"),
      "@aafp/crypto": resolve(root, "../packages/crypto/src/index.ts"),
      "@aafp/transport-quic": resolve(root, "../packages/transport-quic/src/index.ts"),
      "@aafp/transport-ws": resolve(root, "../packages/transport-ws/src/index.ts"),
    },
  },
  test: {
    // Node.js is the primary runtime; Deno + Bun run via the vitest CLI.
    environment: "node",
    // Unit + conformance + vector tests. Integration + smoke are excluded
    // from the default invocation (they need QUIC / spawned binaries).
    include: ["test/**/*.test.ts"],
    exclude: ["test/smoke/**", "test/integration/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.test.ts", "packages/*/src/index.ts"],
      // Acceptance targets (TS_PHASE_8_TESTING.md §11).
      thresholds: { lines: 90, functions: 90, branches: 85 },
    },
    // Vector + conformance tests are fast; integration tests use a
    // separate invocation with a longer timeout (see CI workflow).
    timeout: 30_000,
    pool: "threads",
  },
});
