# Track L4: io_uring Evaluation (Linux-only)

## Status: N/A on macOS — Documented for Linux

## Summary

io_uring is a Linux-only asynchronous I/O subsystem that allows batched,
asynchronous syscalls without context switches. It was introduced in Linux 5.1
and has become the preferred high-performance I/O interface for network
applications.

**On macOS:** io_uring is not available. macOS uses kqueue (via `kevent()`)
for asynchronous I/O, which is already efficient for single-packet reads.
Tokio's `mio` crate uses kqueue on macOS and epoll on Linux.

**On Linux:** io_uring integration with QUIC is non-trivial:

1. **Quinn uses its own UDP socket I/O loop** — quinn-udp directly calls
   `recvmmsg()`/`sendmmsg()` (L2) via the `libc` crate, not through tokio's
   I/O abstraction. This means tokio-uring cannot transparently intercept
   quinn's socket operations.

2. **tokio-uring** provides an alternative runtime that uses io_uring for
   file I/O and TCP, but it does not support UDP sockets (which QUIC requires).
   As of 2026, tokio-uring does not have a stable UDP interface.

3. **Custom io_uring UDP:** It would be possible to write a custom `io_uring`
   UDP socket implementation and integrate it with quinn's `UdpSocket` trait.
   However, this requires:
   - Forking quinn-udp or implementing the `quinn_udp::UdpSocket` trait
   - Managing submission/completion queues manually
   - Handling GSO (Generic Segmentation Offload) via io_uring
   - Significant complexity for modest gains on localhost

4. **Expected benefit on Linux:** For localhost RPC, the benefit is small
   because kqueue/epoll are already efficient. The main benefit of io_uring
   is for high-throughput WAN scenarios with thousands of connections.

## Recommendation

- **macOS:** Skip — kqueue is already efficient. No action needed.
- **Linux:** Document as future work. The `recvmmsg`/`sendmmsg` batching
  already used by quinn (L2) provides the majority of the syscall reduction
  benefit. io_uring would provide an additional 2-5x reduction in syscall
  overhead for high-throughput scenarios, but requires significant engineering
  effort.

## Linux Implementation Plan (Future)

If io_uring support is needed in the future:

1. Use the `io-uring` crate (v0.6+) for low-level io_uring access
2. Implement a custom `quinn_udp::UdpSocket` that uses io_uring for:
   - `recv_multi()` → `io_uring::recvmsg_multi()`
   - `send()` → `io_uring::sendmsg()`
3. Use `IORING_SETUP_SQPOLL` for kernel-side polling (eliminates syscall
   for submission)
4. Batch submissions to reduce `io_uring_enter()` calls
5. Benchmark against the standard `recvmmsg`/`sendmmsg` path

## Key References

- io_uring documentation: https://unixism.net/loti/
- tokio-uring: https://github.com/tokio-rs/tokio-uring
- quinn-udp source: `quinn-udp-0.5.14/src/unix.rs`
- Linux io_uring man pages: `man io_uring_setup`, `man io_uring_enter`
