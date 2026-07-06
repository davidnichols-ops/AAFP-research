# AAFP Agent Testing & Quality Assurance

**Author:** Devin (research synthesis)
**Date:** 2026-07-04
**Status:** Reference design — Phase 4 (World Perception Layer) companion
**Depends on:** `AGENT_RECORD_EXTENSIONS.md`, `RFCs/0006-versioning-compatibility.md`,
`STREAMING_RPC_DESIGN.md`, `SESSION_AFFINITY_DESIGN.md`,
`real-world/LLM_AGENT_INTEGRATION.md`, `real-world/PRODUCTION_DEPLOYMENT.md`

---

## Executive Summary

An AAFP agent is not a library function — it is an autonomous network peer
that advertises capabilities, signs its own identity record, opens
multiplexed streams, streams tokens, delegates tool calls, and participates
in fallback chains. Testing a single function is not enough. AAFP requires a
**layered testing strategy** that validates an agent at five levels — unit,
integration, contract, conformance, and end-to-end — plus three
cross-cutting dimensions: behavior, performance, and security.

This document specifies the complete testing and quality-assurance
architecture for AAFP agents. It defines the `aafp-test-mock` crate for
configurable mock agents, the capability conformance suite that any agent
must pass to be certified, the bronze/silver/gold certification tiers, the
test fixtures (pre-generated keypairs, test DHT, local relay, mock LLM
responses), and the CI integration that runs the conformance suite on every
agent pull request. Concrete test framework designs are given in both Rust
and Python so that implementers in either ecosystem can adopt them
verbatim.

**Key conclusion:** Agent quality is a *network property*, not a *binary
property*. An agent that passes unit tests but fails conformance is a
network hazard — it will corrupt fallback chains, poison capability
graphs, and break streaming backpressure. Certification is therefore
mandatory and tiered: bronze (basic conformance), silver (streaming +
pooling), gold (full v2).

---

## 1. Why Agent Testing Is Different from Library Testing

### 1.1 The Agent as a Network Peer

A library is tested by calling its functions and checking return values. An
AAFP agent is tested by *connecting to it over the wire* and observing its
frame-level behavior. The differences are structural:

| Property | Library | AAFP Agent |
|---|---|---|
| Interface | Function signature | Wire protocol + capability advertisement |
| Identity | None | Self-signed `AgentRecord` (ML-DSA-65) |
| Discovery | Import path | DHT lookup by `AgentId` |
| Concurrency | Caller controls | Multiplexed streams, concurrent requests |
| Failure mode | Exception/return code | `HandlerError` category, CLOSE frame, or hang |
| State | Stateless or caller-managed | Session affinity, replay cache, record version |
| Compatibility | Semver | Protocol version negotiation (RFC-0006) |

A library that returns the wrong value is a bug. An agent that sends the
wrong frame at the wrong time is a **protocol violation** that can desync
the peer's state machine, leak stream IDs, or cause a cascade of timeouts
across a fallback chain.

### 1.2 The Five Failure Classes

Agent testing must cover five distinct failure classes:

1. **Logic errors** — the agent computes the wrong answer (classic unit
   test target).
2. **Protocol errors** — the agent emits a malformed frame, violates
   pipeline ordering, or mishandles version negotiation (conformance
   target).
3. **Contract errors** — the agent advertises a capability it does not
   correctly implement (contract + capability conformance target).
4. **Interaction errors** — two agents that each pass conformance
   individually fail when composed (integration + E2E target).
5. **Degradation errors** — the agent works correctly but too slowly,
   leaks memory, or collapses under load (performance target).

No single test level catches all five. The layered strategy in §3 is
designed so that each class has a dedicated level.

---

## 2. Testing Levels Overview

```
┌─────────────────────────────────────────────────────────────┐
│ E2E: multi-agent workflow (orchestrator + 3 agents + relay) │  ← slowest, fewest
├─────────────────────────────────────────────────────────────┤
│ Integration: agent-to-agent (real wire, two live agents)    │
├─────────────────────────────────────────────────────────────┤
│ Contract: agent vs. published capability schema             │
├─────────────────────────────────────────────────────────────┤
│ Conformance: agent vs. RFC normative requirements           │
├─────────────────────────────────────────────────────────────┤
│ Unit: handler logic (pure functions, no I/O)                │  ← fastest, most
└─────────────────────────────────────────────────────────────┘
```

Each level has a distinct scope, speed, and ownership. Levels are
additive: passing unit tests does not exempt an agent from conformance;
passing conformance does not exempt it from integration.

---

## 3. Agent Testing Levels

### 3.1 Unit Testing (Handler Logic)

**Scope:** Pure functions inside an agent's handler pipeline — request
decoding, capability routing, response encoding, error mapping, cost
computation. No network I/O, no DHT, no signatures over the wire.

**Speed target:** < 10 ms per test, thousands of tests in seconds.

**What to test at this level:**

- CBOR decode/encode of request and response payloads (round-trip
  equality, canonical encoding).
- Capability dispatch: given a request with `capability = "text-generation"`,
  the router selects the correct handler.
- `HandlerError` mapping: each internal error maps to the correct
  RFC-0005 category code (`u8`).
- Cost computation: `input_tokens * input_price + output_tokens *
  output_price` matches expected values.
- Stream-ID allocation: the allocator returns monotonic, non-overlapping
  IDs.
- Replay cache: a replayed `record_version` is rejected; a newer version
  is accepted.

**Rust example:**

```rust
// crates/my-agent/tests/unit_handler.rs
use aafp_protocol::{Frame, FrameType, HandlerError, Category};
use my_agent::handler::TextGenerationHandler;
use my_agent::types::{GenRequest, GenResponse};

#[test]
fn text_generation_handler_returns_canonical_cbor() {
    let req = GenRequest {
        prompt: "Hello".into(),
        max_tokens: 16,
        temperature: 0.0,
    };
    let handler = TextGenerationHandler::new(MockModel::echo());
    let resp: GenResponse = handler.handle(req).unwrap();
    let encoded = serde_cbor::to_vec(&resp).unwrap();
    let decoded: GenResponse = serde_cbor::from_slice(&encoded).unwrap();
    assert_eq!(resp, decoded);           // round-trip
    assert_eq!(resp.tokens.len(), 1);
}

#[test]
fn oversized_prompt_maps_to_invalid_request() {
    let req = GenRequest {
        prompt: "x".repeat(1_000_000),   // exceeds context window
        max_tokens: 16,
        temperature: 0.0,
    };
    let handler = TextGenerationHandler::new(MockModel::echo());
    let err = handler.handle(req).unwrap_err();
    assert_eq!(err.category, Category::InvalidRequest);
    assert_eq!(err.code, 4001);
}
```

**Python example:**

```python
# tests/unit/test_handler.py
import pytest
from my_agent.handler import TextGenerationHandler
from my_agent.types import GenRequest, GenResponse
from my_agent.errors import HandlerError, Category
from tests.helpers import EchoModel


def test_text_generation_round_trip():
    handler = TextGenerationHandler(EchoModel())
    req = GenRequest(prompt="Hello", max_tokens=16, temperature=0.0)
    resp = handler.handle(req)
    assert resp.tokens == ["Hello"]
    # CBOR round-trip via the SDK
    encoded = resp.encode_cbor()
    assert GenResponse.decode_cbor(encoded) == resp


def test_oversized_prompt_maps_to_invalid_request():
    handler = TextGenerationHandler(EchoModel())
    req = GenRequest(prompt="x" * 1_000_000, max_tokens=16, temperature=0.0)
    with pytest.raises(HandlerError) as exc:
        handler.handle(req)
    assert exc.value.category == Category.INVALID_REQUEST
    assert exc.value.code == 4001
```

**Anti-pattern:** Do not open a real socket in a unit test. If the handler
needs a transport, inject a `NullTransport` that records calls without
performing I/O.

### 3.2 Integration Testing (Agent-to-Agent)

**Scope:** Two live agents connected over a real (in-process or localhost)
AAFP transport. The test verifies that frames flow correctly, that
handshake completes, that version negotiation succeeds, and that a
request/response round-trip produces the expected payload.

**Speed target:** < 200 ms per test, hundreds of tests in under a minute.

**What to test at this level:**

- Handshake transcript: both agents derive the same `session_id`.
- Version negotiation: a v2-only agent and a v1/v2 agent negotiate v2.
- Single request/response: a `text-generation` request returns tokens.
- Error propagation: a request that triggers `HandlerError` on the
  responder is received by the requester as a well-formed error frame.
- Stream multiplexing: two concurrent requests on different stream IDs do
  not interfere.
- CLOSE frame: a clean close delivers pending frames before tearing down.

**Rust example (in-process transport):**

```rust
// crates/my-agent/tests/integration_a2a.rs
use aafp_test_mock::{MockAgent, MockConfig};
use aafp_transport::InProcTransport;
use my_agent::MyAgent;

#[tokio::test]
async fn request_response_round_trip() {
    let (tx_a, tx_b) = InProcTransport::pair();

    // Responder: a mock agent that echoes the prompt.
    let mut responder = MockAgent::new(MockConfig {
        echo_mode: true,
        ..Default::default()
    });
    responder.attach(tx_b);

    // Requester: the agent under test.
    let mut requester = MyAgent::new();
    requester.attach(tx_a);

    requester.connect().await.unwrap();
    let resp = requester
        .call("text-generation", b"Hello", 16)
        .await
        .unwrap();
    assert_eq!(resp.payload, b"Hello");
}
```

**Python example (localhost sockets):**

```python
# tests/integration/test_a2a.py
import asyncio
import pytest
from aafp_test_mock import MockAgent, MockConfig
from my_agent import MyAgent


@pytest.mark.asyncio
async def test_request_response_round_trip(tmp_path):
    # Responder: mock agent on a random localhost port.
    responder = MockAgent(MockConfig(echo_mode=True))
    port = await responder.listen("127.0.0.1", 0)

    # Requester: the agent under test.
    requester = MyAgent()
    await requester.connect(f"127.0.0.1:{port}")

    resp = await requester.call("text-generation", b"Hello", max_tokens=16)
    assert resp.payload == b"Hello"
    await responder.stop()
```

### 3.3 End-to-End Testing (Multi-Agent Workflow)

**Scope:** A realistic topology — an orchestrator agent, two or three
worker agents with different capabilities, a local relay, and a test DHT
for discovery. The test drives a user-level task (e.g., "summarize this
URL") and verifies the full delegation chain: orchestrator discovers
workers via DHT, calls `web-browse` on one, calls `text-generation` on
another, streams the result back, and records cost.

**Speed target:** < 5 s per test, tens of tests in a CI suite.

**What to test at this level:**

- Discovery: the orchestrator finds workers by capability name via the
  test DHT.
- Delegation: the orchestrator forwards a sub-request to a worker and
  receives the response.
- Fallback chain: if the primary worker fails, the orchestrator retries
  on the secondary.
- Streaming end-to-end: tokens streamed by the worker arrive at the
  orchestrator and are forwarded to the client in order.
- Cost aggregation: the orchestrator sums cost across all workers and
  reports a total.
- Failure isolation: one worker crashing does not corrupt the
  orchestrator's other streams.

**Rust example (topology harness):**

```rust
// crates/my-agent/tests/e2e_workflow.rs
use aafp_test_fixtures::{TestFixture, Topology};
use aafp_test_mock::{MockAgent, MockConfig};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn summarize_url_workflow() {
    let fixture = TestFixture::start(Topology {
        relay: true,
        dht: true,
        workers: vec![
            ("web-browse", MockConfig::fixture_firecrawl()),
            ("text-generation", MockConfig::fixture_echo_summary()),
        ],
    }).await;

    let orchestrator = fixture.spawn_orchestrator().await;
    let summary = orchestrator
        .run_task("summarize", "https://example.com/article")
        .await
        .unwrap();

    assert!(summary.contains("Example Domain"));
    assert!(summary.cost_total > 0);
    assert_eq!(summary.workers_called, 2);
    fixture.shutdown().await;
}
```

---

## 4. Mock Agents (`aafp-test-mock` Crate)

### 4.1 Purpose

A mock agent is a fully conformant AAFP agent whose behavior is
deterministic and programmable. It is used as the *responder* in
integration tests and as the *worker* in E2E tests. Every agent
implementer should test against mocks, not against other live agents,
because live agents are non-deterministic (LLM outputs vary, network
conditions vary, model versions drift).

The `aafp-test-mock` crate provides:

- **Configurable responses** — script the exact payload returned for a
  given capability and input.
- **Latency simulation** — inject a configurable delay before responding,
  to test timeout and backpressure behavior.
- **Failure injection** — drop the connection, send a malformed frame,
  return a specific `HandlerError`, or hang indefinitely.
- **Capability advertisement** — declare an arbitrary set of capabilities
  in the mock's `AgentRecord` so the DHT and discovery layer see a
  realistic peer.
- **Observability hooks** — record every frame sent and received for
  assertion in tests.

### 4.2 `MockConfig`

```rust
// crates/aafp-test-mock/src/config.rs
use std::time::Duration;
use aafp_protocol::HandlerError;

#[derive(Clone, Debug, Default)]
pub struct MockConfig {
    /// Echo the request payload back as the response.
    pub echo_mode: bool,

    /// Fixed response payload for a given capability.
    pub scripted_responses: HashMap<String, Vec<u8>>,

    /// Delay before sending each response.
    pub response_delay: Duration,

    /// Delay between streamed chunks.
    pub inter_chunk_delay: Duration,

    /// If set, return this error for every Nth request.
    pub periodic_error: Option<(usize, HandlerError)>,

    /// If set, drop the connection after this many frames.
    pub drop_after_frames: Option<usize>,

    /// If set, send a malformed frame instead of a valid response.
    pub inject_malformed: bool,

    /// Capabilities to advertise in the AgentRecord.
    pub advertised_capabilities: Vec<String>,

    /// If true, sign the AgentRecord with an invalid signature.
    pub bad_signature: bool,
}
```

### 4.3 Usage Patterns

**Echo responder (basic round-trip):**

```rust
let responder = MockAgent::new(MockConfig {
    echo_mode: true,
    advertised_capabilities: vec!["text-generation".into()],
    ..Default::default()
});
```

**Scripted LLM responder (deterministic tokens):**

```rust
let responder = MockAgent::new(MockConfig {
    scripted_responses: hashmap! {
        "text-generation".into() =>
            b"The quick brown fox".to_vec(),
    },
    inter_chunk_delay: Duration::from_millis(20),
    advertised_capabilities: vec!["text-generation".into()],
    ..Default::default()
});
```

**Failure-injecting responder (test requester resilience):**

```rust
let responder = MockAgent::new(MockConfig {
    periodic_error: Some((3, HandlerError::overloaded())),
    drop_after_frames: Some(10),
    advertised_capabilities: vec!["text-generation".into()],
    ..Default::default()
});
```

**Latency-simulating responder (test timeout behavior):**

```rust
let responder = MockAgent::new(MockConfig {
    response_delay: Duration::from_millis(500),
    advertised_capabilities: vec!["text-generation".into()],
    ..Default::default()
});
```

### 4.4 Python Binding

The mock agent is exposed to Python via a thin binding so that Python-based
agent implementers (LangChain wrappers, AutoGen wrappers) can test against
the same mocks:

```python
# tests/conftest.py
import pytest
from aafp_test_mock import MockAgent, MockConfig

@pytest.fixture
def echo_responder():
    agent = MockAgent(MockConfig(
        echo_mode=True,
        advertised_capabilities=["text-generation"],
    ))
    return agent
```

---

## 5. Agent Contract Testing

### 5.1 What Is a Contract?

A *contract* is the published schema for a capability: the request shape,
the response shape, the error cases, and the streaming semantics. An agent
that advertises `text-generation` in its `AgentRecord` is claiming it
implements the `text-generation` contract. Contract testing verifies that
claim.

Contracts are distinct from conformance (§6): conformance tests the
*protocol* (framing, handshake, version negotiation); contract tests the
*capability* (does the payload inside the frame match the schema?).

### 5.2 Contract Definition Format

Each capability has a contract file in the registry:

```yaml
# contracts/text-generation.v1.yaml
capability: text-generation
version: 1
request:
  type: map
  required: [prompt]
  fields:
    prompt: { type: string, max_length: 1048576 }
    max_tokens: { type: int, min: 1, max: 128000 }
    temperature: { type: float, min: 0.0, max: 2.0 }
response:
  type: map
  required: [tokens, finish_reason]
  fields:
    tokens: { type: array, items: string }
    finish_reason: { type: enum, values: [stop, length, content_filter] }
streaming: true
errors:
  - code: 4001, name: invalid_prompt
  - code: 4291, name: overloaded
  - code: 5001, name: model_error
```

### 5.3 Contract Test Procedure

A contract test connects to the agent, sends a valid request, and asserts:

1. The response decodes as the declared response schema.
2. Required fields are present and correctly typed.
3. Enum values are within the declared set.
4. If `streaming: true`, the agent emits a stream of chunks terminated by
   a final frame with `finish_reason`.
5. Each declared error code is triggerable by a corresponding malformed
   input.

**Rust contract test harness:**

```rust
// crates/aafp-contract/src/lib.rs
pub async fn run_contract(
    agent_endpoint: &str,
    contract: &Contract,
) -> ContractReport {
    let mut client = AafpClient::connect(agent_endpoint).await.unwrap();
    let mut report = ContractReport::new(contract.name.clone());

    // Valid request → valid response
    for case in &contract.valid_cases {
        let resp = client.call(&contract.capability, case.request()).await;
        report.check_response(&resp, &contract.response);
    }

    // Error cases → correct error code
    for err_case in &contract.error_cases {
        let resp = client.call(&contract.capability, err_case.request()).await;
        report.check_error(&resp, err_case.expected_code);
    }

    // Streaming contract
    if contract.streaming {
        let stream = client.stream(&contract.capability, contract.stream_case()).await;
        report.check_stream(stream, &contract.response);
    }

    report
}
```

---

## 6. Capability Conformance Testing

### 6.1 Conformance vs. Contract

Conformance testing verifies that an agent satisfies the **normative
requirements** of the AAFP RFCs — the MUST/SHOULD/MAY statements. Each
requirement has a stable ID (e.g., `R2-001`, `R3-002`, `R5-003`) that is
preserved across the Rust `aafp-conformance` crate and the TypeScript
mirror (see `implementations/typescript/test/conformance.test.ts`).

Conformance is *capability-agnostic* in its lower layers (framing,
handshake, identity) and *capability-specific* in its upper layers (each
capability has a conformance suite that any agent advertising that
capability must pass).

### 6.2 Conformance Suite Structure

```
crates/aafp-conformance/
├── src/
│   ├── rfc0002.rs            # framing, CBOR, handshake transcript
│   ├── rfc0003.rs            # identity, ML-DSA-65, AgentId derivation
│   ├── rfc0005.rs            # error model, HandlerError categories
│   ├── close_conformance.rs  # CLOSE frame state machine (§6.6)
│   ├── replay_conformance.rs # ReplayCache (§6.7)
│   ├── version_negotiation.rs
│   ├── pipeline_order.rs     # RPC pipeline ordering rules
│   ├── negative.rs           # malformed input rejection
│   └── capabilities/
│       ├── text_generation.rs
│       ├── web_browse.rs
│       ├── tool_use.rs
│       └── code_execution.rs
└── tests/
    └── golden_vectors.rs     # byte-for-byte golden trace replay
```

### 6.3 Per-Capability Conformance

Each capability conformance module defines a set of tests that *any* agent
advertising that capability must pass. These tests are run against the
live agent over the wire — they are not unit tests of the agent's
internals.

**Example: `text-generation` conformance:**

```rust
// crates/aafp-conformance/src/capabilities/text_generation.rs
use aafp_protocol::{Category, FrameType};

pub fn suite() -> Vec<ConformanceTest> {
    vec![
        ConformanceTest::new("TG-001: empty prompt rejected")
            .send(b"")
            .expect_error(Category::InvalidRequest, 4001),
        ConformanceTest::new("TG-002: prompt over 1 MiB rejected")
            .send(&vec![b'x'; 1_048_577])
            .expect_error(Category::InvalidRequest, 4002),
        ConformanceTest::new("TG-003: valid prompt returns tokens")
            .send(br#"{"prompt":"Hi","max_tokens":4}"#)
            .expect_frame(FrameType::Data)
            .expect_field("finish_reason", "stop"),
        ConformanceTest::new("TG-004: streaming emits ordered chunks")
            .stream(br#"{"prompt":"Hi","stream":true}"#)
            .expect_ordered_chunks()
            .expect_terminator(),
        ConformanceTest::new("TG-005: max_tokens=0 rejected")
            .send(br#"{"prompt":"Hi","max_tokens":0}"#)
            .expect_error(Category::InvalidRequest, 4003),
    ]
}
```

### 6.4 Golden Vectors

The conformance crate exports golden vectors — byte-for-byte recordings of
correct frame sequences — that any implementation must reproduce. This is
how cross-language conformance is enforced: the Rust crate generates the
vectors, and the TypeScript (and future Python) suites replay them.

```rust
// crates/aafp-conformance/tests/golden_vectors.rs
#[test]
fn handshake_transcript_matches_golden() {
    let golden = include_bytes!("../vectors/handshake_v2.bin");
    let produced = run_handshake(FIXED_SEED_A, FIXED_SEED_B);
    assert_eq!(produced, golden);
}
```

---

## 7. Agent Behavior Testing

### 7.1 Definition

Behavior testing answers: *given this input, does the agent produce the
correct output?* This is the closest analog to traditional functional
testing, but for LLM-backed agents it is inherently fuzzy. The strategy
is:

1. **Deterministic capabilities** (web-browse, tool-use, code-execution)
   use exact-match assertions on structured outputs.
2. **Generative capabilities** (text-generation, code-generation) use
   graded assertions: structural validity, keyword presence, length
   bounds, and reference-comparison via an embedding similarity threshold.

### 7.2 Graded Assertion Helpers

```rust
// crates/aafp-test-fixtures/src/behavior.rs
pub fn assert_summary_valid(resp: &str, source: &str) {
    assert!(resp.len() >= 50,  "summary too short");
    assert!(resp.len() <= 500, "summary too long");
    assert!(resp.split_whitespace().count() <= 100, "too many words");
    let sim = cosine_similarity(embed(resp), embed(source));
    assert!(sim > 0.55, "summary not semantically related to source");
    for keyword in extract_keywords(source) {
        assert!(resp.contains(keyword), "missing key concept: {keyword}");
    }
}
```

### 7.3 Behavior Test Matrix

Each capability has a behavior test matrix: a set of input scenarios
paired with expected output properties. The matrix is versioned alongside
the contract so that behavior regressions are caught on every PR.

---

## 8. Agent Performance Testing

### 8.1 Claims to Verify

Agents advertise performance claims in their `AgentRecord` metadata (per
`AGENT_RECORD_EXTENSIONS.md`): p50 latency, p99 latency, max throughput,
max concurrent streams. Performance testing verifies these claims under
load.

### 8.2 Performance Test Harness

```rust
// crates/aafp-perf/src/lib.rs
pub async fn run_load_test(
    endpoint: &str,
    profile: LoadProfile,
) -> PerfReport {
    let mut tasks = vec![];
    for _ in 0..profile.concurrency {
        tasks.push(tokio::spawn(single_worker(endpoint, profile)));
    }
    let results = futures::future::join_all(tasks).await;
    PerfReport::from(results)
}

pub struct PerfReport {
    pub p50_latency: Duration,
    pub p99_latency: Duration,
    pub max_throughput: f64,       // req/s
    pub error_rate: f64,
    pub stream_ordering_violations: usize,
}
```

### 8.3 SLO Gates

A performance test *fails* if the measured metrics violate the agent's
advertised SLOs. This prevents agents from over-claiming in their
`AgentRecord`:

```rust
assert!(report.p99_latency <= advertised.p99_latency,
    "p99 {:?} exceeds advertised {:?}",
    report.p99_latency, advertised.p99_latency);
assert!(report.error_rate < 0.01,
    "error rate {:.2}% exceeds 1%", report.error_rate * 100.0);
```

### 8.4 Backpressure and Streaming

Performance testing for streaming capabilities additionally verifies:

- Chunks arrive in order (no stream-ID reordering).
- Inter-chunk latency is bounded (no stalls > advertised p99).
- The agent respects flow-control frames (does not send faster than the
  receiver's window).

---

## 9. Agent Security Testing

### 9.1 Threat Surface

An AAFP agent accepts untrusted network input. Its threat surface
includes:

- **Malformed frames** — truncated headers, invalid CBOR, wrong frame
  type for stream state.
- **Unauthenticated requests** — frames lacking a valid session, or
  with a forged `AgentId`.
- **Replay attacks** — retransmission of a stale `AgentRecord` or
  request.
- **Oversized payloads** — memory exhaustion via huge prompts or
  unbounded arrays.
- **Capability confusion** — a request for a capability the agent does
  not advertise.
- **Signature forgery** — an `AgentRecord` with a tampered payload or
  invalid ML-DSA-65 signature.

### 9.2 Security Test Categories

| Category | Test | Expected Behavior |
|---|---|---|
| Frame validation | Truncated 27-byte header | Reject, send `ProtocolError` |
| Frame validation | CBOR with duplicate map keys | Reject, send `ProtocolError` |
| Auth | Request before handshake | Reject, close stream |
| Auth | Forged AgentId (mismatched pubkey) | Reject record, log |
| Replay | Stale `record_version` | Reject, keep cached newer version |
| Replay | Identical version, different bytes | Reject |
| Payload limit | 10 MiB prompt | Reject with `InvalidRequest` 4002 |
| Capability | Request for unadvertised capability | Reject with `NotFound` |
| Signature | Tampered record body | `verify()` returns false |
| Signature | Wrong key algorithm field | `verify()` returns false |

### 9.3 Fuzzing

Beyond hand-written security tests, the conformance crate includes a
libFuzzer target that feeds random byte sequences into the frame decoder
and asserts no panic, no unbounded allocation, and no state-machine
desync:

```rust
// crates/aafp-conformance/fuzz/fuzz_targets/frame_decode.rs
#![no_main]
use libfuzzer_sys::fuzz_target;
fuzz_target!(|data: &[u8]| {
    let _ = aafp_protocol::decode_frame(data); // must not panic
});
```

---

## 10. Agent Compatibility Testing

### 10.1 The Compatibility Matrix

RFC-0006 defines protocol version negotiation. An agent MUST work with
all SDK versions that share a compatible major version. The
compatibility test matrix is:

| Agent \ SDK | Rust v1 | Rust v2 | TS v1 | TS v2 | Python v2 |
|---|---|---|---|---|---|
| Agent v1 | ✓ | ✓ (fallback) | ✓ | ✓ (fallback) | ✓ (fallback) |
| Agent v2 | ✓ (fallback) | ✓ | ✓ (fallback) | ✓ | ✓ |

### 10.2 Compatibility Test Procedure

For each (agent, SDK) pair in the matrix, the test:

1. Spins up the agent.
2. Connects via the SDK's client.
3. Runs the conformance suite.
4. Records which requirements pass, fail, or are skipped (due to version
   mismatch).

A compatibility regression is any requirement that passes in version N
but fails in version N+1 against the same SDK.

### 10.3 Cross-Implementation Golden Trace Replay

The strongest compatibility check is golden trace replay: the Rust
conformance crate exports a recording of a correct session, and every
other SDK replays it byte-for-byte. This is already the pattern used by
the TypeScript suite (see `implementations/typescript/test/golden-trace.test.ts`).

---

## 11. Test Fixtures

### 11.1 Pre-Generated Keypairs

Tests must be deterministic. Generating a fresh ML-DSA-65 keypair per
test run introduces non-determinism and is slow. The `aafp-test-fixtures`
crate ships a set of pre-generated keypairs derived from fixed 32-byte
seeds:

```rust
// crates/aafp-test-fixtures/src/keys.rs
pub const ALICE_SEED: [u8; 32] = [0xAA; 32];
pub const BOB_SEED:   [u8; 32] = [0xBB; 32];
pub const CAROL_SEED: [u8; 32] = [0xCC; 32];

pub fn alice_keypair() -> MlDsa65KeyPair {
    MlDsa65KeyPair::from_seed(&ALICE_SEED)
}
```

This guarantees that `AgentId`, public key, and signature are identical
across runs and across languages (Rust and TypeScript both derive from
the same seed).

### 11.2 Test DHT

A test DHT is an in-process, in-memory Kademlia instance pre-populated
with a set of `AgentRecord`s for the fixture agents. It eliminates the
non-determinism of real network discovery:

```rust
// crates/aafp-test-fixtures/src/dht.rs
pub struct TestDht {
    records: HashMap<AgentId, AgentRecord>,
}

impl TestDht {
    pub fn populated() -> Self {
        let mut dht = Self::empty();
        dht.insert(alice_record());   // web-browse
        dht.insert(bob_record());     // text-generation
        dht.insert(carol_record());   // tool-use
        dht
    }

    pub fn lookup_by_capability(&self, cap: &str) -> Vec<&AgentRecord> {
        self.records.values()
            .filter(|r| r.capabilities.iter().any(|c| c.name == cap))
            .collect()
    }
}
```

### 11.3 Local Relay

For E2E tests that require NAT traversal or multi-hop topologies, the
fixture provides a local circuit relay (RFC-0010) running in-process:

```rust
// crates/aafp-test-fixtures/src/relay.rs
pub struct LocalRelay {
    addr: Multiaddr,
    handle: tokio::task::JoinHandle<()>,
}

impl LocalRelay {
    pub async fn start() -> Self {
        let (addr, handle) = aafp_relay::start_in_process().await;
        Self { addr, handle }
    }
    pub fn addr(&self) -> &Multiaddr { &self.addr }
}
```

### 11.4 Mock LLM Responses

For agents that wrap LLMs (per `LLM_AGENT_INTEGRATION.md`), the fixture
provides a library of canned LLM responses indexed by prompt hash. This
lets behavior tests run without network access or API keys:

```rust
// crates/aafp-test-fixtures/src/llm_responses.rs
pub fn mock_llm_response(prompt: &str) -> Vec<u8> {
    let hash = blake3::hash(prompt.as_bytes());
    let key = hex::encode(hash.as_bytes());
    include_canned_response(&key)
        .unwrap_or_else(|| b"[mock response]".to_vec())
}
```

### 11.5 Fixture Bundle

All fixtures are bundled into a single `TestFixture` struct that E2E
tests use as their starting point:

```rust
pub struct TestFixture {
    pub dht: TestDht,
    pub relay: Option<LocalRelay>,
    pub keypairs: FixtureKeypairs,
    pub llm: MockLlm,
}
```

---

## 12. CI Integration

### 12.1 Per-PR Conformance Gate

Every agent PR runs the conformance suite as a mandatory CI gate. The
gate is defined in the workflow file and blocks merge on failure:

```yaml
# .github/workflows/agent-ci.yml
name: Agent CI
on: [pull_request]
jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build agent
        run: cargo build --release -p my-agent
      - name: Run conformance suite
        run: |
          cargo run --release -p my-agent --listen 127.0.0.1:9000 &
          cargo test -p aafp-conformance -- --target 127.0.0.1:9000
      - name: Run contract tests
        run: cargo test -p aafp-contract -- --target 127.0.0.1:9000
      - name: Run golden trace replay
        run: cargo test -p aafp-conformance --test golden_vectors
```

### 12.2 Tiered CI Stages

```
PR opened
  │
  ├── Stage 1: unit tests          (< 30 s)   — must pass to proceed
  ├── Stage 2: conformance suite   (< 2 min)  — must pass to proceed
  ├── Stage 3: contract tests      (< 1 min)  — must pass to proceed
  ├── Stage 4: integration tests   (< 3 min)  — must pass to proceed
  ├── Stage 5: E2E workflow tests  (< 5 min)  — must pass to proceed
  ├── Stage 6: performance tests   (< 5 min)  — SLO gate, must pass
  └── Stage 7: security/fuzz tests (< 10 min) — must pass (nightly)
```

Stages 1–5 run on every PR. Stage 6 runs on PRs that touch handler or
transport code. Stage 7 runs nightly and on release branches.

### 12.3 Cross-Language CI

Because conformance is cross-language, CI also runs the TypeScript and
Python conformance mirrors against the Rust agent binary, ensuring a
single agent is compatible with all SDKs:

```yaml
  cross-lang:
    strategy:
      matrix:
        sdk: [typescript, python]
    steps:
      - name: Start Rust agent
        run: cargo run --release -p my-agent --listen 127.0.0.1:9000 &
      - name: Run ${{ matrix.sdk }} conformance
        run: |
          cd implementations/${{ matrix.sdk }}
          npx vitest run test/conformance.test.ts   # or pytest
```

---

## 13. Agent Certification

### 13.1 Why Certify?

Conformance is necessary but not sufficient for trust. Certification is a
*public, signed attestation* that a specific agent binary passed a
defined tier of tests at a specific point in time. It is the mechanism by
which an orchestrator can decide whether to route traffic to an unknown
agent.

### 13.2 Certification Tiers

| Tier | Requirements | Badge |
|---|---|---|
| **Bronze** | RFC-0002 framing conformance, RFC-0003 identity conformance, RFC-0005 error model, basic request/response for at least one capability, no security test failures | 🟫 |
| **Silver** | All bronze requirements + streaming RPC conformance (RFC P2.8), connection pooling, backpressure handling, contract tests for all advertised capabilities | 🟪 |
| **Gold** | All silver requirements + full v2 feature set: session affinity (P2.7), pubsub backchannel, fallback chain participation, cost reporting in `AgentRecord` extensions, performance SLO verification, cross-SDK compatibility matrix | 🟨 |

### 13.3 Certification Procedure

1. The agent author submits the agent binary and its `AgentRecord` to the
   certification harness.
2. The harness runs the tier-appropriate test suite against the binary.
3. On success, the harness produces a signed `CertificationRecord`:

```rust
pub struct CertificationRecord {
    pub agent_id: AgentId,
    pub agent_binary_hash: [u8; 32],
    pub tier: CertificationTier,
    pub tested_at: u64,
    pub tested_against: String,   // conformance crate version
    pub certifier_key: PublicKey,
    pub signature: Vec<u8>,       // ML-DSA-65 over the above
}
```

4. The `CertificationRecord` is published to the DHT so that any
   orchestrator can verify an agent's tier before routing to it.

### 13.4 Tier Enforcement in Routing

The adaptive routing plane (per `ADAPTIVE_ROUTING_PLANE.md`) can be
configured to filter by tier:

- **Strict mode:** only route to Gold-certified agents.
- **Balanced mode:** prefer Gold, fall back to Silver, never route to
  uncertified.
- **Open mode:** route to any agent that passes conformance at runtime
  (tier is advisory).

This lets network operators set the trust bar appropriate to their
domain (a production deployment uses strict; a dev sandbox uses open).

### 13.5 Certification Expiry

Certifications expire when the conformance crate version advances or
when the agent's `AgentRecord` expires (30 days, per §2.4 of
`AGENT_RECORD_EXTENSIONS.md`). Re-certification is required after
expiry; the routing plane treats expired certifications as the next
lower tier (Gold → Silver, Silver → Bronze, Bronze → uncertified).

---

## 14. Concrete Test Framework Design

### 14.1 Rust Crate Layout

```
crates/
├── aafp-test-mock/          # Mock agents (§4)
│   ├── src/
│   │   ├── config.rs
│   │   ├── agent.rs
│   │   └── scripting.rs
│   └── Cargo.toml
├── aafp-test-fixtures/      # Fixtures (§11)
│   ├── src/
│   │   ├── keys.rs
│   │   ├── dht.rs
│   │   ├── relay.rs
│   │   ├── llm_responses.rs
│   │   └── lib.rs
│   └── Cargo.toml
├── aafp-conformance/        # Conformance suite (§6)
│   ├── src/
│   │   ├── rfc0002.rs
│   │   ├── rfc0003.rs
│   │   ├── rfc0005.rs
│   │   ├── capabilities/
│   │   └── lib.rs
│   ├── tests/
│   │   └── golden_vectors.rs
│   ├── fuzz/
│   └── Cargo.toml
├── aafp-contract/           # Contract tests (§5)
│   ├── src/
│   ├── contracts/           # YAML contract definitions
│   └── Cargo.toml
├── aafp-perf/               # Performance tests (§8)
│   ├── src/
│   └── Cargo.toml
└── aafp-certify/            # Certification harness (§13)
    ├── src/
    └── Cargo.toml
```

### 14.2 Python Package Layout

```
python/
├── aafp_test_mock/
│   ├── __init__.py
│   ├── config.py
│   └── agent.py
├── aafp_test_fixtures/
│   ├── __init__.py
│   ├── keys.py
│   ├── dht.py
│   ├── relay.py
│   └── llm_responses.py
├── aafp_conformance/
│   ├── __init__.py
│   ├── rfc0002.py
│   ├── rfc0003.py
│   ├── capabilities/
│   └── golden_vectors.py
├── aafp_contract/
│   ├── __init__.py
│   └── contracts/           # mirrors the Rust YAML
└── aafp_certify/
    └── __init__.py
```

### 14.3 Shared Test Harness Trait

Both Rust and Python expose a common harness interface so that the same
test definitions run in either ecosystem:

```rust
// Rust
pub trait AgentTestHarness {
    async fn connect(&mut self, endpoint: &str);
    async fn call(&mut self, capability: &str, payload: &[u8]) -> TestResponse;
    async fn stream(&mut self, capability: &str, payload: &[u8]) -> TestStream;
    async fn close(&mut self);
}
```

```python
# Python
from abc import ABC, abstractmethod
from typing import AsyncIterator

class AgentTestHarness(ABC):
    @abstractmethod
    async def connect(self, endpoint: str) -> None: ...
    @abstractmethod
    async def call(self, capability: str, payload: bytes) -> "TestResponse": ...
    @abstractmethod
    def stream(self, capability: str, payload: bytes) -> AsyncIterator[bytes]: ...
    @abstractmethod
    async def close(self) -> None: ...
```

### 14.4 Test Discovery and Selection

Conformance tests are tagged by RFC and capability so that CI can run a
subset:

```rust
#[test_group(tag = "rfc0002", tier = "bronze")]
fn framing_conformance() { /* ... */ }

#[test_group(tag = "streaming", tier = "silver")]
fn streaming_conformance() { /* ... */ }
```

```bash
# Run only bronze-tier tests
cargo test -p aafp-conformance -- --tier bronze

# Run only text-generation capability tests
cargo test -p aafp-conformance -- --capability text-generation
```

---

## 15. End-to-End Test Scenario Walkthrough

To make the architecture concrete, here is a full E2E scenario traced
through every test level.

### 15.1 Scenario: "Summarize a URL"

A user asks the orchestrator to summarize `https://example.com/article`.
The orchestrator must:

1. Discover a `web-browse` agent via DHT.
2. Discover a `text-generation` agent via DHT.
3. Call `web-browse` to fetch the article content.
4. Call `text-generation` with the content, streaming the summary back.
5. Aggregate cost and return the result.

### 15.2 Level-by-Level Coverage

| Step | Unit | Integration | E2E |
|---|---|---|---|
| DHT lookup | `TestDht::lookup_by_capability` correctness | Real DHT lookup returns the mock record | Orchestrator discovers workers in populated test DHT |
| `web-browse` call | Handler decodes URL, returns content | Requester ↔ mock web-browse round-trip | Orchestrator ↔ Firecrawl-mock worker |
| `text-generation` call | Handler produces tokens | Requester ↔ mock LLM round-trip with streaming | Orchestrator ↔ echo-summary worker, streamed |
| Fallback | Error mapping logic | Requester retries on `overloaded` error | Primary worker fails, orchestrator retries on secondary |
| Cost aggregation | Cost arithmetic | Single call cost matches expected | Total cost = sum across both workers |
| Final delivery | Response encoding | Response arrives on correct stream ID | User receives streamed summary in order |

### 15.3 What Each Level Catches

- **Unit** catches a bug in the cost arithmetic (wrong multiplier).
- **Integration** catches a bug where the requester misparses the
  streaming terminator frame.
- **E2E** catches a bug where the orchestrator's fallback logic does not
  reset the stream ID after the primary fails, causing a collision on the
  secondary.

No level alone is sufficient. The bug in the fallback logic is invisible
to unit and integration tests because they do not exercise multi-agent
topology.

---

## 16. Recommendations and Anti-Patterns

### 16.1 Recommendations

1. **Test against mocks, not live LLMs, in CI.** Live LLM outputs are
   non-deterministic; CI must be reproducible. Use the mock LLM response
   library (§11.4) for behavior tests, and run live-LLM smoke tests
   separately, nightly, with a failure-tolerance threshold.
2. **Pin conformance crate versions.** An agent certified against
   conformance v2.3 must re-certify when the crate advances to v2.4.
   Record the crate version in the `CertificationRecord`.
3. **Run fuzzing nightly, not per-PR.** Fuzzing is too slow for the PR
   gate but too valuable to skip. Run it on a schedule and file issues
   for any crash.
4. **Treat performance SLO violations as test failures.** An agent that
   claims p99 < 500 ms but delivers p99 = 5 s is not "passing tests with
   a slow result" — it is failing a performance contract.
5. **Certify before advertising.** An agent should not publish its
   `AgentRecord` to the production DHT until it has at least a bronze
   certification. The SDK's `publish()` should warn if no
   `CertificationRecord` is attached.

### 16.2 Anti-Patterns

- **"It works on my machine" with a live LLM.** A behavior test that
  passes because GPT-4 happened to produce a good summary today will
  fail tomorrow when the model is updated. Always use mock LLM responses
  in CI.
- **Skipping conformance because "the SDK handles framing."** The SDK
  handles framing for *its own* emissions. An agent that manually
  constructs frames (e.g., for a custom transport) must still pass
  conformance.
- **Testing only the happy path.** Every capability contract has error
  cases. An agent that only handles valid inputs is a network hazard
  when it receives a malformed request from a buggy peer.
- **Certifying once and never re-certifying.** Certifications expire.
  An agent that was Gold-certified six months ago against conformance
  v2.1 is not Gold against v2.4. Automate re-certification in the
  release pipeline.
- **Using a shared live agent as the test responder.** If the responder
  is a live agent, its behavior can change (model update, config change,
  network issue), making the test non-deterministic. Always use a mock
  responder in automated tests.

---

## 17. Relationship to Existing AAFP Testing Infrastructure

The AAFP project already has a conformance crate
(`crates/aafp-conformance`) and a TypeScript conformance mirror
(`implementations/typescript/test/conformance.test.ts`) that preserves
RFC requirement IDs (`R2-001`, `R3-002`, ...) as test names for
side-by-side audit. The design in this document extends that foundation
in three ways:

1. **Per-capability conformance modules** — the existing suite tests the
   *protocol*; this design adds *capability* conformance (§6.3) so that
   an agent advertising `text-generation` is tested against the
   `text-generation` contract, not just the framing layer.
2. **Mock agent crate** — the existing suite tests the reference
   implementation against itself; the `aafp-test-mock` crate (§4) lets
   *third-party* agents test against a deterministic, conformant peer.
3. **Certification tiers** — the existing suite is pass/fail; the
   bronze/silver/gold tiers (§13) give orchestrators a graded trust
   signal for routing decisions.

The golden-vector replay mechanism already in use (Rust exports, TypeScript
replays) is the model for cross-language compatibility testing (§10.3)
and is extended here to Python.

---

## 18. Open Questions

1. **Certification authority.** Who signs `CertificationRecord`s? Options:
   (a) a central AAFP project key, (b) a web-of-trust model where any
   Gold-certified agent can certify others, (c) self-attestation with
   auditable logs. Recommendation: start with (a), migrate to (c) once
   the audit log infrastructure exists.
2. **Conformance crate versioning.** Should the conformance crate be
   versioned independently of the protocol, or pinned to protocol
   revisions? Recommendation: independently, with a compatibility
   matrix mapping conformance versions to protocol versions.
3. **Live-LLM behavior test thresholds.** What cosine-similarity
   threshold counts as a "pass" for a summary? This is domain-specific
   and should be configurable per capability contract.
4. **Fuzzing corpus sharing.** Should fuzz corpora be shared across
   language implementations? Recommendation: yes — export the Rust
   corpus as a binary blob and replay it in TypeScript/Python fuzz
   targets.

---

## 19. Summary Checklist

- [ ] Unit tests for every handler (pure functions, < 10 ms each)
- [ ] Integration tests for every agent-to-agent frame exchange
- [ ] E2E tests for every multi-agent workflow the orchestrator supports
- [ ] Mock agent (`aafp-test-mock`) used as responder in all automated tests
- [ ] Contract tests for every advertised capability
- [ ] Conformance tests (RFC-0002/0003/0005 + per-capability) pass in CI
- [ ] Golden vector replay passes in all language SDKs
- [ ] Performance tests verify advertised SLOs (p50, p99, throughput)
- [ ] Security tests cover all 10 categories in §9.2
- [ ] Fuzzing runs nightly with no open crash bugs
- [ ] Compatibility matrix tested for all supported SDK versions
- [ ] Test fixtures (keypairs, DHT, relay, mock LLM) bundled and versioned
- [ ] CI gate blocks merge on conformance/contract/integration failure
- [ ] Certification tier (bronze/silver/gold) recorded and published to DHT
- [ ] Re-certification automated in release pipeline

---

*End of document.*
