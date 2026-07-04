# Track L7: XDP / DPDK Feasibility Assessment

## Status: Not Feasible for AAFP — Documented

## Summary

XDP (eXpress Data Path) and DPDK (Data Plane Development Kit) are kernel-bypass
technologies that process network packets before they reach the socket layer.
This evaluation assesses whether they can be used with AAFP's QUIC transport.

## XDP (eXpress Data Path)

**What it is:** XDP allows eBPF programs to process network packets in the
kernel's network driver, before they reach the Linux network stack. Packets
can be processed, modified, or redirected at near-line-rate speed.

**Feasibility for AAFP:**

1. **XDP requires eBPF programs** — XDP programs are written in C/eBPF and
   attached to network interfaces. They run in kernel context with restricted
   capabilities. They cannot run Rust QUIC protocol logic.

2. **XDP can redirect to AF_XDP sockets** — AF_XDP is a special socket type
   that receives packets directly from the XDP hook, bypassing the kernel
   network stack. This is the relevant path for AAFP.

3. **AF_XDP + QUIC challenge:** AF_XDP provides raw Ethernet frames. To use
   it with QUIC, you would need to:
   - Parse IP/UDP headers manually
   - Implement QUIC packet processing on raw frames
   - Handle congestion control without kernel socket APIs
   - This is essentially reimplementing the UDP stack in userspace

4. **Rust AF_XDP support:** The `xdp` crate (v0.4+) provides AF_XDP socket
   bindings. However, it's low-level and doesn't integrate with quinn.

5. **quiche + XDP:** Cloudflare's quiche has experimental XDP support, but
   it's not production-ready and requires a custom build.

**Verdict:** Not feasible for AAFP. The complexity of implementing QUIC on
raw AF_XDP frames is enormous, and the benefit for localhost RPC is zero
(XDP only applies to physical network interfaces, not loopback).

## DPDK (Data Plane Development Kit)

**What it is:** DPDK is a userspace framework for high-speed packet processing.
It bypasses the kernel entirely, using huge pages and polling-mode drivers
(PMD) to achieve line-rate packet processing.

**Feasibility for AAFP:**

1. **DPDK requires dedicated hardware** — DPDK needs NICs with DPDK-compatible
   drivers. It cannot be used on the loopback interface.

2. **DPDK + QUIC:** There is no production-ready DPDK + QUIC implementation.
   F5's NGINX Plus has experimental DPDK support, but it's for TCP, not QUIC.

3. **DPDK complexity:** Using DPDK requires:
   - Huge page configuration
   - Dedicated NIC ports (no sharing with kernel)
   - Custom packet processing pipeline
   - Loss of kernel networking features (firewall, routing, etc.)

4. **Not suitable for agent-to-agent protocol:** AAFP is designed for
   agent-to-agent communication, often over localhost or LAN. DPDK is
   designed for network appliances processing millions of packets/sec.
   The complexity is not justified for AAFP's use case.

**Verdict:** Not feasible for AAFP. DPDK is designed for network appliances,
not agent-to-agent protocols. The infrastructure requirements (dedicated NICs,
huge pages, kernel bypass) are incompatible with AAFP's deployment model.

## Conclusion

Both XDP and DPDK are **not feasible** for AAFP:

| Technology | Feasible? | Reason |
|-----------|-----------|--------|
| XDP (eBPF) | No | Cannot run QUIC logic in eBPF |
| AF_XDP | No | Requires reimplementing UDP stack in userspace |
| DPDK | No | Requires dedicated hardware, no loopback support |
| quiche + XDP | No | Experimental, not production-ready |

## Recommendation

Focus on the optimizations that work across platforms:
- **L2 (recvmmsg/sendmmsg):** Already used by quinn on Linux
- **L3 (SIMD crypto):** Hardware AES enabled (4.6x speedup)
- **L5 (runtime tuning):** RuntimeConfig for configurable runtime

The kernel-bypass technologies (XDP, DPDK) are designed for network
appliances processing millions of packets per second. AAFP's use case
(agent-to-agent RPC, often over localhost) does not benefit from
kernel bypass. The remaining latency floor (~42µs) is dominated by
QUIC protocol processing and TLS, not kernel overhead.

## References

- XDP documentation: https://www.kernel.org/doc/html/latest/networking/xdp-rx-metadata.html
- AF_XDP tutorial: https://github.com/xdp-project/xdp-tutorial
- DPDK: https://www.dpdk.org/
- quiche XDP: https://github.com/cloudflare/quiche/issues/844
- Rust xdp crate: https://crates.io/crates/xdp
