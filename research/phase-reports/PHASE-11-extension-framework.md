# Phase 11: Extension Framework Design

```
Phase:          11 of 16
Title:          Extension Framework Design
Status:         Complete
Date:           2026-07-01
Researchers:    Devin (autonomous)
```

## 1. Objective

Examine how AAFP can evolve without breaking compatibility. Compare
extension models across the ecosystem. Design an extension framework
that enables AAFP to add features (group messaging, ratchet, session
resumption, interop adapters) without forking the protocol.

## 2. Ecosystem Extension Models

### 2.1 A2A Extension Model

- **URI-identified**: `https://a2a-protocol.org/extensions/<name>/v1`
- **Two-tier governance**: Official (`ext-*`) and Experimental (`experimental-ext-*`)
- **Lifecycle**: Proposal -> Sponsorship -> Experimental -> TSC vote -> Official
- **Declaration**: In Agent Card `capabilities.extensions`
- **Activation**: Client requests via `A2A-Extensions` HTTP header
- **Types**: Data-only, Profile, Method, State Machine
- **Constraints**: Cannot modify core data structures or add enum values

### 2.2 MCP Extension Model (SEP-2133)

- **URI-identified**: `{vendor-prefix}/{extension-name}`
- **Vendor prefix**: Reversed domain (e.g., `io.modelcontextprotocol/`)
- **Types**: Official, Experimental, Unofficial
- **Declaration**: In `extensions` field of capabilities
- **Negotiation**: Advertised in capabilities; revert to core if unsupported
- **Constraints**: Breaking changes require new identifier

### 2.3 SLIM Extension Model

- **MLS extensions**: Via `ExtensionList` in MLS protocol (RFC 9420)
- **Application metadata**: Custom key-value pairs in session config
- **Limited**: No general-purpose application extension pipeline

### 2.4 AgentMesh Extension Model

- **Framework Adapter Contract**: Abstract class for framework integration
- **10+ adapters**: LangChain, CrewAI, AutoGen, OpenAI, etc.
- **Protocol bridges**: A2A, MCP, IATP adapters
- **Custom policy backends**: OPA, Cedar, custom adapters

### 2.5 AAFP's Current Extension Points

AAFP has several built-in extension points:

1. **Frame extensions**: 28-byte frame header has `Extension Length` field
   (8 bytes). Up to 64 KiB of extension data per frame. Extensions are
   placed before the payload.

2. **Handshake extensions**: `ClientHello` and `ServerHello` have
   `extensions: Vec<Value>` fields. These are negotiated during handshake.

3. **Capabilities**: `AgentRecord` has `capabilities: Vec<CapabilityDescriptor>`.
   These describe what an agent can do.

4. **Version negotiation**: `protocol_version` field in ClientHello/ServerHello.

5. **Key algorithm negotiation**: `key_algorithm` field (currently only
   ML-DSA-65 = 1, but extensible to future algorithms).

**What's missing**: A formal extension governance model (like A2A's
two-tier system) and a registry of known extensions.

## 3. AAFP Extension Framework Design

### 3.1 Extension Identification

```
Extension ID: aafp:<name>:<version>
Examples:
    aafp:ratchet:1
    aafp:session-resume:1
    aafp:group-messaging:1
    aafp:a2a-bridge:1
    aafp:tcp-transport:1
```

- `aafp` prefix for official extensions
- `aafp:experimental:<name>:<version>` for experimental
- Third-party: `aafp:vendor:<vendor>:<name>:<version>`

### 3.2 Extension Declaration

Extensions are declared in handshake:

```cbor
ClientHello.extensions = [
    {1: "aafp:ratchet:1", 2: {1: true}},  // ratchet enabled
    {1: "aafp:session-resume:1", 2: {1: <ticket>}},
]
```

Server responds with supported extensions in ServerHello:
```cbor
ServerHello.extensions = [
    {1: "aafp:ratchet:1", 2: {1: true}},  // ratchet accepted
    // session-resume not included = not supported
]
```

### 3.3 Extension Negotiation Rules

1. **Client proposes**: Client lists desired extensions in ClientHello
2. **Server selects**: Server lists accepted extensions in ServerHello
3. **Silent rejection**: If server doesn't include an extension, it's
   not active. Client MUST fall back to core behavior.
4. **Mandatory extensions**: If client marks extension as `required: true`
   and server doesn't support it, server MUST reject with error code
   for "unsupported required extension."
5. **No mid-session changes**: Extensions are negotiated once during
   handshake. They cannot be added or removed mid-session.

### 3.4 Extension Types

| Type | Description | Example |
|------|-------------|---------|
| **Security** | Crypto enhancements | Ratchet, group encryption |
| **Transport** | Transport alternatives | TCP fallback, WebSocket |
| **Session** | Session management | Resumption, migration |
| **Interop** | Protocol bridges | A2A binding, MCP transport |
| **Application** | App-layer features | Task lifecycle, streaming RPC |
| **Discovery** | Discovery enhancements | Reputation scoring, geo-aware |

### 3.5 Frame Extension Data

Extensions that need per-frame data use the frame's Extension Length
field. The extension data is CBOR-encoded:

```cbor
FrameExtension = {
    1: tstr,       // extension ID
    2: Value,      // extension-specific data
}
```

Multiple extensions can be stacked:
```cbor
[FrameExtension_1, FrameExtension_2, ...]
```

### 3.6 Extension Governance

**Two-tier model** (adapted from A2A):

1. **Official extensions** (`aafp:<name>:<version>`):
   - Specified in an RFC
   - Reference implementation in aafp-* crates
   - Backward-compatible with core protocol
   - Approved by AAFP project maintainers

2. **Experimental extensions** (`aafp:experimental:<name>:<version>`):
   - Documented in a proposal
   - May not have reference implementation
   - May be unstable
   - For testing and iteration

3. **Vendor extensions** (`aafp:vendor:<vendor>:<name>:<version>`):
   - Vendor-specific
   - Not standardized
   - Must not conflict with official extensions

**Lifecycle**: Proposal -> Experimental -> Reference Implementation ->
RFC -> Official

## 4. Priority Extensions

Based on gaps identified in Phases 5-10:

| Extension | Priority | Phase Reference | Complexity |
|-----------|----------|-----------------|------------|
| `aafp:ratchet:1` | High | Phase 10 (PCS) | Low-Medium |
| `aafp:session-resume:1` | High | Phase 10 (resumption) | Medium |
| `aafp:tcp-transport:1` | High | Phase 8 (firewall) | Medium |
| `aafp:key-rotation:1` | Medium | Phase 6 (key rotation) | Medium |
| `aafp:revocation:1` | Medium | Phase 6 (revocation) | Medium |
| `aafp:sponsor:1` | Medium | Phase 8 (enterprise) | Low |
| `aafp:a2a-bridge:1` | Medium | Phase 4 (interop) | High |
| `aafp:mcp-transport:1` | Medium | Phase 4 (interop) | High |
| `aafp:did-method:1` | Low | Phase 6 (DID interop) | Medium |
| `aafp:group-messaging:1` | Low (future) | Phase 10 (groups) | High |
| `aafp:streaming-rpc:1` | Low | Phase 3 (RPC gap) | Medium |
| `aafp:policy-engine:1` | Low | Phase 8 (governance) | Low |

## 5. Version Negotiation

### 5.1 Current Model

AAFP uses a single `protocol_version` field (u64) in ClientHello and
ServerHello. Currently version 1.

### 5.2 Future Versioning

When AAFP v2 is needed (breaking changes):

1. Client sends `protocol_version: 2` in ClientHello
2. Server responds with `protocol_version: 2` if supported
3. If server only supports v1, it responds with `protocol_version: 1`
4. Client can either accept v1 or abort

**Rules**:
- Major version changes can break wire format
- Minor changes MUST use extensions, not version bumps
- Servers SHOULD support at least 2 major versions for transition
- Version negotiation happens before extension negotiation

### 5.3 Key Algorithm Negotiation

The `key_algorithm` field allows future signature algorithms:

| Value | Algorithm | Status |
|-------|-----------|--------|
| 1 | ML-DSA-65 (FIPS 204) | Current |
| 2 | (reserved) | Future |
| 3 | (reserved) | Future |

Future algorithms might include:
- SLH-DSA (FIPS 205, stateless hash-based)
- Falcon (if standardized)
- Future NIST PQ signatures

**Rule**: New key algorithms require a new RFC. The handshake structure
remains the same; only the signature/verification operations change.

## 6. Comparison with A2A Extension Governance

| Property | AAFP (proposed) | A2A |
|----------|-----------------|-----|
| ID format | `aafp:<name>:<version>` | URI |
| Tiers | Official, Experimental, Vendor | Official, Experimental |
| Approval | AAFP maintainers | TSC vote |
| Reference impl | Required for Official | Required for Official |
| License | (TBD) | Apache 2.0 required |
| Breaking changes | New version number | New URI |
| Mid-session | Not allowed | Not allowed |

**Recommendation**: Adopt a governance model similar to A2A's, but
simpler. AAFP is a smaller project; a full TSC is not yet warranted.
Maintainer approval + RFC + reference implementation is sufficient.

## 7. Extension Specification Template

Each extension RFC should follow this template:

```markdown
# RFC-XXXX: Extension Name

## 1. Extension ID
aafp:<name>:<version>

## 2. Type
Security | Transport | Session | Interop | Application | Discovery

## 3. Purpose
What problem does this extension solve?

## 4. Negotiation
How is it declared in ClientHello/ServerHello?

## 5. Frame Data
What per-frame data does it add? (if any)

## 6. State
What state does it maintain? (if any)

## 7. Security Analysis
What security properties does it add/change?

## 8. Compatibility
Is it backward-compatible? What happens if unsupported?

## 9. Reference Implementation
Where is the reference implementation?

## 10. Test Vectors
Conformance test vectors.
```

## 8. Transition to Phase 12

Phase 12 (Threat Model V2) will update AAFP's threat model in the
context of the ecosystem, considering new attack surfaces (interop
bridges, enterprise deployments, group messaging) and the security
properties of proposed extensions.
