# AAFP Edge & IoT Deployment — The Agent Substrate From Cloud to Sensor

**Status:** Research Document
**Domain:** Edge / IoT / Embedded / Mobile / Browser
**Date:** 2026-07-04
**Depends on:** `STRATEGIC_VISION.md`, Track T (Adaptive Routing), Track U (Semantic Discovery), Phase C (Session Affinity), RFC 0002 (Framing), RFC 0003 (Handshake)

---

## Executive Summary

The `STRATEGIC_VISION.md` positions AAFP as the **operating system of the agent
internet**, not merely a transport. That ambition cannot stop at the data
center. The largest population of computational devices on Earth is not
servers — it is sensors, microcontrollers, phones, browsers, vehicles, factory
controllers, and gateways. If AAFP only runs on x86_64 nodes with gigabit
uplinks, it has captured the smallest and most contested slice of the network.

This document specifies how AAFP extends **downward**: from a 64-core cloud
inference agent to a 32-bit ARM microcontroller sampling a thermistor at 1 Hz,
all participating in the same capability graph, all using the same wire
format, all governed by the same identity and trust model.

The central design constraint is the **immutable boundary** declared in the
Strategic Vision: the wire protocol (RFC 0002 framing, RFC 0003 handshake,
AgentId, CBOR, QUIC, version negotiation) is frozen. Everything that makes
edge deployment feasible — memory budgets, sleep cycles, mesh routing,
offline queues, capability subsetting — must live **above** the transport, in
the SDK, the discovery layer, and the adaptive routing plane. The protocol
does not grow edge-specific opcodes. Instead, the SDK grows edge-specific
*profiles*.

This document covers:

1. AAFP on Raspberry Pi (ARM64 SBC class).
2. AAFP on microcontrollers (embedded Rust, `no_std`, WASM runtime).
3. AAFP on mobile (iOS/Android via WASM bridge and native bindings).
4. AAFP in the browser (WebTransport, WebSocket relay, WebCrypto).
5. AAFP on edge gateways (industrial, automotive, smart city).
6. Resource-constrained agent design (minimal capabilities, lightweight DHT).
7. Offline operation (RPC queuing, sync-on-reconnect).
8. Mesh networking (local mesh without internet, opportunistic bridging).
9. The sensor-to-agent pattern (sensor → edge agent → cloud analysis).
10. Real-time control loops (sub-10ms latency for robotics/industrial).
11. Power management (sleep/wake, connection pooling, duty cycling).
12. A concrete worked example: a smart factory with 500 sensors, 20 edge
    agents, and 5 cloud agents, including topology, traffic, failure modes,
    and recovery.

The guiding question throughout, taken from the Strategic Vision's acid test:
**does this make the network more intelligent, or merely more complicated?**
Edge support makes the network more intelligent because it gives the
capability graph *perception of the physical world*. A cloud-only AAFP network
is an intranet of language models. An edge-aware AAFP network is a system
that can feel a factory floor, a vehicle, a city block, and a human body.

---

## 1. What the Strategic Vision Demands of Edge

The Strategic Vision's stack diagram places the **World Perception Layer**
between applications and the execution fabric. The perception layer is how
agents interact with "everything that is not an AAFP agent — web pages, APIs,
databases, documents, images, audio, files, shells, **physical sensors**."

The vision is explicit that perception is not a special protocol extension.
It is "a set of capability providers — agents that serve `web-browse`,
`pdf-read`, `image-ocr`, `api-call`, `code-execute`, `form-fill`, `search`
capabilities." The edge equivalent: agents that serve `temperature-read`,
`vibration-read`, `motor-actuate`, `image-capture`, `gps-read`, `relay-switch`.
These are discovered and called through the normal AAFP mechanism. Nothing
about the edge is exotic from the protocol's perspective.

Three principles from the vision govern this document:

1. **Design for hardware that doesn't exist yet.** Today: CPU, GPU. Tomorrow:
   NPU, TPU, ASIC, optical accelerators, quantum coprocessors. Edge hardware
   is the leading edge of this curve — NPUs on phones, dedicated vision
   ASICs on cameras, ML accelerators on microcontrollers. Capabilities must
   be abstract. Never encode today's hardware assumptions.

2. **The protocol should disappear.** A developer reading a temperature
   sensor should write `agent.discover("temperature").call(...)` and never
   learn that the sensor is on a Cortex-M4 over BLE to a Pi gateway over
   QUIC to a cloud agent. The SDK hides the topology.

3. **Don't bake algorithms into the protocol.** Mesh routing, offline
   reconciliation, duty cycling, and capability subsetting are all
   *evolving intelligence*. They live in the SDK and the routing plane, not
   in the wire format.

---

## 2. AAFP on Raspberry Pi (ARM64 SBC Class)

The Raspberry Pi 4/5 (Cortex-A76/A76, 4–8 cores, 1–16 GB RAM, gigabit
Ethernet or WiFi 6) is the canonical "edge node that can run a full OS." It
runs Linux, has a real MMU, supports standard Rust toolchains, and can host
the reference AAFP SDK with no `no_std` gymnastics. It is also the cheapest
plausible gateway between microcontroller sensors and the cloud.

### 2.1 What Runs Natively

The full AAFP stack runs on a Pi 5 with 8 GB RAM:

- **QUIC transport** (`quinn` / `s2n-quic`) — works unmodified on ARM64.
- **ML-DSA-65 identity** — the post-quantum signature scheme is CPU-bound
  but feasible; a Pi 5 signs in ~5 ms and verifies in ~0.5 ms. Key
  generation is the expensive operation (~50 ms) and is done once.
- **CBOR framing** — trivial; CBOR is a byte format with no platform
  dependencies.
- **DHT participation** — a Pi can be a full Kademlia-style DHT node. The
  routing table (256 buckets × up to 8 entries) is ~8 KB serialized. The
  bottleneck is not memory but the *churn cost* of maintaining it on a node
  that may sleep (see §11).
- **Capability advertisement** — a Pi advertises its real capabilities
  (camera capture, local LLM via a Coral USB accelerator, GPIO actuation,
  BLE bridging to sensors).

### 2.2 Memory Constraints

A Pi 4 with 1 GB RAM is the floor for a *full* node. Below that, the SDK
must shed features. The memory budget breaks down roughly as:

| Component                       | Typical RSS (ARM64, release) |
|---------------------------------|------------------------------|
| QUIC connection pool (50 peers) | ~12 MB                       |
| DHT routing table + store       | ~8 MB                        |
| CBOR codec + buffers            | ~2 MB                        |
| Crypto (ML-DSA, X25519, AES-GCM)| ~3 MB                        |
| Agent runtime + scheduler       | ~10 MB                       |
| Capability cache                | ~5 MB                        |
| OS + libc + allocator overhead  | ~15 MB                       |
| **Total floor**                 | **~55 MB**                   |

On a 1 GB Pi 4 this leaves ~940 MB for application workloads (a quantized
local LLM, a vision pipeline, a sensor buffer). On a 512 MB Pi Zero 2 W the
full stack is infeasible — see §6 for the *constrained profile* that drops
the DHT and uses a delegated discovery model.

### 2.3 Thermal Management

A Pi 5 under sustained load (e.g., running a local 4-bit quantized LLM plus
AAFP routing) hits thermal throttling at ~80 °C and drops clocks by up to
40%. This is not an AAFP problem per se, but AAFP must *report* it: the
Adaptive Routing Plane (Track T) consumes a `thermal` metric. An edge agent
that is throttling advertises reduced capability throughput so the routing
plane does not pile work onto a hot node.

The SDK exposes a platform trait:

```rust
pub trait PlatformMetrics {
    fn cpu_load(&self) -> f32;
    fn memory_free(&self) -> u64;
    fn thermal_state(&self) -> ThermalState; // Nominal | Throttled | Critical
    fn power_source(&self) -> PowerSource;   // Mains | Battery(pct)
}
```

On a Pi this is backed by `/sys/class/thermal` and `/proc/meminfo`. On a
microcontroller it is backed by an ADC reading a thermistor. The routing
plane does not care which.

### 2.4 Storage Constraints

Pi-class devices boot from SD cards, which have limited write endurance
(10k–100k cycles per cell). The AAFP SDK must avoid write-amplifying
workloads on the persistent store: the DHT store, the offline RPC queue
(§7), and the capability cache should default to a write-ahead log with
batched fsync, or to an in-memory store that is checkpointed to disk only
on graceful shutdown. A naive implementation that fsyncs every DHT put will
kill an SD card in weeks.

---

## 3. AAFP on Microcontrollers (Embedded Rust, `no_std`)

Below the Pi class is the microcontroller class: Cortex-M4/M7/M33
(STM32, nRF52/53, RP2040), ESP32 (Xtensa or RISC-V), and the emerging class
of AI microcontrollers (MAX78002, Ambiq Apollo4 with on-die NPU). These
devices have 256 KB–1 MB flash, 64 KB–1 MB SRAM, no MMU, no OS, and run at
48–400 MHz. AAFP cannot run "the full stack" here. It runs a *profile*.

### 3.1 The `no_std` Profile

The constrained profile is a `no_std` Rust crate (`aafp-embedded`) that
implements:

- **CBOR framing** — the same RFC 0002 frame format, decoded with a
  streaming parser that allocates zero bytes on the heap. Frames are
  processed in a fixed-size arena (e.g., 512 B).
- **A subset of QUIC** — full QUIC is too heavy (~80 KB code, multiple
  connection-state machines). The embedded profile uses either:
  - **QUIC/UDP-lite**: a minimal QUIC client-only implementation that
    supports a single stream to a gateway, no migration, no 0-RTT, no
    connection IDs beyond the minimum. ~20 KB code.
  - **A non-QUIC bridge**: the microcontroller speaks a serial protocol
    (UART/SPI/I2C) or BLE to a *gateway agent* (a Pi or industrial gateway)
    that translates to AAFP-over-QUIC. The MCU is not an AAFP node; it is
    a *sensor peripheral* of a node. See §9.
- **Identity** — ML-DSA-65 is too expensive on a Cortex-M4 (signing would
  take seconds and consume most SRAM). The embedded profile uses either:
  - **Ed25519** for the device's own identity (fast, ~50 KB code, signs in
    ~10 ms on a 168 MHz M4), with the gateway co-signing or attesting the
    device's identity into the AAFP trust graph.
  - **A factory-provisioned X.509 / Ed25519 key in secure element**
    (ATECC608A, OPTIGA Trust M) — the key never leaves the chip; the
    gateway attests the chip's certificate chain.
- **No DHT participation** — the device does not maintain a routing table.
  Discovery is *delegated*: the device asks its gateway "find me an agent
  with capability X," and the gateway performs the DHT lookup and returns
  a candidate. The device caches one or two results.
- **No adaptive routing** — the device does not compute scores. It calls
  the candidate its gateway recommends. The gateway is responsible for
  routing intelligence.

### 3.2 The WASM Runtime Option

An alternative to a native `no_std` port is a **WASM runtime on the
microcontroller**. Several RTOSes (wasm3 on Zephyr, WAMR on NuttX) support
running WASM modules in kilobytes of RAM. The appeal: the AAFP *logic*
(framing, capability advertisement, RPC dispatch) is compiled once to
`wasm32-unknown-unknown` and deployed across MCU families without
per-vendor porting.

The tradeoff:

| Factor            | Native `no_std`         | WASM on MCU              |
|-------------------|-------------------------|--------------------------|
| Code size         | Smaller (no VM)         | +20–40 KB VM overhead    |
| RAM               | Minimal                 | +8–16 KB VM state        |
| Portability       | Per-vendor port         | One WASM blob, many RTOS  |
| Crypto            | Native (fast)           | Interpreted (slow)       |
| Determinism        | Excellent               | Good (interpreter)       |
| Debugging         | Native tools            | Source maps, slower      |

The recommendation: **WASM for application-layer agents on MCUs with ≥ 512 KB
SRAM and a hardware crypto accelerator** (so crypto is offloaded and the
WASM interpreter's slowness does not matter). Native `no_std` for the
smallest class (RP2040 with 264 KB, nRF52 with 256 KB).

### 3.3 Capability Subsetting

A microcontroller advertises a *minimal capability set*. It does not
publish the full capability graph (Track U) — it publishes one or two
leaves:

```
device:stm32-thermal-sensor-04
  capability: temperature-read
    unit: celsius
    rate_hz: 10
    accuracy_c: 0.1
    latency_ms: 2
    trust: attested-by gateway:pi-factory-floor-03
```

The `attested-by` field is how a constrained device participates in the
trust graph without its own heavyweight identity. The gateway vouches for
it. This mirrors the Strategic Vision's principle that trust is
cryptographic *plus* reputation *plus* performance — the device's
reputation is initially the gateway's reputation, and accrues independently
over time as the device's RPCs succeed.

---

## 4. AAFP on Mobile (iOS / Android)

Mobile is the highest-volume edge platform. A phone is a Pi 5 with a
battery, an NPU, a camera, a GPS, and a cellular radio. It is also the most
locked-down: iOS does not allow arbitrary UDP/QUIC in the background, and
Android aggressively kills background sockets.

### 4.1 The WASM Bridge

The cleanest cross-platform story is a **WASM bridge**: the AAFP agent
logic ships as a `wasm32-unknown-unknown` module, and a thin native shell
on each platform provides the transport and platform APIs.

```
┌─────────────────────────────────────────────┐
│  iOS app / Android app (Swift / Kotlin)     │
│  ┌───────────────────────────────────────┐  │
│  │  AAFP agent (WASM module)             │  │
│  │   - CBOR framing                      │  │
│  │   - Capability advertisement         │  │
│  │   - RPC dispatch                      │  │
│  │   - Offline queue (§7)               │  │
│  └──────────────┬────────────────────────┘  │
│                 │ host functions (FFI)      │
│  ┌──────────────▼────────────────────────┐  │
│  │  Native shell                         │  │
│  │   - QUIC (quinn on Android,           │  │
│  │      Network.framework on iOS)        │  │
│  │   - Keychain / Keystore (identity)    │  │
│  │   - CoreML / NNAPI (NPU offload)      │  │
│  │   - Camera, GPS, BLE (capabilities)   │  │
│  │   - Push notifications (wake trigger) │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

The WASM module is portable between iOS and Android (and the browser, §5).
The native shell is ~2000 lines per platform. This is the same architecture
used by Firefox's networking stack and by Cloudflare's WASM workers.

### 4.2 Native Bindings

For performance-critical agents (e.g., a real-time AR agent that must call
a vision agent at 60 Hz), the WASM bridge adds ~1–2 ms of FFI overhead per
call. A **native binding** path (`aafp-swift` / `aafp-kotlin`) links the
core `aafp-core` Rust crate via `cargo lipo` / `cbindgen` / `uniffi`. This
is faster but requires per-platform release engineering. The recommendation
is to ship both: WASM bridge for portability and rapid iteration, native
bindings for the hot path.

### 4.3 Background Operation

Both platforms kill background network sockets. AAFP on mobile must treat
*foreground* and *background* as distinct operational modes:

- **Foreground**: full QUIC, full DHT participation, low-latency RPCs.
- **Background**: the agent goes quiet. It does not maintain a DHT routing
  table. It keeps a single push-token-registered long-lived connection (via
  APNs on iOS, FCM on Android) that exists only to receive a *wake
  notification* from a cloud agent that needs it. On wake, the agent
  re-establishes QUIC, performs the RPC, and returns to quiet.

This is the mobile instantiation of the sleep/wake pattern in §11. The
protocol does not know about background mode; the SDK does.

### 4.4 Identity on Mobile

A phone's AAFP identity lives in the hardware-backed key store (Secure
Enclave on iOS, StrongBox / TEE on Android). The private key never leaves
the secure element; signing is an OS call. ML-DSA-65 is not yet supported
by these key stores, so mobile agents use Ed25519 today, with a migration
path to ML-DSA-65 when the key stores support it (expected 2027–2028 per
NIST's standardization timeline). The protocol's version negotiation (RFC
0006) handles this: an Ed25519 agent and an ML-DSA-65 agent interoperate
because identity algorithms are negotiated, not assumed.

---

## 5. AAFP in the Browser

The browser is the most constrained and most ubiquitous edge platform. It
cannot open raw UDP sockets (so no native QUIC in most browsers), cannot
hold private keys in a secure element (so identity is weaker), and is
sandboxed (so capabilities are limited to what the browser exposes).

### 5.1 Transport: WebTransport and WebSocket Relay

**WebTransport** (over HTTP/3) is the browser-native path to QUIC-like
semantics: multiplexed, low-latency, bidirectional streams over UDP. As of
2026 it is shipped in Chromium and Firefox, with Safari lagging. AAFP's
browser profile uses WebTransport where available, with a frame format
identical to the native QUIC profile (the WebTransport API delivers the
same ordered, unreliable, and datagram stream primitives that AAFP uses
over raw QUIC).

Where WebTransport is unavailable, AAFP falls back to a **WebSocket relay**:
the browser agent connects to a relay agent (a Pi, a cloud node) over
WebSocket (TCP), and the relay speaks QUIC to the rest of the network on
the browser's behalf. This is the same relay architecture AAFP uses for NAT
traversal — the browser is treated as a permanently-NATed client. The
penalty is one extra hop and TCP head-of-line blocking on the browser↔relay
leg; the benefit is universal compatibility.

### 5.2 Cryptography: WebCrypto and the PQ Gap

WebCrypto exposes Ed25519 (as of 2024), X25519, AES-GCM, and SHA-2. It does
**not** expose ML-DSA-65 or ML-KEM-768. A browser agent therefore cannot
perform post-quantum signatures natively. Two options:

1. **Hybrid identity via a relay**: the browser agent holds an Ed25519 key
   in WebCrypto. A trusted relay agent (run by the app provider) holds a
   PQ key and co-signs the browser agent's capability advertisements. The
   trust graph records "this Ed25519 agent is attested by this ML-DSA-65
   relay." This is the same attestation pattern used by microcontrollers
   (§3.3) and mobile background agents (§4.3).

2. **WASM-compiled PQ crypto**: ML-DSA-65 can be compiled to WASM and run
   in the browser. It is slow (~20–50 ms per sign) but feasible for
   low-frequency operations (identity establishment, capability
   advertisement). High-frequency operations (per-frame signing) stay on
   Ed25519 via WebCrypto.

The recommendation is hybrid: WASM PQ for identity, WebCrypto Ed25519 for
per-RPC signatures, with the protocol's negotiated algorithms hiding the
split from peers.

### 5.3 Browser Capabilities

A browser agent advertises a narrow but high-value capability set:

- `dom-read` / `dom-actuate` — read and drive a web page (the World
  Perception Layer's browsing agent, running *in* the browser rather than
  calling out to one).
- `webrtc-capture` — capture camera/mic as a media stream.
- `local-storage-read` — read the origin's local storage (with user
  consent).
- `user-prompt` — ask the human a question (the only agent that can do
  this directly).

The browser agent is the AAFP network's *human-interface peripheral*. It is
how a cloud agent asks a human for consent, confirmation, or a decision.

---

## 6. Resource-Constrained Agent Design

Across Pi, MCU, mobile, and browser, a common pattern emerges: the
**constrained agent profile**. This is not a protocol mode; it is an SDK
configuration that drops features the device cannot afford.

### 6.1 The Capability Subset

A constrained agent advertises *one to three* capabilities. It does not
attempt to be general-purpose. The Strategic Vision's capability graph
becomes a single leaf, not a subgraph. This is by design: specialization is
an ecosystem property the vision explicitly wants to emerge.

### 6.2 Lightweight DHT Participation

Full DHT participation (Kademlia, 256 buckets, k=8) costs ~8 KB for the
routing table and a steady background of `FIND_NODE` RPCs to keep buckets
fresh. A constrained agent cannot afford this. Three modes:

1. **Full node** (Pi 5, desktop, server): maintains a complete routing
   table, answers `FIND_NODE` from others, stores DHT records. ~8 KB, ~1
   RPC/s background.
2. **Light node** (Pi Zero, phone foreground, browser): maintains a
   *bootstrap list* of 3–8 full nodes it trusts. Performs `FIND_NODE`
   through them but does not serve `FIND_NODE` to others. ~1 KB, ~0.1
   RPC/s.
3. **Delegated node** (MCU, phone background, smart sensor): performs no
   DHT operations at all. Asks a single gateway "find capability X," and
   caches the answer. ~0 KB, 0 RPC/s background.

The protocol does not distinguish these modes. A full node, a light node,
and a delegated node all speak RFC 0002 framing. The difference is which
messages they emit and respond to.

### 6.3 Minimal Capability Negotiation

A constrained agent does not implement the full Track U semantic capability
graph query language. It publishes a *static capability descriptor* (a CBOR
map, ~100 bytes) and lets the routing plane match against it. The matching
logic lives on the full nodes. This is the protocol's "bake interfaces, not
algorithms" principle: the descriptor format is stable; the matching
algorithm evolves.

### 6.4 Memory Budget Table

| Class                | RAM      | Profile      | DHT role   | Crypto      |
|----------------------|----------|--------------|------------|-------------|
| Cloud server         | 16–256 GB| Full         | Full       | ML-DSA-65   |
| Desktop / laptop     | 8–64 GB  | Full         | Full       | ML-DSA-65   |
| Pi 5                 | 4–16 GB  | Full         | Full       | ML-DSA-65   |
| Pi 4                 | 1–8 GB   | Full         | Full/Light | ML-DSA-65   |
| Pi Zero 2 W          | 512 MB   | Constrained  | Light      | Ed25519     |
| Phone (foreground)   | 2–12 GB  | Full         | Light      | Ed25519→PQ  |
| Phone (background)   | —        | Constrained  | Delegated  | Ed25519     |
| Browser              | —        | Constrained  | Delegated  | Ed25519+relay|
| ESP32 / STM32 (WASM) | 512 KB+  | Embedded-WASM| Delegated  | Ed25519/SE  |
| RP2040 / nRF52       | 256 KB   | Embedded     | Delegated  | Ed25519/SE  |
| Smallest MCUs        | 32–64 KB | Peripheral   | None       | Gateway-attested|

---

## 7. Offline Operation

Edge devices lose connectivity. A factory floor has RF dead zones. A
vehicle enters a tunnel. A phone goes underground. A sensor's gateway
reboots. The AAFP network must degrade gracefully: an agent that cannot
reach the network does not fail its caller; it *queues* and *reconciles*.

### 7.1 The Outbound Queue

Every constrained agent maintains a persistent **outbound RPC queue**: a
write-ahead log of RPCs the agent has accepted from its local callers but
has not yet delivered to the network. When connectivity returns, the queue
drains in priority order.

```rust
pub struct OutboundQueue {
    log: Wal,                    // persistent, crash-safe
    items: BTreeMap<Priority, VecDeque<Rpc>>,
    capacity_bytes: usize,
    drop_policy: DropPolicy,     // DropOldest | DropLowestPriority | Reject
}
```

The queue is bounded by `capacity_bytes` (e.g., 1 MB on a Pi, 16 KB on an
MCU). When full, the `drop_policy` decides what to evict. The default for
sensor data is `DropOldest` — a temperature reading five minutes old is
less valuable than one five seconds old. The default for actuation commands
is `Reject` — a motor command that cannot be delivered in time should fail
loudly, not silently queue forever.

### 7.2 The Inbound Queue and Sync-on-Reconnect

The symmetric problem: while an agent is offline, other agents may have
sent it RPCs. AAFP uses a **store-and-forward relay** for this. The
agent's designated relay (its gateway, or a cloud relay it registered with
before going offline) buffers inbound RPCs and replays them when the agent
reconnects.

The reconnect handshake (above RFC 0003, in the SDK) is:

1. Agent re-establishes QUIC to its relay.
2. Agent sends `RESUME` with its last-processed sequence number.
3. Relay replays all buffered RPCs with higher sequence numbers.
4. Agent drains its outbound queue to the relay for forwarding.
5. Relay sends `CAUGHT_UP`; agent returns to normal operation.

This is the same pattern as MQTT 5's session persistence and as IMAP's
`UIDVALIDITY`/`UIDFETCH`, adapted to AAFP's RPC model. The protocol carries
sequence numbers in the existing frame metadata; no new wire fields are
required.

### 7.3 Conflict and Causality

Offline operation introduces the possibility of *conflicting* RPCs: two
agents independently issue commands to the same actuator while both are
offline. AAFP does not attempt to solve distributed consensus at the edge
(this would violate "don't become the blockchain of AI"). Instead:

- Actuator agents are *single-writer* by default: one owner agent has
  write authority; others route through it. While the owner is offline,
  the actuator holds its last state.
- Sensor agents are *append-only*: there are no conflicts, only gaps. The
  downstream consumer detects gaps via sequence numbers and interpolates or
  flags.
- For genuinely multi-writer state (rare at the edge), the agents use a
  CRDT (e.g., a last-writer-wins register with hybrid logical clocks)
  layered above the protocol. This is an application concern, not a
  protocol concern.

---

## 8. Mesh Networking

When the internet is absent — a disaster zone, a remote agricultural site,
a factory floor with air-gapped security — edge agents form a **local
mesh**. They discover each other over local link layers (BLE, WiFi Direct,
Thread, LoRa, wired CAN bus) and relay RPCs hop-by-hop without any cloud
dependency.

### 8.1 Local Discovery

Mesh agents discover each other via:

- **mDNS / DNS-SD** on WiFi (the same mechanism AAFP uses on LANs).
- **BLE advertisement** with a service UUID that encodes "AAFP agent."
- **Thread Commissioner** join for 802.15.4 mesh.
- **Static configuration** for wired industrial buses.

A local discovery yields a *peer set* — the agents reachable without a
gateway. The mesh agent builds a *local capability graph* from these peers.

### 8.2 Hop-by-Hop RPC

Within the mesh, an RPC flows:

```
sensor-agent ──RPC──▶ gateway-agent ──RPC──▶ analyzer-agent
   (BLE)                 (WiFi mesh)            (WiFi mesh)
```

Each hop is a normal AAFP RPC over whatever transport the link supports
(QUIC over WiFi, a BLE GATT characteristic, a CAN frame). The SDK's
transport trait abstracts this:

```rust
pub trait Transport {
    fn send(&mut self, frame: &Frame) -> Result<()>;
    fn recv(&mut self) -> Result<Frame>;
}
```

There is a `QuicTransport`, a `BleTransport`, a `CanTransport`, a
`SerialTransport`. The RPC layer above is identical.

### 8.3 Opportunistic Bridging

When *one* mesh agent gains internet access (a gateway with a cellular
uplink comes online), it becomes a **bridge**: it advertises the mesh's
collective capabilities to the global DHT, and relays inbound RPCs from the
cloud into the mesh. The bridge is not a NAT (it does not rewrite
identities); it is a *router*. The cloud agent calling `temperature-read`
on a mesh sensor does not know it is talking through a bridge.

This is the edge instantiation of the Strategic Vision's "the protocol
should disappear": the topology (mesh, bridge, cloud) is invisible to the
caller. The caller writes `discover("temperature").call(...)`, and the
routing plane finds the path.

### 8.4 Partition and Merge

When a mesh partitions (a gateway dies), the two halves operate
independently using offline queues (§7). When they merge, the relays
exchange buffered RPCs by sequence number. Merge is *eventually consistent*
in the sense that all buffered RPCs eventually deliver or expire; it is not
*strongly consistent* and does not pretend to be.

---

## 9. The Sensor-to-Agent Pattern

The canonical edge data flow is the **sensor-to-agent pipeline**:

```
┌────────┐   raw    ┌──────────────┐  RPC   ┌────────────────┐  RPC   ┌──────────┐
│ sensor │─────────▶│ edge agent   │───────▶│ analysis agent │───────▶│ actuator │
│ (MCU)  │  sample  │ (Pi gateway) │        │ (cloud or edge)│        │ (MCU)    │
└────────┘          └──────────────┘        └────────────────┘        └──────────┘
```

### 9.1 The Sensor

A sensor is a peripheral (§3.3): an STM32 with a thermistor, a camera
module with an ESP32, a vibration accelerometer on an nRF52. It does not
speak AAFP directly. It speaks I2C/SPI/UART/BLE to its edge agent. The
edge agent owns the sensor and exposes its data as an AAFP capability.

### 9.2 The Edge Agent

The edge agent (a Pi, an industrial gateway) is the AAFP node. It:

1. Polls or subscribes to the sensor over the local bus.
2. Wraps each sample (or windowed batch) in a CBOR frame.
3. Exposes a `temperature-read` (or `vibration-stream`, `image-capture`)
   capability to the AAFP network.
4. Optionally pre-processes: downsamples, filters, thresholds, compresses.
5. Pushes high-rate streams to subscribers (pub/sub backchannel) or answers
   on-demand RPCs.

### 9.3 The Analysis Agent

The analysis agent consumes the stream and produces decisions. It may be:
- A cloud LLM agent that reasons about anomalies in natural language.
- An edge ML agent (Coral TPU, phone NPU) running a lightweight classifier.
- A statistical agent that computes control-chart limits and alarms.

The analysis agent publishes its *own* capability (`anomaly-classify`,
`predictive-maintenance-score`) so other agents can build on it.

### 9.4 The Actuator

The loop closes when an actuator agent receives a command and drives a
physical device: a relay, a motor, a valve. Actuation is the most safety-
sensitive capability in the network; see §10 and §12.

### 9.5 The Full Loop as One RPC Chain

The Strategic Vision's Execution Fabric assembles this into a pipeline
without human wiring:

```
Need: "if factory floor temperature exceeds 30°C, activate cooling"
  → temperature-read (edge agent)
  → threshold-check (rule agent)
  → relay-actuate (actuator agent)
```

The scheduler assembles the chain from the capability graph. The developer
writes the *intent*, not the wiring.

---

## 10. Real-Time Control Loops

Some edge workloads are not best-effort RPCs; they are **control loops**
with hard latency deadlines. A robot arm controller must compute and
dispatch a torque correction within 10 ms of receiving a position error, or
the arm oscillates. A motor drive must update its PWM duty within 1 ms. A
chemical reactor valve must actuate within 50 ms of a pressure threshold.

### 10.1 Why Best-Effort AAFP Is Not Enough

The default AAFP path — discover, route, schedule, execute — is optimized
for throughput and resilience, not determinism. A control loop cannot
afford a DHT lookup per iteration. It needs:

- **Pinned peers**: the loop's agents are pre-discovered and never
  re-routed mid-loop.
- **Pinned paths**: the QUIC connection (or local bus) is established once
  and reused for every iteration.
- **Bounded scheduling**: the loop's RPCs are scheduled with priority and
  preemption over best-effort work.
- **No queueing behind bulk transfers**: a control RPC must jump the
  outbound queue.

### 10.2 The Real-Time Profile

The SDK exposes a `RealtimeSession`:

```rust
let session = agent
    .realtime_session()
    .deadline(Duration::from_millis(10))
    .peers(&[sensor_agent, controller_agent, actuator_agent])
    .build()
    .await?;

loop {
    let sample = session.call("position-read", ()).await?;
    let correction = session.call("control-compute", sample).await?;
    session.call("torque-write", correction).await?;
    // total budget: 10 ms, enforced by session deadline
}
```

Under the hood, the `RealtimeSession`:

1. Pre-establishes QUIC streams to all peers (no per-iteration handshake).
2. Marks all frames with a `priority = Realtime` flag (a field that already
   exists in RFC 0002's frame metadata).
3. Uses a dedicated outbound queue that bypasses the best-effort queue.
4. Measures each iteration's latency and alarms if it exceeds the deadline
   (a control loop that misses its deadline must *fail loud*, not silently
   degrade — a silent miss causes physical oscillation).

### 10.3 Where the Loop Lives

A sub-10 ms loop cannot tolerate a cloud round trip (typical WAN RTT is
20–80 ms). The loop must close **on the edge**: sensor → edge controller →
actuator, all on the same LAN or same device. The cloud agent's role is to
*tune* the loop (update gains, push new models), not to participate in it.

This is a routing-plane decision, not a protocol decision. The Adaptive
Routing Plane (Track T) knows each agent's latency and locality; when a
`RealtimeSession` requests peers, the plane returns only LAN-local
candidates. The protocol carries the frames; the plane chooses the path.

### 10.4 Determinism and the WASM Caveat

A WASM-interpreted agent (§3.2, §4.1) is not suitable for a sub-1 ms loop
because the interpreter's execution time is not bounded tightly enough.
Sub-1 ms loops require native code on a real-time OS (Zephyr, FreeRTOS,
QNX) or bare metal. The 1–10 ms band is feasible in WASM on a fast edge
node. The capability graph records `runtime: native-rt` vs `runtime: wasm`
so the routing plane can filter.

---

## 11. Power Management

Most edge devices are battery-powered or power-constrained. AAFP must not
keep a device awake to maintain a DHT it does not need. The single biggest
power drain in an edge agent is the **radio**: a WiFi radio transmitting
consumes 200–500 mA; a BLE radio 5–15 mA; an LTE modem 500–2000 mA. Every
second the radio is on is a second of battery life spent.

### 11.1 Sleep / Wake Duty Cycling

A battery-powered edge agent cycles:

```
wake (10 ms)
  → sample sensor
  → encode CBOR frame
  → radio on
  → flush outbound queue (§7) to gateway
  → fetch any inbound RPCs (§7.2)
  → radio off
sleep (60 s)
```

The duty cycle is 10 ms / 60 s ≈ 0.017%, giving a battery life measured in
months or years rather than days. The SDK's `PowerManager` drives this:

```rust
pub struct PowerManager {
    wake_interval: Duration,
    wake_budget: Duration,
    radio_policy: RadioPolicy, // AlwaysOn | DutyCycled | OnDemand
}
```

### 11.2 Connection Pooling

Re-establishing a QUIC connection on every wake is expensive (~50–200 ms
and several joules for the handshake). The agent keeps a **pooled
connection** to its gateway: the QUIC connection is kept alive across sleep
cycles using QUIC's idle timeout and keep-alive pings tuned to the wake
interval. On wake, the agent sends a keep-alive (or data) on the existing
connection rather than re-handshaking.

For longer sleeps (minutes to hours) where keeping the connection alive is
more expensive than re-handshaking, the agent uses **0-RTT resumption**
(RFC 9001): the gateway caches the agent's transport parameters and the
agent resumes encrypted communication in a single round trip on wake.

### 11.3 Adaptive Wake Intervals

A static 60 s wake interval wastes energy when nothing is happening and
misses events when something is. The agent adapts:

- **Event-driven wake**: a hardware interrupt (a threshold-crossing on the
  sensor, a motion detector) wakes the agent immediately, bypassing the
  timer.
- **Exponential backoff on idle**: if the last N wakes produced no
  interesting data and no inbound RPCs, the interval grows (60 s → 120 s
  → 300 s) up to a cap.
- **Compression on wake**: if the gateway signals "I have urgent work,"
  the interval shrinks to the minimum.

This is the same "compete with gravity" principle from the Strategic
Vision: don't fight the device's power budget, settle into its natural
rhythm.

### 11.4 Reporting Energy to the Routing Plane

A battery-powered agent reports its `power_source` and `battery_pct` via
the PlatformMetrics trait (§2.3). The Adaptive Routing Plane uses this to
avoid routing *through* a low-battery agent (it may sleep soon) and to
avoid routing *to* a low-battery agent for non-urgent work. This is the
`energy` metric the Strategic Vision lists among the routing plane's
inputs.

---

## 12. Safety and Actuation

Actuation is where AAFP meets the physical world with consequences. A
misrouted RPC to a language model produces a bad sentence; a misrouted RPC
to a valve produces a chemical spill. The edge deployment model must treat
actuation capabilities with extra rigor.

### 12.1 Capability Tokens with Spatial Scope

AAFP's UCAN-based capability tokens (already in the protocol) carry
`capability`, `resource`, and `caveats`. For actuation, the SDK enforces a
mandatory `caveat` set:

- `max_rate_hz`: the maximum command frequency.
- `safe_range`: the allowable actuation values (e.g., valve 0–100%).
- `requires_confirmation`: whether a human-in-the-loop must approve.
- `spatial_scope`: the physical location this actuation is valid for
  (so a command intended for "reactor 3" cannot be replayed on "reactor 7").

### 12.2 Fail-Safe Defaults

An actuator agent that loses connectivity must **fail safe**: a valve
defaults to closed, a motor to off, a heater to low. The actuator's
offline behavior is not "hold last command" (which could be dangerous) but
"hold safe state." The outbound queue's `drop_policy` for actuation is
`Reject` (§7.1) so that a stale command does not execute after a long
offline period.

### 12.3 The Human-in-the-Loop Agent

For high-consequence actuation, the control loop includes a **human
approval agent** — typically a browser or mobile agent (§4, §5) that
presents the proposed action to a human and forwards their confirmation.
This is the World Perception Layer's "actuation" principle made explicit:
agents don't just act, they ask.

---

## 13. Concrete Example: Smart Factory

A worked example to ground the preceding sections. A factory floor has:

- **500 sensors**: temperature (200), vibration (100), current (100),
  vision cameras (50), pressure (50). Each is an STM32 or ESP32 peripheral
  (§3, §9.1).
- **20 edge agents**: 15 Raspberry Pi 5 gateways (each owning ~30 sensors
  over BLE/CAN/Ethernet), 3 industrial gateway PCs (owning the vision
  cameras and running local ML inference), 2 PLC-class real-time
  controllers (owning the actuators and closing sub-10 ms loops).
- **5 cloud agents**: a predictive-maintenance LLM, a quality-analytics
  agent, a digital-twin simulation agent, a reporting/dashboard agent, and
  an orchestration agent that owns the factory's production schedule.

### 13.1 Topology

```
                    ┌─────────── Cloud (5 agents) ───────────┐
                    │  PM-LLM   Quality   Twin   Dash   Sched │
                    └────────────────┬─────────────────────────┘
                                     │ QUIC over WAN (redundant uplinks)
            ┌────────────────────────┼────────────────────────┐
            │                        │                        │
     ┌──────▼──────┐          ┌──────▼──────┐          ┌──────▼──────┐
     │ Industrial  │          │ Industrial  │          │ Industrial  │
     │ Gateway A   │          │ Gateway B   │          │ Gateway C   │
     │ (vision ML) │          │ (vision ML) │          │ (vision ML) │
     └──┬──────────┘          └──┬──────────┘          └──┬──────────┘
        │ CAN bus                 │ CAN bus                 │ CAN bus
   ┌────┴────┐               ┌────┴────┐               ┌────┴────┐
   │ Pi 5 ×5 │               │ Pi 5 ×5 │               │ Pi 5 ×5 │  (15 Pi total)
   └──┬──┬──┘               └──┬──┬──┘               └──┬──┬──┘
      │  │                     │  │                     │  │
   BLE  CAN                 BLE  CAN                 BLE  CAN
    │    │                   │    │                   │    │
  ~30   ~30                ~30   ~30                ~30   ~30  sensors each
  sens  sens               sens  sens               sens  sens

     ┌──────────────┐        ┌──────────────┐
     │ RT-PLC 1     │        │ RT-PLC 2     │   (real-time controllers)
     │ (actuators)  │        │ (actuators)  │
     └──────────────┘        └──────────────┘
```

### 13.2 Traffic Profile

- **Sensor → edge**: 500 sensors × 10 Hz average = 5,000 samples/s. Each
  sample is ~20 bytes CBOR. Total: ~100 KB/s on the local buses.
- **Edge → cloud**: the Pi gateways downsample and window. Of 5,000
  samples/s, ~200/s carry anomalies or summary statistics to the cloud
  agents. ~40 KB/s WAN uplink.
- **Cloud → edge**: the PM-LLM issues ~5 actuation recommendations/min to
  the RT-PLCs (via the Pi gateways). The digital-twin pulls state snapshots
  at 1 Hz (~50 KB/s WAN downlink).
- **Real-time loops**: 20 control loops close entirely on the RT-PLCs and
  their directly-attached sensors/actuators, sub-10 ms, never touching the
  Pi gateways or the cloud.

### 13.3 Capability Graph (Excerpt)

```
pi-floor-3-thermal-01:
  capability: temperature-read
    rate_hz: 10
    accuracy_c: 0.1
    location: factory-floor-3
    attested-by: gateway-pi-floor-3

gateway-pi-floor-3:
  capability: temperature-aggregate
    source: pi-floor-3-thermal-01..30
    window_s: 5
  capability: anomaly-flag
    model: local-isolation-forest
    latency_ms: 8

industrial-gateway-a:
  capability: vision-inspect
    model: yolo11-fp8
    latency_ms: 14
    gpu: yes
  capability: defect-classify
    classes: [scratch, dent, misalign]

rt-plc-1:
  capability: relay-actuate
    safe_range: [off, on]
    requires_confirmation: false
    max_rate_hz: 50
    spatial_scope: line-3-cooling
  capability: position-read
    rate_hz: 1000
    latency_ms: 1
    runtime: native-rt

cloud-pm-llm:
  capability: predictive-maintenance
    model: gpt-class
    latency_ms: 800
    trust: 0.97
```

### 13.4 Failure Modes and Recovery

**Failure 1: A Pi gateway dies.**
Its 30 sensors lose their edge agent. They buffer samples to their local
flash (each MCU has 8–64 KB spare for a small outbound queue, §7.1). The
factory's orchestration agent detects the Pi's departure from the DHT
within seconds and reassigns the sensors to a neighboring Pi (which has
spare capacity). The neighboring Pi adopts the sensors (they were
provisioned with a fallback gateway address) and drains their buffered
samples. Data loss: the samples between the Pi's death and reassignment,
plus any that overflowed the MCU queue. Worst case ~30 s of data on 30
sensors — acceptable for thermal trending, flagged as a gap.

**Failure 2: The factory loses internet.**
The 20 edge agents and 500 sensors continue operating as a mesh (§8). The
local capability graph is intact. Real-time control loops are unaffected
(they never used the cloud). The cloud agents' inbound RPCs buffer at the
factory's store-and-forward relay (a local industrial gateway with disk).
When internet returns, the relay replays buffered RPCs to the cloud, and
the cloud's buffered responses (e.g., PM recommendations) replay back down.
The factory ran continuously through the outage; only cloud-side analytics
were delayed.

**Failure 3: A sensor's radio fails.**
The sensor cannot reach its gateway. It buffers to flash (§7.1). A
maintenance technician's phone (a mobile agent, §4) walks within BLE range,
discovers the sensor via mDNS/BLE advertisement, drains its queue, and
forwards the samples to the gateway over WiFi. The phone is a temporary
mesh bridge (§8.3).

**Failure 4: An RT-PLC misses a control-loop deadline.**
The `RealtimeSession` (§10.2) detects the miss and fails loud: it logs the
miss, alerts the orchestration agent, and the actuator transitions to its
fail-safe state (§12.2). The cloud PM-LLM is notified and can recommend a
line slowdown. The loop does *not* silently degrade — a silent miss in a
motor controller causes oscillation that damages the product.

**Failure 5: A compromised edge agent attempts unauthorized actuation.**
The actuator's capability token (§12.1) requires `spatial_scope: line-3-
cooling` and `requires_confirmation: false` only for the designated RT-PLC.
The compromised Pi gateway does not hold a token with actuation authority;
its actuation RPC is rejected at the actuator. The trust graph records the
rejected attempt, the compromised Pi's reputation drops, and the routing
plane stops routing *through* it.

### 13.5 Resource Budget

| Resource                  | Value                          |
|---------------------------|--------------------------------|
| Sensors                   | 500 × ~20 B/10 Hz = 100 KB/s   |
| Edge→Cloud uplink         | ~40 KB/s (downsampled)         |
| Cloud→Edge downlink       | ~50 KB/s (twin + commands)     |
| Edge agent RAM (Pi 5)     | ~55 MB AAFP + ~200 MB local ML |
| Edge agent RAM (industrial)| ~55 MB AAFP + ~2 GB vision ML |
| MCU flash (sensor)        | ~80 KB AAFP-embedded + app     |
| MCU SRAM (sensor)         | ~16 KB AAFP-embedded + app     |
| Real-time loop budget     | 10 ms (1 ms on RT-PLC)         |
| Battery (BLE sensors)     | 2× AA, ~2 year life @ 0.017% duty |
| WAN bandwidth             | <1 Mbps total (well under T1)  |

### 13.6 What the Developer Wrote

The factory's orchestration agent, in total, expresses the system in a few
lines (the Strategic Vision's "protocol should disappear"):

```rust
let factory = Agent::new("factory-orchestrator");
let temp = factory.discover("temperature-aggregate")
    .with("location", "factory-floor-3")
    .subscribe().await?;
let anomalies = factory.discover("anomaly-flag")
    .with("source", temp.id())
    .subscribe().await?;
let pm = factory.discover("predictive-maintenance").await?;

while let Some(anomaly) = anomalies.recv().await {
    let recommendation = pm.call(anomaly).await?;
    if recommendation.confidence > 0.9 {
        factory.discover("relay-actuate")
            .with("spatial_scope", recommendation.target)
            .call(recommendation.action).await?;
    }
}
```

No QUIC. No DHT. No NAT traversal. No mesh routing. No offline queue. The
developer expressed *intent*; the SDK and the routing plane handled the
topology.

---

## 14. Open Questions and Future Work

1. **PQ crypto on constrained devices.** ML-DSA-65 is too heavy for an
   MCU and unavailable in WebCrypto and mobile key stores. The attestation
   bridge (gateway co-signs) is the interim answer. The long-term answer
   is a SLH-DSA or a hardware PQ accelerator in secure elements. Track
   this against NIST's standardization and silicon-vendor roadmaps.

2. **WASM determinism for real-time.** WASM interpreters are not yet
   suitable for sub-1 ms loops. WASM compilation (WAMR's AOT mode, wasmtime
   with cranelift) may close this gap. Re-evaluate annually.

3. **Mesh routing algorithms.** This document specifies that mesh routing
   is SDK-local evolving intelligence, not protocol. The specific algorithm
   (AODV, BATMAN, RPL, or a learned policy) is an open research question
   and should be benchmarked against real factory/vehicle/city deployments.

4. **Energy-aware scheduling.** The routing plane consumes `battery_pct`
   but does not yet *predict* it. A model that predicts an agent's battery
   curve from its duty-cycle history would let the plane proactively
   migrate work off a dying agent before it sleeps. This is a Track T
   extension.

5. **Sensor data semantics.** The capability graph describes *how* to read
   a sensor (rate, accuracy, latency) but not *what* the reading means
   semantically (units, coordinate frame, calibration). A lightweight
   sensor-ontology layer above Track U is needed. Candidate: align with
   W3C SSN/SOSA or OGC SensorThings, expressed as CBOR-LD.

6. **Safety certification.** Industrial and automotive actuation may
   require formal safety certification (IEC 61508, ISO 26262). AAFP's
   role in a certified system is the *transport and discovery* layer; the
   safety logic lives in the RT-PLC. Document the certification boundary
   explicitly so AAFP is not implicated in the safety case.

---

## 15. Relationship to the Strategic Vision

This document is the edge instantiation of the Strategic Vision's
architecture. Each principle maps:

| Vision Principle                     | Edge Instantiation                          |
|--------------------------------------|---------------------------------------------|
| World Perception Layer               | Sensor-to-agent pattern (§9)                |
| Capabilities, not integrations       | `temperature-read` as a discovered capability|
| Design for hardware that doesn't exist | NPU/ASIC abstracted as capability metadata |
| The protocol should disappear        | Factory developer writes intent, not topology (§13.6) |
| Don't bake algorithms into protocol  | Mesh routing, duty cycling, offline queue are SDK-local |
| Compete with gravity                 | Adaptive wake intervals, fail-safe defaults |
| Network effects as the moat          | Every sensor that joins enriches the capability graph |
| Evolving intelligence above transport| Sleep, mesh, real-time profiles are all SDK |

The edge does not change the protocol. It stress-tests the SDK's ability to
present the same protocol across seven orders of magnitude in device
capability — from a 256 KB MCU to a 256 GB cloud node — and make the
difference invisible to the developer. That is the test the Strategic
Vision set, and the test the edge deployment model must pass.

---

*End of document.*
