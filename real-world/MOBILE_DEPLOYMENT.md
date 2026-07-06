# AAFP Mobile Agent Deployment

**Status:** Research / design proposal
**Date:** 2026-07-05
**Author:** Devin (architect), David Nichols (owner)
**Related:** [STRATEGIC_VISION.md](../STRATEGIC_VISION.md) §World Perception Layer, [RFC-0010 Circuit Relay](../RFCs/0010-circuit-relay.md), [RFC-0003 Identity](../RFCs/0003-identity-authentication.md), [NAT_TRAVERSAL_TESTING.md](../docs/NAT_TRAVERSAL_TESTING.md), [TYPESCRIPT_SDK_DESIGN.md](../TYPESCRIPT_SDK_DESIGN.md)

---

## 1. Executive Summary

The AAFP strategic vision positions the protocol as the "operating system of
the agent internet," with a World Perception Layer that lets agents perceive
and act on the real world. The most ubiquitous real-world sensor and actuator
platform is the smartphone: billions of devices with cameras, microphones,
GPS, accelerometers, biometric sensors, and a human in the loop. AAFP cannot
claim to be the execution substrate for autonomous software if it does not run
natively on the device that owns the richest perception surface on the planet.

This document specifies how AAFP agents are deployed on iOS, Android, and
React Native. It covers three implementation strategies (native FFI to the
Rust core, pure-platform reimplementation, and WebSocket relay), the
mobile-specific constraints that distinguish mobile agents from server agents
(battery, background execution, network switching, NAT), push-notification
wakeup via APNs/FCM, on-device AI models acting as AAFP agents that call cloud
agents, the relay strategy required because mobile is always behind carrier
NAT, connection persistence across foreground/background transitions, offline
RPC queueing, bandwidth optimization, and mobile security (Secure Enclave /
Keystore, biometric unlock).

A concrete worked example — an iOS app with an on-device agent that calls
cloud LLM agents through AAFP — ties the design together.

**Headline recommendation:** Ship a **hybrid** mobile stack — a Rust core
compiled for iOS (arm64) and Android (arm64/x86_64) exposed via a thin FFI/JNI
surface, with a pure-Kotlin/Swift convenience layer and a React Native bridge
on top. Pure-platform reimplementations are a Phase 6+ stretch goal. The relay
strategy is non-negotiable: every mobile agent MUST maintain a circuit relay
reservation (RFC-0010) for inbound reachability, because mobile networks are
inbound-hostile by design.

---

## 2. Why Mobile Is a First-Class AAFP Target

### 2.1 The Perception Argument

The STRATEGIC_VISION's World Perception Layer lists capabilities: web-browse,
pdf-read, image-ocr, api-call, code-execute, form-fill, search. A phone adds:

- **camera** → image-ocr, document-scan, barcode, scene-understanding
- **microphone** → speech-to-text, speaker-id, ambient-sound classification
- **GPS + IMU** → location, motion, activity recognition
- **contacts / calendar / SMS** → personal-context retrieval
- **biometrics** → presence-attestation, liveness
- **push channel** → human-in-the-loop notifications

A phone is not just a client that *calls* agents; it *hosts* agents that
*serve* perception capabilities to the rest of the network. A phone that
serves `image-ocr` (via on-device CoreML/NNAPI models) to nearby agents is a
first-class AAFP capability provider, not a thin client.

### 2.2 The Scale Argument

Server agents number in the thousands. Mobile agents would number in the
millions to billions. The adaptive routing plane (STRATEGIC_VISION §Adaptive
Routing Plane) becomes meaningful only at that scale. Mobile is the path from
"intranet of agents" to "internet of agents."

### 2.3 The NAT Argument

Every mobile device is behind at least one NAT (carrier-grade NAT on cellular,
NAT on WiFi). It cannot accept inbound QUIC connections without a relay. This
is not an edge case; it is the default condition for the majority of AAFP
agents if mobile adoption succeeds. The circuit relay protocol (RFC-0010) was
designed for exactly this, but mobile imposes additional constraints —
intermittent connectivity, OS-imposed socket teardown, push-wakeup latency —
that the relay protocol alone does not solve. Section 7 addresses these.

---

## 3. Implementation Strategies

Three strategies, evaluated against four axes: performance, binary size,
maintenance cost, and feature parity with the Rust core.

| Strategy | Perf | Binary | Maintenance | Parity | Verdict |
|----------|------|--------|-------------|--------|---------|
| Native FFI to Rust core | High | +3-6 MB | Low (one codebase) | Full | **Recommended** |
| Pure Swift / Kotlin reimpl | Medium | +0.5 MB | High (two codebases) | Drifts | Phase 6+ stretch |
| WebSocket relay to server agent | Low | +0.1 MB | Low | N/A (no on-device agent) | Fallback only |

### 3.1 Strategy A — Native FFI to Rust Core (Recommended)

The Rust implementation (`implementations/rust`) already builds for `aarch64`
and has a `wasm32` target for the browser. iOS and Android are additional
`cargo` targets:

- **iOS:** `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios`
- **Android:** `aarch64-linux-android`, `armv7-linux-androideabi`, `x86_64-linux-android`

The Rust crate exposes a C ABI (`extern "C"`) surface — a flat set of
functions for creating an agent, dialing, discovering, calling, and serving
capabilities. Platform code calls into this ABI.

```
┌─────────────────────────────────────────────┐
│  Swift app  /  Kotlin app  /  RN JS bundle   │
├─────────────────────────────────────────────┤
│  Platform SDK (Swift / Kotlin / TS bridge)   │
├─────────────────────────────────────────────┤
│  C ABI  (aafp_ffi.h)                         │
├─────────────────────────────────────────────┤
│  Rust core (QUIC, ML-DSA-65, CBOR, relay)    │
├─────────────────────────────────────────────┤
│  iOS Network.framework / Android NDK sockets │
└─────────────────────────────────────────────┘
```

**Pros:** Full feature parity (QUIC, post-quantum handshake, CBOR framing,
relay, discovery, streaming RPC) for free. One codebase. The wire protocol is
frozen (Rev 6), so the FFI surface is stable.

**Cons:** +3-6 MB binary (the `quinn` QUIC stack + `pqcrypto` ML-DSA-65).
App Store / Play Store review friction is low (Rust static libs are routine),
but the post-quantum crypto must be audited per platform (see §11).

### 3.2 Strategy B — Pure Swift / Pure Kotlin Reimplementation

Reimplement the AAFP wire protocol natively: QUIC via `Network.framework`
(iOS) / `OkHttp` QUIC (Android), ML-DSA-65 via platform crypto or
`@noble/post-quantum`-equivalent, CBOR via platform codecs.

**Pros:** Smallest binary. Deepest platform integration (background tasks,
push, biometrics all native).

**Cons:** Two codebases that drift from the Rust reference. ML-DSA-65 (FIPS
204) implementations in Swift/Kotlin are immature; the Rust `pqcrypto` crate
is the audited reference. QUIC on `Network.framework` is still incomplete for
server-side streams. **This is a Phase 6+ stretch goal**, not the initial
ship. The risk of wire-protocol drift is the deciding factor — the strategic
vision explicitly freezes the wire protocol and one codebase enforces that.

### 3.3 Strategy C — WebSocket Relay (Fallback)

The mobile app runs no AAFP stack at all. It speaks WebSocket to a server-side
AAFP agent that owns the mobile device's identity and relays RPCs in and out.
The mobile app is a thin UI.

**Pros:** Trivial mobile code. Works on any platform with a WebSocket.

**Cons:** The mobile device is not an AAFP agent — it has no AgentId, no
on-device capabilities, no peer-to-peer path. It is a client of a server
agent. This violates the strategic vision's goal of mobile devices as
first-class capability providers. **Use only as a fallback for constrained
environments** (e.g., feature phones, webviews) or during the transition to
Strategy A.

---

## 4. iOS AAFP Agent (Swift)

### 4.1 Architecture

The iOS agent is a Swift framework (`AAFPKit`) that wraps the Rust core via a
C header. The Rust core is built as a static `.a` / XCFramework and linked
into the app. Swift calls into the C ABI; callbacks from Rust into Swift use a
registered callback context pointer.

```swift
// AAFPKit/Agent.swift
import Foundation
import AAFPFFI   // generated Swift bindings over aafp_ffi.h

public final class Agent {
    private let handle: OpaquePointer

    public init(keypair: Keypair, relay: String) throws {
        var cfg = aafp_agent_config_t(
            keypair: keypair.ffi,
            relay_addr: relay.cString(using: .utf8),
            enable_background: true,
            push_token: nil
        )
        guard let h = aafp_agent_create(&cfg) else {
            throw AAFPError.creationFailed
        }
        self.handle = h
        aafp_agent_set_callback(h, Agent.callbackTrampoline, Unmanaged.passUnretained(self).toOpaque())
    }

    public func discover(_ capability: String) async throws -> Peer {
        try await withCheckedThrowingContinuation { cont in
            aafp_agent_discover(handle, capability) { peerId, error in
                if let error = error { cont.resume(throwing: error) }
                else { cont.resume(returning: Peer(id: peerId!)) }
            }
        }
    }

    public func call(_ peer: Peer, capability: String, body: Data) async throws -> Data {
        var bodyBytes = [UInt8](body)
        return try await withCheckedThrowingContinuation { cont in
            aafp_agent_call(handle, peer.id, capability, &bodyBytes, bodyBytes.count) { resp, error in
                if let error = error { cont.resume(throwing: error) }
                else { cont.resume(returning: Data(bytes: resp!.bytes, count: resp!.len)) }
            }
        }
    }

    private static let callbackTrampoline: aafp_callback_t = { ctx, event, payload in
        let agent = Unmanaged<Agent>.fromOpaque(ctx!).takeUnretainedValue()
        agent.handleEvent(event, payload: payload)
    }

    private func handleEvent(_ event: aafp_event_t, payload: UnsafeRawPointer?) {
        // route to delegate: incoming RPC, push wakeup, connection state, etc.
    }
}
```

### 4.2 Background Execution

iOS suspends the app shortly after backgrounding. AAFP connections (QUIC) are
torn down by the OS within ~30 seconds unless the app has a background
entitlement. The viable background modes for an AAFP agent:

- **`voip` PushKit** — historically the only mode that kept a socket alive
  indefinitely. Apple has restricted this to VoIP apps; using it for a
  non-VoIP agent risks App Store rejection. **Not recommended.**
- **`background processing` task (BGProcessingTask)** — gives ~30 seconds of
  CPU. Suitable for draining the offline RPC queue on wakeup, not for keeping
  a connection alive.
- **Push notification wakeup (APNs silent push)** — the OS delivers a silent
  push, wakes the app for ~30 seconds, the agent re-establishes the relay
  reservation and drains pending inbound RPCs. **This is the primary
  mechanism.** See §8.

The implication: an iOS AAFP agent is **connectionless in the background by
default**. It does not maintain a live QUIC connection while backgrounded. It
relies on APNs to wake it, then re-establishes connectivity on demand. This is
the opposite of a server agent and must be reflected in the relay reservation
lifecycle (§7.3).

### 4.3 Network.framework vs Raw Sockets

`Network.framework` (`NWConnection`) is Apple's preferred transport and
supports QUIC as of iOS 15. However, `Network.framework` QUIC does not expose
the full stream-control surface that `quinn` (the Rust QUIC stack) relies on.
The recommended path is to compile the Rust `quinn` stack against BSD sockets
on iOS directly (the NDK-equivalent for iOS is just POSIX sockets, which are
available). `Network.framework` is used only for reachability monitoring
(`NWPathMonitor`) to drive network-switch handling (§6).

---

## 5. Android AAFP Agent (Kotlin)

### 5.1 Architecture

The Android agent is a Kotlin library (`aafp-android`) that wraps the Rust
core via JNI. The Rust core is built as a `.so` per ABI and packaged in the
AAR. JNI bridges Kotlin ↔ C ABI.

```kotlin
// aafp-android/src/main/kotlin/io/aafp/Agent.kt
class Agent private constructor(private val ptr: Long) {

    companion object {
        init { System.loadLibrary("aafp_jni") }
    }

    interface Callback {
        fun onIncomingRpc(rpc: IncomingRpc)
        fun onPushWakeup(payload: ByteArray)
        fun onConnectionState(state: ConnectionState)
    }

    fun discover(capability: String, cont: Continuation<Peer>) {
        nativeDiscover(ptr, capability, object : NativeCallback {
            override fun onSuccess(peerId: ByteArray) = cont.resume(Peer(peerId))
            override fun onError(code: Int, msg: String) = cont.resumeWithException(AAFPException(code, msg))
        })
    }

    suspend fun call(peer: Peer, capability: String, body: ByteArray): ByteArray =
        suspendCoroutine { cont ->
            nativeCall(ptr, peer.id, capability, body, object : NativeCallback {
                override fun onSuccess(resp: ByteArray) = cont.resume(resp)
                override fun onError(code: Int, msg: String) = cont.resumeWithException(AAFPException(code, msg))
            })
        }

    private external fun nativeDiscover(ptr: Long, cap: String, cb: NativeCallback)
    private external fun nativeCall(ptr: Long, peer: ByteArray, cap: String, body: ByteArray, cb: NativeCallback)
}
```

### 5.2 Foreground Service for Persistent Agents

Android permits a `ForegroundService` (with a persistent notification) to keep
network sockets alive indefinitely. This is the Android equivalent of a
server agent's always-on connection. Use cases that need inbound RPCs while
the app is backgrounded (e.g., a phone serving `image-ocr` to nearby agents)
run as a Foreground Service.

```kotlin
class AafpAgentService : ForegroundService() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification("AAFP agent running"))
        agent = Agent.Builder()
            .keypair(keystoreKeyPair)
            .relay(relayUrl)
            .keepAlive(true)
            .start()
        return START_STICKY  // restart if killed
    }
}
```

**Caveat:** Android 14+ restricts foreground services by type
(`dataSync`, `connectedDevice`, etc.). An AAFP agent maps to
`dataSync` (long-running network data transfer). The persistent notification
is a UX cost; users will see "AAFP agent running" and may kill it. Design for
graceful degradation: if the service is killed, the agent falls back to
FCM-wakeup mode (§8.2).

### 5.3 Doze and App Standby

Doze mode defers network access, jobs, and alarms for backgrounded apps. A
foreground service is exempt, but a non-foreground agent is subject to Doze
maintenance windows (which can be hours). The offline queue (§9) absorbs this:
RPCs generated while in Doze are queued and flushed at the next maintenance
window or on FCM wakeup.

---

## 6. React Native Integration (TypeScript SDK via Bridge)

### 6.1 Bridge Architecture

React Native apps cannot directly load a Rust `.so`/`.a`. The bridge is a
native module (Swift on iOS, Kotlin on Android) that wraps the same Rust core
and exposes a JS API via the RN bridge. The TypeScript SDK (`@aafp/react`)
mirrors the `@aafp/sdk` API surface (see TYPESCRIPT_SDK_DESIGN.md) so that
agent code is portable between Node, browser, and React Native.

```
┌──────────────────────────────────────┐
│  React Native JS (TypeScript)        │
│  import { Agent } from "@aafp/react" │
├──────────────────────────────────────┤
│  NativeModules.AafpBridge (JSI)      │
├──────────────────────────────────────┤
│  Swift NativeModule / Kotlin Module  │
├──────────────────────────────────────┤
│  Rust core (shared .a / .so)         │
└──────────────────────────────────────┘
```

### 6.2 JSI for Performance

The legacy RN bridge serializes everything to JSON over an async queue — too
slow for streaming RPCs and CBOR payloads. Use **JSI (JavaScript Interface)**
to expose the Rust core as a C++ host object that JS can call synchronously
for cheap operations and via promises/async iterables for network ops. CBOR
bytes pass as `ArrayBuffer` without JSON round-trip.

```typescript
// @aafp/react
import { Agent } from "@aafp/react";

const agent = await Agent.serve()
  .capability("image-ocr")
  .onCapability("image-ocr", async (req, ctx) => {
    const img = req.body;  // ArrayBuffer
    const text = await runCoreML("ocr-model", img);
    return Response.text(text);
  })
  .start();

const cloud = await Agent.connect();
const summary = await cloud.discover("summarize").call(Request.text(longText));
```

### 6.3 New Architecture (Fabric / TurboModules)

Under the RN New Architecture, the AAFP native module is a TurboModule with
JSI bindings. Streaming RPCs (STREAMING_RPC_DESIGN.md) map naturally to RN
`EventEmitter` / async iterables. The bridge does not buffer entire streams;
chunks flow as they arrive.

---

## 7. Mobile Relay Strategy

### 7.1 Mobile Is Always Behind NAT

A mobile device is behind carrier-grade NAT (cellular) or home/enterprise NAT
(WiFi). It cannot accept inbound QUIC connections. RFC-0010's circuit relay is
the only path to inbound reachability. Every mobile agent MUST:

1. On startup, detect NAT via AutoNAT (RFC-0010 §6).
2. If NAT'd (always true on mobile), request a relay reservation.
3. Advertise the relay address (not the local address) in its AgentRecord.
4. Renew the reservation before TTL expiry.
5. On network switch, re-reserve (the old reservation's observed address is
   now stale).

### 7.2 Relay Selection

Mobile agents should prefer **geo-nearby relays** to minimize the extra hop
latency. The adaptive routing plane (STRATEGIC_VISION) provides the metrics;
absent that, a static regional relay list is the fallback. A mobile agent
maintains reservations with **2-3 relays** for redundancy — if one relay is
unreachable (common on captive portals), the agent falls back to another.

### 7.3 Reservation Lifecycle Under Mobile Constraints

The RFC-0010 default reservation TTL is 1 hour. On mobile, the connection
underlying the reservation is torn down by the OS on backgrounding. The
reservation itself lives on the relay (it is server-side state), so it
survives the connection teardown — but the relay cannot forward traffic to an
agent that has no live connection. Two options:

- **Lazy reattach:** The reservation persists; when the agent wakes (push or
  foreground), it reconnects to the relay and rebinds to the existing
  reservation ID. Inbound RPCs that arrived while the agent was offline are
  buffered at the relay (requires a relay-side buffer extension — see §7.4).
- **Eager renew:** The agent re-reserves on every wake. Simpler, but loses
  buffered inbound RPCs and changes the advertised address.

**Recommendation: lazy reattach + relay-side buffer.** The relay buffers
inbound RPCs for offline mobile agents for a bounded TTL (e.g., 5 minutes),
delivering them on reattach. This is a backward-compatible extension to
RFC-0010: a new `aafp.relay.reattach` method that takes an existing
reservation ID and replays buffered frames.

### 7.4 Proposed Extension: `aafp.relay.reattach`

```cbor
// Request
{
  1: uint,  // reservation_id: existing reservation
  2: uint,  // last_delivered_seq: last frame seq the agent processed
}

// Response
{
  1: array<uint>,  // buffered_frame_seqs: seqs available for replay
  2: uint,         // buffer_ttl_secs: how long buffer will persist
}
```

The relay holds buffered inbound DATA frames per reservation, indexed by
sequence number. On reattach, the agent reports the last sequence it
processed; the relay replays everything after it. This makes mobile agents
appear connection-persistent to callers despite OS-imposed socket teardown.

---

## 8. Push Notification Integration (Waking Agents for Inbound RPCs)

### 8.1 The Problem

A backgrounded mobile agent has no live QUIC connection. A remote agent that
discovers the mobile agent's capability and calls it would block until the
mobile agent wakes (which could be hours under Doze). Server agents don't have
this problem; mobile agents do. The solution is to wake the mobile agent via
the OS push channel.

### 8.2 Flow

```
Remote Agent ──call──> Relay ──no live connection──> Push Gateway
                                                         │
                                          ┌──────────────┴──────────────┐
                                          │                             │
                                       APNs (iOS)                    FCM (Android)
                                          │                             │
                                          ▼                             ▼
                              iOS silent push                  Android high-priority FCM
                                          │                             │
                                          ▼                             ▼
                              App woke (~30s)                  App woke (~30s)
                                          │                             │
                                          └──────────────┬──────────────┘
                                                         ▼
                                          Agent reattaches to relay
                                          drains buffered RPC
                                          executes capability
                                          sends response via relay
```

### 8.3 Push Payload

The push payload is minimal — it carries only enough to wake the agent and
tell it which relay has buffered work. The actual RPC body is NOT in the push
(it could be large, and push payloads are size-limited and visible to the OS
vendor).

```json
{
  "relay": "quic://relay-eu-west.aafp.net:4433",
  "reservation_id": 4781,
  "seq_hint": 12,
  "priority": "high"
}
```

### 8.4 APNs (iOS)

Register for remote notifications with the `content-available` flag (silent
push). The app receives `didReceiveRemoteNotification` in the background,
wakes for ~30 seconds, reattaches to the relay, drains, and responds. Apple
throttles silent pushes if the app fails to respond or responds too slowly —
the agent MUST complete the relay round-trip within the 30-second window or
risk being deprioritized for future silent pushes.

```swift
func application(_ app: UIApplication,
                 didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                 fetchCompletionHandler handler: @escaping (UIBackgroundFetchResult) -> Void) {
    guard let relay = userInfo["relay"] as? String,
          let resId = userInfo["reservation_id"] as? Int else {
        handler(.noData); return
    }
    Task {
        await agent.reattachAndDrain(relay: relay, reservationId: resId)
        handler(.newData)
    }
}
```

### 8.5 FCM (Android)

Use FCM high-priority messages, which bypass Doze restrictions for
time-sensitive data. Android grants the app a short window (~20-40s) of
network access. Same flow: reattach, drain, respond.

```kotlin
class AafpFcmService : FirebaseMessagingService() {
    override fun onMessageReceived(msg: RemoteMessage) {
        val relay = msg.data["relay"] ?: return
        val resId = msg.data["reservation_id"]?.toInt() ?: return
        CoroutineScope(Dispatchers.IO).launch {
            agent.reattachAndDrain(relay, resId)
        }
    }
}
```

### 8.6 Push Token Registration

On agent startup, the app obtains an APNs/FCM token and registers it with its
relay reservation as out-of-band metadata. The relay stores
`reservation_id → push_token` so it can trigger a push when an inbound RPC
arrives for a reservation with no live connection. This requires the relay to
hold APNs/FCM credentials — a new relay responsibility, but a small one (a
single HTTP call to Apple/Google per wakeup).

### 8.7 Push Reliability and Cost

Push is not guaranteed. APNs and FCM are best-effort; silent pushes are
throttled. For capabilities that require reliable delivery, the caller should
fall back to polling the relay's buffer-status RPC, or the mobile agent should
run as a foreground service (Android) / use a more aggressive background mode
(iOS, with App Store risk). Push is the **cheap default**; foreground service
is the **reliable opt-in**.

---

## 9. Offline Queueing

### 9.1 Outbound Queue

When the mobile agent generates an RPC (e.g., "summarize this text" → cloud
LLM agent) while offline (no connectivity, in Doze, on a captive portal), the
RPC is queued locally rather than dropped. The queue is a persistent on-disk
log (SQLite or a flat CBOR file) keyed by client-assigned RPC ID.

```swift
struct QueuedRpc: Codable {
    let rpcId: UUID
    let peerId: [UInt8]
    let capability: String
    let body: Data
    let queuedAt: Date
    let deadline: Date?   // optional: drop if not delivered by
}
```

On connectivity restore (foregrounding, `NWPathMonitor` reporting
`isConnected`, or push wakeup), the queue is drained in FIFO order, with
deadline-expired entries dropped. Each RPC is retried with exponential
backoff up to a configurable max; the relay is used as the dial path so NAT
is not a barrier.

### 9.2 Inbound Buffer (Relay-Side)

Symmetric to the outbound queue: inbound RPCs that arrive at the relay while
the mobile agent is offline are buffered at the relay (§7.4). The mobile agent
drains both directions on reattach. This gives mobile agents an
**eventually-consistent RPC mailbox** semantics that server agents (always
online) don't need but mobile agents cannot function without.

### 9.3 Idempotency

Retries imply duplicate delivery. AAFP RPCs SHOULD carry an idempotency key
(client-assigned RPC ID) so that the serving agent can dedupe. This is a
general AAFP best practice but is *load-bearing* on mobile because retries are
the norm, not the exception.

---

## 10. Bandwidth Optimization

Mobile data is metered and slow (especially on cellular in poor coverage).
AAFP's CBOR framing is already more compact than JSON/HTTP, but mobile
demands more.

### 10.1 Compression

Enable QUIC's built-in header compression (QPACK) — already on. For payload
compression, layer **zstd** (or **brotli** for text-heavy payloads) over the
CBOR body, negotiated per-stream via a frame metadata flag. Compression is
especially valuable for LLM responses (text) and perception inputs (images
are already compressed, but OCR/structured outputs compress well).

### 10.2 Delta Encoding

For streaming RPCs (STREAMING_RPC_DESIGN.md) where successive chunks are
similar (e.g., incremental document edits, progressive rendering), use delta
encoding: the server sends only the diff relative to the last chunk, referenced
by a chunk sequence number. The client reconstructs by applying deltas. This
is a capability-flag negotiation at stream open.

### 10.3 Batch Responses

A mobile agent that calls multiple cloud agents in a fan-out (e.g., "summarize
+ translate + fact-check" in parallel) issues N separate RPCs. AAFP should
support a **batch RPC frame** (RFC-0002 extension) that carries multiple
sub-requests in one QUIC stream, with a single round-trip for all responses.
This halves the cellular radio-on time, which is the dominant battery cost on
cellular (§11.2).

### 10.4 Adaptive Payload Sizing

The adaptive routing plane carries network-quality metrics. A mobile agent
that reports high packet loss / low bandwidth should receive smaller chunks
from streaming servers. This is a server-side adaptation driven by the
client's reported network class — a concrete instance of the STRATEGIC_VISION's
"protocol should learn" principle.

---

## 11. Mobile-Specific Constraints

### 11.1 Battery

QUIC keep-alives, relay reservation renewals, and push-wakeup round-trips all
cost energy. Rules:

- **No idle keep-alive on cellular.** Cellular radio tail energy (the
  high-power state after a transfer) lasts ~10-15 seconds after the last
  byte. Batch transfers to amortize the tail; do not trickle.
- **Relay renewal aligned with activity.** Renew the reservation only when
  the agent is already awake for another reason (foreground, push wakeup).
  Do not wake the device solely to renew.
- **On-device model inference is cheaper than network round-trips** for small
  tasks. The on-device agent (§12) should handle trivial perception locally
  and escalate to cloud agents only when the local model's confidence is low
  or the task exceeds local capability.

### 11.2 Background Execution (Recap)

| Platform | Mechanism | CPU window | Keeps socket? |
|----------|-----------|-----------|---------------|
| iOS | Silent push | ~30s | No (reattach) |
| iOS | BGProcessingTask | ~30s | No |
| iOS | VoIP PushKit | indefinite | Yes (App Store risk) |
| Android | ForegroundService | indefinite | Yes |
| Android | FCM high-priority | ~20-40s | No (reattach) |
| Android | JobScheduler (Doze window) | minutes-hours | No |

### 11.3 Network Switching (WiFi ↔ Cellular)

`NWPathMonitor` (iOS) / `ConnectivityManager` (Android) report path changes.
On a switch:

1. The live QUIC connection's source address changes. QUIC connection
   migration (RFC 9000 §9) *should* handle this, but carrier NATs often
   remap the source port aggressively, breaking migration.
2. The agent tears down the connection, re-dials the relay, and rebinds to
   the existing reservation (§7.4 reattach).
3. In-flight RPCs are retried from the outbound queue (§9.1) with their
   idempotency keys.
4. The advertised relay address is unchanged (the relay is the stable
   reachability anchor; the mobile device's local address is not).

This is the single most important mobile-specific behavior: **the relay
address is the agent's stable identity for reachability; the local transport
is ephemeral.**

---

## 12. On-Device AI Model as AAFP Agent

### 12.1 The Pattern

A mobile app embeds a small AI model (CoreML on iOS, NNAPI/TFLite on Android)
— e.g., a 1-3B parameter LLM, an OCR model, a speech model. This on-device
model is wrapped as an AAFP agent: it has an AgentId, a keypair, serves
capabilities, and *also* acts as a client to discover and call cloud agents
for tasks beyond its local capacity.

```
┌─────────────────────────────────────────────────────┐
│  Phone                                              │
│  ┌───────────────────────────────────────────────┐  │
│  │  On-device AAFP agent (CoreML/NNAPI)          │  │
│  │  capabilities: local-ocr, local-summarize,    │  │
│  │  local-translate (small model)                │  │
│  └───────────────┬───────────────────────────────┘  │
│                  │ AAFP RPC (via relay)              │
└──────────────────┼──────────────────────────────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │  Cloud LLM agent     │
        │  capability:         │
        │  summarize (large),  │
        │  translate (any),    │
        │  reason              │
        └──────────────────────┘
```

### 12.2 Escalation Policy

The on-device agent serves `summarize` locally for short inputs (model
confidence high, input < 2K tokens). For long inputs or low confidence, it
discovers and calls a cloud `summarize` agent, forwarding the input and
returning the cloud response to its own caller. To the caller, the
capability is `summarize`; whether it ran locally or remotely is invisible.
This is the STRATEGIC_VISION's "discovery becomes planning" realized on a
single device.

### 12.3 Privacy and Selective Disclosure

On-device inference keeps sensitive data on-device. The on-device agent
escalates to cloud only the subset of data the local model cannot handle, and
only after a privacy policy check (e.g., "do not send health data to cloud").
The AAFP capability-graph discovery (STRATEGIC_VISION §Capability Graphs)
lets the on-device agent express `Need: summarize + privacy=on-device-only`
and route accordingly.

### 12.4 The On-Device Agent as Capability Provider

The on-device agent doesn't only call cloud — it *serves* its local
capabilities to the network. A nearby agent (e.g., a laptop on the same LAN,
or a cloud agent that discovered the phone via the relay) can call the
phone's `local-ocr` capability. The phone becomes a perception provider for
the agent internet. This is the strategic vision's World Perception Layer
made literal: the phone's camera + CoreML OCR is a capability served through
AAFP.

---

## 13. Security on Mobile

### 13.1 Keypair Storage

The AAFP AgentId is `SHA-256(public_key)` (RFC-0003 §2.1), with ML-DSA-65
(FIPS 204) as the post-quantum signature algorithm. The private key is the
agent's root identity and MUST be protected against extraction.

- **iOS:** Generate and store the ML-DSA-65 keypair in the **Secure Enclave**
  (SEP). The SEP supports a limited set of algorithms (primarily ECC);
  ML-DSA-65 is not SEP-native. Two options:
  1. **Hybrid:** SEP-protected ECDSA P-256 key as a wrapping key; the
     ML-DSA-65 private key is encrypted with the SEP key and stored in the
     Keychain. The ML-DSA-65 key never exists in plaintext outside a single
     transient decrypt-in-memory operation. SEP enforces biometric/passcode
     gating on the wrapping key.
  2. **Future:** if Apple exposes a generic PQC signing primitive in the SEP
     (plausible as FIPS 203/204/205 standardization completes), move the
     ML-DSA-65 key fully into the SEP.
- **Android:** Generate and store the keypair in the **Android Keystore**
  (`AndroidKeyStore`), hardware-backed by StrongBox (where available) or
  TEE. Same hybrid wrapping approach as iOS, since Keystore also lacks
  native ML-DSA-65 support today.

### 13.2 Biometric Unlock

The private key is gated behind biometric authentication (Face ID / Touch ID
/ Android BiometricPrompt). The agent does not hold the unlocked key in
memory permanently; it unlocks per-session with a biometric prompt, signs the
handshake, and clears the plaintext key from memory after a configurable
idle timeout. This trades UX friction for key protection — appropriate for
the root identity. For per-RPC signing (after handshake), the session key is
used; biometric re-prompt is only on cold start or after idle timeout.

```swift
func unlockKeypair() async throws -> MLDSAKey {
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
        throw AAFPError.biometricUnavailable
    }
    return try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                                            localizedReason: "Unlock your AAFP agent identity")
    // on success: decrypt ML-DSA-65 key with SEP-wrapped key
}
```

### 13.3 Relay Trust

The relay is a trusted intermediary for reachability but CANNOT read
relay traffic (RFC-0010 §8: end-to-end encrypted via QUIC TLS). The mobile
agent pins the relay's expected public key (TOFU with pinning) on first
connection and rejects mismatches. Relay push-trigger credentials (APNs/FCM)
are held by the relay but are not agent-identity material — they only wake
the device.

### 13.4 Attestation

For high-trust capabilities, the mobile agent can attach a **device
attestation** (Apple App Attest / Android Play Integrity) to its AgentRecord,
proving the agent runs on a genuine device with a genuine OS. Cloud agents
can require attestation as a discovery filter (`Need: ocr + attestation=apple`).
This is a Phase 4+ capability-graph feature but the mobile side should be
ready early.

### 13.5 Wipe

On app uninstall or explicit "reset identity," the keypair is destroyed
(Secure Enclave / Keystore key deletion). The AgentId becomes permanently
unreachable; the relay reservation expires; the AgentRecord expires per
RFC-0003's 30-day staleness rule. There is no key recovery — losing the
device means losing the identity, by design.

---

## 14. Concrete Example: iOS App with On-Device Agent Calling Cloud LLM Agents

### 14.1 Scenario

A note-taking app. The user selects a paragraph and taps "Summarize &
Translate." The app's on-device AAFP agent:

1. Tries local summarization with its on-device 1B LLM (CoreML).
2. If the input is too long or confidence is low, escalates to a cloud
   `summarize` agent via AAFP.
3. Calls a cloud `translate` agent (always cloud — no on-device translation
   model) with the summary.
4. Returns the translated summary to the UI.

### 14.2 Code

```swift
import AAFPKit

@MainActor
class AgentService {
    let agent: Agent
    let localLLM: CoreMLRunner

    init() async throws {
        let keypair = try await unlockKeypair()        // biometric
        agent = try Agent(
            keypair: keypair,
            relay: "quic://relay-eu-west.aafp.net:4433"
        )
        try await agent.serve()
            .capability("local-summarize")
            .onCapability("local-summarize") { req in
                let summary = try await self.localLLM.summarize(req.body)
                return Response.text(summary)
            }
            .start()
    }

    func summarizeAndTranslate(_ text: String) async throws -> String {
        // 1. Try local
        let localSummary: String?
        if text.count < 4000 {
            localSummary = try? await localLLM.summarize(text)
        } else { localSummary = nil }

        // 2. Escalate to cloud if local failed or was skipped
        let summary: String
        if let local = localSummary, !local.isEmpty {
            summary = local
        } else {
            let cloud = try await agent.discover("summarize")   // finds cloud LLM agent
            let resp = try await agent.call(cloud, capability: "summarize", body: Data(text.utf8))
            summary = String(data: resp, encoding: .utf8) ?? ""
        }

        // 3. Translate (always cloud)
        let translator = try await agent.discover("translate")
        let translated = try await agent.call(translator, capability: "translate",
                                              body: Data(summary.utf8))
        return String(data: translated, encoding: .utf8) ?? ""
    }
}
```

### 14.3 Background Inbound

The same agent, while the app is backgrounded, can be woken by an APNs silent
push because a remote agent discovered its `local-summarize` capability and
called it via the relay:

```swift
func application(_ app: UIApplication,
                 didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                 fetchCompletionHandler handler: @escaping (UIBackgroundFetchResult) -> Void) {
    Task {
        await agent.reattachAndDrain(
            relay: userInfo["relay"] as! String,
            reservationId: (userInfo["reservation_id"] as! NSNumber).intValue
        )
        handler(.newData)
    }
}
```

The remote agent's `summarize` RPC is buffered at the relay, replayed on
reattach, executed by the on-device CoreML model, and the response flows
back through the relay — all within the ~30-second iOS background window.

### 14.4 Failure Modes

- **30s window exceeded:** the iOS agent is killed mid-RPC. The relay's
  inbound buffer retains the RPC; the next push wakeup retries. The
  idempotency key prevents double-execution if the agent already ran the
  model but failed to send the response.
- **No connectivity on wake:** the RPC stays in the relay buffer; the agent
  retries on next foreground or push.
- **Biometric prompt in background:** biometric prompts cannot be shown in
  the background. The agent uses a session key cached from the last
  foreground unlock (with a short TTL, e.g., 10 minutes) for background
  signing. If the session key has expired, the RPC is deferred to next
  foreground.

---

## 15. Connection Persistence Across Foreground/Background Transitions

### 15.1 State Machine

```
                ┌──────────┐
                │ FOREGROUND│
                │ live QUIC │
                │ to relay  │
                └─────┬──────┘
                      │ background
                      ▼
                ┌──────────┐
                │ BACKGROUND│
                │ no socket │  <-- OS tears down QUIC within ~30s
                │ relay     │      reservation persists server-side
                │ buffers   │      inbound RPCs buffered at relay
                │ inbound   │
                └─────┬──────┘
                      │ APNs/FCM push OR foreground
                      ▼
                ┌──────────┐
                │ WAKING    │
                │ re-dial   │  <-- reattach to existing reservation
                │ relay     │      replay buffered inbound (§7.4)
                │ drain     │
                └─────┬──────┘
                      │ drained
                      ▼
                ┌──────────┐
                │ FOREGROUND│
                └──────────┘
```

### 15.2 Implementation Notes

- The reservation ID is the stable anchor across transitions. It is
  persisted to disk (it survives app kill).
- The push token is re-registered on every app launch (tokens rotate).
- The relay's `reattach` (§7.4) is the single mechanism that makes the
  transition seamless to callers — a caller sees a brief RPC delay, not a
  failure, when the mobile agent is backgrounded.
- QUIC connection migration (RFC 9000) is *not* relied upon for the
  background transition; the OS kills the socket too aggressively. Re-dial
  is more robust on mobile.

---

## 16. Roadmap and Phasing

| Phase | Deliverable | Depends on |
|-------|-------------|------------|
| M1 | Rust core cross-compiles for iOS + Android; C ABI stable | — |
| M2 | `AAFPKit` Swift framework + `aafp-android` Kotlin lib; basic discover/call | M1 |
| M3 | Relay `reattach` extension (RFC-0010 amendment) + relay-side inbound buffer | M2 |
| M4 | APNs + FCM push-wakeup integration; relay push-trigger | M3 |
| M5 | Offline outbound queue + idempotency keys | M2 |
| M6 | Secure Enclave / Keystore keypair with biometric unlock | M2 |
| M7 | React Native bridge (`@aafp/react`) via JSI | M2 |
| M8 | On-device CoreML/NNAPI agent wrapper + escalation policy | M6 |
| M9 | Bandwidth: compression, batch RPC, delta encoding | M2 |
| M10 | Device attestation (App Attest / Play Integrity) in AgentRecord | M6, Phase 4 capability graphs |

M1-M2 are the foundation; M3-M4 are what make mobile agents actually
reachable; M6 is what makes them secure; M8 is the strategic-vision payoff
(phones as perception providers).

---

## 17. Open Questions

1. **Relay push-trigger trust model.** The relay holds APNs/FCM credentials
   to trigger wakeups. Should this be a dedicated "push relay" role separate
   from the data relay, or combined? Combined is simpler; separate is more
   auditable.
2. **ML-DSA-65 in Secure Enclave.** When will Apple/Google expose PQC signing
   in hardware? Until then, the hybrid wrapping approach (§13.1) is the
   pragmatic path. Track FIPS 204 adoption in platform SDKs.
3. **Push throttling vs. reliability.** APNs throttles silent pushes to apps
   that don't respond promptly. For high-reliability mobile agents, is a
   foreground service (Android) / VoIP PushKit (iOS, App Store risk) the only
   real answer? What's the App Store policy on a non-VoIP app using PushKit?
4. **Relay buffer cost.** Buffering inbound RPCs for offline mobile agents
   costs relay memory. What's the fair economic model (STRATEGIC_VISION
   §Economic Layer)? Per-buffered-byte-second pricing?
5. **QUIC on mobile network.framework.** Will Apple's `Network.framework`
   QUIC ever expose the stream-control surface `quinn` needs, making a pure
   Swift reimplementation (Strategy B) viable? Currently no; track iOS
   releases.
6. **Multi-device identity.** Does a user have one AgentId across phone +
   laptop + watch, or one per device? Per-device is simpler and matches the
   keypair-in-secure-enclave model; cross-device requires identity
   delegation (UCAN-style capability delegation, RFC-0003 §Authorization).

---

## 18. Conclusion

Mobile is not a port of AAFP; it is a first-class deployment target that
exercises every layer of the strategic vision — the World Perception Layer
(phones as capability providers), the adaptive routing plane (millions of
mobile agents), the execution fabric (on-device + cloud escalation), and the
trust layer (Secure Enclave identity). The technical crux is that mobile
devices are inbound-hostile, intermittently connected, and battery-constrained,
which makes the circuit relay (RFC-0010) plus push-wakeup plus offline
queueing the load-bearing trio of any mobile deployment. The recommended
implementation — Rust core via FFI/JNI, with Swift/Kotlin/RN layers above —
preserves wire-protocol parity with the server stack and lets the mobile
ecosystem grow on the same frozen foundation the strategic vision demands.

The single most important protocol extension this work requires is the
relay `reattach` mechanism with inbound buffering (§7.4). Without it, mobile
agents appear offline to callers whenever the OS suspends them, and the
"phone as capability provider" vision fails. With it, mobile agents are
eventually-consistent AAFP citizens — briefly unreachable, but never lost.
