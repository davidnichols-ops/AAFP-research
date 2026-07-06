# Builder Prompt: TS Phase 9 — Packaging + Distribution

## Objective

Package the AAFP TypeScript SDK for distribution across npm, JSR (Deno), and
CDN (browser). This phase takes the feature-complete pure-TS v2 implementation
from Phases 1-8 and turns it into a set of publishable, dual ESM/CJS packages
with full type declarations, documentation, example apps, and an automated
publishing workflow. It also produces the optional `@aafp/sdk-native` napi-rs
addon package for Node.js users who need maximum performance.

The end state: `npm install @aafp/sdk` gives a developer a working echo agent
on Node 25+, Deno, Bun, and the browser — with zero native compilation, full
TypeScript types, and API documentation online.

## Prerequisites

- Phases 1-8 must be complete. The pure-TS v2 SDK (CBOR, crypto, handshake,
  transport, simple API v2, streaming, pooling, MCP integration, browser
  support, discovery, ecosystem adapters) is feature-complete and all tests
  pass.
- The `@aafp/sdk-native` napi-rs addon (Phase 9 optional track) is built and
  benchmarked, OR this phase ships the pure-TS packages first and the native
  addon in a follow-on release.
- The Rust SDK version is the source of truth for versioning. As of this
  writing the Rust workspace is at `0.1.0` (`implementations/rust/Cargo.toml`
  §`[workspace.package]`). The TS packages must match the Rust SDK's semantic
  version exactly so users can reason about cross-language compatibility.

## Context

Read these design documents before starting:
- `TYPESCRIPT_SDK_DESIGN.md` §12 (Package Distribution), §11 (Deno and Bun
  Support), §4.2 (Optional native addon), §14 Phase 9.
- `NORTH_STAR.md` §3 Phase 3 — the adoption test ("Can a developer use AAFP
  without understanding the protocol?").
- `INTEROPERABILITY_PLAN.md` — cross-language version alignment.

## Package Structure

The TypeScript SDK is published as a scoped package family under `@aafp/`.
Each package is independently versioned but released in lockstep with the
Rust SDK version. The monorepo uses pnpm workspaces.

```
implementations/typescript/
├── pnpm-workspace.yaml
├── package.json                 # root: scripts, devDeps, pnpm config
├── tsconfig.base.json           # shared compiler options
├── tsup.config.ts               # shared bundler config (Node builds)
├── esbuild.config.ts            # shared browser bundler config
├── typedoc.json                 # API docs config
├── .changeset/
│   └── config.json
├── .github/
│   └── workflows/
│       ├── ci.yml               # build + test on push
│       ├── publish-npm.yml      # npm publish on release tag
│       ├── publish-jsr.yml      # JSR publish on release tag
│       └── native-build.yml     # napi-rs cross-compile (4 platforms)
├── packages/
│   ├── sdk/                     # @aafp/sdk — the primary package
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── deno.json            # JSR config + import map
│   │   ├── src/
│   │   │   ├── index.ts         # public API barrel
│   │   │   ├── types.ts         # Params, Request, Response, metadata
│   │   │   ├── agent.ts         # Agent.serve() / Agent.connect()
│   │   │   ├── cbor.ts          # CBOR encoder/decoder
│   │   │   ├── crypto.ts        # ML-DSA-65 via @noble/post-quantum
│   │   │   ├── handshake.ts     # v1 handshake state machine
│   │   │   ├── frame.ts         # 28-byte frame header
│   │   │   ├── rpc.ts           # RPC request/response
│   │   │   ├── pool.ts          # ConnectionPool
│   │   │   ├── discovery.ts     # discovery + failover
│   │   │   ├── errors.ts        # HandlerError (RFC-0005 categories)
│   │   │   ├── mcp-transport.ts # AafpMcpTransport
│   │   │   ├── langchain.ts     # AafpToolkit adapter
│   │   │   ├── vercel-ai.ts     # aafpProvider adapter
│   │   │   └── transport/
│   │   │       ├── index.ts     # Transport interface + auto-detect
│   │   │       ├── node-quic.ts # NodeQuicTransport (node:quic)
│   │   │       ├── webtransport.ts # WebTransportTransport (browser)
│   │   │       └── ws-gateway.ts  # WsGatewayTransport (fallback)
│   │   ├── dist/                # compiled output (gitignored)
│   │   │   ├── esm/             # ESM build (Node + bundlers)
│   │   │   ├── cjs/             # CJS build (legacy Node)
│   │   │   ├── browser/         # esbuild single-file bundle
│   │   │   └── types/           # .d.ts declaration files
│   │   ├── README.md
│   │   ├── CHANGELOG.md
│   │   └── LICENSE
│   ├── cbor/                    # @aafp/cbor — standalone CBOR codec
│   ├── crypto/                  # @aafp/crypto — ML-DSA-65 + handshake
│   ├── transport-quic/          # @aafp/transport-quic — node:quic binding
│   ├── transport-ws/            # @aafp/transport-ws — WebSocket gateway
│   ├── sdk-native/              # @aafp/sdk-native — napi-rs addon
│   │   ├── package.json
│   │   ├── Cargo.toml           # napi-rs Rust crate
│   │   ├── src/
│   │   │   └── lib.rs           # napi-rs bindings to aafp-sdk
│   │   ├── npm/                 # generated platform packages
│   │   │   ├── darwin-arm64/
│   │   │   ├── linux-x64-gnu/
│   │   │   ├── linux-arm64-gnu/
│   │   │   └── win32-x64-msvc/
│   │   └── __test__/
│   └── examples/                # example apps (published as @aafp/examples)
│       ├── package.json
│       ├── echo-node.ts
│       ├── echo-browser.html
│       ├── echo-deno.ts
│       ├── streaming-llm.ts
│       ├── mcp-server.ts
│       └── langchain-tool.ts
└── docs/
    ├── api/                     # TypeDoc output (published to GitHub Pages)
    └── quickstart.md
```

## package.json Configuration

The primary package `@aafp/sdk` uses a dual ESM/CJS build with a subpath
`exports` map. The `exports` map is the single source of truth for import
resolution — `main`/`module`/`types` are included only for legacy tooling.

```jsonc
// packages/sdk/package.json
{
  "name": "@aafp/sdk",
  "version": "0.1.0",
  "description": "AAFP — post-quantum agent-to-agent protocol SDK for TypeScript (Node, Deno, Bun, browser)",
  "type": "module",
  "license": "Apache-2.0",
  "author": "AAFP Project",
  "homepage": "https://aafp.dev/docs/ts",
  "repository": {
    "type": "git",
    "url": "https://github.com/aafp/aafp",
    "directory": "implementations/typescript/packages/sdk"
  },
  "keywords": ["aafp", "agent", "post-quantum", "quic", "webtransport", "mcp", "p2p"],
  "engines": { "node": ">=18.0.0" },
  "files": [
    "dist/esm",
    "dist/cjs",
    "dist/browser",
    "dist/types",
    "README.md",
    "LICENSE",
    "CHANGELOG.md"
  ],
  "main": "./dist/cjs/index.js",
  "module": "./dist/esm/index.js",
  "types": "./dist/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/types/index.d.ts",
      "import": "./dist/esm/index.js",
      "require": "./dist/cjs/index.js",
      "browser": "./dist/browser/aafp-sdk.min.js",
      "default": "./dist/esm/index.js"
    },
    "./mcp": {
      "types": "./dist/types/mcp-transport.d.ts",
      "import": "./dist/esm/mcp-transport.js",
      "require": "./dist/cjs/mcp-transport.js"
    },
    "./langchain": {
      "types": "./dist/types/langchain.d.ts",
      "import": "./dist/esm/langchain.js",
      "require": "./dist/cjs/langchain.js"
    },
    "./vercel-ai": {
      "types": "./dist/types/vercel-ai.d.ts",
      "import": "./dist/esm/vercel-ai.js",
      "require": "./dist/cjs/vercel-ai.js"
    },
    "./transport/node-quic": {
      "types": "./dist/types/transport/node-quic.d.ts",
      "import": "./dist/esm/transport/node-quic.js",
      "require": "./dist/cjs/transport/node-quic.js"
    },
    "./transport/webtransport": {
      "types": "./dist/types/transport/webtransport.d.ts",
      "import": "./dist/esm/transport/webtransport.js",
      "require": "./dist/cjs/transport/webtransport.js"
    },
    "./transport/ws-gateway": {
      "types": "./dist/types/transport/ws-gateway.d.ts",
      "import": "./dist/esm/transport/ws-gateway.js",
      "require": "./dist/cjs/transport/ws-gateway.js"
    },
    "./package.json": "./package.json"
  },
  "imports": {
    "#crypto": {
      "browser": "./dist/esm/crypto-browser.js",
      "default": "./dist/esm/crypto.js"
    }
  },
  "sideEffects": false,
  "dependencies": {
    "@noble/post-quantum": "^0.2.0",
    "@noble/hashes": "^1.5.0"
  },
  "peerDependencies": {
    "@modelcontextprotocol/sdk": ">=1.0.0"
  },
  "peerDependenciesMeta": {
    "@modelcontextprotocol/sdk": { "optional": true }
  },
  "optionalDependencies": {
    "@aafp/sdk-native": "0.1.0"
  },
  "publishConfig": {
    "access": "public",
    "provenance": true
  }
}
```

Key points:
- `sideEffects: false` enables tree-shaking — users who import only the
  client don't pull in server code.
- `peerDependencies` for MCP is optional so `npm install @aafp/sdk` doesn't
  force the MCP SDK on users who don't need it.
- `optionalDependencies` for `@aafp/sdk-native` lets the runtime auto-detect
  and use the native addon if installed, falling back to pure TS silently.
- `publishConfig.provenance: true` enables npm provenance (Sigstore) for
  supply-chain attestation — required for the v0.1.0 release.
- The `imports` map (`#crypto`) provides conditional exports for
  internal submodules — browser uses Web Crypto, Node uses `node:crypto`.

The sub-packages (`@aafp/cbor`, `@aafp/crypto`, `@aafp/transport-quic`,
`@aafp/transport-ws`) follow the same dual ESM/CJS pattern but with a
narrower `exports` map (single entry point). Example for `@aafp/cbor`:

```jsonc
{
  "name": "@aafp/cbor",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/cjs/index.js",
  "module": "./dist/esm/index.js",
  "types": "./dist/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/types/index.d.ts",
      "import": "./dist/esm/index.js",
      "require": "./dist/cjs/index.js"
    }
  },
  "files": ["dist", "README.md", "LICENSE"]
}
```

## TypeScript Configuration

A shared base `tsconfig.base.json` defines strict compiler options. Each
package extends it and adds its own `outDir`/`rootDir`.

```jsonc
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": false,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": false,
    "allowSyntheticDefaultImports": true
  }
}
```

```jsonc
// packages/sdk/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist/types",
    "declarationDir": "./dist/types",
    "tsBuildInfoFile": "./dist/.tsbuildinfo"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "dist", "node_modules"]
}
```

The `tsconfig.json` is used only for declaration (`.d.ts`) generation.
The actual JS builds are produced by `tsup` (Node) and `esbuild` (browser)
— see Bundle Strategy below. `verbatimModuleSyntax: true` ensures
`import type` is used correctly so the ESM output has no runtime side
effects from type-only imports. `isolatedModules: true` is required for
esbuild compatibility (esbuild transpiles each file in isolation).

## Bundle Strategy

Two build targets with different tools:

### Node.js build (tsup)

`tsup` wraps esbuild and produces both ESM and CJS from the same TS source,
plus type declarations via `tsc`. This gives us dual-format output without
maintaining two tsconfigs.

```ts
// tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig((options) => ({
  entry: [
    "src/index.ts",
    "src/mcp-transport.ts",
    "src/langchain.ts",
    "src/vercel-ai.ts",
    "src/transport/node-quic.ts",
    "src/transport/webtransport.ts",
    "src/transport/ws-gateway.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,                    // generate .d.ts via tsc
  splitting: true,              // code-split shared chunks (ESM only)
  treeshake: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  platform: "node",
  outDir: "dist",
  esbuildOptions(opts) {
    opts.outExtension = { ".js": ".js" };
  },
}));
```

Output layout:
```
dist/
├── esm/
│   ├── index.js
│   ├── mcp-transport.js
│   ├── chunk-XXX.js     # shared code-split chunk
│   └── transport/
│       ├── node-quic.js
│       └── ...
├── cjs/
│   ├── index.cjs        # CJS uses .cjs extension (type:module pkg)
│   └── ...
└── types/
    └── index.d.ts
```

CJS files use the `.cjs` extension because the package has `"type":
"module"` — this is the Node.js convention for dual packages and avoids
the "require of ESM module" error.

### Browser build (esbuild)

A separate esbuild config produces a single minified ESM bundle for CDN
distribution. This bundle inlines `@noble/post-quantum` and uses Web
Crypto (`crypto.subtle`) instead of `node:crypto`.

```ts
// esbuild.config.ts
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  minify: true,
  sourcemap: true,
  target: ["es2022", "chrome109", "firefox115", "safari16"],
  format: "esm",
  outfile: "dist/browser/aafp-sdk.min.js",
  platform: "browser",
  define: {
    "global": "globalThis",
    "process.env.NODE_ENV": '"production"',
  },
  alias: {
    "#crypto": "./src/crypto-browser.ts",
  },
  external: [],  // inline everything for CDN usage
});
```

The browser build is published to the npm package (in `dist/browser/`) so
CDNs like esm.sh and jsdelivr can serve it directly. It is also pushed to
a GitHub Pages site for `<script type="module">` usage.

## Deno Compatibility

Deno supports npm packages via `npm:` specifiers and JSR via `jsr:`
specifiers. The pure-TS SDK works in Deno with no source changes because
it uses Web Crypto and WebTransport (both available in Deno) and avoids
Node-specific globals at the top level.

```jsonc
// packages/sdk/deno.json
{
  "name": "@aafp/sdk",
  "version": "0.1.0",
  "exports": {
    ".": "./src/index.ts",
    "./mcp": "./src/mcp-transport.ts",
    "./transport/webtransport": "./src/transport/webtransport.ts"
  },
  "publish": {
    "include": [
      "src/**/*.ts",
      "README.md",
      "LICENSE"
    ],
    "exclude": [
      "src/**/*.test.ts",
      "dist",
      "node_modules"
    ]
  },
  "imports": {
    "@noble/post-quantum": "npm:@noble/post-quantum@^0.2.0",
    "@noble/hashes": "npm:@noble/hashes@^1.5.0"
  },
  "tasks": {
    "test": "deno test --allow-net --allow-read src/",
    "check": "deno check src/index.ts"
  },
  "lint": {
    "rules": {
      "exclude": ["no-explicit-any", "no-unused-vars"]
    }
  }
}
```

Deno users import via either:
```typescript
// JSR (preferred for Deno-native projects)
import { Agent } from "jsr:@aafp/sdk";

// npm (for projects already using npm specifiers)
import { Agent } from "npm:@aafp/sdk";
```

The `deno.json` `exports` map points directly at `.ts` source files —
Deno compiles TypeScript natively, so no pre-build step is needed for
JSR. The `publish.include` ensures only source + docs are published to
JSR (no `dist/` or `node_modules/`).

The `node:quic` transport is excluded from the Deno exports map because
Deno does not support `node:quic`. Deno users get WebTransport
automatically via the transport auto-detection in `transport/index.ts`.

## Bun Compatibility

Bun runs npm packages natively and supports `npm:` import specifiers.
No special configuration is needed — `bun install @aafp/sdk` works and
Bun resolves the ESM build via the `exports` map.

Bun does not yet have native QUIC, so the transport auto-detection falls
back to `WsGatewayTransport`. The SDK feature-detects at runtime:

```typescript
// src/transport/index.ts (excerpt)
export async function createTransport(): Promise<Transport> {
  // 1. Native addon (if @aafp/sdk-native is installed)
  if (await canUseNative()) return new NativeTransport();
  // 2. Node.js QUIC (Node 25+ with --experimental-quic)
  if (typeof process !== "undefined" && process.versions?.quic) {
    const { NodeQuicTransport } = await import("./node-quic.js");
    return new NodeQuicTransport();
  }
  // 3. WebTransport (browser, Deno)
  if (typeof WebTransport !== "undefined") {
    const { WebTransportTransport } = await import("./webtransport.js");
    return new WebTransportTransport();
  }
  // 4. WebSocket gateway fallback (Bun, older Node)
  const { WsGatewayTransport } = await import("./ws-gateway.js");
  return new WsGatewayTransport();
}
```

A `bun.lockb` is committed at the repo root for Bun users who clone the
monorepo. The CI workflow includes a Bun smoke test (`bun test
packages/sdk/src/`) to catch regressions.

## README.md and API Documentation

### README.md

Each package has a `README.md` with: install command, 10-line quickstart
(server + client), runtime support table, links to full docs, and the
license. The primary `@aafp/sdk` README is the front door for the entire
TS ecosystem.

```markdown
# @aafp/sdk

Post-quantum agent-to-agent protocol SDK for TypeScript.

## Install

npm:   `npm install @aafp/sdk`
pnpm:  `pnpm add @aafp/sdk`
yarn:  `yarn add @aafp/sdk`
Deno:  `import { Agent } from "jsr:@aafp/sdk";`
Bun:   `bun add @aafp/sdk`

## Quickstart

import { Agent, Request } from "@aafp/sdk";

// Serve
const server = await Agent.serve()
  .capability("echo")
  .onCapability("echo", async (req) => Request.text(req.body))
  .start();

// Connect
const client = await Agent.connect();
const res = await client.discover("echo").call(Request.text("hello"));
console.log(res.body); // "hello"

## Runtime support

| Runtime | Transport | Serving | Client |
|---------|-----------|---------|--------|
| Node 25+ | node:quic | Yes | Yes |
| Node <25 | WS gateway | Yes | Yes |
| Deno | WebTransport | Yes | Yes |
| Bun | WS gateway | Yes | Yes |
| Browser | WebTransport | No (v1) | Yes |

## Documentation

- API reference: https://aafp.dev/docs/ts/api
- Quickstart: https://aafp.dev/docs/ts/quickstart
- v2 migration guide: https://aafp.dev/docs/ts/migration
```

### TypeDoc API documentation

TypeDoc generates HTML API docs from the `.d.ts` files, published to
GitHub Pages at `https://aafp.dev/docs/ts/api`.

```jsonc
// typedoc.json
{
  "entryPoints": [
    "packages/sdk/src/index.ts",
    "packages/sdk/src/mcp-transport.ts",
    "packages/sdk/src/langchain.ts",
    "packages/sdk/src/vercel-ai.ts"
  ],
  "out": "docs/api",
  "name": "AAFP TypeScript SDK",
  "includeVersion": true,
  "readme": "packages/sdk/README.md",
  "theme": "default",
  "excludePrivate": true,
  "excludeInternal": true,
  "categorizeByGroup": true,
  "searchInComments": true,
  "plugin": ["typedoc-plugin-markdown"]
}
```

The CI workflow runs `typedoc` on every push to `main` and deploys the
`docs/` directory to GitHub Pages. The markdown output is also embedded
in the `aafp.dev` documentation site.

## Versioning Strategy

The TS packages use **lockstep versioning** with the Rust SDK. The Rust
workspace version (`implementations/rust/Cargo.toml` §`[workspace.package]`,
currently `0.1.0`) is the canonical version. All TS packages are
published at the same version number on every release.

Rationale: users running cross-language interop (Rust server + TS client)
need to know the versions are wire-compatible. Matching version numbers
make this a one-line check rather than a compatibility matrix lookup.

Versioning rules:
- **Major (0.x.0 → 1.0.0):** Wire protocol break (RFC-0002 Rev bump),
  API break (Simple API v2 → v3). All packages bump together.
- **Minor (0.1.0 → 0.2.0):** New feature (e.g., DHT support added),
  new package added to the family. All packages bump together.
- **Patch (0.1.0 → 0.1.1):** Bug fix, perf improvement, doc update.
  Only affected packages bump, but the version number is shared —
  unaffected packages are republished with the same new version to
  keep the lockstep invariant.

Changesets (`@changesets/cli`) manage the version bump workflow. Each
PR includes a changeset describing the change and bump type. The
`changeset version` command bumps all packages consistently and
generates `CHANGELOG.md` entries.

```jsonc
// .changeset/config.json
{
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [["@aafp/sdk", "@aafp/cbor", "@aafp/crypto",
             "@aafp/transport-quic", "@aafp/transport-ws",
             "@aafp/sdk-native"]],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch"
}
```

The `fixed` array enforces lockstep — all listed packages always
publish at the same version.

## Publishing Workflow

### npm publish

Triggered by a GitHub release tag (`ts-v0.1.0`). The workflow:

1. Checkout the tag.
2. Install pnpm + Node 22.
3. Run `pnpm install --frozen-lockfile`.
4. Run full verification: `pnpm typecheck`, `pnpm test`, `pnpm build`.
5. Run `pnpm changeset tag` to apply version bumps.
6. Build all packages (`pnpm -r build`).
7. Run `pnpm -r publish --access public --provenance` with
   `NPM_TOKEN` secret.
8. Create a GitHub Release with the generated changelog.

```yaml
# .github/workflows/publish-npm.yml
name: Publish to npm
on:
  release:
    types: [published]
    tags: ["ts-v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write   # required for npm provenance
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm -r build
      - run: pnpm -r publish --access public --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### JSR publish (Deno)

A separate workflow publishes to JSR. JSR requires `deno.json` in each
package and uses `deno publish`.

```yaml
# .github/workflows/publish-jsr.yml
name: Publish to JSR
on:
  release:
    types: [published]
    tags: ["ts-v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with: { deno-version: v2.x }
      - run: deno publish --allow-dirty
        env:
          DENO_DIR: ${{ runner.temp }}/deno
        working-directory: implementations/typescript/packages/sdk
```

### Native addon build (napi-rs)

The `@aafp/sdk-native` package is built via napi-rs's cross-compile
pipeline, producing 4 platform-specific packages. The main
`@aafp/sdk-native` package lists them as optional dependencies and
resolves the correct one at runtime via `napi-rs`'s `@napi-rs/cli`
platform detection.

```yaml
# .github/workflows/native-build.yml
name: Build native addon
on:
  release:
    types: [published]
    tags: ["ts-v*"]
jobs:
  build:
    strategy:
      matrix:
        include:
          - { os: ubuntu-latest, target: x86_64-unknown-linux-gnu }
          - { os: ubuntu-latest, target: aarch64-unknown-linux-gnu }
          - { os: macos-latest,  target: aarch64-apple-darwin }
          - { os: windows-latest, target: x86_64-pc-windows-msvc }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: napi-rs/napi-actions/setup@main
      - run: cargo build --release --target ${{ matrix.target }}
        working-directory: implementations/typescript/packages/sdk-native
      - run: napi artifacts
        working-directory: implementations/typescript/packages/sdk-native
      - uses: actions/upload-artifact@v4
        with:
          name: native-${{ matrix.target }}
          path: packages/sdk-native/*.node
  publish:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
      - run: napi publish
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### GitHub releases

Each `ts-vX.Y.Z` tag creates a GitHub Release with:
- Auto-generated changelog (from changesets).
- Attached tarballs of each package (`npm pack` output).
- A release notes section listing the Rust SDK version this matches
  and the wire protocol revision (RFC-0002 Rev 6).

## Example Apps

The `@aafp/examples` package (not published to npm — it lives in the
repo and is referenced in docs) contains runnable examples for each
runtime:

| Example | Runtime | Demonstrates |
|---------|---------|-------------|
| `echo-node.ts` | Node 25+ | Basic serve + connect over QUIC |
| `echo-browser.html` | Browser | WebTransport client, `<script>` import |
| `echo-deno.ts` | Deno | JSR import, WebTransport |
| `streaming-llm.ts` | Node | Server-streaming token output |
| `mcp-server.ts` | Node | AafpMcpTransport wrapping an MCP server |
| `langchain-tool.ts` | Node | AafpToolkit as a LangChain.js tool |

Each example is self-contained and runnable with a single command
(`node --experimental-quic echo-node.ts`, `deno run --allow-net
echo-deno.ts`, etc.). The README in `packages/examples/` lists the
run command for each.

## Constraints

1. **No native compilation required for the primary package.** `npm
   install @aafp/sdk` must work with zero build tools, zero platform
   binaries, zero postinstall scripts. The native addon is purely
   optional.

2. **Lockstep versioning with Rust SDK.** Every TS package version
   number must equal the Rust workspace version. Verify this in CI
   (a script reads `Cargo.toml` and compares to `package.json`
   versions; fail the build on mismatch).

3. **Dual ESM/CJS must not break.** CJS consumers (`require("@aafp/sdk")`)
   and ESM consumers (`import { Agent } from "@aafp/sdk"`) must both
   work. Test both in CI. Use `.cjs` extension for CJS output in
   `"type": "module"` packages.

4. **Tree-shakeable.** `sideEffects: false` in all packages. A consumer
   who imports only `Agent.connect()` must not pull in server code,
   CBOR encoder, or crypto sign code. Verify with a bundle-size
   check in CI (esbuild metafile analysis).

5. **No Node-specific globals at the top level.** `process`, `Buffer`,
   `node:crypto` are dynamically imported only inside Node transport
   files. The top-level `index.ts` must be importable in a browser
   without polyfills.

6. **npm provenance enabled.** All publishes use `--provenance` for
   Sigstore supply-chain attestation. The publish workflow has
   `permissions: id-token: write`.

7. **Follow existing conventions.** Check `AGENTS.md` for the Rust
   workspace. The TS workspace follows the same lint/test discipline:
   `pnpm lint`, `pnpm typecheck`, `pnpm test` must all pass before
   publish.

## Verification

```bash
# Build
pnpm install --frozen-lockfile
pnpm -r build                  # all packages build (ESM + CJS + types + browser)

# Type check
pnpm -r typecheck              # 0 errors

# Lint
pnpm -r lint                   # 0 errors, 0 warnings

# Test
pnpm -r test                   # all unit + integration tests pass

# Bundle size check (tree-shaking verification)
pnpm check:bundle-size         # client-only import < 50KB gzipped

# Version lockstep check
pnpm check:version-sync        # TS versions == Rust workspace version

# Dry-run publish (no actual publish)
pnpm -r publish --dry-run      # validates package.json, files, exports

# Local install smoke test
cd /tmp && npm install /path/to/packages/sdk
node -e "const {Agent}=require('@aafp/sdk'); console.log(typeof Agent)"
# → "function"

# Deno smoke test
deno run --allow-net packages/examples/echo-deno.ts

# Bun smoke test
bun run packages/examples/echo-node.ts
```

## Files to Create/Modify

| File | Purpose |
|------|---------|
| `implementations/typescript/pnpm-workspace.yaml` | Workspace definition |
| `implementations/typescript/package.json` | Root scripts, devDeps |
| `implementations/typescript/tsconfig.base.json` | Shared TS config |
| `implementations/typescript/tsup.config.ts` | Node bundler config |
| `implementations/typescript/esbuild.config.ts` | Browser bundler config |
| `implementations/typescript/typedoc.json` | API docs config |
| `implementations/typescript/.changeset/config.json` | Version management |
| `packages/sdk/package.json` | Primary package manifest + exports map |
| `packages/sdk/tsconfig.json` | Package TS config |
| `packages/sdk/deno.json` | JSR/Deno config |
| `packages/sdk/README.md` | Primary README |
| `packages/sdk/CHANGELOG.md` | Release history |
| `packages/sdk/LICENSE` | Apache-2.0 |
| `packages/cbor/package.json` | @aafp/cbor manifest |
| `packages/crypto/package.json` | @aafp/crypto manifest |
| `packages/transport-quic/package.json` | @aafp/transport-quic manifest |
| `packages/transport-ws/package.json` | @aafp/transport-ws manifest |
| `packages/sdk-native/package.json` | @aafp/sdk-native manifest |
| `packages/sdk-native/Cargo.toml` | napi-rs Rust crate |
| `packages/sdk-native/src/lib.rs` | napi-rs bindings |
| `packages/examples/package.json` | Examples package |
| `packages/examples/echo-node.ts` | Node echo example |
| `packages/examples/echo-browser.html` | Browser echo example |
| `packages/examples/echo-deno.ts` | Deno echo example |
| `packages/examples/streaming-llm.ts` | Streaming example |
| `packages/examples/mcp-server.ts` | MCP example |
| `packages/examples/langchain-tool.ts` | LangChain example |
| `.github/workflows/ci.yml` | CI: build + test |
| `.github/workflows/publish-npm.yml` | npm publish |
| `.github/workflows/publish-jsr.yml` | JSR publish |
| `.github/workflows/native-build.yml` | napi-rs cross-compile |
| `scripts/check-version-sync.ts` | Lockstep version verifier |
| `scripts/check-bundle-size.ts` | Tree-shaking verifier |

## Success Criteria

- [ ] `pnpm -r build` produces ESM, CJS, `.d.ts`, and browser bundle for
      every package with 0 errors
- [ ] `package.json` exports map resolves correctly for ESM `import`,
      CJS `require`, and browser `import` in all 6 subpaths
- [ ] `npm install @aafp/sdk` in a fresh project succeeds with zero
      native compilation and zero warnings
- [ ] `require("@aafp/sdk")` (CJS) and `import { Agent } from
      "@aafp/sdk"` (ESM) both work and return the same API
- [ ] `deno run --allow-net examples/echo-deno.ts` works via JSR import
- [ ] `bun run examples/echo-node.ts` works (WS gateway fallback)
- [ ] Browser bundle (`dist/browser/aafp-sdk.min.js`) is < 80KB gzipped
      and loads in Chrome/Firefox/Safari via `<script type="module">`
- [ ] Client-only tree-shaken import is < 50KB gzipped (verified by
      `check-bundle-size.ts`)
- [ ] TypeDoc generates complete API docs with 0 broken links
- [ ] All TS package versions equal the Rust workspace version
      (`check-version-sync.ts` passes)
- [ ] `pnpm -r publish --dry-run` succeeds for all 6 packages
- [ ] npm provenance is enabled (`--provenance` in publish workflow,
      `id-token: write` permission)
- [ ] `@aafp/sdk-native` builds for all 4 platforms (linux-x64,
      linux-arm64, darwin-arm64, win32-x64) and publishes 4 platform
      packages + the main resolver package
- [ ] GitHub release `ts-v0.1.0` is created with changelog and
      attached tarballs
- [ ] All 6 example apps run successfully on their target runtimes
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` all pass
- [ ] README.md install + quickstart instructions verified by a
      fresh-clone smoke test
