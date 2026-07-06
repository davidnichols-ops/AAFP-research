# LLM Agent Integration with AAFP

**Author:** Devin (research synthesis)
**Date:** 2026-07-04
**Status:** Reference design — Phase 4 (World Perception Layer) companion
**Depends on:** `INTERNET_BRIDGE_PLAN.md`, `STRATEGIC_VISION.md`,
`STREAMING_RPC_DESIGN.md` (P2.8), `SESSION_AFFINITY_DESIGN.md` (P2.7),
`AGENT_RECORD_EXTENSIONS.md`

---

## Executive Summary

The AAFP Strategic Vision names OpenAI APIs, Anthropic APIs, and proprietary
agent buses as the *competitor*, not HTTP. But AAFP does not need to *replace*
those models — it needs to **wrap them**. Every frontier LLM becomes an AAFP
agent that advertises capabilities, streams tokens over AAFP streaming RPC,
delegates tool calls to other AAFP agents, tracks cost via `AgentRecord`
extensions, and participates in fallback chains. The moat is the network, not
the model.

This document specifies how to wrap real LLM agents (OpenAI GPT-4, Anthropic
Claude, LangChain, AutoGPT/crewAI/AutoGen) as first-class AAFP agents. It
covers capability advertisement, streaming token delivery, multi-turn
conversations, tool-use delegation, cost tracking, rate limiting, fallback
chains, and includes a concrete Python wrapper class plus TypeScript examples.

**Key conclusion:** LLM providers are *capability providers* in the World
Perception Layer's sense. They expose `text-generation`, `code-generation`,
`analysis`, and `tool-use` capabilities. AAFP's job is to standardize the
advertisement, routing, streaming, and accounting around them — not to host
the weights.

---

## 1. Why Wrap LLMs as AAFP Agents?

### 1.1 The Strategic Position

From `STRATEGIC_VISION.md`: *"The competitor is not HTTP. The competitor is
cloud silos — OpenAI APIs, Anthropic APIs, proprietary agent buses, closed
orchestration systems."* Those silos own the agent graph. AAFP should own
the **open graph**.

But the open graph is worthless if it cannot reach the best models. So the
strategy is:

1. **Wrap, don't rebuild.** GPT-4 and Claude are commodities at the inference
   layer (per `INTERNET_BRIDGE_PLAN.md` §4.3). Wrap them as AAFP capability
   providers, exactly as Firecrawl is wrapped for `web-browse`.
2. **Own the schema.** AAFP defines the agent-native request/response shape
   for LLM calls (analogous to RFC-0016 for web content). The model is
   pluggable; the contract is not.
3. **Own the coordination.** Fallback chains, cost-aware routing, rate-limit
   pooling, and tool-use delegation are network effects that no single
   provider's API offers.

### 1.2 What an "LLM AAFP Agent" Is

An LLM AAFP agent is a process that:

- Holds an `AgentKeypair` (ML-DSA-65) and publishes an `AgentRecord` to the
  DHT advertising `text-generation`, `code-generation`, `analysis`, and/or
  `tool-use` capabilities.
- Accepts AAFP RPC requests on those capabilities.
- Translates the AAFP request into the provider's native API call
  (OpenAI Chat Completions, Anthropic Messages, LangChain `invoke`, etc.).
- Streams tokens back via AAFP server-streaming RPC (P2.8).
- Maintains multi-turn session state keyed by AAFP session ID (P2.7).
- Delegates tool calls to *other* AAFP agents discovered via the DHT.
- Reports cost (token usage) in the response and in `AgentRecord` extensions.
- Respects per-agent rate limits and queue priority.

The LLM itself never speaks AAFP. The wrapper does. This is the same pattern
as the Firecrawl wrapper for `web-browse`: an external service rendered as a
well-known AAFP capability.

---

## 2. Capability Advertisement for LLM Agents

### 2.1 Well-Known LLM Capabilities

Following the `INTERNET_BRIDGE_PLAN.md` convention of well-known capability
names, LLM agents advertise some subset of:

| Capability | What it does | Typical provider |
|------------|--------------|------------------|
| `text-generation` | Produce text from a prompt | GPT-4, Claude, Llama |
| `code-generation` | Produce code (often a model variant or system prompt) | GPT-4, Claude, Codex |
| `analysis` | Reasoning / structured extraction over input | Claude, GPT-4 |
| `tool-use` | Model emits tool calls; wrapper executes them | GPT-4 function-calling, Claude tool_use |
| `embedding` | Vectorize text (not generation, but adjacent) | text-embedding-3, Voyage |
| `vision` | Image understanding (multimodal) | GPT-4o, Claude 3.5 |
| `audio-transcribe` | Speech → text | Whisper (also a perception cap) |

`code-generation` and `analysis` are *specialized* `text-generation`. They
exist as distinct capability names so discovery can route precisely
("I need code generation with Python support") rather than filtering on
freeform metadata.

### 2.2 CapabilityDescriptor with Semantic Metadata

Per `AGENT_RECORD_EXTENSIONS.md` §5.4, `CapabilityDescriptor` carries an
optional semantic descriptor (key 3). For an LLM agent:

```cbor
CapabilityDescriptor = {
    1: "text-generation",            // name
    2: {                             // metadata (backward compat)
        "provider": "openai",
        "model": "gpt-4-turbo",
        "context-window": "128000",
        "supports-streaming": "true",
        "supports-tools": "true",
        "supports-vision": "true",
    },
    3: {                             // SemanticCapabilityData (optional)
        ? 1: PerformanceProfile,     // p50/p99 latency, throughput
        ? 2: QualityMetrics,         // success rate, calibration
        ? 3: CostModel,              // per-token pricing
        ? 4: [*CapabilityEdge],      // Specializes, Composes, etc.
        ? 5: SemanticVersion,        // model version
    }
}
```

The `CapabilityEdge` graph lets `code-generation` declare
`Specializes(text-generation)`, so a query for `text-generation` also
matches the more specific capability (per `SEMANTIC_CAPABILITY_GRAPHS.md`).

### 2.3 Agent-Level Extensions for LLMs

LLM agents populate three `AgentRecord` extensions (key 11):

- **`"aafp.semantic.v1"`** — `languages: ["en", "fr", "ja"]`,
  `modalities: ["text", "image"]`, `hardware: ["cpu"]` (LLM wrappers are
  CPU-bound; they call out to GPU providers).
- **`"aafp.cost.v1"`** — `per_token_micro_usd`, `per_invocation_micro_usd`,
  `has_free_tier`, `currency`. This is what enables cost-aware routing.
- **`"aafp.perf.v1"`** — `avg_latency_ms`, `p99_latency_ms`,
  `throughput_rps`, `max_concurrent`. Self-reported; attested metrics live
  in separate attestations (§7 of AGENT_RECORD_EXTENSIONS.md).

Example CBOR for an OpenAI wrapper's record extension:

```cbor
{ 11: {
    "aafp.cost.v1": { 1: 1, 2: {
        2: 30,            // per_token_micro_usd = 0.00003 USD = 30 micro-USD per 1k tokens
        6: false,         // has_free_tier
        7: "USD",
        8: 1720000000,    // updated_at
    }},
    "aafp.semantic.v1": { 1: 1, 2: {
        1: ["en", "es", "fr", "de", "ja", "zh"],
        2: ["text", "image"],
        6: { 1: 4, 2: 0, 3: 0 },   // agent_semver 4.0.0
    }},
}}
```

---

## 3. Streaming Token Delivery via AAFP Streaming RPC (P2.8)

### 3.1 The Mapping

LLM providers stream tokens via SSE (OpenAI) or SSE-like events (Anthropic).
AAFP's server-streaming RPC (per `STREAMING_RPC_DESIGN.md` §3,
`BUILDER_PROMPT_P2.8.md`) streams tokens via the QUIC bi-stream kept open
after the request frame, with the `MORE` flag set on every frame except the
last.

The mapping is direct:

| Provider stream | AAFP frame |
|-----------------|------------|
| SSE `data: {chunk}` | `DATA` frame with `MORE` flag, payload = one token chunk |
| SSE `data: [DONE]` | Final `DATA` frame without `MORE`, then `send.finish()` |
| SSE error event | Error frame, then finish |
| Client disconnect | QUIC stream reset → server `CancellationToken` fires |

### 3.2 Token Frame Schema

Each streamed frame carries a CBOR `TokenChunk`:

```cbor
TokenChunk = {
    1: tstr,            // "text": the token text (may be empty for tool-call deltas)
    2: tstr / null,     // "role": only on first chunk ("assistant")
    3: [*ToolCallDelta] / null,  // "tool_calls": incremental tool-call parts
    4: tstr / null,     // "finish_reason": only on final chunk
    5: Usage / null,    // "usage": only on final chunk
}

ToolCallDelta = {
    1: uint,            // "index": tool-call index
    2: tstr / null,     // "id": assigned on first delta
    3: tstr / null,     // "name": function name
    4: tstr / null,     // "arguments": partial JSON
}

Usage = {
    1: uint,            // "prompt_tokens"
    2: uint,            // "completion_tokens"
    3: uint,            // "total_tokens"
}
```

### 3.3 Server-Side Streaming Handler (Python)

The Python SDK exposes a streaming handler API mirroring the Rust
`StreamingHandlerContext`:

```python
from aafp import ServeBuilder, StreamingHandlerContext, Request, Response
from aafp.cbor import dumps
import openai

client = openai.AsyncOpenAI(api_key=_load_credential())  # from TrustManager

async def stream_completion(req: Request, ctx: StreamingHandlerContext) -> None:
    params = req.params()  # parsed CBOR map
    messages = params["messages"]
    model = params.get("model", "gpt-4-turbo")

    stream = await client.chat.completions.create(
        model=model,
        messages=messages,
        stream=True,
        stream_options={"include_usage": True},
    )

    async for chunk in stream:
        if ctx.cancel.is_cancelled():
            break  # client disconnected; stop pulling from OpenAI

        choice = chunk.choices[0] if chunk.choices else None
        delta_text = choice.delta.content if choice and choice.delta else ""
        finish = choice.finish_reason if choice else None

        token = {
            "text": delta_text or "",
            "finish_reason": finish,
            "usage": _usage_from_chunk(chunk) if chunk.usage else None,
        }
        await ctx.send(Response.text(dumps(token)))

    # final empty frame is sent automatically when the handler returns
```

The wrapper translates OpenAI's SSE chunks into AAFP `TokenChunk` frames.
Because the handler checks `ctx.cancel` each iteration, a client that drops
the `ResponseStream` triggers a QUIC stream reset, which cancels the
OpenAI pull — no wasted tokens, no wasted spend.

### 3.4 Client-Side Streaming (TypeScript)

```typescript
import { connect } from "aafp";

const agent = await connect().seeds(["/dns4/bootstrap.aafp.io/udp/443/quic-v1"]).connect();

const stream = await agent
  .discover("text-generation")
  .withMetadata({ provider: "openai", "supports-streaming": "true" })
  .callStreaming({
    text: "",
    params: { model: "gpt-4-turbo", messages: [{ role: "user", content: "Explain AAFP." }] },
  });

for await (const resp of stream) {
  const token = resp.decodeCbor();
  if (token.text) process.stdout.write(token.text);
  if (token.finish_reason) {
    console.error("\n[done]", token.usage);
  }
}
// dropping `stream` cancels server-side generation
```

---

## 4. Multi-Turn Conversations over AAFP (P2.7)

### 4.1 Session Affinity for Conversations

LLM conversations are stateful: the model needs prior turns. Two designs
exist:

1. **Client-held history.** The client sends the full `messages` array each
   call. Simple, but expensive (re-sends tokens) and impossible for
   long-running agents that lose context.
2. **Server-held session.** The wrapper keeps a conversation buffer keyed by
   an AAFP session ID. The client sends only the new turn plus the session
   ID. The wrapper appends and calls the provider with the full history.

AAFP supports both, but session affinity (P2.7) makes the second design
efficient. Per `SESSION_AFFINITY_DESIGN.md` §3, the connection pool routes
requests for the same peer AgentId to the same QUIC connection, and the
server-side `SessionManager` (§4) stores per-session state.

### 4.2 Conversation Session Schema

```cbor
ConversationSession = {
    1: tstr,                // "session_id": AAFP session ID (32 bytes, hex)
    2: tstr,                // "model": model used for this conversation
    3: [*Message],          // "messages": full history held server-side
    4: tstr / null,         // "system_prompt": optional pinned system message
    5: ConversationPolicy,  // "policy": max turns, max tokens, truncation rules
    6: uint,                // "created_at"
    7: uint,                // "last_activity"
}

Message = {
    1: tstr,        // "role": system | user | assistant | tool
    2: tstr,        // "content"
    3: [*ToolCall] / null,  // "tool_calls": for assistant messages
    4: tstr / null,         // "tool_call_id": for tool response messages
}
```

### 4.3 Session-Aware Handler

```python
from aafp import ServeBuilder, SessionContext, Request, Response

async def chat_with_session(req: Request, sess: SessionContext) -> Response:
    params = req.params()
    session_id = sess.session_id.hex()

    conv = session_store.get_or_create(
        session_id, model=params.get("model", "gpt-4-turbo"),
    )

    # Append the new user turn
    conv.messages.append({"role": "user", "content": params["text"]})

    # Enforce policy (truncate oldest if over max_tokens)
    conv = enforce_policy(conv)

    # Non-streaming completion using full server-side history
    completion = await client.chat.completions.create(
        model=conv.model,
        messages=conv.messages,
    )
    reply = completion.choices[0].message

    conv.messages.append({
        "role": "assistant",
        "content": reply.content,
        "tool_calls": _serialize_tool_calls(reply.tool_calls),
    })
    session_store.touch(session_id)

    return Response.text(dumps({
        "text": reply.content,
        "usage": _usage(completion.usage),
        "session_id": session_id,
    }))

agent = (
    ServeBuilder()
    .capabilities(["text-generation"])
    .with_session_manager(session_store)  # P2.7
    .session_handler(chat_with_session)
    .bind("[::]:443")
    .keypair(kp)
    .start()
)
```

The client simply includes `session_id` on subsequent turns:

```typescript
const r1 = await agent.discover("text-generation").call({
  params: { text: "What is AAFP?" },
});
const sid = r1.decodeCbor().session_id;

const r2 = await agent.discover("text-generation").call({
  params: { text: "And how does it differ from HTTP?", session_id: sid },
});
// r2 sees the full conversation server-side
```

Because of connection-level affinity (§3.2 of SESSION_AFFINITY_DESIGN.md),
turns 2..N reuse the same QUIC connection — handshake cost drops from
~709µs to ~14µs per turn, a 14.6× improvement over 20 turns.

### 4.4 Session Eviction

Conversations are expensive to hold (token history). The `SessionManager`
evicts idle sessions (default 60s) and should cap per-session token history
via `ConversationPolicy.max_context_tokens`. On eviction, the wrapper can
optionally summarize the conversation (call the model itself to produce a
compact summary) and persist it, so a resumed session starts with the
summary rather than the full transcript.

---

## 5. Tool-Use Delegation (LLM Calls Other AAFP Agents as Tools)

### 5.1 The Pattern

This is where AAFP's network effect bites. When GPT-4 emits a function call,
the wrapper does **not** execute it locally. Instead it:

1. Maps the function name to an AAFP capability.
2. Discovers an agent serving that capability via the DHT.
3. Calls it over AAFP RPC.
4. Feeds the result back to the model as a `tool` message.

This means an LLM agent's "tools" are *other AAFP agents* — a `web-browse`
agent, a `code-execute` agent, a `search` agent, a `document-read` agent.
The LLM wrapper is a *coordinator*; the actual work happens on the network.
This is the Execution Fabric vision (`STRATEGIC_VISION.md` §Execution Fabric)
made concrete for a single LLM call.

### 5.2 Tool Definition Schema

The wrapper advertises available tools to the model by translating AAFP
capability descriptors into the provider's tool schema. For OpenAI:

```python
def aafp_capability_to_openai_tool(cap_desc: CapabilityDescriptor) -> dict:
    return {
        "type": "function",
        "function": {
            "name": cap_desc.name.replace("-", "_"),  # OpenAI requires [a-zA-Z0-9_]
            "description": cap_desc.metadata.get("description", ""),
            "parameters": cap_desc.metadata.get("parameters_schema", {
                "type": "object", "properties": {}
            }),
        },
    }
```

At startup, the wrapper queries the DHT for well-known perception
capabilities (`search`, `web-browse`, `document-read`, `code-execute`) and
registers them as tools with the model.

### 5.3 Tool Execution Loop

```python
async def run_with_tools(req: Request, sess: SessionContext) -> Response:
    conv = session_store.get_or_create(sess.session_id.hex(), model="gpt-4-turbo")
    conv.messages.append({"role": "user", "content": req.params()["text"]})

    tools = await discover_tools()  # from DHT

    for _ in range(MAX_TOOL_ROUNDS):
        completion = await client.chat.completions.create(
            model=conv.model, messages=conv.messages, tools=tools,
        )
        msg = completion.choices[0].message
        conv.messages.append(_serialize(msg))

        if not msg.tool_calls:
            return Response.text(dumps({"text": msg.content, "usage": _usage(completion.usage)}))

        # Execute each tool call by delegating to a discovered AAFP agent
        for tc in msg.tool_calls:
            capability = tc.function.name.replace("_", "-")
            args = json.loads(tc.function.arguments)

            # Discover and call another AAFP agent
            tool_resp = await self.agent.discover(capability).call(
                Request(params=args).with_session_id(sess.session_id),
            )
            result = tool_resp.text()

            conv.messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result,
            })

    return Response.error("tool_round_limit_exceeded")
```

### 5.4 Recursive Delegation and Cycle Prevention

A `tool-use` LLM agent can itself be called as a tool by another LLM agent
(a planner model delegates a sub-task to a specialist model). To prevent
infinite recursion, every tool-call request carries a `depth` counter in
its metadata; the wrapper rejects calls above a configurable depth
(default 5). UCAN capability attenuation (`INTERNET_BRIDGE_PLAN.md` §2.5)
can additionally scope which tools a delegated LLM may call.

---

## 6. Cost Tracking (Token-Based Pricing)

### 6.1 Per-Response Usage

Every LLM response (streaming or not) carries a `Usage` block
(§3.2). The wrapper populates it from the provider's usage report. The
caller can accumulate cost across a multi-turn conversation or a tool-use
loop.

### 6.2 AgentRecord Cost Extension

The `"aafp.cost.v1"` extension (§2.3) advertises pricing so the
cost-aware router (per `ADAPTATION_ROADMAP.md`, Track T) can pick the
cheapest capable agent. For LLMs, `per_token_micro_usd` is the primary
field. Pricing is republished whenever the provider changes prices
(record version bumps trigger DHT republish).

### 6.3 Cost Ledger

The wrapper maintains a per-session cost ledger and reports aggregate cost
in the final frame of each conversation:

```python
@dataclass
class CostLedger:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    tool_call_tokens: int = 0
    estimated_cost_micro_usd: int = 0

    def add(self, usage: Usage, price_per_kt: int):
        self.prompt_tokens += usage.prompt_tokens
        self.completion_tokens += usage.completion_tokens
        self.estimated_cost_micro_usd += (
            usage.prompt_tokens * price_per_kt // 1000
            + usage.completion_tokens * price_per_kt // 1000
        )
```

The ledger is returned in the conversation's final response and optionally
emitted as a PubSub event on topic `aafp.cost.{agent_id}` for network-wide
accounting (feeds the future Economic Layer, `STRATEGIC_VISION.md` §Economic
Layer).

---

## 7. Rate Limiting and Queue Management

### 7.1 The Problem

LLM calls are expensive and rate-limited by the provider (tokens/min,
requests/min). A naive AAFP wrapper that fans out 100 concurrent requests
will get 429s. Two layers of control are needed:

1. **Provider-side limits** — respect the upstream API's rate limits.
2. **Network-side limits** — protect the wrapper from being overwhelmed by
   AAFP clients (RFC-0015 distributed rate limiting, per
   `INTERNET_BRIDGE_PLAN.md` §3.4 item 17).

### 7.2 Per-Agent Token Bucket

```python
import asyncio, time

class TokenBucket:
    def __init__(self, rate_per_min: int, burst: int):
        self.rate = rate_per_min / 60.0
        self.burst = burst
        self.tokens = float(burst)
        self.last = time.monotonic()
        self.lock = asyncio.Lock()

    async def acquire(self, n: int = 1) -> None:
        async with self.lock:
            while True:
                now = time.monotonic()
                self.tokens = min(self.burst, self.tokens + (now - self.last) * self.rate)
                self.last = now
                if self.tokens >= n:
                    self.tokens -= n
                    return
                wait = (n - self.tokens) / self.rate
                await asyncio.sleep(wait)
```

### 7.3 Priority Queue (P2 Internet Bridge Augmentation #9)

`INTERNET_BRIDGE_PLAN.md` §3.3 item 9 specifies per-agent, per-domain
priority queues with weighted fair queuing. For LLM wrappers, "domain" is
the calling agent's AgentId. Urgent interactive requests preempt background
batch generation:

```python
class PriorityLLMQueue:
    def __init__(self, bucket: TokenBucket, max_concurrent: int = 8):
        self.bucket = bucket
        self.sem = asyncio.Semaphore(max_concurrent)
        self.queues = {
            "interactive": asyncio.PriorityQueue(),
            "batch": asyncio.PriorityQueue(),
        }
        self.weights = {"interactive": 8, "batch": 1}

    async def submit(self, priority: str, req: Request) -> Response:
        fut = asyncio.get_event_loop().create_future()
        await self.queues[priority].put((time.monotonic(), req, fut))
        return await fut

    async def run(self):
        while True:
            req, fut = await self._pick_weighted()
            async with self.sem:
                await self.bucket.acquire(1)
                try:
                    fut.set_result(await self._execute(req))
                except Exception as e:
                    fut.set_exception(e)
```

### 7.4 Distributed Rate Limiting (RFC-0015)

When multiple AAFP LLM-wrapper agents share a single upstream API key (key
pooling, per `INTERNET_BRIDGE_PLAN.md` §4.2 `search` capability notes),
they must coordinate to avoid collectively exceeding the provider limit.
RFC-0015 specifies DHT-based quota with gossip coordination. Each wrapper
claims a token quota from the DHT before calling the provider; if the
quota is exhausted, it either waits or falls back to a secondary provider
(§8).

---

## 8. Fallback Chains (GPT-4 → Claude → Local Model)

### 8.1 Why Fallback?

LLM providers fail: rate limits, outages, model deprecations, region
blocks. A single-provider wrapper is a single point of failure. AAFP's
federated discovery makes fallback trivial — the client discovers multiple
`text-generation` providers and tries them in priority order.

### 8.2 Client-Side Fallback

```typescript
import { connect, SdkError } from "aafp";

const agent = await connect().connect();

async function generateWithFallback(prompt: string): Promise<string> {
  const providers = await agent
    .discover("text-generation")
    .orderBy("aafp.cost.v1.per_token_micro_usd")  // cheapest first
    .limit(3)
    .resolve();

  for (const p of providers) {
    try {
      const r = await p.call({ params: { messages: [{ role: "user", content: prompt }] } });
      return r.decodeCbor().text;
    } catch (e) {
      if (e instanceof SdkError && e.isRetryable()) {
        console.warn(`provider ${p.agentId} failed, falling back`, e);
        continue;
      }
      throw e;
    }
  }
  throw new Error("all providers exhausted");
}
```

### 8.3 Server-Side Fallback (Wrapper Internal)

A wrapper can itself implement fallback by holding credentials for multiple
providers and trying them internally. This keeps the client simple but
hides which model actually answered (the wrapper should report the actual
model in the response's `Usage`/metadata).

```python
PROVIDER_CHAIN = [
    ("openai", openai.AsyncOpenAI(api_key=...), "gpt-4-turbo"),
    ("anthropic", anthropic.AsyncAnthropic(api_key=...), "claude-3-5-sonnet"),
    ("local", LocalLLMClient("http://localhost:8080"), "llama-3-70b"),
]

async def generate_with_fallback(messages, **kw):
    last_err = None
    for name, client, model in PROVIDER_CHAIN:
        try:
            return await _call(name, client, model, messages, **kw)
        except (RateLimitError, APIConnectionError, ModelDeprecatedError) as e:
            last_err = e
            continue
    raise last_err
```

### 8.4 Hedged Requests

For latency-sensitive cases, the adaptive routing plane (Track T,
`ADAPTATION_ROADMAP.md`) supports hedged requests — issue the same prompt
to two providers and take the first response. This doubles cost but halves
tail latency. The breaker pattern (per `AR_T3_T4_BREAKER_HEDGING.md`)
prevents hedging from amplifying provider outages.

---

## 9. Concrete Python Wrapper: OpenAI GPT-4 as an AAFP Agent

This is a complete (if condensed) wrapper class. It ties together
capability advertisement, streaming, sessions, tool delegation, cost
tracking, and rate limiting.

```python
"""
openai_aafp_agent.py — GPT-4 wrapped as an AAFP agent.
"""
from __future__ import annotations
import asyncio, json, time
from dataclasses import dataclass, field
from typing import Any, Optional

import openai
from openai import RateLimitError, APIConnectionError

from aafp import (
    AgentKeypair, ServeBuilder, Request, Response,
    StreamingHandlerContext, SessionContext, SessionManager,
    discover, CapabilityDescriptor,
)
from aafp.cbor import dumps, loads
from aafp.cost import CostLedger
from aafp.ratelimit import TokenBucket, PriorityLLMQueue


# ---------- Configuration ----------

@dataclass
class OpenAIAgentConfig:
    bind_addr: str = "[::]:443"
    model: str = "gpt-4-turbo"
    rpm_limit: int = 500          # provider requests/min
    tpm_limit: int = 150_000      # provider tokens/min
    max_concurrent: int = 8
    max_tool_rounds: int = 5
    tool_capabilities: list[str] = field(
        default_factory=lambda: ["search", "web-browse", "code-execute"]
    )
    fallback_models: list[str] = field(default_factory=list)


# ---------- Session state ----------

@dataclass
class Conversation:
    session_id: str
    model: str
    messages: list[dict] = field(default_factory=list)
    system_prompt: Optional[str] = None
    ledger: CostLedger = field(default_factory=CostLedger)
    last_activity: float = field(default_factory=time.time)

    def append(self, role: str, content: str, **extra) -> None:
        msg = {"role": role, "content": content, **extra}
        if role == "system" and not self.messages:
            self.messages.insert(0, msg)
        else:
            self.messages.append(msg)
        self.last_activity = time.time()


class ConversationStore(SessionManager):
    """In-memory conversation store with TTL eviction."""

    def __init__(self, idle_ttl: float = 1800.0):
        self._convs: dict[str, Conversation] = {}
        self._idle_ttl = idle_ttl
        self._lock = asyncio.Lock()

    def get_or_create(self, sid: str, model: str) -> Conversation:
        c = self._convs.get(sid)
        if c is None:
            c = Conversation(session_id=sid, model=model)
            self._convs[sid] = c
        c.last_activity = time.time()
        return c

    def touch(self, sid: str) -> None:
        if c := self._convs.get(sid):
            c.last_activity = time.time()

    async def evict_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            now = time.time()
            stale = [s for s, c in self._convs.items()
                     if now - c.last_activity > self._idle_ttl]
            for s in stale:
                self._convs.pop(s, None)


# ---------- The wrapper agent ----------

class OpenAIAgent:
    """
    Wraps OpenAI GPT-4 as an AAFP agent serving `text-generation`,
    `code-generation`, `analysis`, and `tool-use`.
    """

    def __init__(self, cfg: OpenAIAgentConfig, keypair: AgentKeypair):
        self.cfg = cfg
        self.keypair = keypair
        self.client = openai.AsyncOpenAI(api_key=_load_credential("openai"))
        self.fallback_clients = self._init_fallbacks()
        self.store = ConversationStore()
        self.bucket = TokenBucket(rate_per_min=cfg.rpm_limit, burst=cfg.rpm_limit)
        self.queue = PriorityLLMQueue(self.bucket, cfg.max_concurrent)
        self._srv = None

    # ----- Capability advertisement -----

    def capabilities(self) -> list[CapabilityDescriptor]:
        common = {
            "provider": "openai",
            "model": self.cfg.model,
            "context-window": "128000",
            "supports-streaming": "true",
            "supports-tools": "true",
            "supports-vision": "true",
        }
        return [
            CapabilityDescriptor("text-generation", metadata={**common, "description": "General text generation"}),
            CapabilityDescriptor("code-generation", metadata={**common, "description": "Code generation"}),
            CapabilityDescriptor("analysis", metadata={**common, "description": "Reasoning and analysis"}),
            CapabilityDescriptor("tool-use", metadata={**common, "description": "Function-calling with AAFP tool delegation"}),
        ]

    def extensions(self) -> dict:
        return {
            "aafp.cost.v1": {
                "version": 1,
                "data": {
                    "per_token_micro_usd": 30,   # $0.03/1k input; adjust per model
                    "per_invocation_micro_usd": 0,
                    "has_free_tier": False,
                    "currency": "USD",
                    "updated_at": int(time.time()),
                },
            },
            "aafp.semantic.v1": {
                "version": 1,
                "data": {
                    "languages": ["en", "es", "fr", "de", "ja", "zh"],
                    "modalities": ["text", "image"],
                    "agent_semver": {"major": 4, "minor": 0, "patch": 0},
                },
            },
            "aafp.perf.v1": {
                "version": 1,
                "data": {
                    "avg_latency_ms": 1200,
                    "p99_latency_ms": 4500,
                    "max_concurrent": self.cfg.max_concurrent,
                    "throughput_rps": self.cfg.rpm_limit // 60,
                    "window_secs": 300,
                    "updated_at": int(time.time()),
                },
            },
        }

    # ----- Streaming text-generation handler -----

    async def stream_text(self, req: Request, ctx: StreamingHandlerContext) -> None:
        params = loads(req.body())
        messages = params.get("messages") or [
            {"role": "user", "content": params.get("text", "")}
        ]
        model = params.get("model", self.cfg.model)

        await self.bucket.acquire(1)
        try:
            stream = await self._call_with_fallback(
                lambda c, m: c.chat.completions.create(
                    model=m, messages=messages, stream=True,
                    stream_options={"include_usage": True},
                ),
                model,
            )
            async for chunk in stream:
                if ctx.cancel.is_cancelled():
                    break
                token = self._chunk_to_token(chunk)
                await ctx.send(Response.text(dumps(token)))
        except Exception as e:
            await ctx.send(Response.error(str(e)))

    # ----- Session-aware non-streaming handler (with tools) -----

    async def chat(self, req: Request, sess: SessionContext) -> Response:
        params = loads(req.body())
        conv = self.store.get_or_create(sess.session_id.hex(), model=params.get("model", self.cfg.model))
        conv.append("user", params["text"])

        tools = await self._discover_tools()
        usage_total = CostLedger()

        for _ in range(self.cfg.max_tool_rounds):
            await self.bucket.acquire(1)
            completion = await self._call_with_fallback(
                lambda c, m: c.chat.completions.create(
                    model=m, messages=conv.messages, tools=tools or None,
                ),
                conv.model,
            )
            msg = completion.choices[0].message
            u = self._usage(completion.usage)
            usage_total.add(u, price_per_kt=30)
            conv.append("assistant", msg.content or "",
                        tool_calls=self._serialize_tool_calls(msg.tool_calls))

            if not msg.tool_calls:
                conv.ledger = usage_total
                self.store.touch(sess.session_id.hex())
                return Response.text(dumps({
                    "text": msg.content,
                    "usage": {"prompt_tokens": u.prompt_tokens, "completion_tokens": u.completion_tokens},
                    "cost_micro_usd": usage_total.estimated_cost_micro_usd,
                    "session_id": sess.session_id.hex(),
                    "model": conv.model,
                }))

            # Delegate each tool call to another AAFP agent
            for tc in msg.tool_calls:
                cap = tc.function.name.replace("_", "-")
                args = json.loads(tc.function.arguments or "{}")
                try:
                    tool_resp = await discover(cap).call(
                        Request(params=args).with_session_id(sess.session_id)
                    )
                    result = tool_resp.text()
                except Exception as e:
                    result = f"tool error: {e}"
                conv.append("tool", result, tool_call_id=tc.id)

        return Response.error("tool_round_limit_exceeded")

    # ----- Fallback execution -----

    async def _call_with_fallback(self, fn, model: str):
        last_err = None
        clients = [(self.client, model)] + self.fallback_clients
        for client, m in clients:
            try:
                return await fn(client, m)
            except (RateLimitError, APIConnectionError) as e:
                last_err = e
                continue
        raise last_err

    def _init_fallbacks(self):
        # e.g. Anthropic fallback
        return []  # populated in production

    # ----- Tool discovery -----

    async def _discover_tools(self) -> list[dict]:
        tools = []
        for cap in self.cfg.tool_capabilities:
            try:
                desc = await discover(cap).first()
            except Exception:
                continue
            tools.append({
                "type": "function",
                "function": {
                    "name": cap.replace("-", "_"),
                    "description": desc.metadata.get("description", cap),
                    "parameters": desc.metadata.get("parameters_schema",
                                                    {"type": "object", "properties": {}}),
                },
            })
        return tools

    # ----- Helpers -----

    @staticmethod
    def _chunk_to_token(chunk) -> dict:
        choice = chunk.choices[0] if chunk.choices else None
        return {
            "text": (choice.delta.content if choice and choice.delta else "") or "",
            "finish_reason": choice.finish_reason if choice else None,
            "usage": OpenAIAgent._usage(chunk.usage) if chunk.usage else None,
        }

    @staticmethod
    def _usage(u) -> dict:
        return {"prompt_tokens": u.prompt_tokens, "completion_tokens": u.completion_tokens,
                "total_tokens": u.total_tokens}

    @staticmethod
    def _serialize_tool_calls(tcs) -> Optional[list[dict]]:
        if not tcs:
            return None
        return [{"id": tc.id, "name": tc.function.name,
                 "arguments": tc.function.arguments} for tc in tcs]

    # ----- Startup -----

    async def serve(self) -> None:
        asyncio.create_task(self.store.evict_loop())
        self._srv = (
            ServeBuilder()
            .capabilities(self.capabilities())
            .extensions(self.extensions())
            .on_streaming("text-generation", self.stream_text)
            .on_streaming("code-generation", self.stream_text)
            .with_session_manager(self.store)
            .session_handler("text-generation", self.chat)
            .session_handler("tool-use", self.chat)
            .bind(self.cfg.bind_addr)
            .keypair(self.keypair)
            .start()
        )
        await self._srv.wait_closed()


def _load_credential(name: str) -> str:
    # In production, fetch from TrustManager (AES-256-GCM encrypted at rest).
    # Never hardcode, never expose to the LLM.
    import os
    return os.environ[f"{name.upper()}_API_KEY"]


if __name__ == "__main__":
    kp = AgentKeypair.generate()
    OpenAIAgent(OpenAIAgentConfig(), kp).serve()
```

---

## 10. Anthropic Claude as an AAFP Agent

The Claude wrapper is structurally identical to the OpenAI wrapper; only
the provider call and the streaming event shape differ. Anthropic's
Messages API streams `content_block_delta` events rather than OpenAI's
`ChatCompletionChunk`.

### 10.1 Streaming Translation

```python
import anthropic

client = anthropic.AsyncAnthropic(api_key=_load_credential("anthropic"))

async def stream_claude(req: Request, ctx: StreamingHandlerContext) -> None:
    params = loads(req.body())
    messages = params.get("messages") or [{"role": "user", "content": params.get("text", "")}]
    system = params.get("system")
    model = params.get("model", "claude-3-5-sonnet-20241022")

    async with client.messages.stream(
        model=model, max_tokens=params.get("max_tokens", 4096),
        system=system, messages=messages,
    ) as stream:
        async for text in stream.text_stream:
            if ctx.cancel.is_cancelled():
                break
            await ctx.send(Response.text(dumps({"text": text})))

        msg = await stream.get_final_message()
        await ctx.send(Response.text(dumps({
            "text": "", "finish_reason": msg.stop_reason,
            "usage": {"prompt_tokens": msg.usage.input_tokens,
                      "completion_tokens": msg.usage.output_tokens},
        })))
```

### 10.2 Tool-Use with Claude

Claude's `tool_use` content blocks map onto the same AAFP delegation loop
(§5). The wrapper translates Claude's `tool_input` blocks into AAFP
`discover(capability).call(...)` invocations and returns `tool_result`
content blocks:

```python
async def claude_with_tools(req, sess):
    conv = store.get_or_create(sess.session_id.hex(), model="claude-3-5-sonnet-20241022")
    conv.messages.append({"role": "user", "content": req.params()["text"]})
    tools = await discover_tools()  # Claude tool schema is similar to OpenAI's

    for _ in range(MAX_TOOL_ROUNDS):
        resp = await client.messages.create(
            model=conv.model, max_tokens=4096,
            messages=conv.messages, tools=tools,
        )
        conv.messages.append({"role": "assistant", "content": resp.content})

        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        if not tool_uses:
            text = "".join(b.text for b in resp.content if b.type == "text")
            return Response.text(dumps({"text": text, "usage": _usage(resp.usage)}))

        results = []
        for tu in tool_uses:
            cap = tu.name.replace("_", "-")
            r = await discover(cap).call(Request(params=tu.input).with_session_id(sess.session_id))
            results.append({"type": "tool_result", "tool_use_id": tu.id, "content": r.text()})
        conv.messages.append({"role": "user", "content": results})
```

### 10.3 Capability Advertisement

Claude advertises the same four capabilities. Distinct metadata
(`provider: "anthropic"`, `model: "claude-3-5-sonnet"`, `context-window:
"200000"`) lets the semantic capability graph route by preference. The
`aafp.cost.v1` extension publishes Anthropic's per-token pricing.

---

## 11. LangChain Agent as an AAFP Agent

LangChain agents are a natural fit because they already implement the
tool-use loop. The integration wraps a LangChain `AgentExecutor` as an
AAFP `tool-use` capability provider, and exposes LangChain's underlying
LLM as `text-generation`.

### 11.1 Python (LangChain)

```python
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.tools import StructuredTool
from aafp import ServeBuilder, Request, Response, StreamingHandlerContext
from aafp.cbor import dumps, loads
import json

llm = ChatOpenAI(model="gpt-4-turbo", streaming=True)

def make_aafp_tool(cap_name: str) -> StructuredTool:
    async def _run(**kwargs) -> str:
        r = await discover(cap_name).call(Request(params=kwargs))
        return r.text()
    return StructuredTool.from_function(
        coroutine=_run, name=cap_name.replace("-", "_"),
        description=f"AAFP capability: {cap_name}",
    )

tools = [make_aafp_tool(c) for c in ["search", "web-browse", "code-execute"]]
agent = create_tool_calling_agent(llm, tools, prompt=None)
executor = AgentExecutor(agent=agent, tools=tools, max_iterations=5)

async def langchain_handler(req: Request, ctx: StreamingHandlerContext) -> None:
    params = loads(req.body())
    result = await executor.ainvoke({"input": params["text"]})
    # LangChain's astream_events gives token-level streaming if needed
    await ctx.send(Response.text(dumps({"text": result["output"]})))

aafp_agent = (
    ServeBuilder()
    .capabilities(["tool-use", "text-generation"])
    .on_streaming("tool-use", langchain_handler)
    .keypair(kp).bind("[::]:443").start()
)
```

### 11.2 TypeScript (LangChain.js)

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { DynamicStructuredTool } from "langchain/tools";
import { connect } from "aafp";
import { z } from "zod";

const aafp = await connect().connect();

function aafpTool(cap: string, schema: z.ZodObject) {
  return new DynamicStructuredTool({
    name: cap.replace(/-/g, "_"),
    description: `AAFP capability: ${cap}`,
    schema,
    func: async (input) => {
      const r = await aafp.discover(cap).call({ params: input });
      return r.text;
    },
  });
}

const tools = [
  aafpTool("search", z.object({ query: z.string(), num_results: z.number().optional() })),
  aafpTool("web-browse", z.object({ url: z.string() })),
];

const llm = new ChatOpenAI({ modelName: "gpt-4-turbo", streaming: true });
const executor = AgentExecutor.fromAgentAndTools({
  agent: createToolCallingAgent({ llm, tools }),
  tools,
});

const server = await aafp
  .serve()
  .capabilities(["tool-use", "text-generation"])
  .onStreaming("tool-use", async (req, ctx) => {
    const { text } = req.decodeCbor();
    const result = await executor.invoke({ input: text });
    await ctx.send({ text: result.output });
  })
  .keypair(kp)
  .bind("[::]:443")
  .start();
```

LangChain's built-in streaming (`astream_events`) can be forwarded as
AAFP token frames for true token-level streaming, not just final-output
streaming.

---

## 12. AutoGPT / crewAI / AutoGen Integration Patterns

These higher-level frameworks are *multi-agent orchestrators*. They should
sit **above** AAFP, not be wrapped by it. The integration pattern is to
replace their internal agent-to-agent transport with AAFP, so an AutoGPT
"agent" or a crewAI "crew member" becomes an AAFP agent discovered via the
DHT rather than a hardcoded Python object.

### 12.1 AutoGPT

AutoGPT's agent loop (think → act → observe) maps onto an AAFP `tool-use`
agent whose "tools" are other AAFP agents. Replace AutoGPT's command
registry with AAFP discovery:

```python
# AutoGPT command → AAFP capability
class AafpCommandRegistry:  # drop-in replacement for AutoGPT's CommandRegistry
    def commands(self) -> list[Command]:
        caps = asyncio.run(discover_all())  # query DHT for all capabilities
        return [Command(name=c.name, description=c.metadata.get("description", ""),
                        method=self._make_caller(c.name)) for c in caps]

    def _make_caller(self, cap: str):
        async def _call(**kwargs) -> str:
            return (await discover(cap).call(Request(params=kwargs))).text()
        return _call
```

### 12.2 crewAI

crewAI crews are teams of role-defined agents. Each crew member becomes an
AAFP agent advertising a specialized capability (`researcher`, `writer`,
`reviewer`). The crew's "manager" is an AAFP `tool-use` agent that
delegates to members via discovery. crewAI's `AgentExecutor` is retained
for the per-member LLM loop; only the inter-member transport is AAFP.

```python
from crewai import Agent, Task, Crew

researcher = Agent(
    role="Researcher", goal="Gather facts",
    backstory="...", llm=ChatOpenAI(model="gpt-4-turbo"),
    tools=[aafp_tool("search"), aafp_tool("web-browse")],  # AAFP-backed tools
)
writer = Agent(
    role="Writer", goal="Draft the report",
    backstory="...", llm=ChatOpenAI(model="gpt-4-turbo"),
)
crew = Crew(agents=[researcher, writer],
            tasks=[Task(description="...", agent=researcher),
                   Task(description="...", agent=writer)])
result = crew.kickoff()
```

For full AAFP integration, each `Agent` runs in its own process and is
reached via AAFP rather than in-process; crewAI's process model is
extended with an `AafpAgentAdapter` that wraps `discover(role).call(...)`.

### 12.3 AutoGen

AutoGen's `GroupChat` is the closest analog to AAFP's multi-agent
coordination. The integration replaces AutoGen's in-process message
passing with AAFP PubSub (RFC-0009). Each AutoGen agent subscribes to a
PubSub topic `groupchat:{session_id}` and publishes its messages there;
AAFP's topic-based routing delivers them. This makes AutoGen group chats
span multiple hosts and survive process restarts — something the
in-process version cannot do.

```python
from autogen import ConversableAgent, GroupChat, GroupChatManager
import aafp.pubsub as pubsub

class AafpGroupChatManager(GroupChatManager):
    def __init__(self, session_id: str, agents, **kw):
        super().__init__(agents, **kw)
        self.topic = f"groupchat:{session_id}"
        self.sub = pubsub.subscribe(self.topic)

    async def _aafp_relay(self):
        async for msg in self.sub:
            self.handle_aafp_message(msg)  # inject into the group chat

    async def broadcast(self, msg):
        await pubsub.publish(self.topic, dumps(msg))
```

---

## 13. End-to-End Request Flow

Putting it all together — a client agent asks a question that requires
tool use, streaming, and fallback:

```
Client Agent                     OpenAI AAFP Wrapper                 Tool Agents (DHT)
    │                                    │                                  │
    │ discover("tool-use")               │                                  │
    │      .withMetadata(provider=openai)│                                  │
    │      .callStreaming(...) ─────────►│                                  │
    │                                    │                                  │
    │                                    │ bucket.acquire(1)                │
    │                                    │ client.chat.completions.create(  │
    │                                    │   tools=[search, web-browse])    │
    │                                    │                                  │
    │                                    │ model emits tool_call("search")  │
    │                                    │ discover("search").call(...) ───►│ (Brave wrapper)
    │                                    │ ◄──────── result ────────────────│
    │                                    │ append tool result, re-prompt    │
    │                                    │                                  │
    │ ◄──── token frame (text) ──────────│ stream tokens                    │
    │ ◄──── token frame (text) ──────────│                                  │
    │ ◄──── final frame (usage, cost) ───│                                  │
    │                                    │                                  │
    │ (drops stream → QUIC reset →       │                                  │
    │  CancellationToken fires → wrapper │                                  │
    │  stops pulling from OpenAI)        │                                  │
```

If the OpenAI wrapper hits a 429, `_call_with_fallback` tries the
Anthropic wrapper transparently; the client sees a single AAFP stream and
never knows the model switched (the final frame reports the actual model
used).

---

## 14. Security and Credential Considerations

### 14.1 Credential Isolation

Per `INTERNET_BRIDGE_PLAN.md` §7.1, all credentials live in TrustManager,
encrypted at rest (AES-256-GCM), and are **never exposed to the LLM**. The
wrapper fetches the API key at startup; the model never sees it. This
matters doubly for LLM wrappers because the model could otherwise be
prompt-injected into exfiltrating keys.

### 14.2 Prompt Injection via Tool Results

Tool results fed back to the model are an injection vector (a malicious
web page tells the model to call `code-execute` with harmful code). The
wrapper mitigates this by:

- Marking tool-result messages with a sentinel the model is instructed to
  treat as untrusted data.
- Routing tool calls through UCAN capability attenuation — a delegated
  LLM may only call a subset of tools (e.g., read-only capabilities).
- Applying the action-safety levels from `INTERNET_BRIDGE_PLAN.md` §1.4
  to tool calls: `safe` tools auto-execute, `confirm` tools require client
  approval, `dangerous` tools are blocked unless explicitly authorized.

### 14.3 Cost Bounds

A runaway tool-use loop can spend unbounded tokens. The wrapper enforces
`max_tool_rounds` (default 5) and a per-session cost ceiling
(`ConversationPolicy.max_cost_micro_usd`). When the ceiling is hit, the
wrapper returns an error rather than continuing.

---

## 15. Relationship to the Strategic Vision

This integration realizes several strands of `STRATEGIC_VISION.md`:

- **"Capabilities, not hardcoded integrations."** GPT-4 and Claude are
  capabilities (`text-generation`, `tool-use`), discovered by name, not
  hardcoded endpoints.
- **"The protocol should disappear."** A developer writes
  `discover("text-generation").callStreaming(...)` and never learns that
  QUIC, UCAN, or the DHT are involved.
- **"Execution Fabric."** An LLM's tool calls become AAFP pipeline
  assembly: `text-generation → search → web-browse → analysis`, with no
  human wiring.
- **"Network effects, not cryptography."** Fallback chains, cost-aware
  routing, and federated key pooling get stronger with every LLM wrapper
  that joins. A single OpenAI wrapper is a proxy; a network of wrappers
  sharing rate-limit quotas and fallbacks is a market.
- **"Don't become the blockchain of AI."** AAFP does not host model
  weights or run inference. It leaves that to OpenAI, Anthropic, and local
  GPU owners. It is the glue.

---

## 16. Open Questions / Future Work

1. **Model-native streaming schema.** Should AAFP define a single
   `TokenChunk` schema (§3.2) as an RFC, or leave it to capability
   metadata? A standard schema would let clients swap providers without
   re-parsing, but providers differ (Anthropic has content blocks, OpenAI
   has function deltas). Candidate: RFC-0018 "LLM Streaming Schema".
2. **Attested quality.** Self-reported `aafp.perf.v1` is a claim. Who
   attests LLM quality? Possibly a reputation agent that runs benchmark
   prompts against each provider and signs attestations.
3. **Economic layer.** Cost ledgers (§6.3) feed the future Economic Layer
   (`STRATEGIC_VISION.md`). Micropayment settlement for token usage is
   out of scope here but the usage accounting is in place.
4. **Local-model wrappers.** Ollama / vLLM / llama.cpp wrappers follow the
   same pattern but with `per_token_micro_usd = 0` (or electricity-cost
   based). They are the fallback tier in §8 and the privacy-preserving
   option for sensitive prompts.
5. **Multimodal.** `vision` capability carries image input. The
   agent-native content schema (RFC-0016) already represents images with
   OCR/captions; an LLM `vision` call can consume that schema directly
   rather than raw bytes.

---

## Conclusion

Wrapping frontier LLMs as AAFP agents is straightforward because AAFP's
Phase 2 features — streaming RPC (P2.8), session affinity (P2.7),
AgentRecord extensions, semantic capability graphs — were designed for
exactly this. The wrapper is ~300 lines of Python; the hard parts
(discovery, transport, trust, rate-limit coordination) are the network's
job.

The strategic payoff is that the open graph subsumes the closed silos.
GPT-4 and Claude become pluggable capability providers behind a uniform,
streaming, cost-aware, fallback-capable interface. Every new wrapper that
joins strengthens routing, rate-limit pooling, and fallback redundancy —
the TCP/IP effect, applied to LLMs.

**Next action:** implement the OpenAI wrapper (§9) as the reference LLM
AAFP agent, draft RFC-0018 (LLM Streaming Schema), and wire it into the
Phase 4A capability set alongside `search` and `web-browse`.
