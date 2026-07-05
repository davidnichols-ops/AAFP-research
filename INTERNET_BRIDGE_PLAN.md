# AAFP Internet Bridge Plan — The World Perception Layer

**Author:** Devin (CEO/architect), synthesized from 4 parallel research investigations
**Date:** 2026-07-04
**Status:** Adopted as Phase 4 architecture blueprint
**Prerequisite:** Phase 2 (developer experience) substantially complete

---

## Executive Summary

This document synthesizes four parallel research investigations into a single
actionable plan for building AAFP's **World Perception Layer** — the bridge
between AAFP agents and the real-world internet (web pages, APIs, documents,
media, code execution, real-time data).

The four investigations covered:
1. **Agent-native web content representation** — a schema for how the web
   appears to agents (not HTML, not screenshots, but structured semantic
   documents)
2. **Stateful browsing sessions** — how agents maintain and share browser
   state across multiple calls and multiple agents
3. **Protocol augmentation** — 15 augmentations to accelerate internet
   operations, most implementable as capability providers (no RFC changes)
4. **Real-world internet bridge architectures** — the landscape of existing
   tools (Firecrawl, Jina Reader, Brave Search, Playwright MCP, etc.) and
   what AAFP should wrap vs. build

**Key conclusion:** AAFP should **wrap existing best-of-breed tools** as
capability providers, **define an agent-native content schema** as its
primary contribution, and **leverage AAFP's DHT, PubSub, and TrustManager**
for coordination. The moat is the network, not the scraping infrastructure.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    APPLICATIONS LAYER                            │
│  Agents requesting: search, web-browse, document-read, etc.     │
├─────────────────────────────────────────────────────────────────┤
│              WORLD PERCEPTION LAYER (AAFP)                       │
│                                                                 │
│  Well-known capabilities:                                       │
│  - search        (federated: Brave + SerpApi + SearXNG)         │
│  - web-browse    (Firecrawl wrapper + self-hosted Playwright)   │
│  - document-read (PyMuPDF + Tesseract + unified schema)         │
│  - api-call      (HTTP client + credential store)               │
│  - api-discover  (OpenAPI parser + tool generator)              │
│  - code-execute  (Firecracker/WASM sandbox + validation)        │
│  - image-ocr     (Tesseract + Google Vision)                    │
│  - audio-transcribe (Whisper + Deepgram)                        │
│  - crawl         (DHT frontier + politeness + deduplication)    │
│  - real-time-subscribe (Webhook receiver + PubSub)              │
│  - stealth-browse (Browserless + Bright Data for anti-bot)      │
│                                                                 │
│  Cross-cutting:                                                 │
│  - Agent-native content schema (RFC-0016)                       │
│  - Stateful browsing sessions (RFC-0017)                        │
│  - Streaming RPC conventions                                    │
│  - Content cache + cache control                                │
│  - Robots.txt awareness                                         │
│  - Distributed rate limiting (RFC-0015)                         │
├─────────────────────────────────────────────────────────────────┤
│                   EXTERNAL SERVICES (wrapped)                    │
│  Firecrawl, Jina Reader, Brave Search, Diffbot, Browserless,    │
│  Bright Data, Apify, Boxed, Whisper, Deepgram, Tesseract        │
├─────────────────────────────────────────────────────────────────┤
│                     AAFP CORE LAYER                             │
│  DHT (discovery + frontier), PubSub (real-time),                │
│  TrustManager (credentials), Transport (QUIC)                   │
└─────────────────────────────────────────────────────────────────┘
```

**Key principles:**
1. **Well-known capabilities** — standard names every AAFP network implements
2. **Service wrappers** — external services wrapped as AAFP capabilities
3. **Agent-native schema** — standard content representation across all
   capabilities (this is AAFP's contribution; no one else has this)
4. **AAFP strengths** — DHT, PubSub, TrustManager leveraged throughout
5. **Federation** — multiple providers per capability for redundancy
6. **Discoverability** — agents discover capabilities by name, not endpoints

---

## Part 1: Agent-Native Content Representation

### 1.1 The Problem

Current approaches to representing web content to LLMs/agents:

| Approach | Token Cost | Determinism | Best For |
|----------|-----------|-------------|----------|
| Screenshots (base64) | High (4,800+) | Low (coordinates) | Visual tasks |
| Accessibility tree | Low (200-400) | High (element refs) | Forms, navigation |
| Raw HTML | Very high (10,000+) | Medium | Scraping |
| Cleaned markdown | Medium (1,000-2,000) | High | Reading |
| Extracted JSON | Low (100-500) | Very high | Product pages |

**No standard exists** for agent-native representation. This is AAFP's
opportunity to define one.

### 1.2 The Schema (RFC-0016 Candidate)

```cbor
WebContent = {
    1: tstr,           // "url": Source URL
    2: tstr,           // "title": Page title
    3: PageMetadata,   // "metadata": Headers, status, content-type
    4: NavigationState,// "nav": Current URL, history, can-go-back/forward
    5: [*ContentSection], // "sections": Semantic content blocks
    6: [*InteractiveElement], // "elements": Clickable elements with refs
    7: [*FormDef],     // "forms": Forms with fields
    8: [*MediaItem],   // "media": Images, videos with captions/OCR
    9: [*LinkDef],     // "links": All links with text and target
    10: [*StructuredData], // "structured": JSON-LD, microdata, schema.org
    11: [*Entity],     // "entities": Named entities (people, orgs, places)
    12: ContentHash,   // "hash": Stable hash for change detection
}

ContentSection = {
    1: tstr,           // "id": "@s0", "@s1", etc.
    2: tstr,           // "selector": CSS selector
    3: tstr / null,    // "title": Section heading if any
    4: tstr,           // "content": Text content (markdown)
    5: float,          // "importance": 0.0-1.0
}

InteractiveElement = {
    1: tstr,           // "ref": "@e0", "@e1", etc. (stable hash-based)
    2: tstr,           // "selector": CSS selector
    3: tstr,           // "tag": button, a, input, select, etc.
    4: tstr,           // "label": Visible text or aria-label
    5: tstr / null,    // "role": ARIA role
    6: ActionSafety,   // "safety": safe | confirm | dangerous | unknown
    7: [*Action],      // "actions": What can be done (click, type, etc.)
}

ActionSafety = "safe" / "confirm" / "dangerous" / "unknown"

Action = {
    1: tstr,           // "type": "click", "type", "select", "submit"
    2: tstr / null,    // "value": For type/select actions
    3: tstr,           // "description": Human-readable description
}

FormDef = {
    1: tstr,           // "ref": "@f0", "@f1", etc.
    2: tstr,           // "selector": CSS selector
    3: tstr / null,    // "action": Form action URL
    4: tstr,           // "method": GET, POST
    5: [*FormField],   // "fields": Form fields
}

FormField = {
    1: tstr,           // "ref": "@f0.0", etc.
    2: tstr,           // "name": Field name
    3: tstr,           // "type": text, email, password, checkbox, etc.
    4: bool,           // "required": Is field required
    5: tstr / null,    // "label": Field label
    6: tstr / null,    // "value": Current value
    7: [*tstr] / null, // "options": For select/radio
}

MediaItem = {
    1: tstr,           // "ref": "@m0", etc.
    2: tstr,           // "type": image, video, audio
    3: tstr,           // "src": Source URL
    4: tstr / null,    // "alt": Alt text or caption
    5: tstr / null,    // "ocr_text": OCR text if image contains text
    6: [uint]          // "bbox": [x1, y1, x2, y2] if position matters
}

LinkDef = {
    1: tstr,           // "ref": "@l0", etc.
    2: tstr,           // "url": Target URL
    3: tstr,           // "text": Link text
    4: bool,           // "external": Is external link
}

StructuredData = {
    1: tstr,           // "type": "json-ld", "microdata", "schema.org"
    2: any,            // "data": The structured data
}

Entity = {
    1: tstr,           // "type": person, organization, location, etc.
    2: tstr,           // "name": Entity name
    3: float,          // "confidence": 0.0-1.0
    4: tstr,           // "selector": Where in the page
}

ContentHash = bstr    // SHA-256 of normalized content for change detection

PageMetadata = {
    1: uint,           // "status_code": HTTP status
    2: tstr,           // "content_type": MIME type
    3: tstr / null,    // "description": Meta description
    4: tstr / null,    // "author": Meta author
    5: tstr / null,    // "published_date": Article publish date
    6: tstr / null,    // "modified_date": Article modify date
    7: [*tstr],        // "keywords": Meta keywords
}

NavigationState = {
    1: tstr,           // "current_url": Current URL
    2: bool,           // "can_go_back": History has previous
    3: bool,           // "can_go_forward": History has next
    4: uint,           // "history_length": Number of history entries
}
```

### 1.3 Ref-Based Targeting

Elements are referenced by stable IDs (`@e0`, `@s1`, `@f0`, `@m2`, `@l5`)
rather than coordinates or CSS selectors. This provides:

- **Stability**: Refs survive minor layout changes
- **Determinism**: Same element → same ref across calls
- **Token efficiency**: `click("@e3")` vs `click(523, 187)` or long CSS selectors
- **Multi-agent coordination**: Agent A says "click @e3", Agent B knows exactly what

**Stable hashing:** Refs are assigned by hashing `(tag, role, text, position)`
so the same element gets the same ref across page loads, even if order changes
slightly. Re-numbering only happens on structural changes.

### 1.4 Action Safety Levels

Every interactive element has a safety classification:

| Level | Meaning | Examples |
|-------|---------|----------|
| `safe` | Read-only, no side effects | Links to same site, search buttons |
| `confirm` | Side effects, reversible | Form submission, login |
| `dangerous` | Irreversible or financial | Delete, purchase, money transfer |
| `unknown` | Cannot classify | Custom JS handlers |

Agents can configure policy: "auto-execute safe, ask for confirm, block dangerous."

### 1.5 Document-Native Extension

The same schema extends to non-web documents (PDF, Word, Excel):

```cbor
DocumentContent = {
    1: tstr,           // "source": URL or file path
    2: tstr,           // "type": pdf, word, excel, powerpoint, image
    3: DocumentMetadata, // "metadata": title, author, pages, language
    4: [*ContentSection], // "sections": Semantic sections
    5: [*TableDef],    // "tables": Extracted tables
    6: [*MediaItem],   // "images": Images with OCR/captions
    7: tstr,           // "text": Full text content
    8: tstr / null,    // "summary": AI-generated summary
    9: ContentHash,    // "hash": For change detection
}

TableDef = {
    1: tstr,           // "ref": "@t0", etc.
    2: [*tstr],        // "headers": Column headers
    3: [[*tstr]],      // "rows": Row data
    4: [uint] / null,  // "bbox": Bounding box if spatial
}
```

---

## Part 2: Stateful Browsing Sessions

### 2.1 The Problem

Agents don't just fetch URLs. They **navigate** — click, scroll, fill forms,
wait for dynamic content, execute JavaScript, take screenshots. A browsing
agent must maintain session state that other agents can drive.

### 2.2 Session Lifecycle

```
[CREATING] → [ACTIVE] → [IDLE] → [RESUMING] → [ACTIVE] → [DESTROYED]
     │            │         │           │            │           │
  Launch      Ready     Timeout     Reconnect   Inactivity   Close
  browser    for ops   (no ops    after       (no ops    and
                         for 30m)   network     for 1h)    cleanup
                                    recovery
```

| Transition | Trigger | Action |
|-----------|---------|--------|
| None → Creating | `create_session()` | Launch browser, create BrowserContext |
| Creating → Active | Browser ready | Return session_id, initial state |
| Active → Idle | 30m inactivity | Pause browser, persist state |
| Idle → Resuming | `resume_session()` | Restore browser, reload state |
| Resuming → Active | State restored | Ready for operations |
| Active → Destroyed | `destroy_session()` | Close browser, cleanup |
| Any → Error | Crash/timeout | Mark error, allow recovery |

**Timeouts:**
- Idle timeout: 30 minutes → pause browser
- Session timeout: 24 hours → destroy session
- Operation timeout: 30 seconds per operation
- Network recovery: auto-retry with exponential backoff (max 3)

### 2.3 Session State Schema (RFC-0017 Candidate)

```cbor
SessionState = {
    1: tstr,           // "session_id": Unique identifier
    2: tstr,           // "url": Current URL
    3: tstr,           // "title": Page title
    4: tstr,           // "status": creating|active|idle|resuming|destroyed|error
    5: [*Cookie],      // "cookies": Browser cookies
    6: StorageState,   // "storage": localStorage + sessionStorage
    7: ScrollPosition, // "scroll": (x, y) pixels
    8: FormInputs,     // "forms": Current form field values
    9: NavigationHistory, // "history": Back/forward stack
    10: [*TabInfo],    // "tabs": Open tabs
    11: SessionMetadata, // "metadata": created_at, last_activity, owner
}

Cookie = {
    1: tstr, 2: tstr, 3: tstr, 4: tstr,  // name, value, domain, path
    5: uint / null,   // expires
    6: bool, 7: bool, // http_only, secure
    8: tstr,          // same_site: Strict|Lax|None
}

StorageState = {
    1: {* tstr: {* tstr: tstr}}, // "local": origin -> {key: value}
    2: {* tstr: {* tstr: tstr}}, // "session": origin -> {key: value}
}

ScrollPosition = [int, int]  // [x, y]

FormInputs = {
    1: {* tstr: tstr},    // "by_id": element_id -> value
    2: {* tstr: tstr},    // "by_xpath": xpath -> value
}

NavigationHistory = {
    1: int,              // "current": Current index
    2: [*HistoryEntry],  // "entries": History entries
}

TabInfo = {
    1: tstr, 2: tstr, 3: tstr, 4: bool  // id, url, title, active
}
```

### 2.4 RPC Methods

| Method | Request | Response | Lock | Timeout |
|--------|---------|----------|------|---------|
| `browse.create_session` | viewport, headless | session_id, state | None | 10s |
| `browse.navigate` | session_id, url, wait_until | state | Exclusive | 30s |
| `browse.click` | session_id, ref | state | Exclusive | 10s |
| `browse.type` | session_id, ref, text | state | Exclusive | 10s |
| `browse.scroll` | session_id, direction, amount | scroll_pos, state | Exclusive | 5s |
| `browse.screenshot` | session_id, format, full_page | image bytes | Shared | 5s |
| `browse.extract` | session_id, ref?, format | WebContent | Shared | 10s |
| `browse.submit` | session_id, ref? | state | Exclusive | 10s |
| `browse.back` | session_id | state | Exclusive | 10s |
| `browse.forward` | session_id | state | Exclusive | 10s |
| `browse.get_state` | session_id | SessionState | None | 5s |
| `browse.destroy_session` | session_id, persist? | persisted_state? | None | 5s |

### 2.5 UCAN Delegation for Sessions

**Capability namespace:**
```
aafp://browse/
  ├─ create
  └─ session/{session_id}/
      ├─ navigate
      ├─ click
      ├─ type
      ├─ scroll
      ├─ screenshot
      ├─ extract
      ├─ submit
      ├─ back
      ├─ forward
      ├─ get_state
      └─ destroy
```

**Delegation patterns:**
- **Full session:** `aafp://browse/session/123/*` — all operations
- **Scoped:** `aafp://browse/session/123/{navigate,click,type}` — specific ops
- **Read-only:** `aafp://browse/session/123/{screenshot,extract,get_state}`
- **Single-use:** `aafp://browse/session/123/submit` with nonce

**Validation on every operation:**
1. Verify UCAN signature (ML-DSA-65)
2. Check time bounds (nbf ≤ now ≤ exp)
3. Verify proof chain
4. Check audience matches calling agent
5. Check capability matches operation
6. Check session_id matches
7. Check additional constraints (allowed_urls, nonce)

### 2.6 Multi-Agent Concurrency

**Problem:** Two agents try to click different buttons simultaneously.

**Solution:** Session lock manager with operation queue.

| Lock Type | Scope | Use Case |
|-----------|-------|----------|
| Exclusive | Entire session | Mutating ops (click, type, submit) |
| Shared | Read-only | Non-mutating (screenshot, extract) |
| None | No lock | State queries (get_state) |

**Deadlock prevention:**
- Lock timeout: 30 seconds max, auto-release
- Queue timeout: 5 minutes max, return error
- Watchdog: background task monitors stuck locks

### 2.7 Browser Engine

**Primary: chromiumoxide** (Rust, full CDP support, async-native)

| Metric | Value |
|--------|-------|
| Browser launch | 2-5 seconds (cold start) |
| Page navigation | 0.5-2 seconds |
| Screenshot | 0.1-0.5 seconds |
| Memory per session | 100-300 MB |
| Concurrent sessions | 5-10 per host |

**Optional: Browserless.io** for scale and anti-bot bypass.

---

## Part 3: Protocol Augmentations

### 3.1 Summary: 15 Augmentations

Most augmentations are **capability providers** (no RFC changes). Only 4
require new RFCs. The frozen wire protocol (Rev 6) is never touched.

| Augmentation | Type | Priority | RFC? |
|-------------|------|----------|------|
| Streaming RPC patterns | Capability provider | P1 | No |
| Backpressure handling | Capability provider | P1 | No |
| Agent-level content cache | Capability provider | P1 | No |
| Cache invalidation (Cache-Control) | Capability provider | P1 | No |
| Robots.txt awareness | Capability provider | P1 | No |
| Chunked transfer encoding | Capability provider | P2 | No |
| Compression strategy (zstd) | Capability provider | P2 | No |
| PubSub for web monitoring | Capability provider | P2 | No (RFC-0009) |
| Priority queues | Capability provider | P2 | No |
| Predictive prefetching | Capability provider | P2 | No |
| Parallel fetching | Capability provider | P2 | No |
| Auth for web browsing | Capability provider | P2 | No |
| Privacy: browsing history | Capability provider | P2 | No |
| DHT-based content caching | New RFC | P2 | RFC-0012 |
| Content-addressable storage | New RFC | P3 | RFC-0013 |
| Multicast content distribution | New RFC | P3 | RFC-0014 |
| Distributed rate limiting | New RFC | P2 | RFC-0015 |

### 3.2 Phase 1 Augmentations (P1 — Foundation, 6-8 weeks)

These provide the foundation for all internet operations:

1. **Streaming RPC patterns** — Standardize server-streaming, client-streaming,
   and bidirectional streaming using existing QUIC streams. Convention only,
   no wire changes. (2-3 weeks)

2. **Backpressure handling** — Helpers and guidelines for respecting QUIC
   flow control. Prevents buffer exhaustion on large content. (1 week)

3. **Agent-level content cache** — LRU cache with TTL, respects HTTP
   Cache-Control. Default 1GB, optional persistent (SQLite/RocksDB). (3-4 weeks)

4. **Cache invalidation** — Parse HTTP Cache-Control, ETag, Last-Modified.
   Conditional revalidation (If-None-Match / If-Modified-Since). (2-3 weeks)

5. **Robots.txt awareness** — Fetch and parse robots.txt before crawling.
   Enforce Disallow rules, respect Crawl-delay. RFC 9309 compliance. (2 weeks)

### 3.3 Phase 2 Augmentations (P2 — Coordination, 12-16 weeks)

6. **Chunked transfer** — Standardized chunking for >1MiB content using
   existing DATA frame MORE flag. (1-2 weeks)

7. **Compression** — zstd for text content (60-80% reduction). Use
   compression flag (0x02) in DATA frame. (1 week)

8. **PubSub web monitoring** — Use existing RFC-0009 floodsub for URL
   change notifications. Topic: `web-monitor:{domain}:{path}`. (1-2 weeks)

9. **Priority queues** — Per-agent, per-domain priority queues. Urgent
   fetches preempt background crawls. Weighted fair queuing. (3-4 weeks)

10. **Predictive prefetching** — Markov chain model for URL prediction.
    Background prefetch when idle. Conservative predictions only. (4-6 weeks)

11. **Parallel fetching** — Distribute URLs across agents. Per-domain
    rate limit coordination. Aggregate results. (2-3 weeks)

12. **Web auth credentials** — Encrypted credential store (AES-256-GCM).
    Cookies, bearer tokens, API keys. Never sent over AAFP. (3-4 weeks)

13. **Privacy: browsing history** — Configurable logging, encrypted at
    rest, configurable retention. Never shared over AAFP. (1-2 weeks)

### 3.4 Phase 3 Augmentations (P3 — Distributed, requires RFCs)

14. **DHT-based content caching** (RFC-0012) — Agents share cached content
    like a CDN. DHT key: `SHA-256(url)` → provider list. (8-12 weeks)

15. **Content-addressable storage** (RFC-0013) — IPFS-compatible CIDs.
    Pinning, provider discovery, garbage collection. (10-14 weeks)

16. **Multicast distribution** (RFC-0014) — Tree-based content distribution
    via PubSub. NACK-based retransmission. (10-12 weeks)

17. **Distributed rate limiting** (RFC-0015) — Prevent collective DDoS.
    DHT-based quota, gossip coordination, per-domain enforcement. (12-16 weeks)

---

## Part 4: Internet Bridge Capabilities

### 4.1 Prioritized Capability List

| Priority | Capability | What It Does | Build Order |
|----------|------------|--------------|-------------|
| **P0** | `search` | Federated web search | 1 |
| **P0** | `web-browse` | Fetch pages, return agent-native content | 1 |
| **P0** | `document-read` | Parse PDFs/Office docs | 2 |
| **P1** | `api-call` | Call REST APIs with auth | 2 |
| **P1** | `api-discover` | Auto-discover APIs from OpenAPI | 3 |
| **P1** | `code-execute` | Execute code in sandbox | 3 |
| **P2** | `image-ocr` | Extract text from images | 4 |
| **P2** | `audio-transcribe` | Transcribe audio | 4 |
| **P2** | `structured-extract` | Diffbot-style structured extraction | 5 |
| **P3** | `stealth-browse` | Anti-bot bypass (Browserless) | 5 |
| **P3** | `real-time-subscribe` | Webhook receiver + PubSub | 6 |
| **P3** | `crawl` | Distributed web crawling | 6 |
| **P4** | `video-understand` | Video frame extraction + VLM | 7 |

### 4.2 Capability Specifications

#### `search` (P0)

**What:** Federated web search returning structured results.

**Providers:** Brave Search API (primary, independent index, 30B pages),
SerpApi (Google fallback), SearXNG (self-hosted backup).

**Input:**
```json
{
  "query": "AI agent architectures",
  "num_results": 10,
  "sources": ["brave", "serpapi"],
  "time_range": "any|day|week|month|year",
  "fetch_content": false
}
```

**Output:**
```json
{
  "query": "...",
  "results": [
    {"title": "...", "url": "...", "snippet": "...", "score": 0.95, "source": "brave"}
  ],
  "total": 10,
  "latency_ms": 234
}
```

**Rate limiting:** Per-agent quota (100/hr), network-wide API key pooling.

**Complexity:** Low (1-2 weeks)

---

#### `web-browse` (P0)

**What:** Fetch web pages, return agent-native content (Part 1 schema).

**Implementation:** Start with Firecrawl wrapper (fastest), add self-hosted
Playwright later for cost control.

**Input:**
```json
{
  "url": "https://example.com",
  "format": "agent-native|markdown|html|accessibility",
  "wait_for": "domcontentloaded|load|networkidle",
  "screenshot": false
}
```

**Output:** `WebContent` (Part 1 schema) or markdown/HTML per format.

**Complexity:** Medium (2-3 weeks)

---

#### `document-read` (P0)

**What:** Parse PDFs, Word, Excel, PowerPoint → structured content.

**Stack:** PyMuPDF (PDF, fastest), Apache Tika (multi-format), Tesseract (OCR),
python-docx/openpyxl/python-pptx (Office).

**Input:**
```json
{
  "source": "https://example.com/doc.pdf",
  "type": "auto|pdf|word|excel|powerpoint",
  "ocr": true,
  "extract_tables": true
}
```

**Output:** `DocumentContent` (Part 1.5 schema).

**Complexity:** Medium (2-3 weeks)

---

#### `api-call` (P1)

**What:** Call REST APIs with authentication managed by TrustManager.

**Security:** Credentials never exposed to LLM. Per-API allowlist. Rate
limiting per API. Network-wide API key pooling.

**Input:**
```json
{
  "api_name": "github",
  "method": "GET",
  "path": "/repos/owner/repo",
  "body": null
}
```

**Complexity:** Medium (2 weeks)

---

#### `api-discover` (P1)

**What:** Auto-discover APIs from OpenAPI specs, register as capabilities.

**Flow:** Probe `/openapi.json`, `/swagger.json`, `/api-docs` → parse spec →
generate tool definitions → register as dynamic capabilities.

**Safeguards:** Domain allowlist, read-only by default (GET/HEAD only),
explicit approval for POST/PUT/DELETE.

**Complexity:** High (3-4 weeks)

---

#### `code-execute` (P1)

**What:** Execute code in sandboxed environment.

**Sandbox:** Firecracker microVM (strongest isolation, 125ms startup) for
untrusted code. WASM (10ms startup) for trusted code.

**Security:** Network disabled by default, hard timeout (30s), resource
limits (CPU/memory/disk), code validation, audit logging.

**Input:**
```json
{
  "code": "print('hello')",
  "language": "python",
  "timeout": 30,
  "network": false
}
```

**Complexity:** High (4-5 weeks)

---

#### `crawl` (P3)

**What:** Distributed web crawling using AAFP DHT.

**Architecture:**
```
Seed URLs → DHT (URL frontier)
    ↓
Multiple Crawler Agents (discover "crawl" capability)
    ↓
Each agent:
  1. Claim URL from DHT (compare-and-swap)
  2. Check robots.txt (local cache + DHT)
  3. Enforce politeness (per-host delay)
  4. Fetch page
  5. Extract links
  6. Deduplicate (local Bloom filter + DHT seen-set)
  7. Store/publish content
  8. Return new URLs to DHT
```

**AAFP advantages over traditional crawlers:**
- No single point of failure (decentralized)
- Dynamic scaling (add agents during crawl)
- Specialization (different agents for different content types)
- Real-time processing (PubSub streaming)
- Trust-based (only trusted agents crawl sensitive domains)

**Complexity:** High (6-8 weeks)

---

### 4.3 What to Wrap vs. Build

**Wrap (use existing services):**
- Firecrawl → `web-browse` (all-in-one scraping, MCP-native)
- Jina Reader → `document-read` (handles PDFs, Office docs, simple URL prefix)
- Brave Search → `search` (independent index, AI-optimized)
- Diffbot → `structured-extract` (rule-less extraction)
- Browserless → `stealth-browse` (anti-bot bypass)
- Boxed → `code-execute` (sovereign code execution engine)
- Whisper/Deepgram → `audio-transcribe`

**Build (doesn't exist, AAFP's contribution):**
- Agent-native content schema (RFC-0016) — no standard exists
- Stateful browsing sessions with UCAN delegation (RFC-0017) — no multi-agent
  session sharing exists
- Distributed agent-based crawling — traditional crawlers are centralized
- Federated search with agent-native results — current APIs return web-native
  results
- Capability-based API discovery — current tools don't integrate with agent
  networks
- Trust-based content access — reputation-based routing for content

---

## Part 5: Implementation Roadmap

### Phase 4A: Foundation (Weeks 1-4)

**Goal:** Basic internet interaction — search, browse, read documents.

| Week | Capability | Key Integration |
|------|-----------|-----------------|
| 1-2 | `search` | Brave Search API + SerpApi fallback |
| 2-3 | `web-browse` | Firecrawl wrapper + agent-native schema |
| 3-4 | `document-read` | PyMuPDF + Tesseract + unified schema |

**Deliverable:** Agents can search the web, browse pages, and read documents.

**Also in Phase 4A:**
- Define agent-native content schema (RFC-0016 draft)
- Implement streaming RPC conventions
- Implement agent-level content cache
- Implement robots.txt awareness

### Phase 4B: API Integration (Weeks 5-8)

**Goal:** API calling and discovery.

| Week | Capability | Key Integration |
|------|-----------|-----------------|
| 5-6 | `api-call` | HTTP client + credential store |
| 7-8 | `api-discover` | OpenAPI parser + tool generator |

**Deliverable:** Agents can call and discover APIs.

**Also in Phase 4B:**
- Implement stateful browsing sessions (RFC-0017 draft)
- Implement UCAN delegation for sessions
- Implement session lock manager
- Integrate chromiumoxide for self-hosted browsing

### Phase 4C: Advanced Capabilities (Weeks 9-14)

**Goal:** Code execution and media processing.

| Week | Capability | Key Integration |
|------|-----------|-----------------|
| 9-12 | `code-execute` | Firecracker or Boxed |
| 13-14 | `image-ocr` + `audio-transcribe` | Tesseract + Whisper |

**Deliverable:** Agents can execute code and process media.

**Also in Phase 4C:**
- Implement compression (zstd)
- Implement chunked transfer
- Implement web auth credentials
- Implement privacy controls

### Phase 4D: Specialized Capabilities (Weeks 15-20)

**Goal:** Anti-bot, real-time, distributed crawling.

| Week | Capability | Key Integration |
|------|-----------|-----------------|
| 15-16 | `stealth-browse` | Browserless |
| 17-18 | `real-time-subscribe` | Webhook + PubSub |
| 19-20 | `crawl` | DHT frontier + politeness |

**Deliverable:** Full-featured internet bridge.

**Also in Phase 4D:**
- Start RFC process for RFC-0012 (DHT caching)
- Start RFC process for RFC-0015 (distributed rate limiting)
- Implement predictive prefetching
- Implement parallel fetching

### Phase 4E: Future (Weeks 21+)

- RFC-0013 (content-addressable storage)
- RFC-0014 (multicast distribution)
- `video-understand` capability
- `structured-extract` with Diffbot
- Edge agents on CDN nodes

---

## Part 6: New RFCs Required

| RFC | Title | Priority | Timeline |
|-----|-------|----------|----------|
| RFC-0012 | DHT-Based Content Caching | P2 | Phase 4D |
| RFC-0013 | Content-Addressable Storage | P3 | Phase 4E |
| RFC-0014 | Multicast Content Distribution | P3 | Phase 4E |
| RFC-0015 | Distributed Rate Limiting | P2 | Phase 4D |
| RFC-0016 | Agent-Native Content Schema | P0 | Phase 4A |
| RFC-0017 | Stateful Browsing Sessions | P1 | Phase 4B |

**RFC-0016 and RFC-0017 are the highest priority** — they define AAFP's
unique contribution (agent-native representation and multi-agent session
sharing). The others enhance performance and coordination but are not
strictly required for MVP.

---

## Part 7: Security Considerations

### 7.1 Credential Management
- All credentials stored in TrustManager, encrypted at rest (AES-256-GCM)
- Credentials never exposed to LLMs
- Per-API allowlist
- OAuth token refresh handled automatically
- Session cookies stored in session state, never shared over AAFP

### 7.2 Code Execution
- Firecracker microVM for untrusted code (hardware isolation)
- WASM for trusted code (runtime isolation, 10ms startup)
- Network disabled by default
- Hard timeout enforcement (30s default)
- Resource limits (CPU, memory, disk)
- Code validation (block dangerous operations)
- Audit logging of all executions

### 7.3 Web Browsing
- UCAN validation on every session operation
- Session binding (UCAN session_id must match)
- Action safety levels (safe, confirm, dangerous, unknown)
- Robots.txt compliance (RFC 9309)
- Distributed rate limiting (prevent collective DDoS)
- Privacy controls (configurable history logging)

### 7.4 Content Integrity
- Content hashing for tamper detection
- Content-addressable storage for verification
- ETag-based revalidation
- Signed content from trusted agents

---

## Part 8: Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Agent can search the web | <2s latency | `search` capability benchmark |
| Agent can browse a page | <3s latency | `web-browse` capability benchmark |
| Agent can read a PDF | <5s for 10-page PDF | `document-read` benchmark |
| Agent-native content token cost | <500 tokens per page | Compare to raw HTML |
| Session creation | <5s cold start | `browse.create_session` benchmark |
| Multi-agent session sharing | UCAN delegation <100ms | Delegation benchmark |
| Code execution cold start | <300ms (Firecracker) | `code-execute` benchmark |
| Cache hit rate | >60% for repeated fetches | Cache metrics |
| Robots.txt compliance | 100% | Conformance test |

---

## Part 9: The Moat

AAFP's durable advantage is **not** in scraping infrastructure (Firecrawl,
Jina Reader, etc. are commodities). The moat is:

1. **Agent-native content schema** — No standard exists. If AAFP defines
   it and it gains adoption, it becomes the standard for agent-internet
   interaction.

2. **Multi-agent session sharing** — No existing tool allows Agent A to
   create a browsing session and delegate specific capabilities to Agent B
   with cryptographic proof. This is uniquely enabled by AAFP's UCAN system.

3. **Distributed agent-based crawling** — Traditional crawlers are
   centralized. AAFP can build the first truly decentralized crawler
   leveraging DHT + PubSub + trust.

4. **Federated capability discovery** — Agents discover capabilities by
   name, not hardcoded endpoints. Network effect: more agents → more
   capabilities → more valuable network.

5. **Trust-based content access** — Reputation-based routing. Only
   trusted agents can access sensitive content. No existing scraper has this.

6. **Network effects** — Every new agent that joins improves discovery,
   caching, rate limit coordination, and overall capability. This is the
   TCP/IP effect applied to AI agents.

---

## Conclusion

The World Perception Layer transforms AAFP from an intranet (agents talking
to agents) into the internet (agents perceiving and acting on the real
world). The strategy is clear:

1. **Wrap, don't rebuild** — Use Firecrawl, Jina Reader, Brave Search,
   Boxed as capability providers. These are commodities.
2. **Define the schema** — Agent-native content representation (RFC-0016)
   and stateful sessions (RFC-0017) are AAFP's unique contributions.
3. **Leverage AAFP strengths** — DHT for distributed crawling, PubSub for
   real-time data, TrustManager for credentials, UCAN for session delegation.
4. **Build the network** — Every capability provider that joins makes the
   network more valuable. This is the moat.

**Timeline:** 20 weeks to full World Perception Layer. 8 weeks to MVP
(P0 capabilities: search, web-browse, document-read).

**Next action:** Begin Phase 4A — implement `search` and `web-browse`
capabilities, draft RFC-0016 (agent-native content schema).
