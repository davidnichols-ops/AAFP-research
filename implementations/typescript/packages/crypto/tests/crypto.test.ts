import { describe, it, expect } from "vitest";
import {
  MlDsa65,
  MlDsa65PublicKey,
  MlDsa65SecretKey,
  MlDsa65Signature,
  ML_DSA_65_PUBKEY_LEN,
  ML_DSA_65_SECRETKEY_LEN,
  ML_DSA_65_SIGNATURE_LEN,
} from "../src/dsa.js";
import { generateKeypair, keypairToBytes, keypairFromBytes, fromSecretAndPublic } from "../src/keypair.js";
import { deriveAgentId, verifyAgentId, agentIdFromHex, agentIdShort } from "../src/agent-id.js";
import { hkdfSha256, deriveKey } from "../src/kdf.js";
import { Aead, AeadAlgorithm, NONCE_LEN } from "../src/aead.js";
import { CryptoError } from "../src/types.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("ML-DSA-65 sign/verify", () => {
  it("sign and verify roundtrip", () => {
    const { publicKey, secretKey } = MlDsa65.keypair();
    expect(publicKey.bytes.length).toBe(ML_DSA_65_PUBKEY_LEN);
    expect(secretKey.bytes.length).toBe(ML_DSA_65_SECRETKEY_LEN);

    const msg = enc("post-quantum aafp");
    const sig = MlDsa65.sign(secretKey, msg);
    expect(sig.bytes.length).toBe(ML_DSA_65_SIGNATURE_LEN);
    expect(MlDsa65.verify(publicKey, msg, sig)).toBe(true);
  });

  it("rejects tampered message", () => {
    const { publicKey, secretKey } = MlDsa65.keypair();
    const sig = MlDsa65.sign(secretKey, enc("original"));
    expect(MlDsa65.verify(publicKey, enc("tampered"), sig)).toBe(false);
  });

  it("rejects wrong key", () => {
    const { publicKey: pk1, secretKey: sk1 } = MlDsa65.keypair();
    const { publicKey: pk2 } = MlDsa65.keypair();
    const sig = MlDsa65.sign(sk1, enc("msg"));
    expect(MlDsa65.verify(pk2, enc("msg"), sig)).toBe(false);
    expect(MlDsa65.verify(pk1, enc("msg"), sig)).toBe(true);
  });

  it("serialization roundtrip", () => {
    const { publicKey, secretKey } = MlDsa65.keypair();
    const pk2 = new MlDsa65PublicKey(publicKey.bytes);
    const sk2 = new MlDsa65SecretKey(secretKey.bytes);
    const sig = MlDsa65.sign(sk2, enc("roundtrip"));
    expect(MlDsa65.verify(pk2, enc("roundtrip"), sig)).toBe(true);
  });

  it("rejects bad key/sig lengths", () => {
    expect(() => new MlDsa65PublicKey(new Uint8Array(10))).toThrow(CryptoError);
    expect(() => new MlDsa65SecretKey(new Uint8Array(10))).toThrow(CryptoError);
    expect(() => new MlDsa65Signature(new Uint8Array(10))).toThrow(CryptoError);
  });

  it("keypair from seed is deterministic", () => {
    const seed = new Uint8Array(32).fill(0x42);
    const kp1 = MlDsa65.keypairFromSeed(seed);
    const kp2 = MlDsa65.keypairFromSeed(seed);
    expect(kp1.publicKey.bytes).toEqual(kp2.publicKey.bytes);
    expect(kp1.secretKey.bytes).toEqual(kp2.secretKey.bytes);
  });

  it("different seeds produce different keys", () => {
    const kp1 = MlDsa65.keypairFromSeed(new Uint8Array(32).fill(0x01));
    const kp2 = MlDsa65.keypairFromSeed(new Uint8Array(32).fill(0x02));
    expect(kp1.publicKey.bytes).not.toEqual(kp2.publicKey.bytes);
  });
});

describe("AgentKeypair", () => {
  it("generate and sign", () => {
    const kp = generateKeypair();
    expect(kp.publicKey.length).toBe(ML_DSA_65_PUBKEY_LEN);
    expect(kp.secretKey.length).toBe(ML_DSA_65_SECRETKEY_LEN);
    const msg = enc("agent identity test");
    const sig = kp.sign(msg);
    expect(sig.length).toBe(ML_DSA_65_SIGNATURE_LEN);
    expect(kp.verify(msg, sig)).toBe(true);
  });

  it("serialization roundtrip", () => {
    const kp = generateKeypair();
    const bytes = keypairToBytes(kp);
    const kp2 = keypairFromBytes(bytes);
    expect(kp.publicKey).toEqual(kp2.publicKey);
    expect(kp.secretKey).toEqual(kp2.secretKey);
    const msg = enc("roundtrip");
    const sig = kp2.sign(msg);
    expect(kp.verify(msg, sig)).toBe(true);
  });

  it("fromSecretAndPublic validates", () => {
    const kp = generateKeypair();
    const kp2 = fromSecretAndPublic(kp.secretKey, kp.publicKey);
    expect(kp.publicKey).toEqual(kp2.publicKey);
  });

  it("rejects bad keys", () => {
    expect(() => fromSecretAndPublic(new Uint8Array(10), new Uint8Array(10))).toThrow();
    expect(() => keypairFromBytes(new Uint8Array(3))).toThrow();
  });
});

describe("AgentId", () => {
  it("derive and verify", () => {
    const { publicKey } = MlDsa65.keypair();
    const id = deriveAgentId(publicKey.bytes);
    expect(id.length).toBe(64);
    expect(verifyAgentId(id, publicKey.bytes)).toBe(true);
  });

  it("rejects wrong key", () => {
    const { publicKey: pk1 } = MlDsa65.keypair();
    const { publicKey: pk2 } = MlDsa65.keypair();
    const id1 = deriveAgentId(pk1.bytes);
    expect(verifyAgentId(id1, pk2.bytes)).toBe(false);
  });

  it("hex roundtrip", () => {
    const id = "ab".repeat(32);
    const bytes = agentIdFromHex(id);
    expect(bytes.length).toBe(32);
  });

  it("hex rejects bad input", () => {
    expect(() => agentIdFromHex("abc")).toThrow(); // too short
    expect(() => agentIdFromHex("zz")).toThrow(); // invalid hex
  });

  it("different keys produce different ids", () => {
    const { publicKey: pk1 } = MlDsa65.keypair();
    const { publicKey: pk2 } = MlDsa65.keypair();
    const id1 = deriveAgentId(pk1.bytes);
    const id2 = deriveAgentId(pk2.bytes);
    expect(id1).not.toBe(id2);
  });

  it("short display", () => {
    const id = "ab".repeat(32) as ReturnType<typeof deriveAgentId>;
    expect(agentIdShort(id)).toBe("abababab");
  });
});

describe("HKDF-SHA256", () => {
  it("is deterministic", () => {
    const a = hkdfSha256(enc("salt"), enc("ikm"), enc("info"), 32);
    const b = hkdfSha256(enc("salt"), enc("ikm"), enc("info"), 32);
    expect(a).toEqual(b);
  });

  it("different info diverges", () => {
    const a = hkdfSha256(enc("salt"), enc("ikm"), enc("info-a"), 32);
    const b = hkdfSha256(enc("salt"), enc("ikm"), enc("info-b"), 32);
    expect(a).not.toEqual(b);
  });

  it("deriveKey returns 32 bytes", () => {
    const k = deriveKey(enc("secret"), enc("label"));
    expect(k.length).toBe(32);
  });
});

describe("AEAD", () => {
  it("chacha20 roundtrip", async () => {
    const key = new Uint8Array(32).fill(0x42);
    const aead = new Aead(key, AeadAlgorithm.ChaCha20Poly1305);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
    const aad = enc("associated-data");
    const pt = enc("post-quantum agent message");
    const ct = await aead.encrypt(nonce, aad, pt);
    expect(ct).not.toEqual(pt);
    const decrypted = await aead.decrypt(nonce, aad, ct);
    expect(decrypted).toEqual(pt);
  });

  it("tampered ciphertext fails", async () => {
    const key = new Uint8Array(32).fill(0x42);
    const aead = new Aead(key);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
    const ct = await aead.encrypt(nonce, enc("aad"), enc("secret"));
    ct[0] ^= 0xff;
    await expect(aead.decrypt(nonce, enc("aad"), ct)).rejects.toThrow(CryptoError);
  });

  it("wrong aad fails (AES-256-GCM)", async () => {
    const key = new Uint8Array(32).fill(0x42);
    const aead = new Aead(key, AeadAlgorithm.Aes256Gcm);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
    const ct = await aead.encrypt(nonce, enc("aad-1"), enc("secret"));
    await expect(aead.decrypt(nonce, enc("aad-2"), ct)).rejects.toThrow(CryptoError);
  });

  it("wrong nonce fails", async () => {
    const key = new Uint8Array(32).fill(0x42);
    const aead = new Aead(key);
    const nonce1 = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
    const nonce2 = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
    const ct = await aead.encrypt(nonce1, enc("aad"), enc("secret"));
    await expect(aead.decrypt(nonce2, enc("aad"), ct)).rejects.toThrow(CryptoError);
  });
});
