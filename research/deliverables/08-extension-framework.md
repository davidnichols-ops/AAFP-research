# Deliverable 8: Extension Framework Specification

```
Deliverable:    8 of 12
Title:          Extension Framework Specification
Status:         Complete
Date:           2026-07-01
Source:         Phase 11 (Extension Framework Design)
```

## Extension Identification

```
Official:      aafp:<name>:<version>
Experimental:  aafp:experimental:<name>:<version>
Vendor:        aafp:vendor:<vendor>:<name>:<version>
```

## Extension Negotiation

1. **Client proposes** extensions in `ClientHello.extensions`
2. **Server selects** accepted extensions in `ServerHello.extensions`
3. **Silent rejection**: Omitted = not supported; client falls back to core
4. **Mandatory**: `required: true` + server rejects = error
5. **No mid-session changes**: Negotiated once during handshake

## Extension Types

| Type | Examples |
|------|----------|
| Security | Ratchet, group encryption, padding |
| Transport | TCP fallback, WebSocket |
| Session | Resumption, migration |
| Interop | A2A binding, MCP transport |
| Application | Task lifecycle, streaming RPC |
| Discovery | Reputation, geo-aware |

## Frame Extension Data

Extensions needing per-frame data use the frame's Extension Length field:

```cbor
FrameExtension = {1: tstr (extension ID), 2: Value (extension data)}
```

Multiple extensions: `[FrameExtension_1, FrameExtension_2, ...]`

## Governance Model

| Tier | ID Format | Requirements |
|------|-----------|-------------|
| Official | `aafp:<name>:<version>` | RFC + reference implementation |
| Experimental | `aafp:experimental:<name>:<version>` | Proposal document |
| Vendor | `aafp:vendor:<vendor>:<name>:<version>` | Vendor-specific |

**Lifecycle**: Proposal -> Experimental -> Reference Implementation -> RFC -> Official

## Priority Extensions

| Extension | Priority | Type |
|-----------|----------|------|
| `aafp:ratchet:1` | P0 | Security |
| `aafp:session-resume:1` | P1 | Session |
| `aafp:tcp-transport:1` | P0 | Transport |
| `aafp:key-rotation:1` | P0 | Security |
| `aafp:revocation:1` | P1 | Security |
| `aafp:a2a-bridge:1` | P1 | Interop |
| `aafp:mcp-transport:1` | P1 | Interop |
| `aafp:sponsor:1` | P2 | Identity |
| `aafp:did-method:1` | P2 | Identity |
| `aafp:group-messaging:1` | P3 | Security |
| `aafp:streaming-rpc:1` | P2 | Application |
| `aafp:policy-engine:1` | P2 | Application |

## Extension RFC Template

```markdown
# RFC-XXXX: Extension Name

## 1. Extension ID
## 2. Type
## 3. Purpose
## 4. Negotiation (ClientHello/ServerHello fields)
## 5. Frame Data (per-frame extension data)
## 6. State (extension-specific state)
## 7. Security Analysis
## 8. Compatibility (backward compatibility, fallback)
## 9. Reference Implementation
## 10. Test Vectors
```
