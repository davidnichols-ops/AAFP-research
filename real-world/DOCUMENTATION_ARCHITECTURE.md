# AAFP Documentation Architecture

This document specifies the documentation system for the AAFP protocol
umbrella — the hierarchy of artifacts, the tooling that produces them, the
structure of the documentation site, and the conventions that keep
documentation correct, discoverable, and versioned alongside the protocol it
describes.

AAFP is a protocol umbrella: the **protocol** (RFCs) is the primary artifact,
and implementations are references that prove the RFCs are implementable and
interoperable. The documentation system reflects that priority. RFCs are the
source of truth; everything else — design docs, guides, API reference,
examples — derives from or references them. No prose in a guide may contradict
an RFC. When a guide and an RFC disagree, the RFC wins and the guide is a bug.

---

## 1. Documentation Hierarchy

Documentation is organized as a five-tier hierarchy. Each tier has a distinct
audience, author, lifecycle, and source of truth. Artifacts flow downward:
RFCs constrain design docs, design docs constrain guides, guides reference the
API, and examples exercise all of the above.

```
        ┌──────────────────────────────────────────────────────┐
        │  Tier 0  RFCs (specification)                        │
        │  Source of truth for the wire protocol.              │
        │  Frozen per revision; amended, never silently edited.│
        └───────────────────────┬──────────────────────────────┘
                              constrains
                                ▼
        ┌──────────────────────────────────────────────────────┐
        │  Tier 1  Design docs (architecture)                  │
        │  How the protocol is realized in code.               │
        │  Owned by implementation maintainers.                │
        └───────────────────────┬──────────────────────────────┘
                              explains
                                ▼
        ┌──────────────────────────────────────────────────────┐
        │  Tier 2  Guides (how-to)                             │
        │  Task-oriented walkthroughs for users.               │
        │  Owned by developer relations.                       │
        └───────────────────────┬──────────────────────────────┘
                              references
                                ▼
        ┌──────────────────────────────────────────────────────┐
        │  Tier 3  API reference (auto-generated)              │
        │  Generated from doc comments in source.              │
        │  Never hand-edited; regenerated every release.       │
        └───────────────────────┬──────────────────────────────┘
                              demonstrated by
                                ▼
        ┌──────────────────────────────────────────────────────┐
        │  Tier 4  Examples (runnable)                         │
        │  Working programs that exercise the API.             │
        │  Continuously built; broken examples block releases. │
        └──────────────────────────────────────────────────────┘
```

### 1.1 Tier 0 — RFCs (Specification)

RFCs define the protocol. They are the only tier that can change the wire
format. AAFP currently ships 11 RFCs (0001–0011) frozen at Revision 6, plus
amendment documents and architectural reviews.

- **Audience:** protocol engineers, implementors, security reviewers.
- **Author:** protocol working group; changes require a revision bump and an
  amendment record (`RFCs/AMENDMENTS-NNNN.md`).
- **Lifecycle:** frozen per revision. Edits are append-only amendments with a
  changelog entry in `RFCs/RFC_CHANGELOG.md`. A frozen RFC is never silently
  rewritten; supersession is explicit (`Obsoletes:` / `Obsoleted by:` headers).
- **Source of truth:** the markdown files in `RFCs/`.
- **Location:** `RFCs/0001-protocol-overview.md`, `RFCs/0002-transport-framing.md`,
  …, `RFCs/0011-trust-bootstrap.md`, plus `AMENDMENTS-*` and `REVIEW-*`.

Each RFC carries a YAML-like header block that the renderer parses for status
badges, cross-references, and diff views (see §5).

### 1.2 Tier 1 — Design Docs (Architecture)

Design docs explain how the protocol is realized. They cover subsystems
(transport, DHT, NAT traversal, identity, pub/sub, streaming RPC, session
affinity, adaptive routing) and cross-cutting concerns (security, performance,
operations). They are allowed to describe implementation choices that the RFCs
deliberately leave open.

- **Audience:** contributors, maintainers, integrators.
- **Author:** implementation maintainers.
- **Lifecycle:** living documents; updated as the implementation evolves. A
  design doc that contradicts the current RFC is a bug and must be reconciled.
- **Source of truth:** the implementation source, not the doc. When source and
  doc diverge, the source wins and the doc is updated.
- **Location:** repository root for cross-cutting designs
  (`TRANSPORT_ARCHITECTURE_REVIEW.md`, `STREAMING_RPC_DESIGN.md`,
  `SESSION_AFFINITY_DESIGN.md`, `PUBSUB_BACKCHANNEL_DESIGN.md`,
  `ADAPTIVE_ROUTING_PLANE.md`, `SEMANTIC_CAPABILITY_GRAPHS.md`,
  `SIMPLE_API_V2_DESIGN.md`, `TYPESCRIPT_SDK_DESIGN.md`), and
  `architecture/` for structural diagrams.

### 1.3 Tier 2 — Guides (How-To)

Guides are task-oriented. They answer "how do I do X?" not "what is X?".
Conceptual background belongs in design docs; normative behavior belongs in
RFCs. Guides link out to both.

- **Audience:** application developers, operators.
- **Author:** developer relations; reviewed by maintainers for correctness.
- **Lifecycle:** updated per release. A guide must be tested against the
  release it documents; stale guides are flagged by the version pinning system
  (see §10).
- **Source of truth:** the public API and the RFCs. A guide must not introduce
  behavior not present in the API reference.
- **Location:** `docs/guides/` on the site; source under `docs/guides/src/`.

Planned guide set (see §6 for the full table of contents):

- Getting Started (mirrors `docs/QUICKSTART.md`)
- Streaming RPC
- Connection Pooling
- Pub/Sub Backchannel
- NAT Traversal & Relays
- Capability Discovery
- Identity & UCAN Delegation
- Multi-Agent Chat
- Translation Pipeline
- Python SDK
- TypeScript SDK
- Production Deployment (mirrors `docs/DEPLOYMENT.md`)
- Operations Runbook (mirrors `docs/OPERATIONS.md`)
- Troubleshooting (mirrors `docs/TROUBLESHOOTING.md`)

### 1.4 Tier 3 — API Reference (Auto-Generated)

The API reference is generated from doc comments in source. It is never
hand-edited. Every public item — crate, module, struct, trait, function,
constant — must have a doc comment; missing doc comments fail CI on the
`docs-check` job.

- **Audience:** developers reading code-level detail.
- **Author:** the doc-comment authors in source; rendered by tooling.
- **Lifecycle:** regenerated every release and on every merge to `main` for
  the `latest` snapshot.
- **Source of truth:** the source code.
- **Location:** `/api/<lang>/` on the site; built artifacts under
  `docs/api/<lang>/` in the publish branch.

Per-language tooling (see §3):

| Language | Tool | Output |
|----------|------|--------|
| Rust | `cargo doc` | `target/doc/` → `/api/rust/` |
| TypeScript | TypeDoc | `docs/api/ts/` → `/api/typescript/` |
| Python | pdoc | `docs/api/python/` → `/api/python/` |
| Go | `go doc` / `pkgsite` | `docs/api/go/` → `/api/go/` |

Cross-language linking is handled by a shared symbol index (see §6.3).

### 1.5 Tier 4 — Examples (Runnable)

Examples are working programs. They are the executable contract between the
protocol and the user: if an example does not build and run against the current
release, the release is broken. Examples are continuously built in CI and
block releases on failure.

- **Audience:** developers who learn by reading code.
- **Author:** contributors; reviewed by maintainers.
- **Lifecycle:** maintained per release. Each example pins an AAFP version in
  its manifest (`Cargo.toml`, `package.json`, `pyproject.toml`, `go.mod`).
- **Source of truth:** the example source itself.
- **Location:** `examples/` in the repo — `echo-agent`, `multi-agent-chat`,
  `python-weather-agent`, `relay-setup`, `streaming-agent`,
  `translation-pipeline` — and `/examples/` on the site as a searchable
  gallery (see §7).

### 1.6 Tier precedence rules

1. **RFC > design doc > guide > API > example.** When two tiers disagree, the
   higher tier is normative and the lower tier is a bug to be fixed.
2. **The implementation is the referee for design docs and the API.** If a
   design doc or generated API reference disagrees with the source, the source
   wins and the doc is regenerated.
3. **Examples must compile.** An example that does not build against the
   pinned release is removed from the gallery until fixed.
4. **Guides must be runnable.** Every code block in a guide that is marked
   `bash` or `rust` is extracted and tested by `mdbook-test` in CI.

---

## 2. Documentation Tooling

The documentation stack is built around mdbook as the primary renderer, with
language-specific generators feeding the API reference section. All tooling is
pinned and reproducible; the docs build is a single command (`make docs`).

### 2.1 mdbook (the book)

[mdbook](https://rust-lang.github.io/mdBook/) renders the guides, design-doc
summaries, RFC index, and landing page into a single navigable site. It is
chosen because:

- It is a single static binary with no runtime dependencies.
- It renders markdown (which AAFP's source docs already are).
- It supports preprocessors and custom renderers for the AAFP-specific
  features (RFC badges, cross-references, diff views, symbol links).
- It ships a built-in full-text search index (see §11).

The mdbook configuration lives at `docs/book.toml`. The book source lives
under `docs/book/src/`; the generated site is emitted to `docs/book/html/`.

Custom preprocessors (implemented as small Rust binaries in
`docs/preprocessors/`):

| Preprocessor | Purpose |
|--------------|---------|
| `rfc-preprocessor` | Parses RFC headers, injects status badges, resolves `[[RFC-0001]]` cross-references, builds the RFC index page. |
| `api-link-preprocessor` | Resolves `{{api:rust:aafp_sdk::simple::Agent}}` links to the generated API page. |
| `example-embed-preprocessor` | Inlines `{{example:echo-agent}}` blocks as runnable code with a link to the gallery entry. |
| `version-preprocessor` | Injects the current release tag and a `latest`/`vX.Y.Z` switcher into every page header. |
| `i18n-preprocessor` | Selects the translated page for the reader's locale when available (see §12). |

### 2.2 cargo doc (Rust API)

Rust API reference is generated with `cargo doc`:

```bash
cd implementations/rust
cargo doc --workspace --no-deps --all-features
```

Output in `implementations/rust/target/doc/` is copied to
`docs/book/html/api/rust/` during the publish step. Doc comments use standard
rustdoc markdown. Cross-crate links (``[`Agent`][aafp_sdk::simple::Agent]``)
are preserved and work as-is in the generated HTML.

A `#![deny(missing_docs)]` attribute on every public crate enforces that all
public items are documented; this fails the build in CI.

### 2.3 TypeDoc (TypeScript API)

The TypeScript SDK API reference is generated with
[TypeDoc](https://typedoc.org/):

```bash
cd implementations/typescript
npx typedoc --out ../../docs/api/ts src/index.ts
```

TypeDoc reads TSDoc comments (`/** ... */`) and emits HTML. The
`api-link-preprocessor` maps TypeScript symbols to the TypeDoc output so that
guides can link to them with `{{api:typescript:Agent}}`.

### 2.4 pdoc (Python API)

The Python SDK (PyO3 adapter and pure-Python wrappers) API reference is
generated with [pdoc](https://pdoc.dev/):

```bash
cd implementations/python
pdoc -o ../../docs/api/python aafp
```

pdoc reads docstrings (PEP 257 / Google-style) and emits HTML. The
`api-link-preprocessor` maps Python symbols with
`{{api:python:aafp.Agent}}`.

### 2.5 Go documentation

Go API reference uses `pkgsite` (or `go doc -all` for a quick text dump):

```bash
cd implementations/go
pkgsite -open=false -http=:0 &
# harvest the rendered pages
```

Output is mirrored to `/api/go/`.

### 2.6 mdbook-test (guide testing)

Every fenced code block in a guide tagged `bash`, `rust`, `python`, or `ts`
is extracted by `mdbook-test` and executed against the pinned release. A guide
whose code does not run fails CI. This is the single most important guard
against documentation rot.

### 2.7 Build orchestration

`make docs` runs the full pipeline:

```makefile
docs:
	cargo doc --workspace --no-deps --all-features   # Rust API
	cd implementations/typescript && npx typedoc ...  # TS API
	cd implementations/python && pdoc ...             # Python API
	mdbook build docs/book                            # the book
	./scripts/docs-publish.sh docs/book/html          # stage for deploy
```

CI runs `make docs` on every PR and publishes on every merge to `main` and
every release tag.

---

## 3. Documentation Site Structure

The published site is a static mdbook with the API references and example
gallery mounted under it. The top-level URL layout:

```
/                         Landing page with quickstart
/rfcs/                    All RFCs with rendered status, cross-refs, diffs
/guides/                  Step-by-step tutorials
/api/                     Auto-generated API reference per language
  /api/rust/
  /api/typescript/
  /api/python/
  /api/go/
/examples/                Searchable example gallery
/blog/                    Release notes, deep dives
/versions/                Version switcher (latest, vX.Y.Z)
/search/                  Full-text search (mdbook built-in + Algolia)
```

### 3.1 Landing page (`/`)

The landing page is `docs/book/src/SUMMARY.md`-driven `index.md`. It contains:

- A one-paragraph pitch ("the decentralized execution substrate for
  autonomous software").
- A 30-second quickstart block, mirrored from `docs/QUICKSTART.md`, with a
  copy button on each code block.
- Three "start here" cards: **Read the spec** (→ `/rfcs/`), **Follow a guide**
  (→ `/guides/`), **Browse the API** (→ `/api/`).
- A feature matrix (transport, identity, discovery, NAT traversal) linking to
  the relevant RFC and guide.
- A version badge showing the current release and a link to the changelog.

### 3.2 RFCs (`/rfcs/`)

The RFC index is generated by `rfc-preprocessor` from the `RFCs/` directory.
Each RFC page renders:

- The full markdown body.
- A status badge (`Frozen`, `Release Candidate`, `Draft`, `Obsolete`) parsed
  from the header.
- A metadata table (number, title, author, created, revised, type, obsoletes).
- A "Cross-references" section listing every `[[RFC-NNNN]]` link in the
  document, rendered as backlinks.
- A "Diff view" tab showing the diff against the previous revision (see §5.4).
- An "Amendments" tab listing the amendment records that apply to this RFC.

### 3.3 Guides (`/guides/`)

Guides are listed in the mdbook sidebar grouped by topic (Getting Started,
Networking, Messaging, SDKs, Operations). Each guide page has:

- A difficulty badge (Beginner / Intermediate / Advanced).
- A time estimate ("~10 min").
- A prerequisites block linking to prior guides.
- Tested code blocks with copy buttons.
- "Next" links to related guides and the relevant API reference pages.

### 3.4 API reference (`/api/`)

The API reference is mounted as four sub-sites, one per language, plus a
shared symbol index page at `/api/` that lets a reader look up a concept
(e.g., "Agent") and jump to the Rust, TypeScript, Python, and Go definitions
side by side.

### 3.5 Examples (`/examples/`)

The example gallery is a searchable index generated from `examples/`. Each
entry has a card with: title, one-line description, language badge, use-case
tags, difficulty, a "Run it" snippet, and a link to the source. See §7.

### 3.6 Blog (`/blog/`)

Release notes and deep-dive essays. Release notes are generated from
`CHANGELOG.md` per release tag. Deep dives are authored markdown under
`docs/blog/src/`. The blog has its own RSS feed for release announcements.

---

## 4. RFC Rendering

RFCs are the most carefully rendered tier. The renderer must preserve the
exact semantics of the header block, surface status at a glance, and make
cross-references and revision history navigable.

### 4.1 Header parsing

Every RFC begins with a fenced header block:

```
Status:         Release Candidate (Revision 6)
Number:         0001
Title:          Protocol Overview, Goals, and Layer Architecture
Author:         AAFP Project
Created:        2025-06-25
Revised:        2025-01-15 (Revision 4: ...)
Type:           Informational
Obsoletes:      —
Obsoleted by:   —
```

The `rfc-preprocessor` parses this block, removes it from the rendered body,
and emits a styled metadata card at the top of the page. Unknown fields are
preserved and displayed verbatim.

### 4.2 Status badges

Status is rendered as a colored badge:

| Status | Color | Meaning |
|--------|-------|---------|
| Draft | gray | Under active development; may change without notice. |
| Release Candidate | blue | Proposed for freeze; implementors may build against it. |
| Frozen | green | Wire format locked; changes require an amendment and revision bump. |
| Obsolete | red | Superseded; kept for history. |

The badge links to `RFCs/AMENDMENT_STATUS.md` for the full status table.

### 4.3 Cross-references

RFCs reference each other and external norms with a compact syntax:

- `[[RFC-0001]]` → link to RFC 0001 on this site.
- `[[RFC-0001 §3.2]]` → link to section 3.2 of RFC 0001.
- `[[RFC-8949]]` → link to the external IETF RFC.
- `[[AMENDMENTS-0001]]` → link to the amendment record.

The preprocessor resolves these to anchors and builds a backlink table at the
bottom of each RFC ("Referenced by: RFC-0003, RFC-0007, guide/streaming-rpc").

### 4.4 Diff views

Every RFC page has a "Diff" tab showing the diff against the previous
revision. Diffs are computed at publish time by `git diff` between the
revision tags recorded in `RFCs/RFC_CHANGELOG.md`. The diff is rendered as a
side-by-side view with added/removed lines highlighted. This makes protocol
evolution auditable: a reader can see exactly what changed between Revision 5
and Revision 6 without reading both documents in full.

### 4.5 Amendment records

Each RFC may have an associated `RFCs/AMENDMENTS-NNNN.md` recording the
amendments applied across revisions. The amendments are rendered as a
changelog table on the RFC page:

| Revision | Date | Summary | Rationale |
|----------|------|---------|-----------|
| 6 | 2025-06-30 | Clarify stream ID allocation | Ambiguity found in interop test |

---

## 5. API Reference Generation

### 5.1 Doc comment requirements

Every public item in every implementation must carry a doc comment. This is
enforced in CI:

- **Rust:** `#![deny(missing_docs)]` at the crate root.
- **TypeScript:** a lint rule (`typedoc/require-docs`) in the SDK's ESLint
  config.
- **Python:** a `pytest --doctest-modules` step plus a `pydocstyle` check.
- **Go:** a `revive` rule requiring a doc comment on every exported
  identifier.

A PR that adds a public item without a doc comment fails CI.

### 5.2 Generation pipeline

API reference generation runs per language and is independent of the mdbook
build. The outputs are copied into the book's output directory so that the
final site is a single self-contained tree:

```
docs/book/html/
├── api/
│   ├── rust/          ← cargo doc output
│   ├── typescript/    ← TypeDoc output
│   ├── python/        ← pdoc output
│   └── go/            ← pkgsite output
├── rfcs/
├── guides/
├── examples/
└── ...
```

### 5.3 Cross-linking between languages

A shared symbol index (`docs/api/index.json`) maps conceptual names to their
per-language definitions:

```json
{
  "Agent": {
    "rust": "aafp_sdk::simple::Agent",
    "typescript": "aafp.Agent",
    "python": "aafp.Agent",
    "go": "github.com/.../aafp.Agent"
  },
  "AgentRecord": { "rust": "aafp_identity::AgentRecord", ... }
}
```

The index is built by a script (`scripts/build-api-index.sh`) that scans each
language's generated API for a shared `@canonical` tag in doc comments. The
`/api/` landing page renders a search box over this index; typing "Agent"
shows all four language definitions with links.

Guides use `{{api:rust:...}}` / `{{api:typescript:...}}` syntax, resolved by
the `api-link-preprocessor`, so a guide can link to the Rust `Agent` struct
without hardcoding a URL that will break on the next release.

### 5.4 Cross-linking to RFCs

API doc comments may reference RFCs with the same `[[RFC-NNNN]]` syntax used
in RFCs. The generators emit these as plain text; a post-processing pass
rewrites them into links to the `/rfcs/` pages. This lets a reader of the Rust
`AgentRecord` doc jump directly to RFC-0003 §2 where the record format is
normatively defined.

---

## 6. Example Gallery

The example gallery at `/examples/` is a searchable index over the `examples/`
directory. It is generated at build time by `scripts/build-example-gallery.py`.

### 6.1 Gallery entry

Each example directory contains an `example.yaml` manifest:

```yaml
title: Streaming Agent
description: An agent that streams token-by-token responses back to the caller.
language: rust
use_cases: [streaming, llm, inference]
difficulty: intermediate
prereqs: [getting-started, connection-pooling]
rfcs: [RFC-0002, RFC-0009]
run: cargo run --release
```

The gallery builder reads every `example.yaml` and emits a card per example
plus a searchable JSON index (`/examples/index.json`) consumed by the
client-side search UI.

### 6.2 Search facets

The gallery supports filtering by:

- **Use case:** streaming, pooling, pubsub, relay, discovery, identity,
  translation, chat, inference, iot.
- **Language:** rust, typescript, python, go.
- **Difficulty:** beginner, intermediate, advanced.
- **RFC:** which RFCs the example exercises.

Facet state is encoded in the URL query string so that searches are
shareable and back-button friendly.

### 6.3 Runnable snippets

Each gallery card shows a "Run it" snippet copied from the example's
`README.md`. For examples that can run in the browser playground (see §8),
the card embeds a "Try in playground" button that loads the example directly.

### 6.4 Current examples

The repository ships six examples today:

| Example | Language | Use case |
|---------|----------|----------|
| `echo-agent` | Rust | getting started, request/response |
| `multi-agent-chat` | Rust | multi-agent coordination |
| `python-weather-agent` | Python | Python SDK, external API integration |
| `relay-setup` | Rust | NAT traversal, relay |
| `streaming-agent` | Rust | streaming RPC |
| `translation-pipeline` | Rust | multi-hop agent pipelines |

The gallery is designed to grow to dozens; the manifest format and search
index scale without changes.

---

## 7. Interactive Tutorial (Playground)

The site embeds an interactive AAFP playground that lets a reader run agents
in the browser without installing anything. The playground is a
WebAssembly build of the Rust SDK (`aafp-sdk` compiled to `wasm32-unknown-unknown`
with `wasm-bindgen`) plus a small in-browser QUIC-over-WebSocket shim that
connects the reader's browser agents to each other and, optionally, to a
public relay for cross-device demos.

### 7.1 Capabilities

- **Editor:** a Monaco editor pane with syntax highlighting for Rust.
- **Run:** compiles the snippet in-browser via `wasm-pack` and runs it against
  an in-memory agent runtime.
- **Output:** a console pane showing agent logs, the Agent ID, and the
  address.
- **Multi-agent:** the playground can spawn a second agent in a second pane so
  the reader can watch two agents discover and call each other.
- **Share:** the current snippet is encoded in the URL fragment so that a
  reader can share a runnable example by copying the URL.

### 7.2 Embedded tutorials

Guides embed playground blocks with:

````markdown
```playground
use aafp_sdk::simple::{Agent, Request, Response};

Agent::serve()
    .capability("greet")
    .handler(|req: Request| async move {
        Ok(Response::text(format!("Hello, {}!", req.body())))
    })
    .start().await
```
````

The `example-embed-preprocessor` replaces these blocks with an iframe to the
playground preloaded with the snippet. This turns the "Getting Started" guide
into a fully interactive experience: a reader can edit the handler, re-run,
and see the new output without leaving the docs.

### 7.3 Sandbox limits

The playground runs in a sandboxed WASM environment with no network egress by
default. A "Connect to relay" toggle enables a single outbound WebSocket to a
designated public relay for demos that require cross-device discovery. The
sandbox is rate-limited and state is ephemeral (lost on page refresh).

---

## 8. Documentation Versioning

Documentation is versioned per release. Every release tag (`v1.0.0`,
`v1.1.0`, …) produces a snapshot of the docs at that release, and a `latest`
alias always points to the most recent release on `main`.

### 8.1 Version snapshots

On release, the publish pipeline:

1. Builds the docs from the release tag.
2. Publishes to `/versions/vX.Y.Z/`.
3. Updates the `/latest/` redirect to point at the new release.
4. Adds the version to the version switcher manifest.

Older versions are preserved indefinitely so that developers on a pinned
release can read the docs that match their code. Each versioned subtree is a
complete copy of the site (RFCs, guides, API, examples) at that release.

### 8.2 Version switcher

Every page has a version dropdown in the header populated from
`/versions/manifest.json`:

```json
{
  "latest": "v1.2.0",
  "versions": [
    { "tag": "v1.2.0", "date": "2025-07-04", "latest": true },
    { "tag": "v1.1.0", "date": "2025-06-20" },
    { "tag": "v1.0.0", "date": "2025-06-01" }
  ]
}
```

Switching versions navigates to the same path under the chosen version
subtree. A banner appears on non-`latest` versions: "You are reading docs for
v1.1.0. View the latest."

### 8.3 RFC revision vs. release version

Two distinct version dimensions are surfaced:

- **Release version** (`vX.Y.Z`): the implementation release. Drives the API
  reference and guides.
- **RFC revision** (Revision 6): the protocol revision. Drives the RFC pages.
  RFC revision changes are rare and always accompanied by an amendment record.

The landing page shows both: "AAFP v1.2.0 · Protocol Revision 6".

### 8.4 Changelog and release notes

`CHANGELOG.md` is the source for `/blog/release-notes/vX.Y.Z/`. Each release
note entry links to the RFCs amended in that release (if any), the guides
updated, and the notable API changes. Breaking changes are called out in a
"Breaking" section at the top.

---

## 9. Search

Full-text search covers all tiers: RFCs, guides, API reference, examples, and
the blog.

### 9.1 mdbook built-in search

mdbook ships a lunr-based search index built from all markdown pages. This
covers RFCs, guides, and the blog out of the box. The index is regenerated on
every build and served from `/search-index.json`.

### 9.2 API reference search

The generated API references each ship their own search (rustdoc's built-in
search, TypeDoc's search, pdoc's search). The `/api/` landing page provides a
unified search box that queries the shared symbol index (§6.3) and dispatches
to the per-language search.

### 9.3 Site-wide search

For site-wide search across all tiers (including the generated API HTML,
which mdbook's index does not cover), an [Algolia](https://www.algolia.com/)
index is built at publish time by a crawler that walks the published HTML.
The Algolia DocSearch UI is embedded in the site header. Records are tagged
by tier (`rfc`, `guide`, `api`, `example`, `blog`) and by language so that
faceted filtering is available in the search UI.

### 9.4 Search ranking

Results are ranked by tier precedence: an RFC hit ranks above a guide hit,
which ranks above an API hit, which ranks above an example hit. Within a
tier, title matches rank above body matches. The reader can narrow results to
a single tier via the facet sidebar.

---

## 10. Translation (i18n)

AAFP's audience is global; the docs site ships an i18n framework for
non-English translations.

### 10.1 Locale structure

Translated content lives alongside the source content with a locale suffix:

```
docs/book/src/
├── guides/
│   ├── getting-started.md          ← source (English)
│   ├── getting-started.es.md       ← Spanish
│   ├── getting-started.ja.md       ← Japanese
│   └── getting-started.zh.md       ← Chinese
```

The `i18n-preprocessor` selects the page matching the reader's locale
(detected from the `Accept-Language` header or a manual locale switcher),
falling back to English when no translation exists. Untranslated sections
within a page are rendered in English with a small "(untranslated)" marker.

### 10.2 Translation workflow

Translations are contributed via PRs against the `docs/book/src/` tree. A
`scripts/i18n-status.py` reports translation coverage per locale and flags
pages that are stale (source changed since the translation was last updated).
Stale translations are still served but display a "translation may be out of
date" banner with a link to the English source.

### 10.3 Machine translation policy

Machine-translated content is accepted as a first draft but must be reviewed
by a human contributor before merge. The `i18n-preprocessor` tags
machine-translated pages with `data-mt="true"` so that readers can see the
provenance.

### 10.4 Initial locales

The initial translation target set is: English (source), Spanish, Japanese,
Chinese (Simplified), French, German. Additional locales are added on
contributor demand.

---

## 11. Concrete mdbook Structure

The mdbook table of contents is defined in `docs/book/src/SUMMARY.md`. The
full structure:

````markdown
# Summary

[Introduction](./introduction.md)
[Quickstart](./quickstart.md)

---

# Protocol

- [RFCs](./rfcs/index.md)
  - [RFC-0001: Protocol Overview](./rfcs/0001-protocol-overview.md)
  - [RFC-0002: Transport & Framing](./rfcs/0002-transport-framing.md)
  - [RFC-0003: Identity & Authentication](./rfcs/0003-identity-authentication.md)
  - [RFC-0004: Discovery](./rfcs/0004-discovery.md)
  - [RFC-0005: Error Model](./rfcs/0005-error-model.md)
  - [RFC-0006: Versioning & Compatibility](./rfcs/0006-versioning-compatibility.md)
  - [RFC-0007: MCP Transport Binding](./rfcs/0007-mcp-transport-binding.md)
  - [RFC-0008: A2A Transport Binding](./rfcs/0008-a2a-transport-binding.md)
  - [RFC-0009: Pub/Sub](./rfcs/0009-pubsub.md)
  - [RFC-0010: Circuit Relay](./rfcs/0010-circuit-relay.md)
  - [RFC-0011: Trust Bootstrap](./rfcs/0011-trust-bootstrap.md)
  - [Amendments](./rfcs/amendments.md)
  - [Reviews](./rfcs/reviews.md)
  - [Changelog](./rfcs/changelog.md)

---

# Architecture

- [Transport Architecture](./architecture/transport.md)
- [Identity & PKI](./architecture/identity.md)
- [Discovery (DHT)](./architecture/discovery.md)
- [NAT Traversal](./architecture/nat-traversal.md)
- [Streaming RPC](./architecture/streaming-rpc.md)
- [Pub/Sub Backchannel](./architecture/pubsub.md)
- [Session Affinity](./architecture/session-affinity.md)
- [Adaptive Routing](./architecture/adaptive-routing.md)
- [Semantic Capability Graphs](./architecture/capability-graphs.md)
- [Security Threat Model](./architecture/threat-model.md)

---

# Guides

- [Getting Started](./guides/getting-started.md)
- [Streaming RPC](./guides/streaming-rpc.md)
- [Connection Pooling](./guides/connection-pooling.md)
- [Pub/Sub Backchannel](./guides/pubsub.md)
- [NAT Traversal & Relays](./guides/nat-traversal.md)
- [Capability Discovery](./guides/discovery.md)
- [Identity & UCAN Delegation](./guides/identity-ucan.md)
- [Building a Multi-Agent Chat](./guides/multi-agent-chat.md)
- [Building a Translation Pipeline](./guides/translation-pipeline.md)
- [Python SDK](./guides/python-sdk.md)
- [TypeScript SDK](./guides/typescript-sdk.md)
- [Production Deployment](./guides/deployment.md)
- [Operations Runbook](./guides/operations.md)
- [Troubleshooting](./guides/troubleshooting.md)

---

# API Reference

- [Overview](./api/index.md)
  - [Rust](./api/rust/index.html)            ← external
  - [TypeScript](./api/typescript/index.html) ← external
  - [Python](./api/python/index.html)         ← external
  - [Go](./api/go/index.html)                 ← external

---

# Examples

- [Gallery](./examples/index.md)
  - [Echo Agent](./examples/echo-agent.md)
  - [Multi-Agent Chat](./examples/multi-agent-chat.md)
  - [Python Weather Agent](./examples/python-weather-agent.md)
  - [Relay Setup](./examples/relay-setup.md)
  - [Streaming Agent](./examples/streaming-agent.md)
  - [Translation Pipeline](./examples/translation-pipeline.md)

---

# Blog

- [Release Notes](./blog/release-notes.md)
- [Deep Dives](./blog/deep-dives.md)
````

### 11.1 `book.toml`

```toml
[book]
title = "AAFP — Agent-to-Agent Framing Protocol"
authors = ["AAFP Project"]
language = "en"
multilingual = false
src = "src"

[build]
build-dir = "html"
create-missing = false

[output.html]
default-theme = "light"
preferred-dark-theme = "ayu"
git-repository-url = "https://github.com/davidnichols-ops/AAFP-research"
edit-url-template = "https://github.com/davidnichols-ops/AAFP-research/edit/main/docs/book/src/{path}"
additional-css = ["theme/aafp.css"]
additional-js = ["theme/aafp.js"]

[output.html.search]
enable = true
limit-results = 30
use-boolean-and = true
boost-title = 2
boost-hierarchy = 1
boost-paragraph = 1

[preprocessor.rfc]
command = "docs/preprocessors/rfc-preprocessor"

[preprocessor.api-link]
command = "docs/preprocessors/api-link-preprocessor"

[preprocessor.example-embed]
command = "docs/preprocessors/example-embed-preprocessor"

[preprocessor.version]
command = "docs/preprocessors/version-preprocessor"

[preprocessor.i18n]
command = "docs/preprocessors/i18n-preprocessor"
```

### 11.2 Directory layout

```
docs/
├── book.toml
├── book/
│   └── src/
│       ├── SUMMARY.md
│       ├── introduction.md
│       ├── quickstart.md
│       ├── rfcs/
│       ├── architecture/
│       ├── guides/
│       ├── api/
│       ├── examples/
│       └── blog/
├── preprocessors/
│   ├── rfc-preprocessor/
│   ├── api-link-preprocessor/
│   ├── example-embed-preprocessor/
│   ├── version-preprocessor/
│   └── i18n-preprocessor/
├── theme/
│   ├── aafp.css
│   └── aafp.js
└── api/                       ← generated, gitignored
    ├── rust/
    ├── typescript/
    ├── python/
    └── go/
```

---

## 12. CI and Publishing

### 12.1 CI checks

Every PR runs:

- `make docs` — builds the full site; fails on any preprocessor error.
- `cargo doc --workspace --no-deps` with `#![deny(missing_docs)]` — fails on
  undocumented public items.
- `mdbook-test` — runs every code block in every guide; fails on a non-zero
  exit.
- `build-example-gallery.py` — fails if any `example.yaml` is missing required
  fields.
- `i18n-status.py` — reports (does not fail) translation coverage and
  staleness.

### 12.2 Publishing

On merge to `main`, CI publishes to `/latest/`. On a release tag, CI publishes
to `/versions/vX.Y.Z/`, updates `/latest/`, and updates the version manifest.
Publishing is atomic: the new version subtree is built in a staging path and
swapped in via a rename so that readers never see a half-published site.

### 12.3 Redirects

When a page moves, a redirect entry is added to `docs/redirects.json` and
served by the static host. Redirects are permanent (308) and preserved across
versions so that old links keep working.

---

## 13. Conventions

### 13.1 File naming

- RFCs: `NNNN-kebab-case-title.md` (zero-padded number).
- Guides: `kebab-case.md`.
- Examples: `kebab-case/` directory with `example.yaml`.
- Design docs: `UPPER_SNAKE_CASE.md` at repo root (existing convention).

### 13.2 Code blocks

- Tag every fenced block with a language (` ```rust `, ` ```bash `, etc.).
- Mark blocks that should not be tested with ` ```rust,no_run `.
- Playground blocks use ` ```playground `.
- Keep blocks under 20 lines where possible; link to a full example instead
  of pasting a long program.

### 13.3 Linking

- Link to RFCs with `[[RFC-NNNN]]` inside RFCs and design docs.
- Link to API with `{{api:<lang>:<symbol>}}` in guides.
- Link to examples with `{{example:<name>}}` in guides.
- Use relative links between guide pages; the version preprocessor rewrites
  them to versioned absolute URLs at publish time.

### 13.4 Tone

Guides are direct and imperative ("Run this command.", "Add this to your
file."). RFCs are normative ("An agent MUST …"). Design docs are explanatory
("The transport layer is structured as …"). The tone is part of the tier
contract; mixing tones across tiers is a review blocker.

---

## 14. Relationship to Existing Documentation

This architecture subsumes the existing scattered docs into the tiered
structure:

| Existing file | Tier | Destination |
|---------------|------|-------------|
| `README.md` | — | Landing page source (condensed) |
| `docs/QUICKSTART.md` | Guide | `guides/getting-started.md` |
| `docs/DEPLOYMENT.md` | Guide | `guides/deployment.md` |
| `docs/OPERATIONS.md` | Guide | `guides/operations.md` |
| `docs/TROUBLESHOOTING.md` | Guide | `guides/troubleshooting.md` |
| `docs/PRODUCTION_READINESS.md` | Design doc | `architecture/production-readiness.md` |
| `docs/NAT_TRAVERSAL_TESTING.md` | Guide | `guides/nat-traversal.md` |
| `RFCs/*.md` | RFC | `rfcs/` (rendered in place) |
| `TRANSPORT_ARCHITECTURE_REVIEW.md` | Design doc | `architecture/transport.md` |
| `STREAMING_RPC_DESIGN.md` | Design doc | `architecture/streaming-rpc.md` |
| `PUBSUB_BACKCHANNEL_DESIGN.md` | Design doc | `architecture/pubsub.md` |
| `SESSION_AFFINITY_DESIGN.md` | Design doc | `architecture/session-affinity.md` |
| `ADAPTIVE_ROUTING_PLANE.md` | Design doc | `architecture/adaptive-routing.md` |
| `SEMANTIC_CAPABILITY_GRAPHS.md` | Design doc | `architecture/capability-graphs.md` |
| `SIMPLE_API_V2_DESIGN.md` | Design doc | `architecture/simple-api.md` |
| `TYPESCRIPT_SDK_DESIGN.md` | Design doc | `architecture/typescript-sdk.md` |
| `examples/*` | Example | `examples/` gallery |
| `NORTH_STAR.md`, `STRATEGIC_VISION.md` | Blog/About | `blog/` and an About page |

The migration is incremental: existing files are not deleted. The mdbook
preprocessors either read them in place (RFCs) or the content is copied into
`docs/book/src/` with a redirect from the old path. Once the site is live and
the redirects are verified, the duplicates are removed.

---

## 15. Summary

The AAFP documentation system is a five-tier hierarchy with RFCs as the
single source of truth, rendered by mdbook with custom preprocessors, fed by
`cargo doc` / TypeDoc / pdoc / pkgsite for the API reference, indexed into a
searchable example gallery, augmented with an in-browser WASM playground,
versioned per release with a `latest` alias, searchable across all tiers, and
translatable into multiple locales. Every tier has a clear owner, a clear
source of truth, and a CI check that prevents it from rotting. The result is
documentation that is as trustworthy as the protocol it describes.
