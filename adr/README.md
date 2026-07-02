# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the AAFP
project. ADRs capture the *why* behind architectural decisions — the
context, the decision, and the consequences. They are distinct from RFCs,
which define *what* the protocol does.

## ADR Index

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-0001](0001-aafp-is-session-layer.md) | AAFP is a secure session layer, not an application protocol | Accepted |
| [ADR-0002](0002-preserve-application-payloads.md) | Transport bindings preserve application payloads | Accepted |
| [ADR-0003](0003-mcp-uses-data-frames.md) | MCP uses DATA frames rather than native AAFP RPC | Accepted |
| [ADR-0004](0004-interoperability-over-replacement.md) | Interoperability is prioritized over protocol replacement | Accepted |

## When to Write an ADR

Write an ADR when you make a decision that:
- Affects the architectural layering of the protocol
- Constrains future design choices
- Has trade-offs that future maintainers need to understand
- Is not obvious from reading the code or RFCs

## ADR Format

Each ADR follows this format:

```
# ADR-NNNN: Title

## Status
Accepted | Proposed | Deprecated | Superseded by ADR-XXXX

## Context
What is the problem being addressed? What constraints exist?
What alternatives were considered?

## Decision
What was decided? What is the chosen approach?

## Consequences
What are the implications? What becomes easier? What becomes harder?
What risks remain?
```
