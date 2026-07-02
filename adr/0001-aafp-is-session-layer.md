# ADR-0001: AAFP is a secure session layer, not an application protocol

## Status

Accepted

## Context

AAFP was designed in a landscape with two dominant agent communication
protocols:

- **MCP** (Model Context Protocol): agent-to-tool communication via
  JSON-RPC 2.0, with methods like `tools/list`, `tools/call`,
  `resources/read`.
- **A2A** (Agent2Agent Protocol): agent-to-agent communication via
  JSON-RPC 2.0, with methods like `SendMessage`, `GetTask`,
  `SubscribeToTask`.

Both protocols define their own application semantics, message formats,
and method vocabularies. Both already have SDKs in multiple languages.

A key design question was: should AAFP define its own application protocol
(methods for tool calling, task management, etc.), or should it focus on
being a transport layer that carries existing application protocols?

**Alternatives considered:**

1. **AAFP as application protocol**: Define AAFP-specific methods for tool
   calling, task management, etc. Applications would use AAFP's method
   vocabulary instead of MCP's or A2A's.

2. **AAFP as session layer only**: AAFP handles identity, authentication,
   framing, and transport. Application protocols (MCP, A2A) run on top of
   AAFP and own their message semantics.

3. **Hybrid**: AAFP defines a minimal application protocol for
   AAFP-specific operations (discovery, relay management) but carries
   external application protocols (MCP, A2A) as opaque payloads.

## Decision

**AAFP is a secure session layer, not an application protocol.**

AAFP's responsibilities are:
- Cryptographic agent identity (ML-DSA-65)
- Post-quantum transport security (X25519MLKEM768)
- Length-delimited message framing (28-byte header + opaque payload)
- Session lifecycle (handshake, close, error)
- Optional native RPC (CBOR-encoded RPC_REQUEST/RPC_RESPONSE frames)

AAFP does NOT define:
- Application-level methods (no `tools/call`, no `SendMessage`)
- Application message semantics
- Application state management

Application protocols (MCP, A2A) run on top of AAFP as transport bindings.
They own their message formats, method vocabularies, and semantics.

The hybrid approach (option 3) is effectively what we have: AAFP's native
RPC frames exist for AAFP-internal operations but are not used by
application protocols. Application protocols use DATA frames, which carry
opaque payloads.

## Consequences

**What becomes easier:**
- AAFP does not compete with MCP or A2A — it complements them
- Application protocol evolution is independent of AAFP evolution
- Existing application SDKs (rmcp, Python MCP SDK, etc.) can be adapted
  with a thin transport binding
- AAFP can support multiple application protocols simultaneously
- No need to maintain application-level method definitions

**What becomes harder:**
- AAFP cannot provide application-level features (e.g., tool discovery
  semantics, task state machines) — those belong to the application protocol
- Users must choose an application protocol (MCP, A2A, or custom) to run
  on top of AAFP
- AAFP's value proposition is transport security, not application features

**Risks:**
- Users may be confused about what AAFP provides vs. what MCP/A2A provides
- Documentation must clearly delineate the layers
- AAFP may be perceived as "just a transport" rather than a full protocol

**Mitigation:** The layered architecture is documented in the crate-level
docs, the compatibility analysis, and the RFCs. The ADRs make the design
intent explicit and durable.
