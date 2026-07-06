# AAFP Data Serialization & Schema Evolution

> **Status:** Research note
> **Scope:** How AAFP encodes structured data on the wire, why it chose CBOR,
> how schemas evolve without breaking deployed agents, and the engineering
> rules that keep the protocol both compact and forward-compatible.
> **Primary source:** `implementations/rust/crates/aafp-cbor/src/lib.rs`
> and `implementations/rust/crates/aafp-identity/src/identity_v1.rs`.

AAFP is a binary protocol. Every handshake message, every RPC frame, every
`AgentRecord` published to the DHT, and every `CapabilityDescriptor` carried
inside it is encoded as Concise Binary Object Representation (CBOR). This
document explains that choice in depth and then builds on it to describe how
the protocol's implicit schemas are allowed to change over time.

The central design principle is this: **AAFP has no schema language and no
codegen step.** Schemas are conventions — agreed integer keys, agreed value
types — enforced by hand-written encoders and decoders. CBOR's self-describing
map structure, combined with a few discipline rules (new fields are optional,
unknown fields are ignored, integer keys are stable identifiers), gives us
schema evolution for free. The cost is that there is no compiler to catch a
typo in a field number. The benefit is that an agent written in Python in an
afternoon can interoperate with a Rust agent without sharing any IDL file.

---

## 1. Why CBOR

AAFP needed a serialization format for structured protocol data. The
candidates were evaluated against four constraints:

1. **Deterministic encoding** — the same logical value must produce the same
   bytes on every implementation, because those bytes are signed and cached.
2. **Binary efficiency** — records are published to a DHT and gossiped across
   the network; every byte costs bandwidth and storage at every hop.
3. **No build-time dependency** — the protocol must be implementable in any
   language without a compiler plugin, code generator, or shared IDL repo.
4. **Self-describing enough to evolve** — receivers must be able to skip
   fields they do not understand, so that schemas can grow without forcing
   every agent to upgrade simultaneously.

### 1.1 Why not Protocol Buffers

Protocol Buffers are the obvious "industry standard" answer for binary
serialization. They are compact, widely supported, and have a mature schema
evolution story (optional fields, `reserved` numbers, unknown-field
preservation). AAFP rejected them for three reasons.

**Codegen requirement.** Protobuf defines a `.proto` IDL and generates
language-specific bindings. That works well inside a single organization
that owns the schema, but AAFP is an open protocol. Forcing every
implementer — including someone writing a 200-line Python demo — to install
`protoc`, manage generated files, and keep them in sync with the canonical
schema is a friction tax that disproportionately hurts small
implementations. CBOR maps can be built and parsed by hand in any language
with a dictionary type.

**Wire format is not self-describing.** A protobuf message on the wire is a
stream of field-number/tag tuples, which is good, but the type of each field
is baked into the generated code, not the bytes. A receiver that does not
have the schema cannot meaningfully inspect a message. CBOR carries type
information per value (major type tags), so a generic decoder can print any
AAFP message without knowing what the fields mean. This matters enormously
for debugging, conformance testing, and writing protocol fuzzers — the
`aafp-cbor` fuzzer operates on raw bytes with no schema knowledge.

**Determinism is not the default.** Protobuf serialization is *not*
canonical by default; map field ordering is unspecified, and there is a
separate "canonical" spec (and even then, signed-integer handling and
optional-field emission vary across implementations). AAFP needs
byte-exact determinism for signature verification. CBOR has an explicit,
single-page normative definition of deterministic encoding in RFC 8949
§4.2.3, which `aafp-cbor` implements directly.

### 1.2 Why not JSON

JSON is the most universally supported format and needs no codegen. It was
rejected primarily on efficiency and determinism grounds.

**Text overhead.** AAFP's `AgentRecord` contains a 1952-byte ML-DSA-65
public key and a ~3300-byte signature. In JSON these become ~2600 and ~4400
hex/base64 characters plus quoting. In CBOR they are length-prefixed byte
strings with a 3-byte header each. Across a DHT that replicates records to
`k=5` nodes and gossips them on lookup, that overhead compounds. JSON also
represents every integer as ASCII digits and every map key as a quoted
string; CBOR encodes small integers in a single byte and uses integer keys
that are 1–3 bytes instead of `"record_type"` (13 bytes plus quotes).

**No canonical form in the base spec.** RFC 8259 explicitly says JSON object
key order is not significant. There is a separate canonical JSON spec
(JCS, RFC 8785) but it is young, has edge cases around number
serialization (e.g., `1e10` vs `10000000000`), and is not implemented
consistently. CBOR's deterministic encoding is older, simpler, and
specifically designed for the signature-use case.

**No native binary type.** JSON has no byte string; binary data must be
base64-encoded, inflating it by 33% and requiring an out-of-band agreement
on whether the string is base64 or hex or something else. CBOR has a
dedicated byte-string major type.

### 1.3 Why not MessagePack

MessagePack is the closest competitor to CBOR — it is also a binary,
self-describing, schemaless format with map and array types. AAFP chose
CBOR over MessagePack for two reasons.

**Deterministic encoding is normative in CBOR.** RFC 8949 §4.2.3 defines
*length-first core deterministic encoding* as a single, testable profile:
shortest-form integers, definite-length containers, sorted map keys.
MessagePack has no equivalent normative canonical form. There is a
"MessagePack canonical" proposal but it is not an RFC and implementations
differ. For a protocol whose security model depends on byte-exact
reproduction of signed data, having the canonical form be a published RFC
section is valuable both for implementers and for security reviewers.

**CBOR is an IETF standard with broader ecosystem support.** CBOR was
developed in the IETF and is used in COSE (RFC 8152), CBOR Web Tokens
(RFC 8392), and AT Protocol data structures. That lineage means the
security properties (canonical encoding, tag semantics, deterministic map
ordering) are well-studied in contexts very close to AAFP's. MessagePack's
ecosystem is more application-cache-oriented.

The cost CBOR pays versus MessagePack is marginal wire overhead in a few
cases (CBOR's length-first sorting can use one extra byte for some map
headers), which is irrelevant at AAFP's message sizes.

---

## 2. Deterministic CBOR Encoding (RFC 8949 §4.2.3)

The `aafp-cbor` crate implements *length-first core deterministic encoding*.
The crate's own doc comment (`lib.rs` lines 3–16) states the five rules:

1. Map keys are sorted by length-first canonical byte ordering.
2. Integers use the shortest encoding.
3. No indefinite-length arrays or maps.
4. Text strings use definite-length UTF-8.
5. All CBOR maps use integer keys (with one exception: the
   `CapabilityDescriptor` metadata map uses string keys).

### 2.1 What "length-first canonical byte ordering" means

Map keys are sorted first by the length of their CBOR encoding, then by the
raw bytes of that encoding. For integer keys this means a 1-byte key
(e.g., `1` → `0x01`) always sorts before a 2-byte key (e.g., `24` →
`0x18 0x18`), even though `24 > 1` numerically. The implementation in
`sort_int_keys` (`lib.rs` lines 272–280) computes each key's encoding and
sorts by `(encoding.len(), encoding)`.

This is *not* the same as numeric ordering. It is also *not* the same as
pure bytewise ordering of the keys (which would put `0x18` before `0x01`).
Length-first ordering is the RFC 8949 §4.2.3 requirement and is what makes
two independent implementations produce identical bytes.

### 2.2 Why determinism matters: signatures

The single most important consumer of determinism is `AgentRecord`
signature verification. Per RFC-0003 §3.4, the signature is computed over
the canonical CBOR encoding of the record *with the signature field
omitted*. The `to_cbor_without_sig` method (`identity_v1.rs` lines 174–197)
builds an `IntMap` with keys 1–7, 9, 10 (skipping key 8, the signature).
That map is encoded canonically and signed with ML-DSA-65.

A verifier on a different implementation, in a different language, must
reproduce those exact bytes to verify the signature. If two encoders
disagree on map ordering, or on whether `24` is encoded as `0x18 0x18` vs
some longer form, the signature will not verify even though the logical
record is identical. Deterministic encoding is what makes cross-language
signature interop possible at all — the A-10 cross-language ML-DSA-65 test
vectors (Rust ↔ Go) depend on it.

### 2.3 Why determinism matters: caching and deduplication

Beyond signatures, deterministic encoding enables content-addressed storage.
The DHT stores `AgentRecord`s keyed by `AgentId`, but caches and relay
buffers can hash the canonical bytes to detect duplicates without parsing.
Two records that are logically equal produce the same bytes, so a simple
`SHA-256(encoded)` is a valid dedup key. With a non-deterministic format,
two encoders could produce different bytes for the same record and a dedup
cache would store it twice.

### 2.4 How the encoder enforces shortest form

The encoder (`encode_header`, `lib.rs` lines 177–193) always picks the
smallest additional-info representation: values 0–23 inline, 24–255 in one
extra byte, 256–65535 in two, and so on. The decoder goes further and
*rejects* non-canonical input: `read_argument` (lines 473–553) returns
`CborError::Invalid` if it sees, for example, a value of `5` encoded with
the one-byte form (`0x18 0x05`) instead of the inline form (`0x05`). This
means the decoder doubles as a canonical-conformance checker — the
`check_canonical` function (lines 162–175) is just `decode` plus a
trailing-bytes check. This is stricter than RFC 8949 *requires* (the RFC
says decoders SHOULD accept non-canonical input), but for a security
protocol, rejecting non-canonical input on receive closes a class of
"malleability" attacks where an attacker re-encodes a signed record
non-canonically to produce a different byte string with the same logical
content and a still-valid signature.

### 2.5 What is rejected

The decoder explicitly rejects several things that canonical encoding
forbids, each with a distinct error:

- **Indefinite-length arrays/maps** — the break code `0xFF` and the
  indefinite-length initial bytes (`0x9F`, `0xBF`) produce
  `CborError::Unsupported` (line 544). Canonical CBOR requires
  definite-length containers.
- **Non-shortest integers** — as above, `CborError::Invalid` with a message
  naming the value and the shorter form that should have been used.
- **Duplicate map keys** — `decode_value` for `MT_MAP` (lines 391–451)
  checks each new key against all prior keys and returns
  `CborError::Invalid("duplicate map key")`. Canonical CBOR requires
  unique keys.
- **Trailing bytes** — `check_canonical` rejects input where
  `consumed != data.len()`, so a single CBOR value cannot hide extra data
  after it.
- **Deep nesting** — `MAX_DECODE_DEPTH = 100` (line 141) prevents the
  stack-overflow/OOM class of attacks found by the `fuzz_cbor_decode`
  fuzzer (regression test at lines 808–822). AAFP messages are shallow
  (handshake maps, RPC maps, arrays of capabilities); 100 levels is far
  beyond any legitimate use.
- **Tags and floats** — `MT_TAG` and float simple values return
  `Unsupported`. AAFP does not use CBOR tags or floating point; keeping
  them out of the accepted set reduces the attack surface and the
  cross-implementation variance.

---

## 3. Schema Evolution: The Core Model

AAFP has no `.proto` file, no Avro schema registry, no JSON Schema document.
Its "schemas" are the field-number-to-meaning conventions documented in the
RFCs and implemented in code. This section explains how those schemas
evolve.

### 3.1 The two structural patterns

Every AAFP structured value is one of two CBOR shapes:

**IntMap (integer keys).** Used for all protocol-defined structures:
`AgentRecord`, `CapabilityDescriptor` (outer map), handshake messages, RPC
requests/responses. Integer keys are stable, compact identifiers assigned
by the RFC. Example from `identity_v1.rs` lines 105–119:

```
AgentRecord = {
    1: tstr,          // record_type
    2: bstr,          // agent_id (32 bytes)
    3: bstr,          // public_key
    4: [ *CapabilityDescriptor ],  // capabilities
    5: [ *tstr ],     // endpoints
    6: uint,          // created_at
    7: uint,          // expires_at
    8: bstr,          // signature
    9: uint,          // key_algorithm
    10: uint,         // record_version (added in Rev 6, A-3)
}
```

**StrMap (string keys).** Used in exactly one place: the `metadata` field
of a `CapabilityDescriptor` (`identity_v1.rs` lines 419–425). Here the keys
are user/application-defined strings like `"semantic"`, `"cost"`,
`"geo"`, `"heartbeat"`. The protocol does not constrain what keys an agent
puts in its capability metadata; it only constrains the *value* types
(`MetadataValue`: bool, int, text, bytes — lines 516–526).

This split is deliberate and is the foundation of AAFP's evolution story:
**the protocol owns the integer-keyed maps; applications own the
string-keyed maps.**

### 3.2 The four evolution rules

Schemas evolve under four rules, all of which are observable in the
existing code:

**Rule 1 — New fields must be optional on receive.** A newly added field
must not cause an older receiver to reject the message. The decoder for
`AgentRecord::from_cbor` (`identity_v1.rs` lines 227–335) demonstrates
this: the `record_version` field (key 10, added in Rev 6 for A-3 replay
protection) is decoded with a default of `0` when absent (lines 312–314).
An older record without key 10 still parses. The same pattern applies to
`CapabilityDescriptor::from_cbor`, where `metadata` (key 2) defaults to an
empty vector when absent (line 492).

**Rule 2 — Old agents ignore unknown fields.** Because every structure is
a CBOR map, a receiver simply does not look up keys it does not know. The
`int_map_get` helper (`lib.rs` lines 567–572) returns `None` for missing
keys. There is no "strict mode" that rejects unknown keys, by design —
that would break forward compatibility. An agent that adds a hypothetical
key 11 (`revocation_pointer`) to its `AgentRecord` can publish it today,
and every deployed agent that only knows keys 1–10 will parse the record
and simply not use key 11.

**Rule 3 — Never reuse a field number.** Once a key is assigned a meaning
in an RFC, it is permanently reserved for that meaning even if the field
is later deprecated. This is the same rule protobuf enforces with
`reserved`. There is no compiler to enforce it in AAFP; it is a
documentation and review discipline. The cost of violating it is
catastrophic (a receiver interprets a new field as an old one), so RFC
editors must maintain a registry.

**Rule 4 — New fields must not change the signature input of existing
records.** This is the subtle one. `AgentRecord` signs
`to_cbor_without_sig`, which includes *all present fields except key 8*.
If a v1.1 agent adds key 11 to its record and signs it, the signature
covers key 11. A v1.0 verifier that re-encodes the record to check the
signature will *also* include key 11 (because it round-trips the whole
map), so verification still succeeds — the verifier does not need to
understand key 11, it just needs to reproduce the bytes. This works
because the signature is over the *encoded bytes*, not over a
schema-validated projection. The one thing you cannot do is add a field
and then *strip it* before signing, because then the signed bytes would
not match what a round-tripping verifier reconstructs.

### 3.3 Forward vs backward compatibility, precisely

These terms are often confused. AAFP uses them as follows:

- **Backward compatible:** a *new* receiver can read messages produced by
  an *old* sender. This is Rule 1 — new decoders default missing fields.
  Example: a Rev 6 agent reading a pre-Rev 6 record without key 10.
- **Forward compatible:** an *old* receiver can read messages produced by
  a *new* sender. This is Rule 2 — old decoders ignore unknown keys.
  Example: a pre-Rev 6 agent reading a Rev 6 record that includes key 10;
  the old agent ignores key 10 and uses the rest.

AAFP requires both. A new field is only safe to introduce if it satisfies
both directions: old senders don't produce it (so new receivers must
default it — backward compat), and new senders do produce it (so old
receivers must ignore it — forward compat). The `record_version` field is
the canonical example: it is present in new records, absent in old ones,
defaulted to `0` by new decoders, and silently dropped by old decoders.

### 3.4 What you cannot evolve

Some changes are not safe under these rules and must be done via a new
message type or a new version:

- **Changing a field's type** (e.g., key 6 from `uint` to `tstr`). Old
  receivers will fail the type check (`expect_u64` returns
  `InvalidField`). This breaks backward compatibility. Use a new key
  number instead.
- **Making an optional field required.** This breaks forward
  compatibility for old senders that never produced it.
- **Changing the meaning of a value** (e.g., redefining key 9's algorithm
  code `1` from ML-DSA-65 to something else). This is a semantic break
  even though the bytes parse. Use a new code value.
- **Reordering the signature-covered fields** in a way that changes the
  canonical bytes of an existing logical record. Adding a field is fine
  (it appends a new key-value pair); renumbering existing fields is not.

When a change falls into these categories, AAFP's answer is to introduce a
new `record_type` string (e.g., `"aafp-record-v2"`) or a new frame type,
and let old and new coexist by inspecting the type discriminator. The v0
→ v1 transition in the Rust codebase did exactly this: legacy
`agent_record.rs` is `#[deprecated]`, and `identity_v1.rs` carries the new
`RECORD_TYPE_V1 = "aafp-record-v1"` constant (line 21).

---

## 4. IntMap vs StrMap Trade-offs

AAFP uses both integer-keyed and string-keyed CBOR maps, and the choice is
not arbitrary. The split is visible in the `Value` enum (`lib.rs` lines
56–59): `IntMap(Vec<(i64, Value)>)` and `StrMap(Vec<(String, Value)>)`.

### 4.1 Space efficiency

An integer key in the common range 0–23 costs **1 byte** on the wire (the
initial byte itself encodes the value). A string key costs `1 + len(utf8)`
bytes minimum (header + bytes), and usually 2 bytes of header for keys
longer than 23 bytes. The `AgentRecord` has 10 fields; with integer keys
the key overhead is ~10 bytes total. With string keys
(`"record_type"`, `"agent_id"`, ...) it would be ~90 bytes. That ~80-byte
saving is per record, multiplied by DHT replication factor `k=5` and by
every lookup that fetches the record. For a protocol that expects to
gossip records across hundreds of nodes, integer keys are the clear
choice for protocol-defined structures.

### 4.2 Readability and debuggability

String keys are self-documenting. A `cbor2json` dump of a capability's
metadata map shows `{"semantic": <bytes>, "cost": 5}` — immediately
meaningful. The same dump of an `AgentRecord` shows
`{1: "aafp-record-v1", 2: h'...', 3: h'...', ...}` which is meaningless
without the RFC table. This is the trade-off: integer keys are opaque,
string keys are verbose.

AAFP resolves this by using integer keys *only where the protocol defines
the schema* (so the RFC table is the documentation) and string keys
*where the application defines the schema* (so no RFC table exists). The
`CapabilityDescriptor` metadata map is the application's namespace —
the protocol cannot enumerate every possible metadata key an agent might
want to advertise, so it hands the key space to the application and uses
strings so that keys are self-describing.

### 4.3 Canonical ordering cost

Both map types are sorted canonically by the encoder. For `IntMap`,
`sort_int_keys` sorts by the encoding of the integer key. For `StrMap`,
`sort_str_keys` (lines 283–303) sorts by the full CBOR encoding of the
text-string key (header + UTF-8 bytes), which is equivalent to
length-first then bytewise ordering of the UTF-8. The cost is O(n log n)
per encode, negligible at AAFP's map sizes (tens of entries, not
thousands).

### 4.4 When to use which

The rule, codified in `lib.rs` line 16, is: **protocol structures use
IntMap; application-extensible structures use StrMap.** If you are adding
a new protocol-level message with fields defined in an RFC, use integer
keys and register them. If you are adding a new *kind* of capability
metadata that agents can invent, put it in the `metadata` StrMap under a
string key you choose. The extensions system (`aafp-identity/src/extensions/`)
does exactly this: `semantic`, `cost`, `geo`, `heartbeat`, `reputation`,
`performance`, `attestation`, `version` are all string keys in the
metadata map, not new integer keys on the descriptor.

---

## 5. Large Payload Handling: Fragmentation and Streaming

AAFP frames carry a payload up to `MAX_PAYLOAD_SIZE = 1 MiB`
(`framing.rs` line 26). For payloads larger than that, or for payloads
that should begin streaming before the full content is available, AAFP
fragments.

### 5.1 The MORE flag

The DATA frame flags byte (`framing.rs` lines 124–131) defines:

```
MORE       = 0x01  // more fragments will follow
COMPRESSED = 0x02  // payload is compressed
CRITICAL   = 0x80  // for unknown frame types, receiver must reject
```

A sender splits a large payload into ≤1 MiB chunks, sends each as a DATA
frame on the same stream ID, and sets `MORE` on every fragment except the
last. The `with_more()` builder (line 194) and `has_more()` checker
(line 200) are the API surface. The receiver reassembles by concatenating
payloads in stream-ID order until it sees a frame without `MORE`.

Because fragments are on the same stream ID and QUIC (AAFP's primary
transport) preserves stream ordering, reassembly is a simple append — no
sequence numbers, no reordering buffer, no gap detection. If a stream is
reset mid-fragment, the whole logical payload is lost, which is the
desired failure semantics: a partial large payload is not useful.

### 5.2 Streaming RPC

For RPC, the same mechanism supports server-streaming and
client-streaming RPCs: each chunk of a streaming response is a DATA frame
with `MORE` set until the final chunk. This avoids needing a separate
streaming RPC wire format; the frame layer's fragmentation is reused as
the streaming transport. The `STREAMING_RPC_DESIGN.md` document develops
this in detail.

### 5.3 When not to fragment

Fragmentation is only for payloads that exceed 1 MiB or that benefit from
streaming. For ordinary RPC requests and responses (typically a few hundred
bytes to a few KB), a single unfragmented DATA frame is simpler and avoids
the reassembly state. The 1 MiB limit is generous; most AAFP messages are
well under it. An `AgentRecord` with a 1952-byte key, a ~3300-byte
signature, and a handful of capabilities is typically 6–10 KB.

---

## 6. Binary vs Text Payloads

The *payload* of a DATA frame is raw bytes — the frame layer does not
interpret it. The *content* of that payload is typically a CBOR-encoded
structure, but it does not have to be. AAFP allows two broad categories.

### 6.1 CBOR payloads (structured)

Most frame payloads are CBOR-encoded maps: handshake messages, RPC
request/response bodies, `AgentRecord`s in DHT messages. These use the
canonical encoder and are self-describing. This is the default and the
case for everything in the `aafp-messaging` and `aafp-identity` crates.

### 6.2 Raw binary payloads (unstructured)

A DATA frame can carry arbitrary bytes — a file chunk, an image, an audio
buffer, a serialized tensor. In this case the payload is not CBOR; it is
just the raw content, and the *semantics* are established by the
application-level RPC that produced the stream. For example, an RPC method
`fetch/blob` might return a stream of DATA frames whose payloads are raw
bytes, with the blob's content-type agreed at the RPC layer.

### 6.3 Content-type negotiation

AAFP does not put a content-type field in the frame header. Content
negotiation happens at the RPC layer: an RPC request declares (in its
CBOR body) what content-type it wants, and the response carries the
content-type of what it returned. This keeps the frame layer generic and
avoids a per-frame type tag that would be redundant for the common case
(CBOR). For raw-binary streams, the RPC response's metadata tells the
receiver how to interpret the subsequent DATA frames.

The practical rule: if the payload is structured protocol data, it is
CBOR and needs no content-type (it is implied). If the payload is
application data, the RPC that established the stream carries the
content-type, and the DATA frames are opaque bytes.

---

## 7. Schema Registry: Why AAFP Does Not Have One

A natural question after reading section 3 is: should AAFP define a
formal schema language — a CDDL (RFC 8610) description, an Avro schema, a
`.proto` — and register it somewhere, so that field numbers cannot collide
and implementations can be auto-validated?

**The answer is no, for the core protocol.** The reasoning:

**CBOR maps suffice for evolution.** The four rules in section 3.2 give
safe evolution without a schema compiler. The only thing a schema language
would add is *machine-checked enforcement* of those rules. In a protocol
with a small number of structures (`AgentRecord`,
`CapabilityDescriptor`, a handful of handshake/RPC messages), that
enforcement is cheap to do in human review and in conformance tests. The
`aafp-conformance` crate already encodes the expected shapes as Rust test
code. A CDDL file would duplicate that and become a second source of
truth that could drift.

**Codegen friction, again.** Any schema language that produces bindings
reintroduces the build-time dependency that section 1.1 rejected. CDDL is
validation-only (no codegen by default), which is better, but it still
requires implementers to obtain and parse the CDDL to validate — a step
most small implementations will skip, making the registry theater rather
than enforcement.

**The application namespace is already free.** The `metadata` StrMap in
`CapabilityDescriptor` is where application-specific, rapidly-evolving
data lives. That namespace needs no registry by design — agents invent
keys, and receivers ignore keys they don't understand. A registry for
*protocol* structures (the IntMaps) is just an RFC section, which AAFP
already has (RFC-0003 §3 for `AgentRecord`, §4 for
`CapabilityDescriptor`).

**Where CDDL would help.** There is one place a formal schema would add
real value: conformance testing and fuzzing. A CDDL description of
`AgentRecord` could generate random valid records and check that
implementations accept them, and generate invalid ones and check that
implementations reject them. This is a *test-time* use of CDDL, not a
*runtime* or *build-time* use. AAFP may adopt CDDL for this purpose
without making it a protocol requirement. The `aafp-cbor` fuzzer already
operates at the raw-byte level; CDDL-guided fuzzing would be an
enhancement, not a dependency.

---

## 8. Comparison with Protobuf (Revisited)

Having laid out the model, the comparison with protobuf sharpens:

| Concern | Protobuf | AAFP / CBOR |
|---|---|---|
| Schema language | `.proto` (required) | none (conventions in RFCs) |
| Codegen | required | none |
| Wire determinism | not default; separate canonical spec | normative (RFC 8949 §4.2.3) |
| Self-describing wire | no (types in schema, not bytes) | yes (CBOR major types) |
| Unknown-field handling | preserved by default (proto3) | ignored by default (map lookup) |
| Field number reuse | prevented by `reserved` | prevented by RFC discipline |
| Binary fields | `bytes` type | byte-string major type |
| Map type | yes (proto3) | yes (IntMap / StrMap) |
| Ecosystem for security | COSE-adjacent, less common | COSE/CWT/CBOR-Web-Token lineage |
| Implementation friction | high for small impls | low (hand-write encoder) |
| Strictness | high (compiler-checked) | low (review-checked) |

AAFP trades strictness for frictionlessness and determinism. The bet is
that a protocol with ~10 structures and careful RFC review does not need a
compiler to catch field-number mistakes, and that the security and
interop value of normative canonical encoding outweighs the loss of
compile-time schema validation. For a protocol that wants adoption by
weekend implementers in Python, JavaScript, and Go, this is the right
trade. For a protocol inside a single large org, protobuf's strictness
would win.

---

## 9. Comparison with JSON (Revisited)

| Concern | JSON | AAFP / CBOR |
|---|---|---|
| Wire size | large (text, quoted keys, base64) | small (binary, int keys) |
| Canonical form | not in base spec (JCS is separate) | normative |
| Binary data | no (base64/hex) | native byte string |
| Self-describing | yes | yes |
| Debuggability | excellent (human-readable) | good (with `cbor2json` tools) |
| Implementation effort | trivial (every language has it) | low (small encoder) |
| Integer range | safe integers only (2^53) | full 64-bit |

JSON's one real advantage is debuggability: you can `cat` a JSON message
and read it. CBOR requires a decoder to inspect. AAFP mitigates this with
the `check_canonical` function and with round-trip tests that print
decoded `Value` trees. For a security protocol where signed bytes must be
reproducible, JSON's lack of a normative canonical form is disqualifying
on its own; the size overhead is a secondary but real cost in a
DHT-gossiped system.

---

## 10. Compression

The frame layer reserves a `COMPRESSED` flag (`framing.rs` line 128,
`0x02`). When set, the payload is compressed and the receiver must
decompress it before interpreting the content. AAFP's compression
guidance is deliberately conservative.

### 10.1 When to compress

**Compress payloads above ~1 KB.** Below that threshold, the compression
dictionary overhead and the CPU cost exceed the bandwidth saving. A
100-byte CBOR map compressed with zstd may not shrink at all and may even
grow. A 10 KB `AgentRecord` compresses meaningfully because it contains
high-entropy binary (the public key and signature, ~5 KB) alongside
low-entropy text (record type, endpoints, capability names).

**Use zstd.** zstd is the recommended algorithm: it has good ratio, fast
decompression, and implementations in every language AAFP targets. The
frame flag does not encode the algorithm; AAFP standardizes on zstd so
that sender and receiver agree without negotiation. (If a future version
needs algorithm negotiation, it goes in an extension block, not the
flag.)

### 10.2 When not to compress

**Do not compress small payloads.** A handshake message, a PING, an RPC
request of a few hundred bytes — leave these alone. The CPU cost on every
node along the path is not worth the tens of bytes saved.

**Do not compress already-compressed content.** If a DATA frame carries a
JPEG, an already-zstd-compressed blob, or encrypted bytes (which are
high-entropy by design), re-compressing is wasted CPU and may expand the
payload. The RPC layer that knows the content-type should decide; the
frame layer just carries the flag.

**Do not compress before signing.** The signature is over the
*uncompressed* canonical CBOR. Compression is applied after signing, to
the encoded bytes, and the `COMPRESSED` flag tells the receiver to
decompress before verifying. This keeps the signature input stable
regardless of whether compression is used on the wire — a record verifies
the same whether it was transmitted compressed or not.

### 10.3 Interaction with fragmentation

Compression and fragmentation compose: a sender compresses the full
payload first, then fragments the compressed bytes across frames. The
`COMPRESSED` flag is set on the *first* fragment (or on every fragment,
idempotently); the receiver reassembles the fragments into the compressed
payload and then decompresses. This avoids per-fragment decompression
state and keeps the streaming case simple.

---

## 11. Concrete Example: Evolving a Capability Schema Across 3 Versions

This section traces a hypothetical capability, `text.translate`, through
three schema versions to show the evolution rules in action. This is a
worked example, not an existing RFC, but it follows the patterns in
`identity_v1.rs`.

### 11.1 Version 1 — the initial capability

An agent advertises a translation capability. The `CapabilityDescriptor`
is encoded as:

```cbor
{
    1: "text.translate",                          // name
    2: { "languages": ["en", "fr", "de"] }        // metadata (StrMap)
}
```

In canonical CBOR (integer key 1 = `0x01`, value text string; integer
key 2 = `0x02`, value StrMap with string key `"languages"` and an array
of text strings). A receiver parses this with
`CapabilityDescriptor::from_cbor`: key 1 gives the name, key 2 gives the
metadata map, and the application reads `"languages"` from the metadata.
No version field exists yet.

### 11.2 Version 2 — add an optional `model` metadata key

The agent now wants to advertise which model it uses, without breaking v1
receivers. Because metadata is a StrMap with application-defined keys,
this is a pure application-level addition — no protocol change, no RFC
edit:

```cbor
{
    1: "text.translate",
    2: {
        "languages": ["en", "fr", "de"],
        "model": "trans-v2"
    }
}
```

A v1 receiver that does not know `"model"` simply does not read it —
`str_map_get` returns `None` and the receiver uses the languages list as
before. A v2 receiver reads `"model"` and can route based on it. This is
forward and backward compatible for free, because the metadata map was
designed to be application-extensible. **No field number was consumed, no
RFC changed, no version bump required.**

### 11.3 Version 3 — add a protocol-level `cost` field

Now suppose the protocol itself wants to standardize a cost field so that
*any* capability can advertise its price in a uniform, RFC-defined way,
not just as an ad-hoc metadata string. This is a protocol-level change,
so it goes on the `CapabilityDescriptor` IntMap as a new integer key.

The descriptor has used keys 1 (name) and 2 (metadata). The next free key
is 3. The RFC is amended:

```
CapabilityDescriptor = {
    1: tstr,                    // name
    2: { *tstr => MetadataValue },  // metadata
    3: uint,                    // cost_units (optional, default 0)
}
```

A v3 agent produces:

```cbor
{
    1: "text.translate",
    2: { "languages": ["en", "fr", "de"], "model": "trans-v2" },
    3: 10
}
```

Compatibility:

- **v1 receiver** parses keys 1 and 2, ignores key 3. Forward compatible.
- **v2 receiver** parses keys 1 and 2, ignores key 3. Forward compatible.
- **v3 receiver** parses key 3 as `cost_units`, defaulting to `0` when
  absent (per Rule 1). So a v3 receiver can read a v1 or v2 descriptor
  and treat it as cost-0. Backward compatible.

The decoder change in `CapabilityDescriptor::from_cbor` is three lines,
mirroring the `record_version` pattern at `identity_v1.rs` lines 312–314:

```rust
let cost_units = match get(3) {
    Some(Value::Unsigned(n)) => *n,
    None => 0,  // pre-v3 descriptor, cost unknown, assume 0
    Some(other) => return Err(IdentityError::InvalidField {
        field: "cost_units",
        message: format!("expected uint, got {:?}", other),
    }),
};
```

### 11.4 What would break this

To make the example concrete about what *not* to do:

- **Reusing key 2** for something other than metadata would break every
  v1 and v2 receiver that interprets key 2 as a StrMap.
- **Making key 3 required** (returning `MissingField` when absent) would
  break forward compatibility — v1 and v2 senders do not produce key 3.
- **Changing key 3 from `uint` to `tstr`** in a later version would break
  backward compatibility — a v3 receiver that expects `tstr` would
  reject a v3.0 record that encoded `10` as `uint`. If the cost model
  later needs fractional units, the safe path is a *new* key 4
  (`cost_micro_units: uint`) rather than redefining key 3.

### 11.5 The version field question

Notice that none of the three versions added a `version` field to the
descriptor. AAFP's philosophy is that version is implicit in which fields
are present: a receiver detects "v3" by the presence of key 3, not by an
explicit version number. This works because every new field is optional
and additive. An explicit version field would be redundant and would
itself be an evolution hazard (what if a sender sets version=3 but omits
key 3?). The one place AAFP *does* carry an explicit version is the
`record_type` string (`"aafp-record-v1"`) on `AgentRecord`, which
distinguishes major, incompatible schema generations — not minor additive
evolution within v1.

---

## 12. Summary of Rules

For implementers, the entire serialization and evolution model reduces to
a short checklist:

1. **Encode with canonical CBOR** (RFC 8949 §4.2.3): shortest integers,
   definite lengths, length-first sorted map keys. Use `aafp-cbor::encode`.
2. **Reject non-canonical input on receive** — the decoder does this; do
   not bypass it. This protects signature malleability and dedup
   correctness.
3. **Protocol structures use integer keys; application metadata uses
   string keys.** Register new integer keys in the RFC. Pick your own
   string keys for metadata.
4. **New fields are optional on receive** — default them when absent.
5. **Unknown fields are ignored on receive** — never reject a map for
   having extra keys.
6. **Never reuse a field number.** Deprecated fields keep their number
   forever.
7. **Sign the canonical bytes, not a projection.** Adding a field to a
   signed record is safe because the verifier round-trips the whole map.
8. **Fragment payloads > 1 MiB** with the `MORE` flag on the same stream
   ID. Do not fragment small messages.
9. **Compress payloads > ~1 KB with zstd**; leave small payloads alone;
   never compress encrypted or already-compressed content; compress
   after signing.
10. **For incompatible changes** (type changes, field renumbering,
    semantic redefinition), introduce a new `record_type` or frame type
    rather than mutating an existing schema in place.

These rules, plus the `aafp-cbor` encoder/decoder, are the complete
serialization and schema-evolution story. There is no schema compiler,
no registry service, no codegen step — just CBOR maps, integer keys, and
the discipline above. The result is a protocol that a new implementation
can speak in a few hundred lines of code, that produces compact signed
records, and that can grow new fields without forcing every deployed
agent to upgrade.
