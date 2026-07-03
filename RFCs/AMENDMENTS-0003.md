# Amendment to RFC-0003: Revocation Mechanism

**Status:** Proposed
**Date:** 2026-07-02

## Summary

Adds a CRL-based revocation mechanism for AAFP agent identities. This
addresses the gap documented in RFC-0003 §5 and AMENDMENTS-0001 §C3.

## Problem

Currently, if an agent's ML-DSA-65 private key is compromised, there is
no way to revoke the associated AgentId. A compromised key can be used
indefinitely to authenticate new connections.

## Design

### CRL (Certificate Revocation List)

A CRL is a CBOR-encoded signed list of revoked AgentIds. It is signed by
the agent that owns the revoked key (self-revocation) or by a trusted
revocation authority (future work).

### Self-Revocation (v1)

An agent whose key is compromised can sign a revocation statement with
the compromised key (if they still have it) or with a new key that
references the old AgentId.

### Distribution

CRLs are distributed via:
- Discovery (published as a capability: `aafp.revocation.crl`)
- Direct exchange during handshake (optional extension)
- Out-of-band (published to a known location)

### Checking

During the AAFP handshake, after identity verification, the peer checks
the connecting agent's AgentId against known CRLs. If the AgentId is
revoked, the connection is rejected with ERROR 2002 (Expired or revoked
identity).

## Wire Format

### Revocation Entry (CBOR map)

```cbor
{
    1: bstr,   // agent_id: The revoked AgentId (32 bytes)
    2: uint,   // revoked_at: Unix timestamp
    3: tstr,   // reason: Optional — "compromised", "rotated", etc.
    4: bstr,   // revoking_key_id: AgentId of the revoking key (32 bytes)
    5: bstr,   // signature: ML-DSA-65 signature over fields 1-4
}
```

### Revocation List (CBOR map)

```cbor
{
    1: array,  // entries: Array of revocation entries
    2: uint,   // generated_at: Unix timestamp when CRL was generated
    3: uint,   // expires_at: Unix timestamp when CRL expires
}
```

## Verification

1. During handshake, after identity verification, check AgentId against
   the local RevocationStore.
2. If revoked: send ERROR 2002, close connection.
3. CRL signature verified with the revoking key (self-revocation or
   authority).

## Security Considerations

- **Self-revocation paradox:** If the key is compromised, the attacker
  can also sign revocations. Self-revocation is still valuable because
  it lets the legitimate owner revoke the key. A future delegation-based
  revocation (with a trusted authority) would be more secure.
- **CRL freshness:** Stale CRLs mean revoked agents can still connect.
  Short TTL (default 1 hour) and periodic refresh via discovery mitigate
  this.
- **CRL scaling:** In large networks, CRLs could be large. Delta-CRLs
  (only new revocations since last CRL) are documented as future work.
