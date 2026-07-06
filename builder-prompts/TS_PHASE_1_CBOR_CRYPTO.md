# Builder Prompt: TypeScript SDK Phase 1 — CBOR + Crypto Foundation

**Target:** Implement `@aafp/cbor` and `@aafp/crypto` npm packages — the
foundational wire-format and cryptography layers for the AAFP TypeScript SDK.

**Reference implementations:**
- `implementations/rust/crates/aafp-cbor/src/lib.rs` — canonical CBOR (841 lines)
- `implementations/rust/crates/aafp-crypto/src/dsa.rs` — ML-DSA-65 (284 lines)
- `implementations/rust/crates/aafp-crypto/src/kdf.rs` — HKDF-SHA256 (48 lines)
- `implementations/rust/crates/aafp-crypto/src/aead.rs` — ChaCha20-Poly1305 / AES-256-GCM (179 lines)
- `implementations/rust/crates/aafp-identity/src/agent_id.rs` — AgentId derivation (98 lines)
- `implementations/rust/crates/aafp-identity/src/keypair.rs` — AgentKeypair (175 lines)
- `test-vectors/mldsa65/vectors.json` — A-10 cross-language test vectors

**Design doc:** `TYPESCRIPT_SDK_DESIGN.md` §7.1 (CBOR), §7.4 (Identity), §14 Phase 1.

---

## 1. Package Structure

Create a monorepo with two packages. Use `pnpm` workspaces (or npm workspaces).

```
implementations/typescript/
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── cbor/
│   │   ├── package.json          # @aafp/cbor
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts          # Public API exports
│   │   │   ├── encoder.ts        # encodeCbor()
│   │   │   ├── decoder.ts        # decodeCbor()
│   │   │   ├── types.ts          # CborValue discriminated union
│   │   │   └── helpers.ts        # intMap(), intMapGet(), strMap(), strMapGet()
│   │   └── tests/
│   │       ├── encoder.test.ts
│   │       ├── decoder.test.ts
│   │       ├── roundtrip.test.ts
│   │       └── golden-traces.test.ts
│   └── crypto/
│       ├── package.json          # @aafp/crypto
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts          # Public API exports
│       │   ├── dsa.ts            # ML-DSA-65 sign/verify/keygen
│       │   ├── kdf.ts            # HKDF-SHA256
│       │   ├── aead.ts           # ChaCha20-Poly1305 + AES-256-GCM
│       │   ├── agent-id.ts       # AgentId derivation (SHA-256)
│       │   ├── keypair.ts        # AgentKeypair class
│       │   └── types.ts          # CryptoError, interfaces
│       └── tests/
│           ├── dsa.test.ts
│           ├── kdf.test.ts
│           ├── aead.test.ts
│           ├── agent-id.test.ts
│           ├── keypair.test.ts
│           └── cross-verify.test.ts   # A-10 test vectors
```

### 1.1 `@aafp/cbor` package.json

```json
{
  "name": "@aafp/cbor",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "scripts": {
    "build": "tsc",
    "test": "node --test --import tsx tests/**/*.test.ts"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsx": "^4.0.0",
    "@types/node": "^22.0.0"
  }
}
```

### 1.2 `@aafp/crypto` package.json

```json
{
  "name": "@aafp/crypto",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "scripts": {
    "build": "tsc",
    "test": "node --test --import tsx tests/**/*.test.ts"
  },
  "dependencies": {
    "@noble/post-quantum": "^0.2.0",
    "@noble/hashes": "^1.5.0",
    "@aafp/cbor": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsx": "^4.0.0",
    "@types/node": "^22.0.0"
  }
}
```

---

## 2. CBOR — `@aafp/cbor`

### 2.1 CborValue type

Match the Rust `Value` enum exactly. The TS discriminated union must cover all
8 variants: `Unsigned`, `Negative`, `ByteString`, `TextString`, `Array`,
`IntMap`, `StrMap`, `Bool`, `Null`.

```typescript
// packages/cbor/src/types.ts

export type CborValue =
  | { type: "unsigned"; value: number }       // u64 (use BigInt for >2^53)
  | { type: "negative"; value: number }       // i64 negative
  | { type: "bytes"; value: Uint8Array }      // byte string
  | { type: "text"; value: string }           // UTF-8 text string
  | { type: "array"; items: CborValue[] }     // array
  | { type: "int-map"; entries: [number, CborValue][] }  // integer-keyed map
  | { type: "text-map"; entries: [string, CborValue][] } // string-keyed map
  | { type: "bool"; value: boolean }
  | { type: "null" };

export class CborError extends Error {
  constructor(
    public readonly offset: number,
    message: string,
  ) {
    super(`CBOR error at offset ${offset}: ${message}`);
    this.name = "CborError";
  }
}
```

### 2.2 Encoder — deterministic mode (RFC 8949 §4.2.3)

The encoder MUST produce byte-identical output to `aafp-cbor`. Key rules from
the Rust reference (`lib.rs` lines 10-16):

1. **Map keys sorted by length-first canonical byte ordering** — sort by
   `(encoding_length, bytewise_encoding)`. Shorter key encodings come first;
   within the same length, sort bytewise.
2. **Integers use shortest encoding** — values 0-23 use immediate (1 byte),
   24-255 use 1-byte additional info, 256-65535 use 2-byte, etc.
3. **No indefinite-length arrays or maps** — always definite-length.
4. **Text strings use definite-length UTF-8**.
5. **Negative integers**: CBOR encodes -1 as `0x20`, -n as `0x20 + (n-1)`.

```typescript
// packages/cbor/src/encoder.ts

const MT_UNSIGNED = 0;
const MT_NEGATIVE = 1;
const MT_BYTE_STRING = 2;
const MT_TEXT_STRING = 3;
const MT_ARRAY = 4;
const MT_MAP = 5;
const MT_SIMPLE = 7;

const SIMPLE_FALSE = 20;
const SIMPLE_TRUE = 21;
const SIMPLE_NULL = 22;

/** Encode a CborValue to deterministic CBOR bytes (RFC 8949 §4.2.3). */
export function encodeCbor(val: CborValue): Uint8Array {
  const chunks: number[] = [];
  encodeValue(chunks, val);
  return new Uint8Array(chunks);
}

function encodeHeader(chunks: number[], major: number, value: number): void {
  if (value <= 23) {
    chunks.push((major << 5) | value);
  } else if (value <= 0xFF) {
    chunks.push((major << 5) | 24);
    chunks.push(value);
  } else if (value <= 0xFFFF) {
    chunks.push((major << 5) | 25);
    chunks.push((value >> 8) & 0xFF);
    chunks.push(value & 0xFF);
  } else if (value <= 0xFFFFFFFF) {
    chunks.push((major << 5) | 26);
    chunks.push((value >> 24) & 0xFF);
    chunks.push((value >> 16) & 0xFF);
    chunks.push((value >> 8) & 0xFF);
    chunks.push(value & 0xFF);
  } else {
    // 8-byte (use BigInt for values > 2^32)
    chunks.push((major << 5) | 27);
    const v = BigInt(value);
    for (let i = 7; i >= 0; i--) {
      chunks.push(Number((v >> BigInt(i * 8)) & 0xFFn));
    }
  }
}

function encodeValue(chunks: number[], val: CborValue): void {
  switch (val.type) {
    case "unsigned":
      encodeHeader(chunks, MT_UNSIGNED, val.value);
      break;
    case "negative": {
      // CBOR negative: encoded value = (-1 - n), major type 1
      const encoded = -1 - val.value;
      encodeHeader(chunks, MT_NEGATIVE, encoded);
      break;
    }
    case "bytes":
      encodeHeader(chunks, MT_BYTE_STRING, val.value.length);
      for (const b of val.value) chunks.push(b);
      break;
    case "text": {
      const bytes = new TextEncoder().encode(val.value);
      encodeHeader(chunks, MT_TEXT_STRING, bytes.length);
      for (const b of bytes) chunks.push(b);
      break;
    }
    case "array":
      encodeHeader(chunks, MT_ARRAY, val.items.length);
      for (const item of val.items) encodeValue(chunks, item);
      break;
    case "int-map": {
      const sorted = sortIntKeys(val.entries);
      encodeHeader(chunks, MT_MAP, sorted.length);
      for (const [key, v] of sorted) {
        encodeIntKey(chunks, key);
        encodeValue(chunks, v);
      }
      break;
    }
    case "text-map": {
      const sorted = sortTextKeys(val.entries);
      encodeHeader(chunks, MT_MAP, sorted.length);
      for (const [key, v] of sorted) {
        const bytes = new TextEncoder().encode(key);
        encodeHeader(chunks, MT_TEXT_STRING, bytes.length);
        for (const b of bytes) chunks.push(b);
        encodeValue(chunks, v);
      }
      break;
    }
    case "bool":
      chunks.push((MT_SIMPLE << 5) | (val.value ? SIMPLE_TRUE : SIMPLE_FALSE));
      break;
    case "null":
      chunks.push((MT_SIMPLE << 5) | SIMPLE_NULL);
      break;
  }
}

function encodeIntKey(chunks: number[], key: number): void {
  if (key >= 0) {
    encodeHeader(chunks, MT_UNSIGNED, key);
  } else {
    encodeHeader(chunks, MT_NEGATIVE, -1 - key);
  }
}

/** Sort integer keys by length-first canonical byte ordering. */
function sortIntKeys(entries: [number, CborValue][]): [number, CborValue][] {
  return [...entries].sort((a, b) => {
    const encA = intKeyEncoding(a[0]);
    const encB = intKeyEncoding(b[0]);
    if (encA.length !== encB.length) return encA.length - encB.length;
    return compareBytes(encA, encB);
  });
}

function intKeyEncoding(key: number): number[] {
  const chunks: number[] = [];
  encodeIntKey(chunks, key);
  return chunks;
}

/** Sort text keys by full CBOR encoding (header + UTF-8 bytes). */
function sortTextKeys(entries: [string, CborValue][]): [string, CborValue][] {
  return [...entries].sort((a, b) => {
    const encA = textKeyEncoding(a[0]);
    const encB = textKeyEncoding(b[0]);
    return compareBytes(encA, encB);
  });
}

function textKeyEncoding(s: string): number[] {
  const chunks: number[] = [];
  const bytes = new TextEncoder().encode(s);
  encodeHeader(chunks, MT_TEXT_STRING, bytes.length);
  for (const b of bytes) chunks.push(b);
  return chunks;
}

function compareBytes(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
```

### 2.3 Decoder

The decoder must reject non-canonical encodings (same as the Rust reference):
- Values 0-23 encoded with AI_ONE_BYTE (0x18) → error
- Indefinite-length (break code 0xFF) → error
- Duplicate map keys → error
- Trailing bytes after top-level value (in `checkCanonical`) → error
- Nesting depth > 100 → `CborError` (prevent stack overflow / OOM)

```typescript
// packages/cbor/src/decoder.ts

const MAX_DECODE_DEPTH = 100;

export function decodeCbor(data: Uint8Array): CborValue {
  const pos = { value: 0 };
  const val = decodeValue(data, pos, 0);
  return val;
}

/** Decode and verify no trailing bytes (canonical check). */
export function checkCanonical(data: Uint8Array): void {
  const pos = { value: 0 };
  decodeValue(data, pos, 0);
  if (pos.value !== data.length) {
    throw new CborError(pos.value, `trailing bytes: consumed ${pos.value} of ${data.length}`);
  }
}

function decodeValue(data: Uint8Array, pos: { value: number }, depth: number): CborValue {
  if (pos.value >= data.length) throw new CborError(pos.value, "unexpected end of input");
  if (depth >= MAX_DECODE_DEPTH) {
    throw new CborError(pos.value, `nesting depth exceeded limit ${MAX_DECODE_DEPTH}`);
  }

  const initialByte = data[pos.value++];
  const major = initialByte >> 5;
  const ai = initialByte & 0x1F;
  const arg = readArgument(data, pos, ai);

  switch (major) {
    case 0: return { type: "unsigned", value: Number(arg) };
    case 1: return { type: "negative", value: -1 - Number(arg) };
    case 2: {
      const len = Number(arg);
      const bytes = data.slice(pos.value, pos.value + len);
      if (bytes.length !== len) throw new CborError(pos.value, "byte string truncated");
      pos.value += len;
      return { type: "bytes", value: bytes };
    }
    case 3: {
      const len = Number(arg);
      const bytes = data.slice(pos.value, pos.value + len);
      if (bytes.length !== len) throw new CborError(pos.value, "text string truncated");
      pos.value += len;
      return { type: "text", value: new TextDecoder().decode(bytes) };
    }
    case 4: {
      const len = Number(arg);
      const items: CborValue[] = [];
      for (let i = 0; i < len; i++) items.push(decodeValue(data, pos, depth + 1));
      return { type: "array", items };
    }
    case 5: {
      const len = Number(arg);
      const entries: [CborValue, CborValue][] = [];
      for (let i = 0; i < len; i++) {
        const key = decodeValue(data, pos, depth + 1);
        const val = decodeValue(data, pos, depth + 1);
        // Check for duplicate keys
        if (entries.some(([k]) => cborEqual(k, key))) {
          throw new CborError(pos.value, "duplicate map key");
        }
        entries.push([key, val]);
      }
      // Convert to int-map or text-map based on key types
      const allInt = entries.every(([k]) => k.type === "unsigned" || k.type === "negative");
      const allText = entries.every(([k]) => k.type === "text");
      if (allInt) {
        return {
          type: "int-map",
          entries: entries.map(([k, v]) => [
            k.type === "negative" ? k.value : k.value,
            v,
          ]) as [number, CborValue][],
        };
      } else if (allText) {
        return {
          type: "text-map",
          entries: entries.map(([k, v]) => [(k as any).value, v]) as [string, CborValue][],
        };
      }
      throw new CborError(pos.value, "mixed key types in map");
    }
    case 7: {
      if (ai === SIMPLE_FALSE) return { type: "bool", value: false };
      if (ai === SIMPLE_TRUE) return { type: "bool", value: true };
      if (ai === SIMPLE_NULL || ai === 23) return { type: "null" };
      throw new CborError(pos.value, `unsupported simple value ${ai}`);
    }
    default:
      throw new CborError(pos.value, `unsupported major type ${major}`);
  }
}

function readArgument(data: Uint8Array, pos: { value: number }, ai: number): bigint {
  if (ai <= 23) return BigInt(ai);
  if (ai === 24) {
    const val = data[pos.value++];
    if (val <= 23) throw new CborError(pos.value, `non-canonical: value ${val} should use immediate encoding`);
    return BigInt(val);
  }
  if (ai === 25) {
    const val = (data[pos.value] << 8) | data[pos.value + 1];
    pos.value += 2;
    if (val <= 255) throw new CborError(pos.value, `non-canonical: value ${val} should use 1-byte encoding`);
    return BigInt(val);
  }
  if (ai === 26) {
    const val = (data[pos.value] << 24) | (data[pos.value + 1] << 16) |
                (data[pos.value + 2] << 8) | data[pos.value + 3];
    pos.value += 4;
    if (val <= 65535) throw new CborError(pos.value, `non-canonical: value ${val} should use 2-byte encoding`);
    return BigInt(val);
  }
  if (ai === 27) {
    let val = 0n;
    for (let i = 0; i < 8; i++) val = (val << 8n) | BigInt(data[pos.value + i]);
    pos.value += 8;
    if (val <= 0xFFFFFFFFn) throw new CborError(pos.value, `non-canonical: value should use 4-byte encoding`);
    return val;
  }
  if (ai === 31) throw new CborError(pos.value, "indefinite-length not allowed");
  throw new CborError(pos.value, `unsupported additional info ${ai}`);
}
```

### 2.4 Helper functions

```typescript
// packages/cbor/src/helpers.ts

export function intMap(entries: [number, CborValue][]): CborValue {
  return { type: "int-map", entries };
}

export function intMapGet(map: CborValue, key: number): CborValue | undefined {
  if (map.type !== "int-map") return undefined;
  return map.entries.find(([k]) => k === key)?.[1];
}

export function strMap(entries: [string, CborValue][]): CborValue {
  return { type: "text-map", entries };
}

export function strMapGet(map: CborValue, key: string): CborValue | undefined {
  if (map.type !== "text-map") return undefined;
  return map.entries.find(([k]) => k === key)?.[1];
}
```

### 2.5 CBOR test expectations (match Rust `aafp-cbor` test vectors)

These are the exact byte sequences from the Rust test suite. Every test MUST
produce/assert these exact bytes:

```typescript
// tests/encoder.test.ts — exact byte matches from Rust aafp-cbor tests

// test_encode_unsigned
assert.deepStrictEqual(encodeCbor({ type: "unsigned", value: 0 }),  hex("00"));
assert.deepStrictEqual(encodeCbor({ type: "unsigned", value: 1 }),  hex("01"));
assert.deepStrictEqual(encodeCbor({ type: "unsigned", value: 23 }), hex("17"));
assert.deepStrictEqual(encodeCbor({ type: "unsigned", value: 24 }), hex("1818"));
assert.deepStrictEqual(encodeCbor({ type: "unsigned", value: 100 }), hex("1864"));
assert.deepStrictEqual(encodeCbor({ type: "unsigned", value: 1000 }), hex("1903E8"));

// test_encode_negative
assert.deepStrictEqual(encodeCbor({ type: "negative", value: -1 }),  hex("20"));
assert.deepStrictEqual(encodeCbor({ type: "negative", value: -10 }), hex("29"));
assert.deepStrictEqual(encodeCbor({ type: "negative", value: -100 }), hex("3863"));

// test_encode_byte_string
assert.deepStrictEqual(
  encodeCbor({ type: "bytes", value: hex("010203") }),
  hex("43010203"),
);

// test_encode_text_string
assert.deepStrictEqual(
  encodeCbor({ type: "text", value: "hi" }),
  hex("626869"),  // 0x62 = text(2), 0x68='h', 0x69='i'
);

// test_encode_bool_null
assert.deepStrictEqual(encodeCbor({ type: "bool", value: true }),  hex("F5"));
assert.deepStrictEqual(encodeCbor({ type: "bool", value: false }), hex("F4"));
assert.deepStrictEqual(encodeCbor({ type: "null" }),              hex("F6"));

// test_encode_array
assert.deepStrictEqual(
  encodeCbor({ type: "array", items: [
    { type: "unsigned", value: 1 },
    { type: "unsigned", value: 2 },
  ]}),
  hex("820102"),
);

// test_encode_int_map_canonical_ordering
// Keys 1, 2, 5, 10 — all 1-byte, sorted numerically
assert.deepStrictEqual(
  encodeCbor(intMap([
    [10, { type: "unsigned", value: 100 }],
    [2,  { type: "unsigned", value: 20 }],
    [1,  { type: "unsigned", value: 10 }],
    [5,  { type: "unsigned", value: 50 }],
  ])),
  hex("A4010A02140518320A1864"),
);

// test_encode_int_map_mixed_lengths
// Key 1 (1-byte: 0x01) sorts before key 24 (2-byte: 0x18 0x18)
assert.deepStrictEqual(
  encodeCbor(intMap([
    [24, { type: "unsigned", value: 2 }],
    [1,  { type: "unsigned", value: 1 }],
  ])),
  hex("A20101181802"),
);

// test_empty_map
assert.deepStrictEqual(encodeCbor(intMap([])), hex("A0"));

// test_empty_array
assert.deepStrictEqual(encodeCbor({ type: "array", items: [] }), hex("80"));
```

```typescript
// tests/roundtrip.test.ts — canonical determinism

// test_canonical_encoding_is_deterministic
const map1 = intMap([
  [3, { type: "unsigned", value: 3 }],
  [1, { type: "unsigned", value: 1 }],
  [2, { type: "unsigned", value: 2 }],
]);
const map2 = intMap([
  [1, { type: "unsigned", value: 1 }],
  [2, { type: "unsigned", value: 2 }],
  [3, { type: "unsigned", value: 3 }],
]);
assert.deepStrictEqual(encodeCbor(map1), encodeCbor(map2),
  "canonical encoding must be deterministic regardless of insertion order");

// test_str_map_canonical_ordering
// "cat" (3B) < "apple" (5B) < "zebra" (5B), same-length sorted bytewise
const decoded = decodeCbor(encodeCbor(strMap([
  ["zebra", { type: "unsigned", value: 1 }],
  ["apple", { type: "unsigned", value: 2 }],
  ["cat",   { type: "unsigned", value: 3 }],
])));
assert.strictEqual(decoded.type, "text-map");
assert.deepStrictEqual(
  (decoded as any).entries.map(([k]: [string]) => k),
  ["cat", "apple", "zebra"],
);

// test_indefinite_length_rejected
assert.throws(() => decodeCbor(hex("9F01FF")), CborError);

// test_deep_nesting_rejected (200 nested arrays, limit is 100)
const deepData = new Uint8Array(201);
deepData.fill(0x81, 0, 200);  // 200 × array(1)
deepData[200] = 0x00;         // unsigned(0)
assert.throws(() => decodeCbor(deepData), CborError);
```

---

## 3. ML-DSA-65 — `@aafp/crypto`

### 3.1 Constants and types

From the Rust reference (`dsa.rs` lines 17-21):
- Public key: **1952 bytes**
- Secret key: **4032 bytes**
- Signature: **3309 bytes**
- Empty context string (`""`) for sign/verify (matches PQClean behavior)

```typescript
// packages/crypto/src/dsa.ts

import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { randomBytes } from "@noble/post-quantum/utils.js";

export const ML_DSA_65_PUBKEY_LEN = 1952;
export const ML_DSA_65_SECRETKEY_LEN = 4032;
export const ML_DSA_65_SIGNATURE_LEN = 3309;

export class MlDsa65PublicKey {
  constructor(public readonly bytes: Uint8Array) {
    if (bytes.length !== ML_DSA_65_PUBKEY_LEN) {
      throw new CryptoError(`invalid public key length: expected ${ML_DSA_65_PUBKEY_LEN}, got ${bytes.length}`);
    }
  }
}

export class MlDsa65SecretKey {
  constructor(public readonly bytes: Uint8Array) {
    if (bytes.length !== ML_DSA_65_SECRETKEY_LEN) {
      throw new CryptoError(`invalid secret key length: expected ${ML_DSA_65_SECRETKEY_LEN}, got ${bytes.length}`);
    }
  }
}

export class MlDsa65Signature {
  constructor(public readonly bytes: Uint8Array) {
    if (bytes.length !== ML_DSA_65_SIGNATURE_LEN) {
      throw new CryptoError(`invalid signature length: expected ${ML_DSA_65_SIGNATURE_LEN}, got ${bytes.length}`);
    }
  }
}
```

### 3.2 Key generation, signing, verification

```typescript
// packages/crypto/src/dsa.ts (continued)

export interface MlDsa65Keypair {
  publicKey: MlDsa65PublicKey;
  secretKey: MlDsa65SecretKey;
}

/** Generate a fresh ML-DSA-65 keypair (FIPS 204). */
export function mlDsa65Keypair(seed?: Uint8Array): MlDsa65Keypair {
  const keys = ml_dsa65.keygen(seed ?? randomBytes(32));
  return {
    publicKey: new MlDsa65PublicKey(keys.publicKey),
    secretKey: new MlDsa65SecretKey(keys.secretKey),
  };
}

/** Deterministic keygen from a 32-byte seed (FIPS 204 Algorithm 1). */
export function mlDsa65KeypairFromSeed(seed: Uint8Array): MlDsa65Keypair {
  if (seed.length !== 32) throw new CryptoError("seed must be 32 bytes");
  return mlDsa65Keypair(seed);
}

/** Sign a message with ML-DSA-65. Empty context string (matches PQClean). */
export function mlDsa65Sign(secretKey: MlDsa65SecretKey, msg: Uint8Array): MlDsa65Signature {
  const sig = ml_dsa65.sign(msg, secretKey.bytes);
  return new MlDsa65Signature(sig);
}

/** Verify an ML-DSA-65 signature. Returns true if valid. */
export function mlDsa65Verify(
  publicKey: MlDsa65PublicKey,
  msg: Uint8Array,
  sig: MlDsa65Signature,
): boolean {
  try {
    return ml_dsa65.verify(sig.bytes, msg, publicKey.bytes);
  } catch {
    return false;
  }
}

/** Deterministic signing using a 32-byte randomness seed. */
export function mlDsa65SignDeterministic(
  secretKey: MlDsa65SecretKey,
  msg: Uint8Array,
  seed: Uint8Array,
): MlDsa65Signature {
  if (seed.length !== 32) throw new CryptoError("sign seed must be 32 bytes");
  const sig = ml_dsa65.sign(msg, secretKey.bytes, seed);
  return new MlDsa65Signature(sig);
}
```

### 3.3 DSA test expectations (match Rust `aafp-crypto::dsa` tests)

```typescript
// tests/dsa.test.ts

import { test } from "node:test";
import assert from "node:assert";

test("sign_verify_roundtrip", () => {
  const { publicKey, secretKey } = mlDsa65Keypair();
  assert.strictEqual(publicKey.bytes.length, 1952);
  assert.strictEqual(secretKey.bytes.length, 4032);

  const msg = new TextEncoder().encode("post-quantum aafp");
  const sig = mlDsa65Sign(secretKey, msg);
  assert.strictEqual(sig.bytes.length, 3309);
  assert.ok(mlDsa65Verify(publicKey, msg, sig));
});

test("verify_rejects_tampered_message", () => {
  const { publicKey, secretKey } = mlDsa65Keypair();
  const sig = mlDsa65Sign(secretKey, new TextEncoder().encode("original"));
  assert.ok(!mlDsa65Verify(publicKey, new TextEncoder().encode("tampered"), sig));
});

test("verify_rejects_wrong_key", () => {
  const { publicKey: pk1, secretKey: sk1 } = mlDsa65Keypair();
  const { publicKey: pk2 } = mlDsa65Keypair();
  const sig = mlDsa65Sign(sk1, new TextEncoder().encode("msg"));
  assert.ok(!mlDsa65Verify(pk2, new TextEncoder().encode("msg"), sig));
  assert.ok(mlDsa65Verify(pk1, new TextEncoder().encode("msg"), sig));
});

test("serialization_roundtrip", () => {
  const { publicKey, secretKey } = mlDsa65Keypair();
  const pk2 = new MlDsa65PublicKey(publicKey.bytes);
  const sk2 = new MlDsa65SecretKey(secretKey.bytes);
  const sig = mlDsa65Sign(sk2, new TextEncoder().encode("roundtrip"));
  assert.ok(mlDsa65Verify(pk2, new TextEncoder().encode("roundtrip"), sig));
});

test("rejects_bad_lengths", () => {
  assert.throws(() => new MlDsa65PublicKey(new Uint8Array(10)));
  assert.throws(() => new MlDsa65SecretKey(new Uint8Array(10)));
  assert.throws(() => new MlDsa65Signature(new Uint8Array(10)));
});

test("keypair_from_seed_deterministic", () => {
  const seed = new Uint8Array(32).fill(0x42);
  const kp1 = mlDsa65KeypairFromSeed(seed);
  const kp2 = mlDsa65KeypairFromSeed(seed);
  assert.deepStrictEqual(kp1.publicKey.bytes, kp2.publicKey.bytes,
    "same seed must produce same public key");
  assert.deepStrictEqual(kp1.secretKey.bytes, kp2.secretKey.bytes,
    "same seed must produce same secret key");
});

test("keypair_from_seed_different_seeds", () => {
  const seed1 = new Uint8Array(32).fill(0x01);
  const seed2 = new Uint8Array(32).fill(0x02);
  const kp1 = mlDsa65KeypairFromSeed(seed1);
  const kp2 = mlDsa65KeypairFromSeed(seed2);
  assert.notDeepStrictEqual(kp1.publicKey.bytes, kp2.publicKey.bytes);
});
```

### 3.4 Cross-language test vectors (A-10)

Load the Rust-generated test vectors from `test-vectors/mldsa65/vectors.json`
and verify that `@noble/post-quantum` produces identical keys and signatures
from the same seed. This is the critical interop test.

```typescript
// tests/cross-verify.test.ts

import { readFileSync } from "node:fs";

const vectors = JSON.parse(readFileSync("test-vectors/mldsa65/vectors.json", "utf-8"));

test("A-10: same seed produces same public key as Rust", () => {
  for (const v of vectors) {
    const seed = hexToBytes(v.seed);
    const kp = mlDsa65KeypairFromSeed(seed);
    assert.deepStrictEqual(
      Buffer.from(kp.publicKey.bytes).toString("hex"),
      v.public_key_hex,
      `vector ${v.id}: public key mismatch`,
    );
  }
});

test("A-10: deterministic signature matches Rust", () => {
  for (const v of vectors) {
    const seed = hexToBytes(v.seed);
    const kp = mlDsa65KeypairFromSeed(seed);
    const msg = hexToBytes(v.message_hex);
    const signSeed = new Uint8Array(32).fill(0);  // deterministic seed
    const sig = mlDsa65SignDeterministic(kp.secretKey, msg, signSeed);
    // Verify the signature is valid
    assert.ok(mlDsa65Verify(kp.publicKey, msg, sig), `vector ${v.id}: signature invalid`);
  }
});

test("A-10: Rust signatures verify in TS", () => {
  for (const v of vectors) {
    const pk = new MlDsa65PublicKey(hexToBytes(v.public_key_hex));
    const msg = hexToBytes(v.message_hex);
    const sig = new MlDsa65Signature(hexToBytes(v.signature_hex));
    assert.ok(mlDsa65Verify(pk, msg, sig), `vector ${v.id}: Rust sig failed TS verify`);
  }
});
```

---

## 4. HKDF-SHA256 — `@aafp/crypto`

Match `aafp-crypto/src/kdf.rs`. Use `@noble/hashes` for SHA-256.

```typescript
// packages/crypto/src/kdf.ts

import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

/** HKDF-SHA256 extract-and-expand. Returns `outputLen` bytes. */
export function hkdfSha256(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  outputLen: number,
): Uint8Array {
  return hkdf(sha256, ikm, salt, info, outputLen);
}

/** Derive a 32-byte key from input key material. */
export function deriveKey(ikm: Uint8Array, info: Uint8Array): Uint8Array {
  return hkdfSha256(new Uint8Array(0), ikm, info, 32);
}
```

### 4.1 HKDF test expectations

```typescript
// tests/kdf.test.ts — match Rust aafp-crypto/src/kdf.rs tests

test("hkdf_deterministic", () => {
  const a = hkdfSha256(enc("salt"), enc("ikm"), enc("info"), 32);
  const b = hkdfSha256(enc("salt"), enc("ikm"), enc("info"), 32);
  assert.deepStrictEqual(a, b);
});

test("hkdf_different_info_diverges", () => {
  const a = hkdfSha256(enc("salt"), enc("ikm"), enc("info-a"), 32);
  const b = hkdfSha256(enc("salt"), enc("ikm"), enc("info-b"), 32);
  assert.notDeepStrictEqual(a, b);
});

test("derive_key_is_32_bytes", () => {
  const k = deriveKey(enc("secret"), enc("label"));
  assert.strictEqual(k.length, 32);
});
```

---

## 5. AEAD — `@aafp/crypto`

Match `aafp-crypto/src/aead.rs`. Default: ChaCha20-Poly1305. Also support
AES-256-GCM. Nonce is 12 bytes. Key is 32 bytes.

Use Web Crypto API (`crypto.subtle`) for AEAD — it's available in Node 18+,
browsers, Deno, and Bun. This avoids native dependencies.

```typescript
// packages/crypto/src/aead.ts

export const NONCE_LEN = 12;

export enum AeadAlgorithm {
  ChaCha20Poly1305 = "ChaCha20-Poly1305",
  Aes256Gcm = "AES-256-GCM",
}

export class Aead {
  private readonly key: Uint8Array;
  private readonly algorithm: AeadAlgorithm;

  constructor(key: Uint8Array, algorithm: AeadAlgorithm = AeadAlgorithm.ChaCha20Poly1305) {
    if (key.length !== 32) throw new CryptoError("AEAD key must be 32 bytes");
    this.key = key;
    this.algorithm = algorithm;
  }

  async encrypt(nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await this.importKey();
    // Web Crypto returns ciphertext+tag concatenated
    const ciphertext = await crypto.subtle.encrypt(
      { name: this.webCryptoName(), iv: nonce, additionalData: aad },
      cryptoKey,
      plaintext,
    );
    return new Uint8Array(ciphertext);
  }

  async decrypt(nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await this.importKey();
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: this.webCryptoName(), iv: nonce, additionalData: aad },
        cryptoKey,
        ciphertext,
      );
      return new Uint8Array(plaintext);
    } catch {
      throw new CryptoError("AEAD decryption failed");
    }
  }

  private async importKey(): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      "raw", this.key,
      { name: this.webCryptoName() },
      false, ["encrypt", "decrypt"],
    );
  }

  private webCryptoName(): string {
    return this.algorithm === AeadAlgorithm.ChaCha20Poly1305
      ? "ChaCha20-Poly1305"
      : "AES-GCM";
  }
}
```

### 5.1 AEAD test expectations

```typescript
// tests/aead.test.ts — match Rust aafp-crypto/src/aead.rs tests

test("chacha20_roundtrip", async () => {
  const key = new Uint8Array(32).fill(0x42);
  const aead = new Aead(key, AeadAlgorithm.ChaCha20Poly1305);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = enc("associated-data");
  const pt = enc("post-quantum agent message");
  const ct = await aead.encrypt(nonce, aad, pt);
  assert.notDeepStrictEqual(ct, pt);
  const decrypted = await aead.decrypt(nonce, aad, ct);
  assert.deepStrictEqual(decrypted, pt);
});

test("tampered_ciphertext_fails", async () => {
  const key = new Uint8Array(32).fill(0x42);
  const aead = new Aead(key);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await aead.encrypt(nonce, enc("aad"), enc("secret"));
  ct[0] ^= 0xff;
  await assert.rejects(() => aead.decrypt(nonce, enc("aad"), ct));
});

test("wrong_aad_fails", async () => {
  const key = new Uint8Array(32).fill(0x42);
  const aead = new Aead(key, AeadAlgorithm.Aes256Gcm);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await aead.encrypt(nonce, enc("aad-1"), enc("secret"));
  await assert.rejects(() => aead.decrypt(nonce, enc("aad-2"), ct));
});

test("wrong_nonce_fails", async () => {
  const key = new Uint8Array(32).fill(0x42);
  const aead = new Aead(key);
  const nonce1 = crypto.getRandomValues(new Uint8Array(12));
  const nonce2 = crypto.getRandomValues(new Uint8Array(12));
  const ct = await aead.encrypt(nonce1, enc("aad"), enc("secret"));
  await assert.rejects(() => aead.decrypt(nonce2, enc("aad"), ct));
});
```

---

## 6. AgentId — `@aafp/crypto`

AgentId = SHA-256(ML-DSA-65 public key) = 32 bytes. Represented as a
lowercase hex string (64 chars) for display/routing. Matches
`aafp-identity/src/agent_id.rs`.

```typescript
// packages/crypto/src/agent-id.ts

import { sha256 } from "@noble/hashes/sha256";

/** AgentId = SHA-256(publicKey), 32 bytes. Hex-encoded for display. */
export type AgentId = string;  // 64-char lowercase hex

/** Derive an AgentId from an ML-DSA-65 public key. */
export function deriveAgentId(publicKey: Uint8Array): AgentId {
  const hash = sha256(publicKey);
  return toHex(hash);
}

/** Verify that a public key corresponds to an AgentId. */
export function verifyAgentId(agentId: AgentId, publicKey: Uint8Array): boolean {
  return deriveAgentId(publicKey) === agentId;
}

/** Parse an AgentId from hex. Throws if invalid. */
export function agentIdFromHex(hex: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) throw new CryptoError("agent ID must be 32 bytes (64 hex chars)");
  return bytes;
}

/** Truncate an AgentId to a short prefix (first 8 hex chars). */
export function agentIdShort(agentId: AgentId): string {
  return agentId.slice(0, 8);
}
```

### 6.1 AgentId test expectations

```typescript
// tests/agent-id.test.ts — match Rust aafp-identity/src/agent_id.rs tests

test("derive_and_verify", () => {
  const { publicKey } = mlDsa65Keypair();
  const id = deriveAgentId(publicKey.bytes);
  assert.strictEqual(id.length, 64);
  assert.ok(verifyAgentId(id, publicKey.bytes));
});

test("rejects_wrong_key", () => {
  const { publicKey: pk1 } = mlDsa65Keypair();
  const { publicKey: pk2 } = mlDsa65Keypair();
  const id1 = deriveAgentId(pk1.bytes);
  assert.ok(!verifyAgentId(id1, pk2.bytes));
});

test("hex_roundtrip", () => {
  const id = "ab".repeat(32);
  const bytes = agentIdFromHex(id);
  assert.strictEqual(bytes.length, 32);
});

test("hex_rejects_bad_input", () => {
  assert.throws(() => agentIdFromHex("abc"));     // too short
  assert.throws(() => agentIdFromHex("zz"));      // invalid hex
});

test("different_keys_different_ids", () => {
  const { publicKey: pk1 } = mlDsa65Keypair();
  const { publicKey: pk2 } = mlDsa65Keypair();
  const id1 = deriveAgentId(pk1.bytes);
  const id2 = deriveAgentId(pk2.bytes);
  assert.notStrictEqual(id1, id2);
});

test("short_display", () => {
  const id = "ab".repeat(32);
  assert.strictEqual(agentIdShort(id), "abababab");
});
```

---

## 7. AgentKeypair — `@aafp/crypto`

Matches `aafp-identity/src/keypair.rs`. Wraps ML-DSA-65 keys with convenience
methods for signing, verification, serialization, and AgentId derivation.

```typescript
// packages/crypto/src/keypair.ts

export interface AgentKeypair {
  /** ML-DSA-65 public key (1952 bytes). */
  readonly publicKey: Uint8Array;
  /** ML-DSA-65 secret key (4032 bytes). */
  readonly secretKey: Uint8Array;
  /** Agent ID = hex of SHA-256(publicKey). */
  agentId(): AgentId;
  /** Sign a message with ML-DSA-65. Returns 3309-byte signature. */
  sign(msg: Uint8Array): Uint8Array;
  /** Verify a signature against this keypair's public key. */
  verify(msg: Uint8Array, sig: Uint8Array): boolean;
}

/** Generate a fresh ML-DSA-65 keypair. */
export function generateKeypair(seed?: Uint8Array): AgentKeypair {
  const kp = seed ? mlDsa65KeypairFromSeed(seed) : mlDsa65Keypair();
  return makeKeypair(kp.publicKey.bytes, kp.secretKey.bytes);
}

/** Reconstruct a keypair from both secret and public key bytes. */
export function fromSecretAndPublic(secret: Uint8Array, public_: Uint8Array): AgentKeypair {
  // Validates lengths via MlDsa65SecretKey/MlDsa65PublicKey constructors
  new MlDsa65SecretKey(secret);
  new MlDsa65PublicKey(public_);
  return makeKeypair(public_, secret);
}

/** Serialize keypair to bytes: [4-byte BE secret_len][secret][public]. */
export function keypairToBytes(kp: AgentKeypair): Uint8Array {
  const out = new Uint8Array(4 + kp.secretKey.length + kp.publicKey.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, kp.secretKey.length);
  out.set(kp.secretKey, 4);
  out.set(kp.publicKey, 4 + kp.secretKey.length);
  return out;
}

/** Deserialize keypair from bytes. */
export function keypairFromBytes(data: Uint8Array): AgentKeypair {
  if (data.length < 4) throw new CryptoError("keypair too short");
  const view = new DataView(data.buffer, data.byteOffset);
  const skLen = view.getUint32(0);
  if (data.length < 4 + skLen) throw new CryptoError("truncated secret key");
  const secretKey = data.slice(4, 4 + skLen);
  const publicKey = data.slice(4 + skLen);
  return fromSecretAndPublic(secretKey, publicKey);
}

function makeKeypair(publicKey: Uint8Array, secretKey: Uint8Array): AgentKeypair {
  return {
    publicKey,
    secretKey,
    agentId() {
      return deriveAgentId(publicKey);
    },
    sign(msg: Uint8Array) {
      return mlDsa65Sign(new MlDsa65SecretKey(secretKey), msg).bytes;
    },
    verify(msg: Uint8Array, sig: Uint8Array) {
      try {
        return mlDsa65Verify(
          new MlDsa65PublicKey(publicKey),
          msg,
          new MlDsa65Signature(sig),
        );
      } catch {
        return false;
      }
    },
  };
}
```

### 7.1 AgentKeypair test expectations

```typescript
// tests/keypair.test.ts — match Rust aafp-identity/src/keypair.rs tests

test("generate_and_sign", () => {
  const kp = generateKeypair();
  assert.strictEqual(kp.publicKey.length, 1952);
  assert.strictEqual(kp.secretKey.length, 4032);
  const msg = enc("agent identity test");
  const sig = kp.sign(msg);
  assert.strictEqual(sig.length, 3309);
  assert.ok(kp.verify(msg, sig));
});

test("serialization_roundtrip", () => {
  const kp = generateKeypair();
  const bytes = keypairToBytes(kp);
  const kp2 = keypairFromBytes(bytes);
  assert.deepStrictEqual(kp.publicKey, kp2.publicKey);
  assert.deepStrictEqual(kp.secretKey, kp2.secretKey);
  const msg = enc("roundtrip");
  const sig = kp2.sign(msg);
  assert.ok(kp.verify(msg, sig));
});

test("from_secret_and_public_validates", () => {
  const kp = generateKeypair();
  const kp2 = fromSecretAndPublic(kp.secretKey, kp.publicKey);
  assert.deepStrictEqual(kp.publicKey, kp2.publicKey);
});

test("rejects_bad_keys", () => {
  assert.throws(() => fromSecretAndPublic(new Uint8Array(10), new Uint8Array(10)));
  assert.throws(() => keypairFromBytes(new Uint8Array(3)));
});
```

---

## 8. Public API exports

### 8.1 `@aafp/cbor` index

```typescript
// packages/cbor/src/index.ts

export { encodeCbor } from "./encoder.js";
export { decodeCbor, checkCanonical } from "./decoder.js";
export { intMap, intMapGet, strMap, strMapGet } from "./helpers.js";
export { CborError } from "./types.js";
export type { CborValue } from "./types.js";
```

### 8.2 `@aafp/crypto` index

```typescript
// packages/crypto/src/index.ts

// DSA
export {
  mlDsa65Keypair, mlDsa65KeypairFromSeed, mlDsa65Sign,
  mlDsa65SignDeterministic, mlDsa65Verify,
  MlDsa65PublicKey, MlDsa65SecretKey, MlDsa65Signature,
  ML_DSA_65_PUBKEY_LEN, ML_DSA_65_SECRETKEY_LEN, ML_DSA_65_SIGNATURE_LEN,
} from "./dsa.js";

// KDF
export { hkdfSha256, deriveKey } from "./kdf.js";

// AEAD
export { Aead, AeadAlgorithm, NONCE_LEN } from "./aead.js";

// AgentId
export {
  deriveAgentId, verifyAgentId, agentIdFromHex, agentIdShort,
} from "./agent-id.js";
export type { AgentId } from "./agent-id.js";

// AgentKeypair
export {
  generateKeypair, fromSecretAndPublic, keypairToBytes, keypairFromBytes,
} from "./keypair.js";
export type { AgentKeypair } from "./keypair.js";

// Errors
export { CryptoError } from "./types.js";
```

---

## 9. Acceptance Criteria

The Phase 1 deliverable is complete when ALL of the following pass:

1. **`@aafp/cbor` — all encoder tests pass** with exact byte matches to the
   Rust `aafp-cbor` test suite (§2.5 above). Every hex assertion must match.

2. **`@aafp/cbor` — decoder rejects non-canonical input**: indefinite-length
   (0x9F...0xFF), non-shortest integers (e.g., `0x18 0x01` for value 1),
   duplicate map keys, and nesting depth > 100.

3. **`@aafp/cbor` — roundtrip determinism**: encode(decode(x)) === x and
   decode(encode(v)) deep-equals v for all CborValue variants. Insertion
   order of map entries does not affect encoded bytes.

4. **`@aafp/crypto` — ML-DSA-65 sign/verify roundtrip**: keygen → sign →
   verify succeeds. Tampered message, wrong key, and bad signature lengths
   are rejected.

5. **`@aafp/crypto` — A-10 cross-verification**: All vectors in
   `test-vectors/mldsa65/vectors.json` pass. Same 32-byte seed produces the
   same 1952-byte public key as the Rust `fips204` crate. Rust-generated
   signatures verify in TS and vice versa.

6. **`@aafp/crypto` — HKDF-SHA256**: deterministic output, diverges on
   different `info` strings, `deriveKey` returns 32 bytes.

7. **`@aafp/crypto` — AEAD**: ChaCha20-Poly1305 and AES-256-GCM encrypt/decrypt
   roundtrips succeed. Tampered ciphertext, wrong AAD, and wrong nonce all fail.

8. **`@aafp/crypto` — AgentId**: SHA-256 of public key, 64-char hex, verifies
   against correct key, rejects wrong key, different keys produce different IDs.

9. **`@aafp/crypto` — AgentKeypair**: generate, sign, verify, serialize
   (`keypairToBytes`), deserialize (`keypairFromBytes`), and reject bad keys.

10. **Both packages build with `tsc` — zero errors, zero warnings.**
    ESM output, `.d.ts` declarations generated.

11. **Both packages are tree-shakeable** — no side effects at import time.
    `package.json` has `"sideEffects": false`.

---

## 10. Implementation Notes

- **Use `Uint8Array` everywhere** — not `Buffer`. This ensures browser/Deno/Bun
  compatibility. `Buffer` is Node-only.
- **Use `TextEncoder`/`TextDecoder`** for UTF-8 — available in all JS runtimes.
- **Use `crypto.subtle` (Web Crypto)** for AEAD — available in Node 18+, all
  browsers, Deno, Bun. No native deps.
- **Use `@noble/post-quantum`** for ML-DSA-65 — audited, FIPS 204 compliant,
  pure JS. Import path: `@noble/post-quantum/ml-dsa.js`.
- **Use `@noble/hashes`** for SHA-256 and HKDF — pure JS, no native deps.
- **BigInt for large CBOR integers** — values > 2^32 need 8-byte encoding.
  The `readArgument` function returns `bigint`; convert to `number` when safe.
- **No `require()`** — ESM only. Dynamic imports for Node-specific code (none
  in Phase 1).
- **`hex()` helper** — use `Buffer.from(hexStr, "hex")` in tests (Node only) or
  a small utility function for browser test compatibility.

---

## 11. Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@noble/post-quantum` | `^0.2.0` | ML-DSA-65 (FIPS 204) |
| `@noble/hashes` | `^1.5.0` | SHA-256, HKDF |
| `typescript` | `^5.5.0` | Build (dev) |
| `tsx` | `^4.0.0` | Test runner (dev) |
| `@types/node` | `^22.0.0` | Node types (dev) |

No other runtime dependencies. Web Crypto (`crypto.subtle`) is built-in.
