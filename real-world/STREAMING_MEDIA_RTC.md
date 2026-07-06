# AAFP for Streaming Media & Real-Time Communication

**Author:** Devin (research synthesis)
**Date:** 2026-07-04
**Status:** Reference design — streaming media & RTC patterns over AAFP
**Depends on:** `STREAMING_RPC_DESIGN.md` (P2.8 server/client/bidi streaming),
`PUBSUB_BACKCHANNEL_DESIGN.md` (RFC-0009 fan-out), `PERFORMANCE_SCALABILITY.md`
(QUIC tuning presets), `USE_CASES_KILLER_APPS.md` (Use Case 4: translation mesh)

---

## Executive Summary

AAFP's streaming RPC layer (P2.8) was designed primarily for LLM token
streaming, but the underlying primitives — persistent QUIC bi-streams, the
MORE flag for multi-frame messages, stream-level flow control, stream reset
for cancellation, and RFC-0009 PubSub for fan-out — are exactly the
primitives needed for general-purpose **streaming media** and **real-time
communication (RTC)** between agents. This document specifies how to use
those primitives for:

- **Audio streaming** — voice agents, podcast transcription, real-time
  translation.
- **Video streaming** — camera agents, surveillance, visual inspection.
- **Real-time sensor data** — IoT telemetry, financial market data feeds.
- **Token streaming for LLMs** — already supported via P2.8; documented here
  as the canonical best-practice reference.
- **Multicast** — one producer, many consumers (live transcription feed,
  surveillance fan-out) via RFC-0009 PubSub.
- **Recording & replay** — capture a stream for later analysis or replay.

The document also covers the cross-cutting concerns that make streaming
media work in production: **backpressure handling**, **flow control**
(QUIC stream-level vs AAFP-level), **buffer management** (ring buffers,
bounded channels, drop policies), **latency optimization** (low-latency
mode, no buffering, immediate flush), and **codec considerations** (Opus
for audio, VP8/AV1 for video, CBOR for structured data).

**Key conclusion:** No wire protocol changes are required. All streaming
media patterns are compositions of existing P2.8 streaming RPC, RFC-0009
PubSub, and QUIC transport features. The work is in the SDK and application
layer: codec integration, buffer policy, and ergonomic APIs for media
chunking.

---

## Table of Contents

1. [Streaming Media vs Token Streaming](#1-streaming-media-vs-token-streaming)
2. [AAFP for Audio Streaming](#2-aafp-for-audio-streaming)
3. [AAFP for Video Streaming](#3-aafp-for-video-streaming)
4. [AAFP for Real-Time Sensor Data](#4-aafp-for-real-time-sensor-data)
5. [Token Streaming for LLMs (Best Practices)](#5-token-streaming-for-llms-best-practices)
6. [Backpressure Handling](#6-backpressure-handling)
7. [Flow Control: QUIC vs AAFP](#7-flow-control-quic-vs-aafp)
8. [Buffer Management](#8-buffer-management)
9. [Latency Optimization](#9-latency-optimization)
10. [Multicast via PubSub](#10-multicast-via-pubsub)
11. [Recording and Replay](#11-recording-and-replay)
12. [Codec Considerations](#12-codec-considerations)
13. [Concrete Example: Voice Agent → Transcription](#13-concrete-example-voice-agent--transcription)
14. [Concrete Example: Camera Agent → Object Detection](#14-concrete-example-camera-agent--object-detection)
15. [Concrete Example: LLM Agent → Display Agent](#15-concrete-example-llm-agent--display-agent)
16. [Security Considerations](#16-security-considerations)
17. [Implementation Roadmap](#17-implementation-roadmap)

---

## 1. Streaming Media vs Token Streaming

### 1.1 What Is Different About Media

LLM token streaming (the P2.8 flagship use case) has a forgiving profile:

- **Small frames** — a token is 1–20 bytes of UTF-8; even with CBOR/RPC
  envelope overhead, each frame is < 256 B.
- **Low rate** — 20–80 tokens/second for a fast model; bursty, not
  continuous.
- **Loss tolerance** — a dropped token is a UI glitch, not data
  corruption; the final assembled text is what matters.
- **No codec** — text is text; no encoding/decoding step.

Streaming media (audio, video, sensor data) has a harsher profile:

| Property | LLM tokens | Audio (Opus) | Video (VP8/AV1) | Sensor data |
|----------|-----------|--------------|-----------------|-------------|
| Frame size | 1–20 B | 40–400 B | 1–100 KB | 8–200 B |
| Frame rate | 20–80/s | 50/s (20 ms) | 30–60/s | 100–10K/s |
| Sustained rate | ~1 KB/s | 16–64 KB/s | 0.5–5 MB/s | 10 KB–2 MB/s |
| Latency budget | 100 ms+ | 50–150 ms | 33–100 ms | 1–50 ms |
| Loss tolerance | High | Medium (PLC) | Low (keyframes) | Varies |
| Codec required | No | Yes | Yes | Optional |
| Ordering critical | Yes | Yes | Yes | Yes (per-stream) |

The key differences that drive design decisions in this document:

1. **Higher sustained throughput** — video at 5 MB/s can saturate a 1 MB
   QUIC stream window in 200 ms, making flow control and backpressure
   first-order concerns rather than theoretical edge cases.
2. **Tighter latency budgets** — audio at 150 ms one-way is acceptable;
   video at 100 ms is acceptable; beyond that, interactive use breaks.
   This rules out large buffers and favors immediate flush.
3. **Codec framing** — media is already framed by the codec (Opus packets,
   VP8 frames). AAFP frames should carry codec frames 1:1 to avoid
   re-buffering and extra latency.
4. **Loss semantics differ by media type** — audio has packet-loss
   concealment (PLC); video keyframes are critical, delta frames are
   disposable; sensor data may need exactly-once or may tolerate drops.

### 1.2 What Is the Same

Despite the differences, the *transport* primitives are identical:

- **Persistent bi-stream** — one QUIC bi-stream per media session, kept
  open for the duration of the stream (P2.8 server-streaming or
  bidirectional streaming).
- **MORE flag** — each media chunk is a DATA/RPC_RESPONSE frame with the
  MORE flag set; the final frame clears MORE to signal end-of-stream.
- **Cancellation** — QUIC stream reset maps to "stop the mic" / "stop the
  camera" (P2.8 §6).
- **Flow control** — QUIC stream-level flow control provides automatic
  backpressure when the consumer is slow (P2.8 §7).
- **PubSub fan-out** — RFC-0009 delivers one producer's frames to many
  consumers for multicast scenarios.

This means the P2.8 streaming RPC API (`streaming_handler`,
`call_stream`, `CancellationToken`, `StreamContext`) is reused directly.
The additions in this document are: codec-aware payload conventions,
buffer/drop policies, latency-tuned QUIC presets, and recording hooks.

---

## 2. AAFP for Audio Streaming

### 2.1 Use Cases

- **Voice agents** — a user speaks to a voice agent; audio streams to a
  transcription agent (ASR), which streams partial transcripts back.
- **Podcast transcription** — a long audio file is chunked and streamed
  to a transcription agent for batch or real-time transcription.
- **Real-time translation** — audio streams to a translation mesh (Use
  Case 4 in `USE_CASES_KILLER_APPS.md`); translated audio or text
  streams back.
- **Voice chat between agents** — two agents exchange audio
  bidirectionally (intercom pattern).

### 2.2 Audio Chunking Convention

Audio is chunked at the codec frame boundary. For **Opus** (recommended,
see §12.1), the standard frame durations are 2.5, 5, 10, 20, 40, or 60 ms.
For real-time voice, **20 ms** is the sweet spot: low enough latency for
interactive use, high enough that per-frame overhead is negligible.

Each AAFP frame carries exactly one Opus packet:

```
AAFP Frame {
  frame_type: RPC_RESPONSE (0x04) or DATA (0x01),
  flags: MORE (0x01),           // set on all but the last frame
  stream_id: 0,
  extensions: [AudioMetadata],  // optional, see below
  payload: <Opus packet bytes>  // 40–400 B for voice
}
```

**AudioMetadata extension** (RFC-0006, proposed type `0x0020`):

```cbor
AudioMetadata = {
    1: uint,       // sample rate (Hz), e.g. 48000
    2: uint,       // channels, e.g. 1 (mono) or 2 (stereo)
    3: uint,       // frame duration (microseconds), e.g. 20000
    4: tstr,       // codec, e.g. "opus"
    5: uint,       // sequence number (monotonic, per stream)
    6: uint,       // timestamp (samples since stream start)
    ? 7: uint,     // rtp-style timestamp (optional, for interop)
}
```

The metadata extension is sent on the **first frame** of the stream and
optionally on key boundaries (e.g., every 1000 frames) for late-joiners
in a multicast scenario. Intermediate frames omit it to save overhead.

### 2.3 Server-Side: Voice Agent Streaming Audio

```rust
use aafp_sdk::simple::{Agent, Request, Response};
use aafp_sdk::extensions::Extension;
use tokio_util::sync::CancellationToken;
use futures::stream::StreamExt;

Agent::serve()
    .capability("voice.stream-audio")
    .streaming_handler(|req: Request, cancel: CancellationToken| {
        async move {
            // req carries session config: sample_rate, codec, frame_ms
            let config = parse_audio_config(&req)?;
            let mic = open_microphone(config).await?;

            let stream = async_stream::try_stream! {
                let mut seq = 0u64;
                let mut ts = 0u64;
                let frame_samples = config.sample_rate * config.frame_us / 1_000_000;

                while let Some(opus_packet) = mic.next().await {
                    if cancel.is_cancelled() {
                        yield Err("cancelled".into());
                        return;
                    }

                    let mut resp = Response::data(opus_packet);
                    if seq == 0 {
                        // Attach metadata on first frame
                        let meta = encode_audio_metadata(&config, seq, ts);
                        resp = resp.with_extension(EXT_AUDIO_METADATA, meta);
                    }
                    yield resp;

                    seq += 1;
                    ts += frame_samples;
                }
            };
            Ok(stream)
        }
    })
    .start()
    .await?;
```

### 2.4 Client-Side: Transcription Agent Consuming Audio

```rust
let agent = Agent::connect().connect().await?;
let mut audio_stream = agent
    .discover("voice.stream-audio")
    .call_stream(Request::text("transcribe this call"))
    .await?;

let mut decoder = OpusDecoder::new(48000, 1)?;
let mut asr = AsrEngine::new()?;

while let Some(frame) = audio_stream.next().await {
    let resp = frame?;
    let opus_packet = resp.payload();

    // Decode to PCM
    let pcm = decoder.decode(opus_packet)?;

    // Feed to ASR; get partial transcripts
    if let Some(partial) = asr.push_pcm(&pcm)? {
        // Emit partial transcript (could be another stream to a display agent)
        println!("[partial] {}", partial.text);
    }
}
```

### 2.5 Bidirectional Voice (Intercom)

For two-way voice, use **bidirectional streaming** (P2.8 §5). Both
directions carry Opus packets on the same bi-stream:

```rust
let mut session = agent
    .discover("voice.intercom")
    .call_bidi_stream()
    .await?;

// Spawn task to send microphone audio
let send_task = tokio::spawn(async move {
    let mic = open_microphone(config).await?;
    while let Some(packet) = mic.next().await {
        session.requests.send(Request::data(packet)).await?;
    }
});

// Spawn task to play received audio
let play_task = tokio::spawn(async move {
    let mut speaker = open_speaker(config).await?;
    while let Some(resp) = session.responses.next().await {
        let pcm = decoder.decode(resp?.payload())?;
        speaker.play(&pcm).await?;
    }
});
```

**Latency note:** bidirectional voice is the most latency-sensitive
pattern. Use the `low_latency()` QUIC preset (§9.1), 20 ms Opus frames,
and no application-level buffering (§9.3).

### 2.6 Podcast Transcription (Long-Form, Batch)

For long-form audio (podcasts, meetings), the latency budget is relaxed
(minutes, not milliseconds). This allows:

- **Larger frames** — 60 ms Opus frames (fewer frames, less overhead).
- **Higher compression** — Opus music mode at 32–64 kbps.
- **Parallel chunking** — split the audio into N segments, stream each to
  a different transcription agent in parallel, reassemble by sequence
  number. This is the Execution Fabric pattern from Use Case 1.

```rust
// Parallel transcription: split 1-hour podcast into 60 1-minute chunks
let chunks = split_audio(&podcast, Duration::from_secs(60))?;
let mut handles = Vec::new();

for (i, chunk) in chunks.into_iter().enumerate() {
    let agent = agent.clone();
    handles.push(tokio::spawn(async move {
        let resp = agent.discover("audio.transcribe")
            .call(Request::data(chunk))
            .await?;
        Ok::<_, SdkError>((i, resp.body().to_string()))
    }));
}

// Reassemble in order
let mut transcripts = Vec::new();
for h in handles {
    let (i, text) = h.await??;
    transcripts.push((i, text));
}
transcripts.sort_by_key(|(i, _)| *i);
let full = transcripts.iter().map(|(_, t)| t.as_str()).collect::<String>();
```

---

## 3. AAFP for Video Streaming

### 3.1 Use Cases

- **Camera agents** — a camera agent streams frames to an object
  detection agent for real-time analysis.
- **Surveillance** — multiple cameras fan out to multiple detection
  agents (multicast, §10).
- **Visual inspection** — a drone or robot camera streams to a quality
  inspection agent on a factory floor.
- **Screen sharing between agents** — an agent shares its "visual
  workspace" with a collaborator agent.

### 3.2 Video Frame Convention

Video is more complex than audio because of keyframe/delta-frame
structure. A video stream consists of:

- **Keyframes (I-frames)** — self-contained, larger (10–100 KB for
  VP8, larger for AV1). Sent periodically (e.g., every 2 seconds).
- **Delta frames (P/B-frames)** — depend on prior frames, smaller
  (0.5–10 KB). Sent between keyframes.

Each AAFP frame carries one encoded video frame:

```
AAFP Frame {
  frame_type: RPC_RESPONSE (0x04),
  flags: MORE (0x01),
  stream_id: 0,
  extensions: [VideoMetadata],
  payload: <VP8/AV1 frame bytes>
}
```

**VideoMetadata extension** (RFC-0006, proposed type `0x0021`):

```cbor
VideoMetadata = {
    1: uint,       // width (pixels)
    2: uint,       // height (pixels)
    3: tstr,       // codec, e.g. "vp8" or "av1"
    4: uint,       // frame type: 0=key, 1=delta, 2=disposable
    5: uint,       // sequence number (monotonic)
    6: uint,       // presentation timestamp (microseconds)
    7: uint,       // frame duration (microseconds), e.g. 33333 for 30fps
    ? 8: uint,     // target bitrate (bps)
    ? 9: bool,     // end-of-stream flag (alternative to clearing MORE)
}
```

The `frame type` field (key/delta/disposable) lets consumers and
recording agents handle frames intelligently — e.g., a late-joining
multicast consumer waits for the next keyframe before decoding.

### 3.3 Server-Side: Camera Agent Streaming Frames

```rust
Agent::serve()
    .capability("camera.stream-frames")
    .streaming_handler(|req: Request, cancel: CancellationToken| {
        async move {
            let config = parse_video_config(&req)?; // width, height, fps, codec
            let camera = open_camera(config).await?;
            let encoder = VideoEncoder::new(&config)?;

            let stream = async_stream::try_stream! {
                let mut seq = 0u64;
                let mut pts = 0u64;
                let frame_us = 1_000_000 / config.fps;

                while let Some(raw_frame) = camera.next().await {
                    if cancel.is_cancelled() {
                        yield Err("cancelled".into());
                        return;
                    }

                    let (encoded, frame_type) = encoder.encode(&raw_frame)?;
                    let mut resp = Response::data(encoded);

                    let meta = encode_video_metadata(
                        &config, seq, pts, frame_type);
                    resp = resp.with_extension(EXT_VIDEO_METADATA, meta);

                    yield resp;

                    seq += 1;
                    pts += frame_us;
                }
            };
            Ok(stream)
        }
    })
    .start()
    .await?;
```

### 3.4 Keyframe Scheduling

Keyframe cadence is a tradeoff between:

- **Recovery** — frequent keyframes let late-joiners and loss-affected
  consumers recover quickly.
- **Bandwidth** — keyframes are 10–50x larger than delta frames; too
  frequent wastes bandwidth.

**Recommendation:** 2-second keyframe interval for surveillance (30 fps
→ every 60 frames), 1-second for interactive (30 fps → every 30 frames).
The camera agent can also send a keyframe **on demand** via a
bidirectional control channel:

```rust
// Consumer requests a keyframe (e.g., after packet loss)
session.requests.send(Request::text("keyframe")).await?;
```

The camera agent's bidi handler checks for control messages and forces
the next encoded frame to be a keyframe.

### 3.5 Resolution and Quality Adaptation

When the consumer is slow (backpressure, §6) or the network degrades,
the camera agent should **adapt** rather than drop frames blindly:

1. **Reduce resolution** — 1080p → 720p → 480p. Halves bandwidth each
   step.
2. **Reduce framerate** — 30 fps → 15 fps. Halves frame count.
3. **Increase compression** — higher QP (quantization parameter), lower
   bitrate.
4. **Drop disposable frames** — VP8/AV1 mark some frames as disposable;
   dropping them has minimal quality impact.

The adaptation logic lives in the camera agent's handler, informed by
`StreamContext` (§7.2) which exposes the QUIC send window and
write-blocked state.

---

## 4. AAFP for Real-Time Sensor Data

### 4.1 Use Cases

- **IoT telemetry** — temperature, pressure, humidity sensors streaming
  to a monitoring agent.
- **Financial market data** — tick-by-tick price quotes streaming to
  trading agents (Use Case 5 in `USE_CASES_KILLER_APPS.md`).
- **Industrial sensors** — vibration, current, acoustic emission
  sensors streaming to predictive maintenance agents.
- **GPS/IMU** — location and orientation streams from mobile agents.

### 4.2 Sensor Data Convention

Sensor data is typically small, structured, and high-rate. Use **CBOR**
for encoding (see §12.3) to keep frames compact and self-describing:

```
AAFP Frame {
  frame_type: RPC_RESPONSE (0x04),
  flags: MORE (0x01),
  stream_id: 0,
  extensions: [SensorMetadata],  // first frame only
  payload: <CBOR-encoded reading>
}
```

**SensorMetadata extension** (RFC-0006, proposed type `0x0022`):

```cbor
SensorMetadata = {
    1: tstr,       // sensor type, e.g. "temperature", "price.tick"
    2: tstr,       // unit, e.g. "celsius", "usd"
    3: uint,       // sample rate (Hz)
    4: tstr,       // encoding, e.g. "cbor", "protobuf", "raw"
    ? 5: tstr,     // device ID
    ? 6: tstr,     // location/label
}
```

Each payload is a CBOR-encoded reading:

```cbor
SensorReading = {
    1: uint,       // sequence number
    2: uint,       // timestamp (epoch microseconds)
    3: float,      // value
    ? 4: float,    // confidence/quality (0.0–1.0)
}
```

### 4.3 High-Rate Sensor Streaming

For very high-rate sensors (10K+ samples/sec), per-frame overhead
becomes significant. Two mitigation strategies:

**Strategy 1: Batching** — accumulate N readings into one AAFP frame:

```rust
let batch: Vec<SensorReading> = sensor.collect_n(100).await;
let payload = encode_cbor_batch(&batch); // CBOR array of readings
yield Response::data(payload);
```

At 10K samples/sec and batch size 100, this is 100 frames/sec —
comfortable for QUIC. Latency cost: 10 ms (batch accumulation). This is
the right tradeoff for non-interactive telemetry.

**Strategy 2: QUIC datagrams** — for sub-millisecond latency
requirements, use QUIC datagrams (unreliable, unordered) instead of
streams. AAFP's `aafp-messaging` includes a `datagram.rs` module
(architecture deliverable §line 811) for this. Datagrams skip flow
control and retransmission, giving the lowest possible latency at the
cost of potential loss. Suitable for sensor data where a dropped sample
is acceptable (e.g., high-frequency vibration monitoring where
statistical aggregates matter, not individual samples).

```rust
// Unreliable datagram for ultra-low-latency sensor data
agent.send_datagram("sensor.vibration", &cbor_reading).await?;
```

### 4.4 Financial Market Data Feed

Market data is a canonical high-rate, low-latency, fan-out use case.
One exchange feed (producer) → many trading agents (consumers). This is
the **multicast via PubSub** pattern (§10):

```rust
// Price discovery agent subscribes to market data topic
let mut price_feed = agent.subscribe("market.AAPL.price").await?;

while let Some(event) = price_feed.next().await {
    let tick: PriceTick = decode_cbor(event?.payload())?;
    strategy_agent.on_price(tick).await;
}
```

The exchange feed agent publishes each tick to the topic; RFC-0009
floodsub forwards to all subscribers. For WAN distribution, gossipsub
(v2, planned) reduces redundant forwarding.

**Latency target:** market data feeds target <1 ms tick-to-trade. This
requires: QUIC datagrams (no retransmission), `low_latency()` preset,
CPU affinity pinning (§9.5), and co-located agents (same datacenter).

---

## 5. Token Streaming for LLMs (Best Practices)

### 5.1 P2.8 Already Supports This

Server-streaming RPC (P2.8 §3) is the canonical pattern for LLM token
streaming. The LLM agent registers a `streaming_handler` for
`text-generation`; the client calls `call_stream()` and receives tokens
as they're generated. This is documented in detail in
`STREAMING_RPC_DESIGN.md` §3 and `LLM_AGENT_INTEGRATION.md`.

### 5.2 Best Practice: Token Frame Format

Each token is one AAFP frame:

```
AAFP Frame {
  frame_type: RPC_RESPONSE (0x04),
  flags: MORE (0x01),           // all but last
  stream_id: 0,
  extensions: [],
  payload: <CBOR-encoded TokenChunk>
}
```

**TokenChunk** (CBOR):

```cbor
TokenChunk = {
    1: tstr,           // token text (UTF-8)
    ? 2: uint,         // token index (monotonic, 0-based)
    ? 3: tstr,         // finish reason (only on last frame): "stop", "length", "tool"
    ? 4: [*ToolCall],  // tool calls (if model emits them)
    ? 5: Usage,        // token usage (only on last frame)
}

Usage = {
    1: uint,           // prompt tokens
    2: uint,           // completion tokens
    3: uint,           // total tokens
}
```

**Why CBOR instead of raw text?** Because the stream may carry
structured data (tool calls, usage) on the final frame, and CBOR keeps
the schema consistent across all frames. For pure-text streaming where
no metadata is needed, raw UTF-8 payload is acceptable and saves ~10
bytes/frame.

### 5.3 Best Practice: Cancellation

LLM generation is expensive. If the user navigates away or the display
agent is done, **cancel immediately** to stop billing GPU time:

```rust
let (mut stream, cancel) = agent
    .discover("text-generation")
    .call_stream_with_cancel(Request::text(prompt))
    .await?;

// Display tokens as they arrive
let display_task = tokio::spawn(async move {
    while let Some(token) = stream.next().await {
        render(token?.body());
        if user_navigated_away() {
            cancel.cancel();  // stops server-side generation
            break;
        }
    }
});
```

The server-side handler checks `cancel.is_cancelled()` between tokens
(P2.8 §3.5) and aborts the inference. The QUIC stream reset notifies the
transport layer; the application layer stops work.

### 5.4 Best Practice: Back-Channel Progress

For long generations (chain-of-thought, multi-step reasoning), use the
**back-channel** pattern (`PUBSUB_BACKCHANNEL_DESIGN.md` §5) to emit
progress without interleaving it with token frames:

```rust
let (resp_fut, mut progress) = agent
    .discover("text-generation")
    .call_with_backchannel(Request::text("analyze this 100-page doc"))
    .await?;

tokio::spawn(async move {
    while let Some(ev) = progress.next().await {
        eprintln!("progress: {}", ev?.body());
    }
});

let result = resp_fut.await?; // final assembled response
```

### 5.5 Best Practice: Fallback Chains

If the primary LLM agent fails or is slow, fall back to a secondary
agent. The streaming API should support **mid-stream fallback** — if the
primary stream errors after N tokens, continue from token N on the
secondary:

```rust
match primary.call_stream(req.clone()).await {
    Ok(stream) => consume_with_fallback(stream, secondary, req).await,
    Err(_) => secondary.call_stream(req).await?.consume().await,
}
```

This is detailed in `LLM_AGENT_INTEGRATION.md` §fallback chains.

---

## 6. Backpressure Handling

### 6.1 The Problem

Backpressure occurs when the **producer generates data faster than the
consumer can process it**. Without handling, this leads to:

- **Unbounded memory growth** — buffers fill up on the producer side.
- **Latency inflation** — buffered data becomes stale by the time it's
  consumed.
- **Resource exhaustion** — a slow consumer can OOM the producer (a
  backpressure attack, see §16).

### 6.2 Two Layers of Backpressure

AAFP has two backpressure layers that compose:

1. **QUIC stream-level flow control** (transport) — when the receiver's
   QUIC receive buffer is full, the sender's `write_all()` blocks
   automatically. This is built into QUIC and requires no application
   code. It prevents the *transport* from being overwhelmed.

2. **AAFP-level backpressure** (application) — when the *application*
   consumer is slow (e.g., the ASR engine takes 50 ms to process a 20 ms
   audio frame), QUIC flow control alone is insufficient because the
   application may buffer received frames in a channel before processing
   them. AAFP-level backpressure uses bounded channels and drop policies
   (§8) to prevent *application* buffer growth.

The relationship:

```
Producer (camera) → [app buffer] → QUIC send → network → QUIC recv → [app buffer] → Consumer (detector)
     ^                                                                              ^
     |____ AAFP-level backpressure (bounded channel, drop policy) ____|             |
     |____ QUIC flow control (automatic, send blocks when recv buffer full) _______|
```

### 6.3 When the Consumer Is Slower Than the Producer

For **real-time media** (audio, video), a slow consumer means the data
is getting stale. The right response is usually to **drop**, not buffer:

- **Audio** — drop the oldest frame, play the newest. A brief glitch is
  better than growing latency.
- **Video** — drop disposable delta frames; if still behind, drop to
  the latest keyframe and resume.
- **Sensor data** — depends: for monitoring, drop oldest; for
  accounting, buffer (correctness > latency).

For **LLM tokens**, a slow consumer (display agent) is less critical —
tokens are not time-sensitive. Buffering is fine; the user just sees
text appear slightly late. Use a bounded channel with a generous bound
(e.g., 1000 tokens).

### 6.4 Signaling Backpressure to the Producer

The producer should observe backpressure and adapt. Three mechanisms:

1. **`StreamContext::is_write_blocked`** (P2.8 §7.2) — true when QUIC
   flow control is blocking sends. The producer can reduce quality
   (§3.5) or yield to let the consumer catch up.

2. **`StreamContext::send_window`** — bytes available before blocking.
   A shrinking window signals congestion.

3. **Explicit feedback via bidi control channel** — the consumer sends
   "slow down" / "speed up" / "keyframe now" messages on the reverse
   direction of a bidirectional stream.

```rust
// Producer adapts to backpressure
async fn camera_handler(req: Request, cancel: CancellationToken, ctx: StreamContext) {
    let mut quality = Quality::High;
    loop {
        if cancel.is_cancelled() { break; }

        if ctx.is_write_blocked() {
            quality = quality.reduce(); // 1080p → 720p → 480p
        } else if ctx.send_window > 500_000 {
            quality = quality.increase(); // recover when consumer catches up
        }

        let frame = camera.capture_encoded(quality).await?;
        ctx.wait_for_window(frame.len() as u64).await;
        yield Response::data(frame);
    }
}
```

---

## 7. Flow Control: QUIC vs AAFP

### 7.1 QUIC Stream-Level Flow Control

QUIC provides per-stream and per-connection flow control. The sender
cannot send more bytes than the receiver has credited (the "flow control
window"). When the receiver's buffer fills, it stops extending credit,
and the sender's `write_all()` blocks.

**Configuration** (`QuicConfig`, from `PERFORMANCE_SCALABILITY.md` §3.1):

| Parameter | Small RPC | Bulk Transfer | 1M Streams | Media (proposed) |
|-----------|-----------|---------------|------------|------------------|
| `stream_initial_max_data` | 1 MB | 10 MB | 256 KB | 2–4 MB |
| Connection-level window | 10 MB | 100 MB | 4 MB | 16 MB |
| `max_concurrent_bidi_streams` | 100 | 100 | 10,000 | 100 |

**Media preset rationale:** Video at 5 MB/s saturates a 1 MB window in
200 ms. A 4 MB window gives ~800 ms of headroom — enough for the
consumer to process a burst without the producer blocking. Too large a
window risks memory pressure under backpressure (§6). The proposed
`media()` preset balances throughput and memory.

### 7.2 AAFP-Level Backpressure (Application)

QUIC flow control only protects the *transport* buffers. The
*application* may still buffer unboundedly:

```
QUIC recv buffer (bounded by flow control)
    ↓
Application channel (mpsc::channel) ← THIS can grow unboundedly
    ↓
Consumer task (ASR, detector, etc.)
```

AAFP-level backpressure uses **bounded `mpsc` channels** between the
frame reader and the consumer task:

```rust
// Bounded channel: capacity 50 frames (~1 second of audio at 20ms)
let (tx, rx) = mpsc::channel::<Frame>(50);

// Frame reader task: reads from QUIC, pushes to channel
tokio::spawn(async move {
    while let Some(frame) = read_frame(&mut recv).await? {
        // send() blocks when channel is full → backpressure propagates
        // to QUIC (recv buffer fills → sender blocks)
        tx.send(frame).await.map_err(|_| "consumer gone")?;
    }
});

// Consumer task: processes frames at its own pace
tokio::spawn(async move {
    while let Some(frame) = rx.recv().await {
        process_frame(frame).await?; // may be slow
    }
});
```

When the channel is full, `tx.send()` blocks, which means the frame
reader stops reading from QUIC, which means the QUIC receive buffer
fills, which means the sender's flow control window closes, which means
the producer's `write_all()` blocks. **Backpressure propagates
end-to-end automatically** — this is the key property of bounded
channels combined with QUIC flow control.

### 7.3 When to Use Each

| Scenario | Mechanism | Why |
|----------|-----------|-----|
| LLM tokens → display | Bounded channel (1000) | Tokens aren't time-sensitive; buffer is fine |
| Audio → ASR | Bounded channel (50) + drop oldest | Real-time; drop stale frames |
| Video → detector | Bounded channel (10) + drop disposable | Real-time; drop delta frames |
| Sensor → monitor | Bounded channel (100) + drop oldest | Near-real-time; tolerate gaps |
| Market data → trader | Datagram (no flow control) | Ultra-low-latency; loss acceptable |
| File upload | QUIC flow control only | Correctness > latency; no drops |

---

## 8. Buffer Management

### 8.1 Buffer Locations

There are four buffer points in an AAFP media stream:

1. **Producer application buffer** — frames generated but not yet sent.
2. **QUIC send buffer** — frames written to the stream but not yet
   acknowledged.
3. **QUIC receive buffer** — frames received but not yet read by the
   application.
4. **Consumer application buffer** — frames read but not yet processed.

Buffers 2 and 3 are managed by QUIC (bounded by flow control windows).
Buffers 1 and 4 are managed by the application. The goal is to keep all
four bounded and small for latency-sensitive streams.

### 8.2 Ring Buffers

For high-throughput, low-latency streams, a **ring buffer** (lock-free,
fixed-size) is more efficient than a `mpsc` channel:

```rust
use crossbeam_queue::ArrayQueue;

// Fixed-size ring buffer: 256 frames
let queue = Arc::new(ArrayQueue::<Frame>::new(256));

// Producer: non-blocking push, drops oldest if full
fn push_frame(queue: &ArrayQueue<Frame>, frame: Frame) {
    while queue.push(frame.clone()).is_err() {
        // Ring is full: drop oldest to make room
        let _ = queue.pop();
    }
}

// Consumer: blocking pop with timeout
async fn pop_frame(queue: &ArrayQueue<Frame>) -> Option<Frame> {
    loop {
        if let Some(f) = queue.pop() {
            return Some(f);
        }
        tokio::time::sleep(Duration::from_micros(100)).await;
    }
}
```

Ring buffers are ideal for video (drop oldest = always process the
latest frame) and sensor data (drop oldest = latest reading is most
relevant). They avoid the allocation overhead of channel-based queues.

### 8.3 Bounded Channels

For ordered, no-drop streams (LLM tokens, file upload), use Tokio's
bounded `mpsc` channel. The bound should be large enough to absorb
bursts but small enough to trigger backpressure before memory pressure:

```rust
// LLM tokens: 1000-frame bound (~a few seconds of generation)
let (tx, rx) = mpsc::channel(1000);

// File upload: 64-frame bound (chunks of 64 KB = 4 MB in flight)
let (tx, rx) = mpsc::channel(64);
```

### 8.4 Drop Policies

When a buffer is full, the drop policy determines which frame is
evicted. The right policy depends on the media type:

| Media type | Drop policy | Rationale |
|------------|-------------|-----------|
| Audio (voice) | Drop oldest | Latest audio is most relevant; stale audio causes echo |
| Audio (music) | Don't drop (block) | Gaps are audible; prefer latency over loss |
| Video | Drop oldest delta, keep keyframes | Keyframes are needed for decoding; deltas are disposable |
| Sensor (monitoring) | Drop oldest | Latest reading is most relevant |
| Sensor (accounting) | Don't drop (block) | Every sample matters; prefer latency over loss |
| LLM tokens | Don't drop (block) | Every token matters; text must be complete |
| Market data | Drop oldest (or use datagram) | Latest tick is most relevant |

**Implementing "drop oldest delta, keep keyframes" for video:**

```rust
fn push_video_frame(queue: &ArrayQueue<Frame>, frame: &Frame, meta: &VideoMetadata) {
    match meta.frame_type {
        FrameType::Key => {
            // Keyframe: evict everything, push keyframe
            while queue.pop().is_some() {} // clear
            let _ = queue.push(frame.clone());
        }
        FrameType::Delta => {
            // Delta: push if room, drop oldest if full
            while queue.push(frame.clone()).is_err() {
                let _ = queue.pop();
            }
        }
        FrameType::Disposable => {
            // Disposable: push if room, drop silently if full
            let _ = queue.push(frame.clone());
        }
    }
}
```

---

## 9. Latency Optimization

### 9.1 Low-Latency QUIC Preset

AAFP ships a `low_latency()` preset (`PERFORMANCE_SCALABILITY.md` §1.5):

| Parameter | Default | `low_latency()` | Media recommendation |
|-----------|---------|-----------------|---------------------|
| Congestion | Cubic | BBR | BBR |
| Initial RTT | 10 ms | 10 ms | 10 ms |
| Max ACK delay | 5 ms | 5 ms | 1 ms (media) |
| Stream window | 1 MB | 1 MB | 2–4 MB (media) |
| Crypto buffer | 8 KB | 8 KB | 8 KB |
| Max idle timeout | 30 s | 30 s | 60 s (media sessions) |

For media, the key tuning is **BBR congestion control** (avoids window
reduction on packet loss, critical for real-time) and a **larger stream
window** (prevents the producer from blocking during bursts). A proposed
`media()` preset combines these.

### 9.2 No Buffering (Immediate Flush)

The default behavior for QUIC writes may coalesce small writes into
larger packets (Nagle's algorithm equivalent). For low-latency media,
**disable write coalescing** and flush each frame immediately:

```rust
// After writing a frame to the send stream:
send.write_all(&frame_bytes).await?;
send.flush().await?; // force immediate transmission
```

Quinn's `QuicSendStream` does not coalesce by default (QUIC packets are
sent immediately when stream data is written), but if the application
writes frame header and payload in separate `write_all` calls, they may
end up in separate QUIC packets. **Always write the complete frame in a
single `write_all` call** to avoid this:

```rust
// GOOD: single write, single QUIC packet
let mut buf = Vec::with_capacity(frame_bytes.len());
encode_frame_into(&mut buf, &frame)?;
send.write_all(&buf).await?;

// BAD: two writes, may produce two QUIC packets
send.write_all(&header).await?;
send.write_all(&payload).await?;
```

### 9.3 No Application Buffering

For the lowest latency, the consumer should process frames **as they
arrive** with no intermediate channel:

```rust
// Direct processing: no channel, no buffer
while let Some(frame) = read_frame(&mut recv).await? {
    // Process immediately
    decoder.decode_and_play(frame.payload()).await?;
}
```

This is viable when processing is faster than the frame rate. If
processing occasionally exceeds the frame rate, a small bounded channel
(capacity 2–3) provides elasticity without adding significant latency.

### 9.4 Connection Reuse

Opening a new QUIC connection per media session adds 150–300 ms of
handshake latency on WAN. **Reuse connections** from the connection pool
(P2.8 §14.2):

```rust
// Pool reuses existing connection; stream open is ~14 µs
let conn = pool.get_or_dial(&peer_id).await?;
let (send, recv) = conn.open_bi().await?;
```

For recurring media sessions (e.g., a voice agent that handles many
calls), keep a warm pool to the transcription agent.

### 9.5 CPU Affinity Pinning

For ultra-low-latency workloads (market data, real-time audio),
`PERFORMANCE_SCALABILITY.md` §1.6 documents CPU affinity pinning to
reduce p99 variance from core migration:

```rust
// Pin the media task to a specific core
aafp_sdk::cpu_affinity::pin_to_core(2)?;
```

On Linux this uses `sched_setaffinity()`; on macOS it is advisory. This
reduces p99 tail latency by preventing the OS scheduler from migrating
the task between cores during bursts.

### 9.6 Latency Budget Breakdown

For a 20 ms Opus frame over WAN (50 ms RTT):

| Component | Latency | Notes |
|-----------|---------|-------|
| Capture + encode | 2 ms | Opus encode at 48 kHz |
| AAFP frame encode | < 0.1 ms | 66 ns for 1 KB (§1.2 of perf doc) |
| QUIC send (1 RTT for first frame) | 50 ms | WAN RTT |
| QUIC send (subsequent, pipelined) | 0 ms | No RTT, just propagation |
| Network propagation | 25 ms | One-way |
| QUIC recv | < 0.1 ms | |
| AAFP frame decode | < 0.1 ms | 35 ns for 1 KB |
| Decode + play | 2 ms | Opus decode |
| **Total one-way (steady state)** | **~29 ms** | Well within 150 ms budget |

The first frame incurs an extra RTT (50 ms) for the RPC request, but
subsequent frames are pipelined on the same stream with no per-frame
RTT.

---

## 10. Multicast via PubSub

### 10.1 One Producer, Many Consumers

Many media scenarios involve **fan-out**: one producer, many consumers.

- **Live transcription feed** — one voice agent's audio → multiple
  display agents (different languages, different devices).
- **Surveillance fan-out** — one camera → multiple detection agents
  (object detection, anomaly detection, recording).
- **Market data distribution** — one exchange feed → many trading
  agents.
- **Live event broadcast** — one agent's output → many viewer agents.

RFC-0009 PubSub (`PUBSUB_BACKCHANNEL_DESIGN.md`) provides this. The
producer publishes frames to a topic; all subscribers receive them.

### 10.2 Topic Naming for Media Streams

Following the hierarchical topic convention (`PUBSUB_BACKCHANNEL_DESIGN.md`
§6.1):

```
media.audio.<session_id>           # audio stream for a session
media.video.<camera_id>            # video stream from a camera
media.transcript.<session_id>      # live transcription feed
market.<symbol>.price              # market data for a symbol
sensor.<device_id>.<sensor_type>   # sensor data stream
```

### 10.3 Producer: Publishing Media to a Topic

```rust
// Camera agent publishes frames to a topic
let topic = format!("media.video.{}", camera_id);

while let Some(frame) = camera.next().await {
    let encoded = encoder.encode(&frame)?;
    agent.publish(&topic, Event::data(encoded)).await?;
}
```

### 10.4 Consumer: Subscribing to a Media Topic

```rust
// Detection agent subscribes to camera feed
let mut frames = agent.subscribe("media.video.cam-001").await?;

while let Some(event) = frames.next().await {
    let frame = decode_video_frame(event?.payload())?;
    let detections = detector.detect(&frame).await?;
    for d in detections {
        println!("detected: {} at ({}, {})", d.label, d.x, d.y);
    }
}
```

### 10.5 Late-Joiner Handling

A consumer that subscribes mid-stream has missed prior frames. For
video, it cannot decode until it receives a keyframe. Two approaches:

1. **Wait for next keyframe** — the consumer buffers frames until a
   keyframe arrives, then starts decoding. Latency cost: up to one
   keyframe interval (1–2 seconds).

2. **Request a keyframe** — the consumer publishes a control message to
   a companion topic (`media.video.cam-001.control`), and the producer
   forces a keyframe on the next encode:

```rust
// Late-joining consumer requests keyframe
agent.publish("media.video.cam-001.control", Event::text("keyframe")).await?;

// Producer listens for control messages
let mut control = agent.subscribe("media.video.cam-001.control").await?;
if let Some(msg) = control.next().await {
    if msg?.body() == "keyframe" {
        encoder.force_keyframe();
    }
}
```

### 10.6 PubSub vs Direct Streaming

| Property | Direct streaming (P2.8) | PubSub (RFC-0009) |
|----------|------------------------|---------------------|
| Consumers | 1 (point-to-point) | N (fan-out) |
| Latency | Lower (no floodsub hop) | Higher (forwarding overhead) |
| Reliability | Stream-level (ordered, no loss) | Best-effort (floodsub) |
| Backpressure | End-to-end (QUIC flow control) | Per-hop (may drop at relay) |
| Setup | One bi-stream per consumer | One subscription per consumer |

**Recommendation:** Use direct streaming for 1:1 media (voice agent →
transcription). Use PubSub for 1:N fan-out (camera → multiple detectors,
live transcription → multiple displays). For 1:N with strict ordering
and no-loss, a future gossipsub + ack extension will provide stronger
guarantees.

---

## 11. Recording and Replay

### 11.1 Why Record Streams

- **Debugging** — replay a media stream to reproduce a detection miss.
- **Audit** — record surveillance feeds for compliance.
- **Training data** — capture audio/video streams to build training
  datasets.
- **Quality assurance** — compare agent decisions against the raw media
  they processed.

### 11.2 Recording Architecture

A **recording agent** subscribes to a media topic (or receives a direct
stream) and writes frames to durable storage. The recording is a
sequence of AAFP frames with timestamps:

```cbor
RecordingHeader = {
    1: tstr,           // recording ID
    2: tstr,           // media type: "audio", "video", "sensor", "tokens"
    3: tstr,           // codec
    4: uint,           // start timestamp (epoch microseconds)
    5: SensorMetadata / AudioMetadata / VideoMetadata,  // stream config
}

RecordingFrame = {
    1: uint,           // offset from start (microseconds)
    2: bstr,           // frame payload (encoded media)
    3: VideoMetadata / AudioMetadata,  // per-frame metadata (optional)
}
```

The recording is stored as a CBOR sequence: header followed by frames.
This format is self-describing and can be replayed by any AAFP agent.

### 11.3 Recording Agent

```rust
Agent::serve()
    .capability("media.record")
    .on_publish("media.video.#", |topic, event| async move {
        let frame = RecordingFrame {
            offset: elapsed_since_start(),
            payload: event.payload().to_vec(),
            metadata: extract_metadata(event),
        };
        recording_file.append_cbor(&frame)?;
    })
    .start()
    .await?;
```

The recording agent is a passive subscriber — it does not interfere with
the live stream. Multiple recording agents can subscribe (e.g., one
local, one remote for redundancy).

### 11.4 Replay Agent

Replay reads a recording file and re-publishes it as a live stream,
preserving original timing:

```rust
Agent::serve()
    .capability("media.replay")
    .streaming_handler(|req: Request, cancel: CancellationToken| {
        async move {
            let recording_id = req.body();
            let recording = Recording::open(&recording_id)?;
            let header = recording.header();

            let stream = async_stream::try_stream! {
                let mut start = None;
                for frame in recording.frames() {
                    if cancel.is_cancelled() { return; }

                    // Preserve original timing
                    let target = frame.offset;
                    if start.is_none() { start = Some(Instant::now()); }
                    let elapsed = start.unwrap().elapsed().as_micros() as u64;
                    if elapsed < target {
                        tokio::time::sleep(Duration::from_micros(target - elapsed)).await;
                    }

                    yield Response::data(frame.payload);
                }
            };
            Ok(stream)
        }
    })
    .start()
    .await?;
```

Replay can be used to:

- **Reprocess** — feed a recorded stream to a different (or updated)
  detection agent and compare results.
- **Test** — replay recorded streams through a new agent version to
  verify it handles edge cases.
- **Demonstrate** — replay a stream for a human reviewer.

### 11.5 Selective Recording

Not all frames need recording. For video, recording only keyframes
reduces storage by 10–50x at the cost of losing inter-keyframe detail:

```rust
if frame_metadata.frame_type == FrameType::Key {
    recording.append(frame)?;
}
```

For audio, recording every Nth frame (e.g., every 5th) gives a
time-lapsed audio recording at 1/5 the storage.

---

## 12. Codec Considerations

### 12.1 Audio: Opus

**Opus** is the recommended audio codec for AAFP streaming:

- **Low latency** — supports 2.5 ms frame durations; 20 ms is standard
  for voice.
- **Wide bitrate range** — 6 kbps (narrowband speech) to 510 kbps
  (fullband music).
- **Built-in PLC** — packet-loss concealment handles lost frames
  gracefully.
- **Royalty-free** — open standard, no licensing fees.
- **Wide support** — libopus available in Rust (`opus` crate), Python,
  C, browser WebRTC.

**Configuration for voice agents:**

```rust
let encoder = OpusEncoder::new(48000, 1, Application::VoIP)?;
encoder.set_bitrate(24000)?; // 24 kbps, sufficient for voice
encoder.set_complexity(5)?;   // 1–10, lower = faster encode
```

**Configuration for music/podcast:**

```rust
let encoder = OpusEncoder::new(48000, 2, Application::Audio)?;
encoder.set_bitrate(64000)?; // 64 kbps stereo
encoder.set_complexity(8)?;   // higher quality
```

**Alternative codecs:**
- **AAC-LC** — higher quality at low bitrates, but patent-encumbered.
  Avoid for open ecosystems.
- **PCM (raw)** — zero encoding latency, but 16× larger than Opus.
  Suitable for localhost/LAN where bandwidth is not a constraint and
  latency is critical.
- **µ-law/a-law** — telephony-grade, 8 kHz. Legacy interop only.

### 12.2 Video: VP8 / AV1

**VP8** is the recommended baseline video codec:

- **Royalty-free** — open, no licensing fees.
- **Real-time encoding** — fast enough for 30 fps at 720p on commodity
  hardware.
- **WebRTC-compatible** — widely supported in browsers.
- **Keyframe/delta structure** — maps cleanly to AAFP frame metadata.

**AV1** is the next-generation recommendation for higher efficiency:

- **Better compression** — 20–30% better than VP8 at the same quality.
- **Higher complexity** — encoding is 5–10× slower than VP8. Hardware
  encoders (AV1-CE) are emerging but not yet ubiquitous.
- **Use when:** bandwidth is constrained (WAN, mobile) and encoding
  latency is acceptable (non-interactive surveillance, batch).

**Configuration for real-time camera:**

```rust
// VP8 for real-time (low encode latency)
let encoder = VpxEncoder::new(Codec::Vp8, 1280, 720, 30)?;
encoder.set_bitrate(1_500_000)?; // 1.5 Mbps for 720p30
encoder.set_keyframe_interval(60)?; // every 2 seconds at 30fps
encoder.set_cpu_used(-6)?; // -6 = fastest (real-time)
```

**Configuration for high-quality surveillance:**

```rust
// AV1 for bandwidth-constrained surveillance
let encoder = AomEncoder::new(1920, 1080, 30)?;
encoder.set_bitrate(2_500_000)?; // 2.5 Mbps for 1080p30 (AV1 is more efficient)
encoder.set_keyframe_interval(120)?; // every 4 seconds
encoder.set_cpu_used(6)?; // 0–10, higher = faster
```

**Alternative codecs:**
- **H.264 (AVC)** — ubiquitous, hardware-accelerated, but
  patent-encumbered. Use only when interop with legacy systems is
  required.
- **H.265 (HEVC)** — better compression than H.264, but heavy licensing.
  Avoid.
- **VP9** — predecessor to AV1, good compression, slower than VP8.
  Reasonable middle ground.

### 12.3 Data: CBOR

**CBOR** (Concise Binary Object Representation, RFC 8949) is the
recommended encoding for structured sensor data and metadata:

- **Compact** — binary, smaller than JSON.
- **Self-describing** — types are embedded; no external schema needed.
- **AAFP-native** — AAFP already uses CBOR for RPC payloads, extensions,
  and PubSub messages.
- **Schema evolution** — optional fields (marked with `?` in CDDL) allow
  forward/backward compatibility.

**When to use raw bytes instead:** For ultra-high-rate sensor data where
even CBOR overhead (a few bytes per field) matters, use raw fixed-width
binary encoding:

```rust
// Raw binary: 16 bytes per reading (seq + timestamp + value + flags)
let mut buf = [0u8; 16];
buf[0..8].copy_from_slice(&seq.to_le_bytes());
buf[8..12].copy_from_slice(&ts.to_le_bytes());
buf[12..16].copy_from_slice(&value.to_le_bytes());
yield Response::data(&buf);
```

This is 16 bytes vs ~40 bytes for CBOR. At 100K samples/sec, this saves
2.4 MB/s. The tradeoff is that the schema is implicit (defined by the
`SensorMetadata` extension on the first frame).

### 12.4 Codec Negotiation

Codec selection should be **negotiated** during capability discovery.
The `CapabilityDescriptor` metadata (RFC-0006 / `AGENT_RECORD_EXTENSIONS.md`
§5.4) includes supported codecs:

```cbor
CapabilityDescriptor = {
    1: "audio.transcribe",
    2: {
        "codecs": ["opus", "pcm", "aac"],
        "sample-rates": [8000, 16000, 48000],
        "channels": [1, 2],
    },
}
```

The client selects a codec from the intersection of its capabilities and
the server's advertised codecs. If no overlap, the client transcodes
(e.g., PCM → Opus) or finds another agent.

---

## 13. Concrete Example: Voice Agent → Transcription

### 13.1 Scenario

A user speaks to a voice agent. The voice agent captures microphone
audio, encodes it as Opus, and streams it to a transcription agent. The
transcription agent decodes the audio, runs ASR, and streams partial
transcripts back to a display agent.

### 13.2 Topology

```
  Microphone → Voice Agent → (Opus stream) → Transcription Agent
                                                      │
                                                      ▼ (partial transcripts)
                                               Display Agent → Screen
```

### 13.3 Voice Agent (Producer)

```rust
use aafp_sdk::simple::{Agent, Request, Response};
use aafp_sdk::extensions::{Extension, EXT_AUDIO_METADATA};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
struct AudioConfig {
    sample_rate: u32,
    channels: u8,
    frame_ms: u32,
}

Agent::serve()
    .capability("voice.capture")
    .streaming_handler(|req: Request, cancel: CancellationToken| {
        async move {
            let config: AudioConfig = parse_config(&req)?;
            let mic = Microphone::open(config.sample_rate, config.channels)?;
            let encoder = OpusEncoder::new(config.sample_rate, config.channels as u32,
                                           opus::Application::VoIP)?;
            encoder.set_bitrate(24000)?;

            let frame_samples = config.sample_rate * config.frame_ms / 1000;
            let frame_us = config.frame_ms * 1000;

            let stream = async_stream::try_stream! {
                let mut seq = 0u64;
                let mut ts = 0u64;

                loop {
                    if cancel.is_cancelled() {
                        yield Err("cancelled".into());
                        return;
                    }

                    // Capture frame_duration of PCM
                    let pcm = mic.read_samples(frame_samples as usize).await?;
                    let opus = encoder.encode(&pcm)?;

                    let mut resp = Response::data(opus);
                    if seq == 0 {
                        let meta = encode_audio_metadata(
                            config.sample_rate, config.channels,
                            frame_us, "opus", seq, ts);
                        resp = resp.with_extension(EXT_AUDIO_METADATA, meta);
                    }
                    yield resp;

                    seq += 1;
                    ts += frame_samples as u64;
                }
            };
            Ok(stream)
        }
    })
    .start()
    .await?;
```

### 13.4 Transcription Agent (Consumer + Producer)

```rust
Agent::serve()
    .capability("audio.transcribe")
    .streaming_handler(|req: Request, cancel: CancellationToken| {
        async move {
            // req.payload() is the streaming audio from voice agent
            // But we need to receive the stream... use client_streaming
            unreachable!("see client_streaming_handler below")
        }
    })
    // Actually: the transcription agent receives a client stream of audio
    // and produces a server stream of transcripts (bidirectional)
    .bidi_streaming_handler(|audio_stream, transcript_tx, cancel| {
        async move {
            let mut decoder = OpusDecoder::new(48000, 1)?;
            let mut asr = AsrEngine::new(48000)?;
            let mut config: Option<AudioConfig> = None;

            tokio::pin!(audio_stream);
            while let Some(Ok(audio_req)) = audio_stream.next().await {
                if cancel.is_cancelled() { break; }

                // Extract metadata from first frame
                if config.is_none() {
                    if let Some(meta) = audio_req.extension(EXT_AUDIO_METADATA) {
                        config = Some(parse_audio_metadata(meta));
                    }
                }

                // Decode Opus → PCM
                let pcm = decoder.decode(audio_req.payload())?;

                // Feed PCM to ASR
                if let Some(partial) = asr.push_pcm(&pcm)? {
                    let transcript = Response::text(partial.text);
                    transcript_tx.send(Ok(transcript)).await
                        .map_err(|_| "display agent gone")?;
                }
            }

            // Flush final transcript
            if let Some(final_text) = asr.finalize()? {
                transcript_tx.send(Ok(Response::text(final_text))).await.ok();
            }
        }
    })
    .start()
    .await?;
```

### 13.5 Display Agent (Final Consumer)

```rust
let voice_agent = Agent::connect().connect().await?;
let transcribe_agent = Agent::connect().connect().await?;

// 1. Open bidi stream to transcription agent
let mut session = transcribe_agent
    .discover("audio.transcribe")
    .call_bidi_stream()
    .await?;

// 2. Open streaming call to voice agent, forward audio to transcription
let audio_stream = voice_agent
    .discover("voice.capture")
    .call_stream(Request::text("start capturing"))
    .await?;

tokio::spawn(async move {
    tokio::pin!(audio_stream);
    while let Some(Ok(audio_frame)) = audio_stream.next().await {
        // Forward audio to transcription agent
        session.requests.send(Request::data(audio_frame.payload().to_vec()))
            .await.ok();
    }
});

// 3. Receive partial transcripts and display
while let Some(transcript) = session.responses.next().await {
    let text = transcript?.body();
    print!("\r[transcript] {}", text);
}
```

### 13.6 Latency Analysis

| Step | Latency | Notes |
|------|---------|-------|
| Mic capture (20 ms frame) | 20 ms | Frame duration |
| Opus encode | 1 ms | |
| AAFP frame + QUIC send | 0.1 ms | |
| Network (LAN) | 0.5 ms | |
| QUIC recv + AAFP decode | 0.1 ms | |
| Opus decode | 1 ms | |
| ASR processing | 10–30 ms | Model-dependent |
| Transcript send + display | 1 ms | |
| **Total (mic → display)** | **34–54 ms** | Well within 150 ms interactive budget |

---

## 14. Concrete Example: Camera Agent → Object Detection

### 14.1 Scenario

A camera agent captures video at 30 fps, encodes each frame as VP8, and
streams to an object detection agent. The detection agent runs YOLO on
each frame and emits bounding boxes.

### 14.2 Topology

```
  Camera → Camera Agent → (VP8 stream) → Object Detection Agent → Bounding boxes
```

### 14.3 Camera Agent (Producer)

```rust
Agent::serve()
    .capability("camera.capture")
    .streaming_handler(|req: Request, cancel: CancellationToken| {
        async move {
            let config: VideoConfig = parse_config(&req)?;
            // config: { width: 1280, height: 720, fps: 30, codec: "vp8" }
            let camera = Camera::open(config.width, config.height, config.fps)?;
            let encoder = VpxEncoder::new(Codec::Vp8, config.width, config.height, config.fps)?;
            encoder.set_bitrate(1_500_000)?;
            encoder.set_keyframe_interval(config.fps * 2)?; // 2-second interval

            let frame_us = 1_000_000 / config.fps;

            let stream = async_stream::try_stream! {
                let mut seq = 0u64;
                let mut pts = 0u64;

                loop {
                    if cancel.is_cancelled() {
                        yield Err("cancelled".into());
                        return;
                    }

                    let raw = camera.capture().await?;
                    let (encoded, frame_type) = encoder.encode(&raw)?;

                    let meta = encode_video_metadata(
                        config.width, config.height, "vp8",
                        frame_type, seq, pts, frame_us);
                    let resp = Response::data(encoded)
                        .with_extension(EXT_VIDEO_METADATA, meta);
                    yield resp;

                    seq += 1;
                    pts += frame_us;
                }
            };
            Ok(stream)
        }
    })
    .start()
    .await?;
```

### 14.4 Object Detection Agent (Consumer)

```rust
Agent::serve()
    .capability("vision.detect-objects")
    .streaming_handler(|req: Request, cancel: CancellationToken| {
        async move {
            // This agent receives a client stream of video frames
            // and produces a server stream of detection results.
            // Use bidirectional streaming.
            unreachable!("see bidi handler")
        }
    })
    .bidi_streaming_handler(|video_stream, detection_tx, cancel| {
        async move {
            let mut decoder = VpxDecoder::new(Codec::Vp8)?;
            let mut detector = YoloDetector::load("yolov8n.pt")?;

            tokio::pin!(video_stream);
            while let Some(Ok(frame_req)) = video_stream.next().await {
                if cancel.is_cancelled() { break; }

                let meta = parse_video_metadata(
                    frame_req.extension(EXT_VIDEO_METADATA))?;

                // Skip delta frames if we haven't seen a keyframe yet
                if meta.frame_type != FrameType::Key && !decoder.has_keyframe() {
                    continue;
                }

                // Decode VP8 → raw RGB
                let rgb = decoder.decode(frame_req.payload(), &meta)?;

                // Run detection
                let detections = detector.detect(&rgb, 0.5)?; // confidence > 0.5

                // Emit detection results as CBOR
                let payload = encode_detections_cbor(&detections, meta.seq, meta.pts);
                detection_tx.send(Ok(Response::data(payload))).await
                    .map_err(|_| "consumer gone")?;
            }
        }
    })
    .start()
    .await?;
```

### 14.5 Backpressure in Video Streaming

If the detection agent is slower than 30 fps (e.g., YOLO takes 50 ms
per frame), the bounded channel fills and backpressure propagates to the
camera agent. The camera agent should **drop frames** rather than
buffer:

```rust
// Camera agent observes backpressure via StreamContext
if ctx.is_write_blocked() {
    // Skip the next capture (drop a frame) to let consumer catch up
    camera.skip_frame().await?;
    continue;
}
```

Alternatively, the camera agent reduces framerate or resolution (§3.5).

### 14.6 Latency Analysis

| Step | Latency | Notes |
|------|---------|-------|
| Camera capture | 33 ms | 1 frame at 30 fps |
| VP8 encode | 5 ms | |
| AAFP + QUIC send | 0.5 ms | |
| Network (LAN) | 0.5 ms | |
| QUIC recv + AAFP decode | 0.1 ms | |
| VP8 decode | 3 ms | |
| YOLO inference | 20–50 ms | Model-dependent |
| Detection result send | 0.5 ms | |
| **Total (capture → detection)** | **63–93 ms** | Acceptable for surveillance |

---

## 15. Concrete Example: LLM Agent → Display Agent

### 15.1 Scenario

An LLM agent generates text token-by-token and streams tokens to a
display agent that renders them for the user. This is the canonical P2.8
use case, included here for completeness and best-practice reference.

### 15.2 LLM Agent (Producer)

```rust
Agent::serve()
    .capability("text-generation")
    .streaming_handler(|req: Request, cancel: CancellationToken| {
        async move {
            let prompt = req.body();
            let model = LlmClient::new("gpt-4-turbo")?;

            let stream = async_stream::try_stream! {
                let mut token_stream = model.stream_generate(prompt).await?;
                let mut index = 0u64;

                while let Some(token) = token_stream.next().await {
                    if cancel.is_cancelled() {
                        yield Err("cancelled".into());
                        return;
                    }

                    let chunk = encode_token_chunk(&token, index, None);
                    yield Response::data(chunk);
                    index += 1;
                }

                // Final frame with usage info
                let final_chunk = encode_token_chunk("", index, Some(FinishReason::Stop));
                yield Response::data(final_chunk);
            };
            Ok(stream)
        }
    })
    .start()
    .await?;
```

### 15.3 Display Agent (Consumer)

```rust
let agent = Agent::connect().connect().await?;
let (mut token_stream, cancel) = agent
    .discover("text-generation")
    .call_stream_with_cancel(Request::text("Write a sonnet about AAFP"))
    .await?;

// Render tokens as they arrive (typewriter effect)
tokio::spawn(async move {
    while let Some(result) = token_stream.next().await {
        let resp = match result {
            Ok(r) => r,
            Err(e) => { eprintln!("stream error: {e}"); break; }
        };

        let chunk: TokenChunk = decode_cbor(resp.payload())?;
        print!("{}", chunk.text);
        std::io::Flush(&mut std::io::stdout())?;

        if chunk.finish_reason.is_some() {
            println!(); // newline at end
            break;
        }
    }
});

// User can press Ctrl-C to cancel generation
tokio::signal::ctrl_c().await.ok();
cancel.cancel(); // stops LLM generation, saves GPU cost
```

### 15.4 Best-Practice Summary

1. **Use `call_stream_with_cancel`** — always provide a cancellation
   path; LLM generation is expensive.
2. **Check `cancel.is_cancelled()` between tokens** — the handler should
   abort promptly.
3. **Send usage info on the final frame** — enables cost tracking
   (`LLM_AGENT_INTEGRATION.md`).
4. **Use CBOR for structured chunks** — supports tool calls and usage
   on the final frame without wire changes.
5. **Flush each token immediately** — no buffering; the user sees
   tokens as they're generated (§9.2).
6. **Reuse connections** — pool the connection to the LLM agent for
   follow-up turns in a conversation.

---

## 16. Security Considerations

### 16.1 Resource Exhaustion via Media Streams

**Threat:** A malicious consumer opens many media streams and never
reads, causing the producer to buffer unboundedly (backpressure attack).

**Mitigations:**
- QUIC flow control automatically blocks the producer when the
  consumer's receive buffer is full (transport-level).
- Bounded application channels (§8.3) prevent application-level buffer
  growth.
- Per-connection stream limits (`max_concurrent_bidi_streams`, default
  100) cap the number of concurrent media streams.
- Per-stream write timeout: if `write_all()` blocks for > N seconds,
  reset the stream with error code 9005 (BACKPRESSURE_EXCEEDED).

### 16.2 Media Injection

**Threat:** A malicious agent publishes fake media frames to a topic,
causing detection agents to process fabricated data.

**Mitigations:**
- PubSub messages carry the publisher's `AgentId`, verified against the
  connection's authenticated identity (RFC-0009 §5).
- Topic ACLs (UCAN-based, `PUBSUB_BACKCHANNEL_DESIGN.md` §6.4) restrict
  who can publish to `media.video.*` topics.
- Content hashing: each frame can carry a hash of the raw (pre-codec)
  data for integrity verification by skeptical consumers.

### 16.3 Codec Vulnerabilities

**Threat:** Malformed codec payloads exploit decoder vulnerabilities
(buffer overflow in libopus, libvpx, libaom).

**Mitigations:**
- Use memory-safe decoder bindings (Rust wrappers around C libraries
  should validate input bounds).
- Sandbox decoders in a separate process with seccomp restrictions
  (defense in depth).
- Rate-limit frame size: reject frames larger than the codec's maximum
  expected size (e.g., > 200 KB for a VP8 frame at 1080p is suspicious).

### 16.4 Privacy

**Threat:** Media streams (audio, video) contain sensitive personal
data. Eavesdropping or recording by unauthorized agents is a privacy
violation.

**Mitigations:**
- AAFP connections are encrypted (QUIC TLS 1.3 + ML-DSA-65 PQ
  handshake). Media in transit is protected.
- Recording agents must be explicitly authorized via UCAN delegation
  ("agent X may record topic media.video.cam-001 for 24h").
- Topic ACLs restrict who can subscribe to media topics.
- Retention policies: recording agents should enforce automatic deletion
  after a configured TTL.

---

## 17. Implementation Roadmap

### 17.1 Phase 1: Audio Streaming (High Priority)

**Goal:** Enable voice agent → transcription agent streaming.

**Work Items:**
1. Define `AudioMetadata` extension (RFC-0006 type `0x0020`).
2. Add `media()` QUIC preset (BBR, 4 MB stream window).
3. Integrate `opus` crate for encode/decode in example agents.
4. Implement bounded-channel backpressure in streaming handler loop.
5. Write voice agent + transcription agent example (§13).

**Estimated Effort:** 5–7 days

### 17.2 Phase 2: Video Streaming (Medium Priority)

**Goal:** Enable camera agent → detection agent streaming.

**Work Items:**
1. Define `VideoMetadata` extension (RFC-0006 type `0x0021`).
2. Integrate `vpx` (VP8) and `aom` (AV1) crates.
3. Implement keyframe/delta drop policy in buffer management.
4. Implement quality adaptation based on `StreamContext` backpressure.
5. Write camera agent + detection agent example (§14).

**Estimated Effort:** 7–10 days

### 17.3 Phase 3: Sensor Data Streaming (Medium Priority)

**Goal:** Enable IoT and market data streaming.

**Work Items:**
1. Define `SensorMetadata` extension (RFC-0006 type `0x0022`).
2. Implement CBOR batch encoding for high-rate sensors.
3. Expose QUIC datagrams in the Simple API for ultra-low-latency.
4. Write sensor agent + monitoring agent example.

**Estimated Effort:** 4–6 days

### 17.4 Phase 4: Multicast & Recording (Low Priority)

**Goal:** Enable fan-out and recording/replay.

**Work Items:**
1. Integrate media streaming with RFC-0009 PubSub (publish frames to
  topics, subscribe to media topics).
2. Implement late-joiner keyframe request protocol.
3. Implement recording agent (CBOR sequence file format).
4. Implement replay agent with timing preservation.
5. Write multicast surveillance example (1 camera → N detectors).

**Estimated Effort:** 5–8 days

### 17.5 Phase 5: Latency Optimization (Low Priority)

**Goal:** Achieve sub-50 ms end-to-end media latency.

**Work Items:**
1. Add `media()` QUIC preset to `QuicConfig`.
2. Verify single-write-per-frame (no QUIC packet splitting).
3. Profile and optimize the frame reader → consumer path.
4. Add CPU affinity pinning for media tasks.
5. Benchmark end-to-end latency for audio and video streams.

**Estimated Effort:** 3–5 days

---

## Appendix A: Media Extension Type Registry

Proposed RFC-0006 extension types for media metadata:

| Type | Name | Used on | Description |
|------|------|---------|-------------|
| `0x0020` | `EXT_AUDIO_METADATA` | First audio frame | Sample rate, channels, codec, seq, timestamp |
| `0x0021` | `EXT_VIDEO_METADATA` | Every video frame | Width, height, codec, frame type, seq, pts |
| `0x0022` | `EXT_SENSOR_METADATA` | First sensor frame | Sensor type, unit, sample rate, encoding |
| `0x0023` | `EXT_MEDIA_KEYFRAME` | Keyframe frames | Signals keyframe for late-joiner recovery |
| `0x0024` | `EXT_MEDIA_END` | Final frame | End-of-stream signal (alternative to clearing MORE) |

These are application-level extensions; servers that don't understand
them ignore them gracefully (RFC-0006 degradation).

---

## Appendix B: Codec Quick Reference

| Media | Recommended codec | Alternative | Bitrate (typical) | Frame size | Latency |
|-------|-------------------|-------------|-------------------|------------|---------|
| Voice | Opus (VoIP, 20 ms) | PCM, µ-law | 24 kbps | 40–60 B | 20 ms |
| Music | Opus (Audio, 60 ms) | AAC-LC | 64–128 kbps | 200–500 B | 60 ms |
| Video (real-time) | VP8 | H.264 | 1–2.5 Mbps | 5–50 KB | 33 ms |
| Video (surveillance) | AV1 | VP9, H.265 | 0.5–2 Mbps | 5–100 KB | 33–100 ms |
| Sensor (structured) | CBOR | Protobuf, raw | varies | 20–200 B | < 1 ms |
| Sensor (ultra-low-latency) | Raw binary | — | varies | 8–32 B | < 0.1 ms |
| Text (LLM tokens) | UTF-8 or CBOR | — | ~1 KB/s | 10–50 B | n/a |

---

## Appendix C: Buffer Policy Decision Matrix

| Media type | Buffer type | Capacity | Drop policy | Backpressure signal |
|------------|------------|----------|-------------|---------------------|
| Voice (interactive) | Bounded mpsc | 50 frames (1s) | Drop oldest | Reduce quality |
| Voice (intercom bidi) | Ring buffer | 10 frames (200ms) | Drop oldest | Reduce quality |
| Podcast (batch) | Unbounded* | — | Don't drop | Block (correctness) |
| Video (real-time) | Ring buffer | 10 frames (330ms) | Drop oldest delta | Reduce fps/resolution |
| Video (surveillance) | Ring buffer | 30 frames (1s) | Drop oldest delta | Reduce fps |
| Sensor (monitoring) | Ring buffer | 100 frames | Drop oldest | n/a |
| Sensor (accounting) | Bounded mpsc | 1000 frames | Don't drop | Block |
| Market data | Datagram | 0 (no buffer) | Drop (unreliable) | n/a |
| LLM tokens | Bounded mpsc | 1000 tokens | Don't drop | Block (display can wait) |
| File upload | QUIC flow control | — | Don't drop | Block |

*Podcast batch uses QUIC flow control only; the producer blocks when the
consumer is slow, preserving all data.

---

This document demonstrates that AAFP's streaming RPC primitives (P2.8),
combined with RFC-0009 PubSub and QUIC transport features, provide a
complete foundation for streaming media and real-time communication
between agents — with no wire protocol changes. The work is in codec
integration, buffer policy, and latency-tuned configuration, all of
which live in the SDK and application layer.
