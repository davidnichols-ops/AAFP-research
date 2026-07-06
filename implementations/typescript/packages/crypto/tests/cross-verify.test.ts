import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MlDsa65,
  MlDsa65PublicKey,
  MlDsa65Signature,
} from "../src/dsa.js";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// Load test vectors from the repo root
const vectorsPath = resolve(process.cwd(), "../../test-vectors/mldsa65/vectors.json");
const vectors = JSON.parse(readFileSync(vectorsPath, "utf-8")) as Array<{
  id: string;
  seed: string;
  message_hex: string;
  context_hex: string;
  public_key_hex: string;
  secret_key_hex: string;
  signature_hex: string;
  expected_verify: boolean;
  description: string;
}>;

describe("A-10: ML-DSA-65 cross-language verification", () => {
  it("all Rust vectors verify in TS", () => {
    for (const v of vectors) {
      const pk = new MlDsa65PublicKey(hexToBytes(v.public_key_hex));
      const msg = hexToBytes(v.message_hex);
      const sig = new MlDsa65Signature(hexToBytes(v.signature_hex));
      const result = MlDsa65.verify(pk, msg, sig);
      expect(result).toBe(v.expected_verify);
    }
  });

  it("same seed produces same public key as Rust (valid vectors)", () => {
    for (const v of vectors) {
      if (!v.expected_verify) continue; // Skip invalid vectors (mismatched keys by design)
      const seed = hexToBytes(v.seed);
      const kp = MlDsa65.keypairFromSeed(seed);
      expect(
        Buffer.from(kp.publicKey.bytes).toString("hex"),
        `vector ${v.id}: public key mismatch`,
      ).toBe(v.public_key_hex);
    }
  });

  it("same seed produces same secret key as Rust (valid vectors)", () => {
    for (const v of vectors) {
      if (!v.expected_verify) continue; // Skip invalid vectors
      const seed = hexToBytes(v.seed);
      const kp = MlDsa65.keypairFromSeed(seed);
      expect(
        Buffer.from(kp.secretKey.bytes).toString("hex"),
        `vector ${v.id}: secret key mismatch`,
      ).toBe(v.secret_key_hex);
    }
  });
});
