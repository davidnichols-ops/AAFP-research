# AAFP TypeScript SDK

Post-quantum agent-to-agent protocol SDK for TypeScript.

## Packages

| Package | Description |
|---------|-------------|
| [`@aafp/cbor`](packages/cbor/) | Standalone deterministic CBOR codec (RFC 8949 §4.2.3) |
| [`@aafp/crypto`](packages/crypto/) | ML-DSA-65 signatures, HKDF-SHA256, ChaCha20-Poly1305 / AES-256-GCM, AgentId |
| [`@aafp/transport-quic`](packages/transport-quic/) | Node.js `node:quic` transport binding |
| [`@aafp/transport-ws`](packages/transport-ws/) | WebSocket gateway transport (fallback) |
| [`@aafp/sdk`](packages/sdk/) | Primary SDK — Agent.serve() / Agent.connect() with auto-detect transport |
| [`@aafp/sdk-native`](packages/sdk-native/) | napi-rs native addon (optional, for maximum performance) |
| [`@aafp/examples`](packages/examples/) | Example apps (echo, streaming, MCP server, LangChain) |

## Monorepo Layout

```
implementations/typescript/
├── package.json              # root: workspaces, devDeps, scripts
├── tsconfig.base.json        # shared strict compiler options
├── vitest.config.ts          # test runner config
└── packages/
    ├── cbor/
    ├── crypto/
    ├── transport-quic/
    ├── transport-ws/
    ├── sdk/
    ├── sdk-native/
    └── examples/
```

## Development

```bash
# install dependencies
npm install

# build all packages
npm run build

# run tests
npm test
```

## Versioning

All packages use lockstep versioning aligned with the Rust SDK
(currently `0.1.0`). See
[`builder-prompts/TS_PHASE_9_PACKAGING.md`](../../builder-prompts/TS_PHASE_9_PACKAGING.md)
for the full packaging and distribution plan.

## License

Apache-2.0
