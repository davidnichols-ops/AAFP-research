/**
 * @aafp/crypto — post-quantum cryptography for the AAFP TypeScript SDK.
 *
 * Public API exports for the crypto package. Re-exports all modules:
 * ML-DSA-65 signatures, HKDF-SHA256, AEAD, AgentId, and AgentKeypair.
 */

// DSA — ML-DSA-65 (FIPS 204)
export {
  MlDsa65,
  MlDsa65PublicKey,
  MlDsa65SecretKey,
  MlDsa65Signature,
  ML_DSA_65_PUBKEY_LEN,
  ML_DSA_65_SECRETKEY_LEN,
  ML_DSA_65_SIGNATURE_LEN,
  ML_DSA_65_SEED_LEN,
} from "./dsa.js";
export type { MlDsa65Keypair } from "./dsa.js";

// KDF — HKDF-SHA256
export { hkdfSha256, deriveKey } from "./kdf.js";

// AEAD — ChaCha20-Poly1305 + AES-256-GCM
export { Aead, AeadAlgorithm, NONCE_LEN, AEAD_KEY_LEN } from "./aead.js";

// AgentId — SHA-256 of public key
export {
  deriveAgentId,
  verifyAgentId,
  agentIdFromHex,
  agentIdShort,
  AGENT_ID_HEX_LEN,
  AGENT_ID_BYTE_LEN,
} from "./agent-id.js";
export type { AgentId } from "./agent-id.js";

// AgentKeypair — ML-DSA-65 keypair management
export {
  MlDsa65Keypair,
  generateKeypair,
  fromSecretAndPublic,
  keypairToBytes,
  keypairFromBytes,
} from "./keypair.js";
export type { AgentKeypair } from "./keypair.js";

// Errors
export { CryptoError } from "./types.js";
export type { CryptoErrorKind } from "./types.js";
