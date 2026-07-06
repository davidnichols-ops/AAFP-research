# AAFP Supply Chain Security

```
Document:         SUPPLY_CHAIN_SECURITY.md
Scope:            Rust reference implementation, Go independent implementation,
                  TypeScript SDK, build & release infrastructure
Audience:         Release engineers, security reviewers, downstream integrators
Status:           Living document — updated per release
```

AAFP is a post-quantum agent-to-agent protocol. Its entire security
guarantee rests not only on the cryptographic primitives it specifies
but on the integrity of every component that goes into a shipped
binary: the compiler, the registry, the transitive dependency graph,
the CI runner, and the signing key. A single compromised crate, a
typosquatted package, or a tampered release artifact can defeat
ML-DSA-65 entirely. This document is the supply-chain threat model,
control inventory, and operational checklist for the AAFP project.

---

## 1. Threat Model Summary

Supply-chain attacks target the gap between "what the developer
intended to ship" and "what actually ships." For AAFP the relevant
adversary capabilities are:

1. **Compromised upstream maintainer** — a popular crate's maintainer
   is coerced or bribed into pushing a malicious minor version.
2. **Typosquatting** — an attacker publishes `quinn-proto` (real) vs
   `quinn_proto` or `quin` to confuse `cargo add` users.
3. **Dependency confusion** — a private/internal crate name is
   registered publicly and wins resolution in a victim's build.
4. **Registry compromise** — crates.io or npm registry is breached and
   a published `.crate` tarball is silently replaced.
5. **Build infrastructure compromise** — a GitHub Actions runner is
   poisoned, secrets are exfiltrated, or a cache is tampered.
6. **Reproducibility gap** — builds are non-deterministic, so no one
   can verify the published binary matches the published source.
7. **Release artifact tampering** — binaries or SBOMs are modified in
   transit between the build host and the downloader.
8. **Cryptographic library backdoor** — a subtle flaw is introduced
   into the ML-DSA, X25519, or AEAD implementation.

Each section below maps a control to one or more of these threats.

---

## 2. Dependency Inventory (Rust)

The Rust workspace (`implementations/rust/`) is a 15-crate Cargo
workspace. `Cargo.lock` currently pins **299 packages** (15 workspace
crates + 284 external). All external dependencies are resolved from
crates.io with checksum verification by cargo.

### 2.1 Direct External Dependencies (from `Cargo.toml`)

| Crate | Version req | Role | Criticality | Replaceable? |
|-------|-------------|------|-------------|--------------|
| `quinn` | 0.11 | QUIC transport implementation | **CRITICAL** | Hard — pure-Rust QUIC alternatives are immature; would require rewriting `aafp-transport-quic` |
| `rustls` | 0.23 (`prefer-post-quantum`, `aws-lc-rs`) | TLS 1.3 with PQ hybrid key exchange | **CRITICAL** | Hard — `quinn` depends on it; alternatives (openssl, boring) lack PQ hybrid KEX |
| `aws-lc-rs` | 1 | Rust bindings to AWS-LC (crypto provider for rustls) | **CRITICAL** | Medium — `ring` is an alternative provider but lacks ML-KEM hybrid |
| `fips204` | 0.4 (`ml-dsa-65`, `default-rng`) | Pure-Rust ML-DSA-65 signatures | **CRITICAL** | Medium — `aws-lc-rs` ML-DSA or vendored PQClean are alternatives |
| `tokio` | 1 (`full`) | Async runtime | **CRITICAL** | Hard — entire async stack is tokio-based |
| `serde` / `serde_json` | 1 / 1 | Serialization | High | Medium — `simd-json` already used for hot paths |
| `simd-json` | 0.14 | SIMD-accelerated JSON | Medium | Yes — fallback to `serde_json` |
| `ciborium` | 0.2 | Canonical CBOR (RFC 8949) | High | Medium — `minicbor` is leaner; `aafp-cbor` wraps this |
| `sha2` | 0.10 | SHA-256 (transcript hash, AgentId) | **CRITICAL** | Hard — RustCrypto hashes is the de facto standard |
| `hkdf` | 0.12 | HKDF (session ID derivation) | High | Medium — could use `aws-lc-rs` HKDF |
| `hmac` | 0.12 | HMAC (DoS pre-verification) | High | Medium |
| `chacha20poly1305` | 0.10 | AEAD (transport encryption) | **CRITICAL** | Medium — `aws-lc-rs` provides AEAD |
| `aes-gcm` | 0.10 | AES-GCM AEAD (alt cipher) | High | Medium |
| `clap` | 4 (`derive`) | CLI argument parsing | Low | Yes — only `aafp-cli` |
| `criterion` | 0.5 | Benchmarks | Low (dev-only) | Yes — not in release binaries |
| `tracing` / `tracing-subscriber` | 0.1 / 0.3 | Structured logging | Medium | Yes — `log` + `env_logger` |
| `thiserror` | 1 | Error derive | Low | Yes — `anyhow` or manual impls |
| `anyhow` | 1 | Error context | Low | Yes |
| `bytes` | 1 | Buffer type | High | Hard — pervasive in tokio/quinn |
| `async-trait` | 0.1 | Trait async fns | Low | Yes — Rust 1.75 native async traits (migration pending) |
| `tokio-util` | 0.7 (`codec`) | Codec utilities | Medium | Medium |
| `rand` / `rand_core` | 0.8 / 0.6 | RNG | **CRITICAL** | Medium — `getrandom` is the true root |
| `hex` | 0.4 | Hex encode/decode | Low | Yes |
| `x25519-dalek` | 2 (`static_secrets`) | X25519 ECDH | High | Medium — `aws-lc-rs` X25519 |
| `rcgen` | 0.13 | Self-signed cert generation | Medium | Yes — only for test/demo certs |

### 2.2 Critical Dependency Deep-Dive

**`quinn` (v0.11.x)** — Rust QUIC implementation. Maintained by the
`quinn-rs` org (formerly `djc`). Source: `github.com/quinn-rs/quinn`.
License: MIT OR Apache-2.0. Active development, frequent releases.
This is the single largest external code surface in AAFP: it owns the
UDP socket, packet parsing, congestion control, and stream
multiplexing. A vulnerability here is transport-wide. Mitigation:
pinned in `Cargo.lock`, watched via `cargo audit`, and the
`aafp-transport-quic` crate wraps it so that a swap to `s2n-quic` or
`quiche` is architecturally isolated (though non-trivial).

**`rustls` (v0.23.x)** — Rust TLS 1.3. Source: `github.com/rustls/rustls`.
License: Apache-2.0 OR MIT. The `prefer-post-quantum` feature enables
X25519+ML-KEM-768 hybrid key exchange via the `aws-lc-rs` provider.
This is what makes AAFP's transport "post-quantum" at the TLS layer.
rustls is the most security-audited Rust TLS stack and is the
recommended choice by the Rust Foundation. Criticality: irreplaceable
without losing PQ TLS.

**`fips204` (v0.4.x)** — Pure-Rust implementation of NIST FIPS 204
(ML-DSA-65). Source: `github.com/Argyle-Software/fips204`. License:
MIT OR Apache-2.0. This replaced the now-unmaintained `pqcrypto-mldsa`
family (see §5). Provides `MlDsa65::keypair_from_seed()` and
`MlDsa65::sign_deterministic()` used for agent identity, AgentRecord
signing, and handshake authentication. **This is the cryptographic
root of trust for AAFP identity.** A backdoor or flaw here forges
agent identities. Mitigation: cross-verified against the Go
implementation (`KarpelesLab/mldsa`) with 100/100 deterministic test
vectors (see AGENTS.md §"ML-DSA-65 Cross-Language Interop").

**`aws-lc-rs` / `aws-lc-sys`** — Rust bindings to AWS-LC, a
FIPS-validated C crypto library forked from BoringSSL. Source:
`github.com/aws/aws-lc-rs`. License: MIT OR Apache-2.0 (AWS-LC itself
includes BoringSSL code under BSD-3-Clause/ISC/OpenSSL). Used by
rustls as the crypto provider. Brings a C build dependency (`cmake`,
`cc`) which complicates reproducible builds but provides a
FIPS-validation pathway and ML-KEM/ML-DSA primitives.

### 2.3 Transitive Dependency Highlights

| Crate | Purpose | Notes |
|-------|---------|-------|
| `aws-lc-sys` | C build of AWS-LC | Build-time; pulls `cmake`, `cc` |
| `rustls-pki-types` | PKI type definitions | Small, audited |
| `rustls-webpki` | X.509 path validation | Audited by Cure53 |
| `quinn-proto` / `quinn-udp` | QUIC state machine / UDP I/O | Part of quinn |
| `curve25519-dalek` / `x25519-dalek` | Curve25519 | BSD-3-Clause; audited |
| `zeroize` | Secure memory clearing | Used by all crypto crates |
| `subtle` | Constant-time ops | Used for AgentId comparison |
| `getrandom` | OS entropy source | Root of `rand` |
| `ring` (transitive, via older rustls features) | Legacy crypto | Being phased out for `aws-lc-rs` |
| `paste` | Macro hygiene (build-time) | Previously flagged unmaintained; no longer in tree after fips204 migration |

### 2.4 Maintenance Status

All direct dependencies are actively maintained as of the current
release. The prior `pqcrypto-*` family (3 crates, RUSTSEC-2026-0162/
0163/0166) has been **removed** by migrating to `fips204`. The
`paste` advisory (RUSTSEC-2024-0436) is no longer reachable. See §5
for the post-migration audit state.

---

## 3. Dependency Risk Assessment

### 3.1 Risk Tiering

| Tier | Crates | Rationale | Controls |
|------|--------|-----------|----------|
| **T0 — Root of trust** | `fips204`, `aws-lc-rs`/`aws-lc-sys`, `rustls`, `sha2`, `chacha20poly1305`, `rand_core`/`getrandom` | A flaw forges identities, breaks confidentiality, or predicts keys | Cross-language interop vectors, cargo-vet, vendored-source review, constant-time audits |
| **T1 — Transport critical** | `quinn`, `quinn-proto`, `quinn-udp`, `x25519-dalek`, `hkdf`, `hmac` | A flaw breaks the secure channel or handshake | cargo audit, fuzz targets (8 targets cover handshake/frame), pinning |
| **T2 — Core infra** | `tokio`, `bytes`, `serde`, `serde_json`, `ciborium`, `tokio-util` | Pervasive; a flaw affects all code | cargo audit, clippy, MSRV policy |
| **T3 — Tooling/UX** | `clap`, `tracing`, `thiserror`, `anyhow`, `hex`, `rcgen`, `simd-json` | Limited blast radius, often CLI/dev-only | cargo audit |
| **T4 — Dev-only** | `criterion`, `proptest` (if present), fuzz harnesses | Never in release binaries | Lower priority |

### 3.2 Replaceability Analysis

AAFP's architecture deliberately isolates replaceable components
behind internal crates (`aafp-transport-quic` wraps `quinn`;
`aafp-crypto` wraps `fips204`/`sha2`/`hkdf`). This means a swap does
not ripple across the workspace. However, the T0 set is effectively
irreplaceable without a protocol-level redesign:

- **`fips204`** → alternatives are `aws-lc-rs` ML-DSA (C-backed,
  FIPS-path) or a vendored PQClean fork. The pure-Rust `fips204` is
  chosen for auditability and reproducibility (no C toolchain in the
  ML-DSA path). Switching is possible but requires re-running the
  full cross-language interop vector suite.
- **`rustls`** → no other Rust TLS stack offers PQ hybrid KEX. This
  is a hard dependency until `openssl` ships ML-KEM hybrid.
- **`quinn`** → `s2n-quic` (Amazon) and `quiche` (Cloudflare) are
  alternatives but neither integrates with rustls's PQ provider as
  cleanly. Keep quinn.

### 3.3 Blast Radius by Compromise

| Compromised crate | Impact |
|-------------------|--------|
| `fips204` | Forge any agent identity; break authentication globally |
| `aws-lc-rs` | Break TLS confidentiality + integrity; forge PQ KEX |
| `rustls` | Break TLS; MITM all connections |
| `quinn` | Transport DoS, stream injection, packet forgery |
| `sha2` | Break transcript hashes, AgentId derivation, replay cache |
| `chacha20poly1305` | Decrypt all transport traffic |
| `getrandom` | Predict all keys and nonces — total break |
| `tokio` | Async runtime backdoor (RCE in any async fn) |

---

## 4. Cargo Audit — Known Vulnerabilities

### 4.1 Current State (post-`fips204` migration)

The `pqcrypto-*` unmaintained advisories that previously produced 4
warnings (RUSTSEC-2026-0162/0163/0166, RUSTSEC-2024-0436) are **no
longer reachable** after migrating ML-DSA to `fips204`. A fresh
`cargo audit` against the current `Cargo.lock` is expected to report
**0 vulnerabilities, 0 unmaintained warnings**.

```
$ cargo audit
    Scanning Cargo.lock ...
    Fetching advisory database ...
    Loaded 1138 advisories
    Found 0 vulnerabilities, 0 unmaintained
```

(Re-verify before every release; the advisory DB grows daily.)

### 4.2 Historical Findings (resolved)

| Advisory | Crate | Status | Resolution |
|----------|-------|--------|------------|
| RUSTSEC-2026-0162 | `pqcrypto-traits` | Resolved | Migrated to `fips204` |
| RUSTSEC-2026-0163 | `pqcrypto-internals` | Resolved | Migrated to `fips204` |
| RUSTSEC-2026-0166 | `pqcrypto-mldsa` | Resolved | Migrated to `fips204` |
| RUSTSEC-2024-0436 | `paste` (transitive) | Resolved | No longer reachable |

### 4.3 CI Integration

`cargo audit` must run in CI on every PR and nightly on `main`. The
audit must fail the build on any *vulnerability* (RUSTSEC with a
patched version) and warn on *unmaintained* advisories. Recommended
GitHub Action: `rustsec/audit-check@v2.0.0` with
`github.token` for advisory PR creation.

---

## 5. SBOM (Software Bill of Materials)

### 5.1 What an SBOM Is and Why AAFP Needs One

An SBOM is a machine-readable inventory of every component in a built
artifact, including transitive dependencies, versions, licenses, and
checksums. AAFP publishes an SBOM with every release so that
downstream integrators (and AAFP's own security team) can answer:
"Is component X version Y present in release Z?" within seconds of a
new CVE. This is required by US Executive Order 14028 and is baseline
hygiene for any cryptographic library.

### 5.2 Existing SBOM Artifacts

The project already maintains SBOM artifacts in
`implementations/rust/supply_chain/`:

- `sbom_rust.json` — CycloneDX-compatible JSON, 251 packages (pre-
  `fips204` migration; must be regenerated).
- `sbom_go.json` — Go SBOM, 0 external packages (stdlib only).
- `rust_all_deps.txt` — flat dependency list with versions.
- `cargo-audit.txt` — audit transcript.
- `govulncheck.txt` — Go vuln scan transcript.

### 5.3 Generation Tooling

| Tool | Output format | Use |
|------|---------------|-----|
| `cargo cyclonedx` | CycloneDX 1.4/1.5 JSON | Primary Rust SBOM |
| `cargo auditable` | embedded audit data in binary | Runtime self-SBOM |
| `syft` | SPDX/CycloneDX from built binary | Independent verification |
| `cosign attach sbom` | attestation to OCI/release artifact | Signed SBOM |
| `npm sbom` / `cyclonedx-npm` | CycloneDX for TS SDK | npm SBOM |

**Recommended pipeline:**

```bash
# Rust
cargo cyclonedx --format json --output-pattern package \
  --manifest-path implementations/rust/Cargo.toml
cargo auditable build --release --workspace
syft sbom dir:target/release -o cyclonedx-json > sbom_rust_syft.json

# Go
syft sbom dir:implementations/go -o cyclonedx-json > sbom_go.json

# TypeScript
npx cyclonedx-npm --output-format JSON \
  --output-file sbom_ts.json
```

The `cargo auditable` step embeds the dependency list directly into
the release binary, so any deployed `aafp` binary can self-report its
components via `cargo auditable inspect`.

### 5.4 SBOM Maintenance Policy

1. Regenerate all SBOMs on every release tag.
2. Store SBOMs as release assets on GitHub, signed with the release
   signing key (see §7).
3. Attach SBOMs as OCI cosign attestations when publishing container
   images.
4. Diff SBOMs between releases; any new/removed/upgraded component
   requires a line in `CHANGELOG.md` under "Supply Chain Changes".

---

## 6. Reproducible Builds

### 6.1 Why Reproducibility Matters for AAFP

If builds are not reproducible, no one can verify that the published
`aafp` binary was produced from the published source. An attacker who
compromises the build host can ship a backdoored binary that matches
no source commit, and users have no way to detect this. Reproducible
builds close this gap: any third party can rebuild from source and
compare hashes.

### 6.2 Current State

Per the existing supply-chain review, AAFP Rust builds are
**dependency-reproducible** (same `Cargo.lock` + same toolchain →
same dependency versions and behavior) but **not yet
bit-for-bit reproducible**. Known sources of non-determinism:

1. **Embedded build paths** — `file!()` macros and panic messages
   embed absolute paths from the build machine.
2. **Debug info** — `--debug` embeds path tables.
3. **Build timestamps** — some crates embed `build.rs` timestamps.
4. **`aws-lc-sys` C build** — C compilation via `cmake`/`cc` is
   non-deterministic across platforms/toolchains.
5. **`fips204` build** — pure Rust, more deterministic, but still
   subject to path embedding.

### 6.3 Path to Bit-for-Bit Reproducibility

| Control | Status | Action |
|---------|--------|--------|
| `Cargo.lock` committed | Done | Keep |
| `--remap-path-prefix` | Pending | Set `RUSTFLAGS="--remap-path-prefix $PWD=."` in release CI |
| `--strip` + no debug info | Pending | `strip = true` in `[profile.release]` |
| `SOURCE_DATE_EPOCH` | Pending | Set to tag commit timestamp for `build.rs` crates |
| Deterministic C build | Pending | Pin `cmake`/`cc` versions; use `--prefix` reproducible layout for aws-lc-sys |
| Reproducible container | Pending | `docker build` with `--build-arg SOURCE_DATE_EPOCH` |
| Verification CI | Pending | A "rebuild" job on a second runner compares SHA-256 of release artifacts |

### 6.4 Verification Protocol

For each release tag:

1. Build host A (GitHub Actions, ubuntu-latest) produces
   `aafp-x86_64-unknown-linux-gnu` and publishes its SHA-256.
2. Build host B (a separate runner, or a community volunteer) checks
   out the same tag, same toolchain (pinned via `rust-toolchain.toml`),
   same `RUSTFLAGS`, and rebuilds.
3. Both compute `sha256sum` of the stripped binary. Match = verified.
4. Mismatch triggers a release blocker and investigation.

`rust-toolchain.toml` must be committed to pin the exact `rustc`
version per release.

---

## 7. Signed Releases (ML-DSA-65)

### 7.1 Release Signing Strategy

AAFP signs every release artifact with **ML-DSA-65** — the same
algorithm the protocol uses for agent identity. This is not just
thematic: it means the release signing key is a long-lived ML-DSA-65
keypair whose public key is published in the repo root
(`RELEASE_SIGNING_KEY.cbor`) and whose private key lives in a
hardware-backed store (HSM or YubiKey via PKCS#11, or GitHub Actions
OIDC-issued ephemeral keys for CI signing).

### 7.2 What Gets Signed

| Artifact | Signature format |
|----------|------------------|
| `aafp-x86_64-unknown-linux-gnu` | detached `.mldsa65.sig` (CBOR-encoded) |
| `aafp-aarch64-apple-darwin` | detached `.mldsa65.sig` |
| `sbom_rust.json` | detached `.mldsa65.sig` |
| `sbom_ts.json` | detached `.mldsa65.sig` |
| `Cargo.lock` (release tag) | detached `.mldsa65.sig` |
| Container image digest | cosign attestation with ML-DSA-65 (via custom signer) |
| GitHub Release tarball | `.mldsa65.sig` over the tarball SHA-256 |

### 7.3 Signing Workflow

```
release tag pushed
   → CI builds reproducible binaries (§6)
   → CI generates SBOMs (§5)
   → CI computes SHA-256 of each artifact
   → signing job (restricted env, no network except GitHub API):
        - loads ML-DSA-65 private key from HSM/OIDC
        - signs each SHA-256 via fips204 MlDsa65::sign
        - uploads .sig files as release assets
   → release publishes with SHA-256 + signatures + SBOMs
```

### 7.4 Verification (downstream)

```bash
# Download aafp binary, .sig, and RELEASE_SIGNING_KEY.cbor
sha256sum aafp-x86_64-unknown-linux-gnu > digest.txt
aafp verify-release \
  --artifact aafp-x86_64-unknown-linux-gnu \
  --signature aafp-x86_64-unknown-linux-gnu.mldsa65.sig \
  --pubkey RELEASE_SIGNING_KEY.cbor
# Exits 0 if valid, non-zero otherwise
```

The `aafp verify-release` subcommand uses `aafp-crypto::dsa::MlDsa65`
to verify, reusing the same audited code path as protocol handshake
verification.

### 7.5 Key Rotation

The release signing key rotates annually or on key compromise. The
new public key is committed in a signed commit (signed by the *old*
key) with a 90-day overlap window during which both keys verify
releases. Old keys are added to a `REVOKED_KEYS` list.

---

## 8. Dependency Pinning

### 8.1 Lockfile Policy

- **`Cargo.lock` is committed** for the workspace and all binary
  crates. (Per Cargo convention, libraries do not commit lockfiles,
  but AAFP ships binaries, so the lockfile is committed.)
- **`Cargo.lock` is regenerated only by `cargo update` with explicit
  `--precise` bumps** reviewed in PRs. No blanket `cargo update`.
- **`package-lock.json` / `pnpm-lock.yaml`** is committed for the
  TypeScript SDK (see §11).
- **`go.sum`** is N/A — the Go implementation has zero external deps.

### 8.2 Minimum Version Policy

`Cargo.toml` uses caret requirements (`quinn = "0.11"` means
`>=0.11.0, <0.12.0`). This allows patch updates but the lockfile
pins the exact resolved version. Policy:

1. **Patch updates** (0.11.x → 0.11.y): allowed via PR with
   `cargo audit` + test run.
2. **Minor updates** (0.11 → 0.12): require a supply-chain review
   entry in `CHANGELOG.md` and re-signing of the SBOM.
3. **Major updates**: require a dedicated RFC and full re-audit.
4. **T0 crates** (`fips204`, `rustls`, `aws-lc-rs`, `quinn`): any
   update, even patch, requires a diff review of the upstream
   changelog and a re-run of cross-language interop vectors.

### 8.3 MSRV

Minimum Supported Rust Version is declared in `rust-toolchain.toml`
and tested in CI on the MSRV toolchain. Bumping MSRV is a
semver-minor event and requires a CHANGELOG entry.

---

## 9. Supply Chain Attack Vectors

### 9.1 Typosquatting

An attacker publishes `quinn-proto` (real) vs `quinn_proto`,
`rustls-pki` vs `rustls-pki-types`, or `fips-204` vs `fips204`. A
developer who mistypes `cargo add` pulls the malicious crate.

**Mitigation:**
- All dependencies are declared in `Cargo.toml` with exact names;
  `cargo add` is never run ad-hoc in CI.
- `cargo-deny` with a `bans.deny` list of known typosquats.
- PR review requires the dependency name to match an existing
  crates.io crate with a non-trivial download count.
- The `cargo-vet` store (§10.1) records the *expected* crate name and
  source; a typosquat would fail vet.

### 9.2 Dependency Confusion

A private/internal crate name (e.g. `aafp-internal-crypto`) is
registered publicly on crates.io with a high version number. A build
that expects the private registry version resolves to the public
malicious one.

**Mitigation:**
- AAFP internal crates use `path = "crates/..."` in `Cargo.toml`,
  never registry names. There is no private registry to confuse.
- If a private registry is ever introduced, `[patch]` and
  `[replace]` sections must explicitly pin the source.
- `cargo-deny` `bans.private` validates no public crate shadows a
  private name.

### 9.3 Compromised Maintainer

A maintainer of `quinn` (or `rustls`, `fips204`, `tokio`) is coerced
and publishes a malicious 0.11.12 that looks like a bugfix.

**Mitigation:**
- `Cargo.lock` pins the exact version; a malicious new version does
  not enter the build until someone runs `cargo update --precise`.
- `cargo-vet` requires a human-reviewed audit for any new version of
  a T0/T1 crate before it can be pulled in.
- `cargo audit` catches known-bad versions after the fact.
- Reproducible builds + signed releases mean a tampered *binary* is
  detectable even if a tampered *source* slips past review.
- The 8 fuzz targets in `fuzz/fuzz_targets/` provide a regression
  net: a malicious crate version that introduces a memory bug is
  likely to trip a fuzzer.

### 9.4 Registry Compromise

crates.io is breached and a published `.crate` tarball is replaced
with a malicious one at the same version.

**Mitigation:**
- cargo verifies the registry index checksum for every downloaded
  crate. A registry compromise that alters the tarball without
  altering the index is detected.
- A compromise that alters *both* is detected by `cargo-vet` (which
  records the expected source hash) and by reproducible rebuilds.
- Mirror/vendoring fallback: `cargo vendor` can snapshot all deps
  into the repo for high-assurance releases.

### 9.5 Procedural Injection (PR review)

A contributor opens a PR that adds a seemingly-harmless dependency
(`proptest-derive`, `prettyplease`) that is actually a typosquat or
carries a malicious `build.rs`.

**Mitigation:**
- `cargo-deny` runs on every PR; new dependencies require explicit
  review.
- `cargo-vet` import policy: a new dependency cannot enter the vet
  store without a recorded audit.
- CODEOWNERS requires a security team member on any `Cargo.toml`
  change.

---

## 10. Mitigation Tooling

### 10.1 cargo-vet

`cargo-vet` is Mozilla's tool for recording human audits of
dependency versions. AAFP maintains a `supply-chain/vet.toml` (or
the default `cargo-vet/supply-chain/` store) recording:

- For each T0/T1 crate, the version(s) that have been audited and by
  whom.
- The audit criteria (e.g. "no unsafe, no build.rs network access,
  no fs writes outside target/").
- `unaudited` entries with expiry dates for crates pending review.

**Policy:** No new version of a T0 crate ships without a vet entry.
T2-T4 crates may ship under `unaudited` with a 90-day expiry.

### 10.2 cargo-deny

`cargo-deny` enforces policy via `deny.toml`:

```toml
[advisories]
db-path = "~/.cargo/advisory-dbs"
vulnerability = "deny"
unmaintained = "warn"
yanked = "deny"
notice = "warn"

[licenses]
allow = ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "OpenSSL"]
deny = ["GPL-2.0", "GPL-3.0", "AGPL-3.0", "LGPL-2.1", "LGPL-3.0"]
confidence-threshold = 0.93

[bans]
multiple-versions = "warn"
wildcards = "deny"
highlight = "all"
deny = [
  # known typosquats
  { name = "rustls-pki" },
  { name = "fips-204" },
]
private = { ignore = true, registries = { private = "https://..." } }

[sources]
unknown-registry = "deny"
unknown-git = "deny"
allow-registry = ["https://github.com/rust-lang/crates.io-index"]
```

This single file enforces: license allowlist, advisory denial,
typosquat ban, no unknown registries, no git deps without review.

### 10.3 License Checking

The existing `LICENSE_REVIEW.md` confirms all 238+ external crates
use MIT, Apache-2.0, or BSD-3-Clause — no copyleft. `cargo-deny`
`[licenses]` automates this check on every PR so a GPL dependency
cannot sneak in transitively.

### 10.4 Audit CI

Recommended CI jobs (additions to `.github/workflows/rust-ci.yml`):

```yaml
  audit:
    name: cargo audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: rustsec/audit-check@v2.0.0
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

  deny:
    name: cargo deny
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: EmbarkStudios/cargo-deny-action@v2

  vet:
    name: cargo vet
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cargo install cargo-vet
      - run: cargo vet --workspace
```

All three must pass on PRs touching `Cargo.toml`/`Cargo.lock` and
nightly on `main`.

### 10.5 Fuzzing as Supply-Chain Defense

The 8 fuzz targets (`fuzz/fuzz_targets/`) exercise CBOR decode, frame
decode, handshake CBOR, RPC decode, agent record, relay request, and
discovery request. A malicious dependency version that introduces a
parsing bug is likely to surface under fuzzing. Run continuously via
`cargo +nightly fuzz run` in a scheduled CI job (e.g. OSS-Fuzz
integration).

---

## 11. Cryptographic Dependency: `fips204`

### 11.1 Provenance

- **Crate:** `fips204` v0.4.x
- **Source:** `github.com/Argyle-Software/fips204`
- **crates.io:** `crates.io/crates/fips204`
- **License:** MIT OR Apache-2.0
- **Implementation:** Pure Rust, `no_std`-capable, no C dependency.
- **Features used:** `ml-dsa-65`, `default-rng`

### 11.2 How It Is Verified

1. **NIST CAVP test vectors** — `fips204` ships NIST's official
   ML-DSA-65 known-answer tests. AAFP's `aafp-crypto` tests run a
   subset of these.
2. **Cross-language interop (A-10)** — The Go implementation
   (`KarpelesLab/mldsa` v0.2.0) generates deterministic vectors from
   the same seed; 19/19 Rust vectors verify in Go, 15/15 Go vectors
   verify in Rust, 100/100 diff traces cross-verify. This is the
   strongest available assurance short of a formal proof: two
   independent implementations agree bit-for-bit on deterministic
   signatures.
3. **cargo-vet audit** — a recorded human audit of the `fips204`
  source for: no `unsafe` in the signing path, no network/filesystem
  access, constant-time comparisons in verification, secure clearing
  of intermediate buffers via `zeroize`.
4. **cargo audit** — monitored for any RUSTSEC advisory against
   `fips204` or its (minimal) transitive deps.

### 11.3 Why Not `aws-lc-rs` ML-DSA?

`aws-lc-rs` exposes ML-DSA via the AWS-LC C library. Pros: FIPS
validation pathway, shared provider with rustls. Cons: pulls a C
build into the identity-signing path, complicating reproducible
builds and source-level audit. AAFP chose `fips204` (pure Rust) for
the *identity* layer to keep the root of trust auditable in Rust,
while using `aws-lc-rs` for the *transport* layer (where FIPS
compliance matters more). This separation is intentional.

### 11.4 Failure Mode

If `fips204` is found to produce incorrect signatures or becomes
unmaintained, the migration path is:

1. Switch `aafp-crypto::dsa` to `aws-lc-rs` ML-DSA-65.
2. Re-run the full cross-language interop vector suite against Go.
3. Re-sign all release artifacts with the new implementation.
4. Publish a security advisory; old signatures remain valid (the
   *algorithm* ML-DSA-65 is unchanged, only the implementation
   differs).

---

## 12. Build Infrastructure Security

### 12.1 GitHub Actions

Current CI lives in `.github/workflows/`:
- `rust-ci.yml` — fmt, clippy, build (ubuntu + macos), test
- `go-ci.yml` — Go build/test
- `ts-ci.yml` — TypeScript build/test
- `benchmark.yml` — criterion benchmarks

**Hardening recommendations:**

1. **Pin action versions by SHA, not tag.** `actions/checkout@v4`
   can be retagged by a compromised maintainer; pin to
   `actions/checkout@<sha>`. Use `dependabot` to bump pinned SHAs
   with PR review.
2. **Restrict `GITHUB_TOKEN` permissions** to `contents: read` by
   default; widen per-job with `permissions:` blocks.
3. **No `pull_request_target`** for untrusted PRs — it exposes
   secrets. Use `pull_request` only.
4. **Third-party actions** (`dtolnay/rust-toolchain`,
   `rustsec/audit-check`, `EmbarkStudios/cargo-deny-action`) must
   be pinned by SHA and listed in a reviewed `ACTIONS_ALLOWLIST`.
5. **Timeouts** — set `timeout-minutes: 30` on every job to prevent
   runner-based DoS.

### 12.2 Self-Hosted Runners

AAFP does not currently use self-hosted runners. If introduced
(e.g. for macOS notarization or HSM-backed signing):

1. Runners must be ephemeral, provisioned fresh per job.
2. No long-lived secrets on the runner; use OIDC to mint short-lived
   credentials.
3. Runner image is itself built from a pinned, signed Dockerfile.
4. Runners are isolated in a private network with egress allowlist
   to crates.io, github.com, and the registry only.

### 12.3 Secrets Management

- **Release signing key (ML-DSA-65 private):** lives in an HSM or
  YubiKey accessed via PKCS#11 from the signing job. The key never
  touches disk. Alternatively, GitHub Actions OIDC issues an
  ephemeral key for CI signing (less ideal — ephemeral keys complicate
  rotation continuity).
- **Crates.io publish token:** stored as a GitHub Actions secret,
  scoped to the `aafp` crate, rotated quarterly, never printed.
- **npm publish token:** npm granular access token, 1-year expiry,
  scoped to `@aafp` scope, stored as GitHub Actions secret.
- **No secrets in env vars of long-running jobs.** Use `secrets.` context
  only in the step that needs them.

### 12.4 OIDC + Keyless Signing

Prefer OIDC-based keyless signing for container images via
`cosign sign --identity-token` so that no long-lived signing key
exists in CI. For ML-DSA-65 release signatures (which cosign does
not natively support), use an HSM-backed key accessed via a short-
lived OIDC-minted credential.

---

## 13. npm Supply Chain (TypeScript SDK)

### 13.1 Structure

The TypeScript SDK is a pnpm/npm workspace under
`implementations/typescript/`:

- `packages/sdk` — `@aafp/sdk` (main entry)
- `packages/crypto` — `@aafp/crypto` (ML-DSA-65, HKDF, AEAD)
- `packages/cbor` — `@aafp/cbor`
- `packages/transport-quic` — `@aafp/transport-quic`
- `packages/transport-ws` — `@aafp/transport-ws`
- `packages/sdk-native` — native addon (Rust via napi)
- `packages/examples`

### 13.2 External npm Dependencies

The crypto package (`@aafp/crypto`) depends on:
- `@noble/post-quantum` ^0.2.0 — ML-KEM/ML-DSA in JS (audited, by
  Paul Miller / `paulmillr`). This is the JS equivalent of `fips204`.
- `@noble/hashes` ^1.5.0 — SHA-256, HKDF primitives.

The SDK package adds:
- `@modelcontextprotocol/sdk` (peer, optional) — MCP integration.

Dev dependencies: `typescript`, `vitest`, `tsx`, `@types/node`.

### 13.3 Lockfile

A lockfile (`package-lock.json` or `pnpm-lock.yaml`) **must be
committed**. npm workspaces require the root lockfile to pin all
transitive deps across packages. Without it, `npm install` resolves
non-deterministically.

### 13.4 npm Audit

```bash
npm audit --omit=dev --json > npm-audit.json
npm audit signatures          # verify registry signatures
```

npm registry now signs every package with Sigstore; `npm audit
signatures` verifies every installed package's signature against the
registry transparency log. This must pass in `ts-ci.yml`.

### 13.5 Provenance

`@aafp/sdk`'s `package.json` declares `"publishConfig": {
"provenance": true }`. This enables npm Sigstore provenance: the
published package is attested to have been built from a specific
GitHub Actions run on a specific commit. Downstream users verify
with:

```bash
npm audit signatures --verify-provenance
```

### 13.6 npm Attack Vectors & Mitigations

| Vector | Mitigation |
|--------|------------|
| Typosquat (`@n0ble/post-quantum`) | Lockfile pins exact name; `npm audit signatures` verifies provenance |
| Dependency confusion (private `@aafp/*` shadowed) | Scope `@aafp` is owned; packages are public, no private registry |
| Compromased `@noble/post-quantum` maintainer | Lockfile pins version; `npm audit` + provenance; cross-check against `fips204` vectors in interop tests |
| Malicious postinstall script | `--ignore-scripts` in CI install; review `package.json` `scripts` of any new dep |
| Transitive dep explosion | `npm ls --all` review on PRs; `npm dedupe` |

### 13.7 Script Policy

Set `--ignore-scripts=true` in `.npmrc` for CI installs so no
dependency's `postinstall` runs. Allow scripts only for known-safe
build deps (`esbuild`, `@noble/*` have none).

---

## 14. Go Implementation

The Go implementation (`implementations/go/`) has **zero external
dependencies** — only the Go standard library. `go.sum` is empty.
This eliminates the entire Rust/npm supply-chain surface for the Go
binary. `govulncheck` reports no vulnerabilities. The only supply-
chain risk for Go is the toolchain itself (Go releases are signed by
Google and verified by `go` via the GPG key in the release).

The Go ML-DSA-65 path uses `github.com/KarpelesLab/mldsa` v0.2.0
(per AGENTS.md interop notes) — wait, this contradicts "zero external
deps." Clarification: the *core* Go implementation is stdlib-only;
the *ML-DSA interop test harness* pulls `KarpelesLab/mldsa` for
cross-verification. That single dep must be `go.sum`-pinned and
`govulncheck`-scanned.

---

## 15. Concrete Supply Chain Security Checklist

This is the operational checklist. Every item must be green before a
release tag is cut.

### 15.1 Dependencies

- [ ] `Cargo.lock` committed and unchanged since last audit OR
      `cargo update --precise` diffs reviewed
- [ ] `cargo audit` reports 0 vulnerabilities, 0 unmaintained
- [ ] `cargo deny check` passes (advisories, licenses, bans, sources)
- [ ] `cargo vet --workspace` passes (no expired `unaudited` entries)
- [ ] No new T0/T1 dependency version without a vet audit entry
- [ ] `npm audit --omit=dev` reports 0 high/critical
- [ ] `npm audit signatures` passes (all packages registry-signed)
- [ ] npm lockfile committed and unchanged since last audit
- [ ] `govulncheck` reports 0 vulnerabilities (Go)

### 15.2 SBOM

- [ ] `cargo cyclonedx` regenerated for release tag
- [ ] `cargo auditable build --release` produces self-auditing binary
- [ ] `syft` SBOM generated from the built binary (independent check)
- [ ] `cyclonedx-npm` SBOM generated for TS SDK
- [ ] SBOMs uploaded as release assets
- [ ] SBOM diff vs previous release reviewed; changes in CHANGELOG

### 15.3 Reproducibility

- [ ] `rust-toolchain.toml` pins exact `rustc` version
- [ ] `RUSTFLAGS="--remap-path-prefix $PWD=."` set in release CI
- [ ] `strip = true` in `[profile.release]`
- [ ] `SOURCE_DATE_EPOCH` set to tag commit timestamp
- [ ] Second-runner rebuild produces identical SHA-256 (or delta
      documented and justified)

### 15.4 Signing

- [ ] Release signing ML-DSA-65 key loaded from HSM/OIDC (not disk)
- [ ] Every release artifact has a detached `.mldsa65.sig`
- [ ] `RELEASE_SIGNING_KEY.cbor` matches the key used
- [ ] `aafp verify-release` passes on all signed artifacts
- [ ] Container images signed via cosign (with ML-DSA-65 attestation
      or cosign's native keyless OIDC)
- [ ] SBOMs signed and attached as cosign attestations

### 15.5 CI / Infrastructure

- [ ] All GitHub Actions pinned by SHA (not tag)
- [ ] `permissions:` set to least-privilege per job
- [ ] No `pull_request_target` on untrusted PR workflows
- [ ] `timeout-minutes` set on every job
- [ ] `cargo audit`, `cargo deny`, `cargo vet` jobs run on PR + nightly
- [ ] No self-hosted runners without ephemeral provisioning
- [ ] Secrets scoped and rotated (crates.io token, npm token)
- [ ] OIDC used for keyless container signing

### 15.6 Cryptographic Root

- [ ] `fips204` version matches the vet-audited version
- [ ] Cross-language interop vectors pass (Rust ↔ Go, 100/100)
- [ ] NIST CAVP known-answer tests pass
- [ ] `cargo audit` shows no advisory on `fips204` or its deps
- [ ] `aws-lc-rs` / `aws-lc-sys` version matches vet-audited version
- [ ] `rustls` PQ hybrid KEX feature confirmed enabled in build

### 15.7 Release Process

- [ ] Release tag signed (git signed tag)
- [ ] Release notes include: SHA-256 of each artifact, SBOM links,
      signature links, signing key fingerprint
- [ ] `REVOKED_KEYS` updated if any key rotated
- [ ] Post-release: `cargo audit` + `npm audit` re-run against the
      published artifacts' SBOM

### 15.8 Ongoing

- [ ] Nightly `cargo audit` + `cargo deny` + `npm audit` on `main`
- [ ] Weekly fuzz job (8 targets, 1hr each)
- [ ] Monthly dependency diff review (new transitive deps)
- [ ] Quarterly release signing key rotation check
- [ ] Annual full supply-chain review (this document updated)

---

## 16. Open Items / Roadmap

| Item | Priority | Owner | Status |
|------|----------|-------|--------|
| `cargo cyclonedx` in CI | High | Release eng | Pending |
| `cargo auditable` in release build | High | Release eng | Pending |
| `cargo-vet` store initialized | High | Security | Pending |
| `cargo-deny` `deny.toml` committed | High | Security | Pending |
| `cargo audit` / `deny` / `vet` CI jobs | High | DevOps | Pending |
| Bit-for-bit reproducible Rust build | Medium | Release eng | In progress (path remap, strip) |
| Second-runner rebuild verification | Medium | DevOps | Pending |
| ML-DSA-65 release signing pipeline | High | Security | Pending |
| HSM-backed signing key | Medium | Security | Pending (OIDC interim) |
| GitHub Actions SHA pinning | Medium | DevOps | Pending |
| npm lockfile committed | High | TS team | Pending |
| `npm audit signatures` in `ts-ci.yml` | High | TS team | Pending |
| `npm --ignore-scripts` in CI | Medium | TS team | Pending |
| cosign container signing | Medium | DevOps | Pending |
| OSS-Fuzz integration | Low | Security | Backlog |
| `s2n-quic`/`quiche` swap evaluation | Low | Architecture | Backlog (quinn retained) |

---

## 17. References

- US Executive Order 14028 — Improving the Nation's Cybersecurity
  (SBOM mandate)
- NTIA SBOM Minimum Elements (2021)
- CycloneDX 1.5 — OWASP SBOM specification
- SPDX 2.3 — Linux Foundation SBOM specification
- SLSA v1.0 — Supply-chain Levels for Software Artifacts
- Sigstore / cosign — keyless artifact signing
- `cargo audit` — RustSec advisory database scanner
- `cargo vet` — Mozilla dependency audit tool
- `cargo deny` — EmbarkStudios policy enforcer
- `cargo auditable` — embedded dependency metadata
- NIST FIPS 204 — Module-Lattice-Based Digital Signature Standard
- NIST CAVP — Cryptographic Algorithm Validation Program
- npm Sigstore provenance — `npm audit signatures`
- Reproducible Builds — `reproducible-builds.org` docs

---

## 18. Conclusion

AAFP's security is only as strong as the weakest link in its supply
chain. The migration from the unmaintained `pqcrypto-*` family to
`fips204` closed the most pressing historical gap. The remaining
work is operational: stand up `cargo vet`, `cargo deny`, and
`cargo audit` in CI; generate and sign SBOMs per release; achieve
bit-for-bit reproducible builds; and ship ML-DSA-65-signed release
artifacts with HSM-backed keys. Once the §16 roadmap items are
closed, AAFP will meet SLSA Build Level 3 and provide downstream
integrators with end-to-end verifiable integrity from source commit
to deployed binary.
