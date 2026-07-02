# ADR-0004: Interoperability is prioritized over protocol replacement

## Status

Accepted

## Context

AAFP enters a landscape where MCP and A2A are established protocols with
existing SDKs, tooling, and ecosystems. A strategic question arises:

1. **Replace existing protocols**: Position AAFP as a competing application
   protocol. Users would migrate from MCP/A2A to AAFP's native methods.
   This requires building a full application protocol ecosystem (methods,
   SDKs, tooling, conformance tests).

2. **Interoperate with existing protocols**: Position AAFP as a secure
   transport that carries MCP and A2A messages. Users keep their existing
   MCP/A2A SDKs and add an AAFP transport adapter. AAFP provides security
   (PQ TLS, ML-DSA-65 identity) without requiring application-level
   migration.

3. **Both**: Define AAFP's native application methods AND provide transport
   bindings for MCP/A2A. Users can choose.

The choice affects adoption strategy, development priorities, and the
project's relationship with the MCP and A2A ecosystems.

## Decision

**Interoperability is prioritized over protocol replacement.**

AAFP's primary value proposition is transport security:
- Post-quantum TLS (X25519MLKEM768)
- ML-DSA-65 agent identity verification
- QUIC transport with NAT traversal
- Length-delimited framing

AAFP does not compete with MCP or A2A at the application layer. Instead,
it provides a secure transport that carries MCP and A2A messages. Users
adopt AAFP by adding a transport adapter to their existing MCP/A2A
application — no application-level migration required.

The development priority order reflects this:
1. MCP transport binding (RFC-0007) — **implemented**
2. A2A transport binding (RFC-0008) — **designed**
3. Cross-SDK interoperability testing — **planned**
4. Official conformance testing — **planned**

## Consequences

**What becomes easier:**
- Users can adopt AAFP without rewriting their application logic
- AAFP benefits from the existing MCP/A2A ecosystems (SDKs, tooling,
  community)
- AAFP's scope is smaller (transport + security, not full application
  protocol)
- AAFP can support both MCP and A2A without choosing sides
- The project can focus on what AAFP does best: secure transport

**What becomes harder:**
- AAFP's adoption depends on MCP/A2A SDKs supporting custom transports
- Cross-SDK interoperability testing requires implementing AAFP adapters
  in multiple languages (Python, TypeScript, Go)
- AAFP cannot provide a "batteries-included" experience — users need both
  AAFP and an application protocol
- The value proposition is subtle: "secure transport for MCP" vs. "a new
  protocol that does everything"

**Risks:**
- MCP or A2A may add built-in post-quantum security, reducing AAFP's
  differentiation. Mitigation: AAFP's ML-DSA-65 agent identity is a
  distinct feature that HTTP/TLS cannot provide.
- The MCP/A2A ecosystems may not adopt custom transports widely.
  Mitigation: the rmcp SDK's `Transport<R>` trait makes custom transports
  straightforward in Rust; Python and TypeScript SDKs have similar
  extension points.
- AAFP may be perceived as "just a transport library" rather than a
  protocol. Mitigation: the RFCs and ADRs document the full protocol
  design (framing, handshake, session management) that goes beyond a
  simple transport library.

**Relationship to ADR-0001:**
This ADR is the strategic expression of ADR-0001. If AAFP is a session
layer (not an application protocol), then interoperability with existing
application protocols is the natural adoption strategy.
