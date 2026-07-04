#!/bin/bash
# AAFP Stability Test (Track S3)
#
# Runs a long-running stability test to detect memory leaks.
# A single agent accepts connections from 10 clients, each sending 1 msg/s.
# Metrics are logged every 5 minutes.
#
# Usage:
#   # 4-hour run (recommended):
#   bash test-results/performance/run-stability-test.sh 14400
#
#   # 24-hour run (optional):
#   bash test-results/performance/run-stability-test.sh 86400
#
#   # Quick 60-second verification:
#   bash test-results/performance/run-stability-test.sh 60 10
#
# Arguments:
#   $1 = duration in seconds (default: 14400 = 4 hours)
#   $2 = metrics interval in seconds (default: 300 = 5 minutes)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUST_DIR="$REPO_ROOT/implementations/rust"
BINARY="$RUST_DIR/target/release/stability"

DURATION=${1:-14400}
INTERVAL=${2:-300}

# Increase file descriptor limit
ulimit -n 65536 2>/dev/null || true

echo "=== AAFP Stability Test (Track S3) ==="
echo "Duration: ${DURATION}s ($(( DURATION / 3600 ))h $(( (DURATION % 3600) / 60 ))m)"
echo "Metrics interval: ${INTERVAL}s"
echo "Date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# Build if needed
if [ ! -f "$BINARY" ]; then
    echo "Building stability binary (release mode)..."
    cd "$RUST_DIR"
    cargo build --release -p aafp-loadtest --features cli --bin stability
fi

OUTPUT="$SCRIPT_DIR/stability-4h.json"
if [ "$DURATION" -lt 3600 ]; then
    OUTPUT="$SCRIPT_DIR/stability-${DURATION}s.json"
fi

echo "Running stability test..."
echo "Output: $OUTPUT"
echo ""

cd "$RUST_DIR"
"$BINARY" \
    --duration "$DURATION" \
    --clients 10 \
    --rate 1 \
    --size 1024 \
    --interval "$INTERVAL" \
    --output "$OUTPUT"

echo ""
echo "=== Done ==="
echo "Results: $OUTPUT"
echo ""
echo "To analyze:"
echo "  python3 -c \"import json; d=json.load(open('$OUTPUT')); print(json.dumps(d['analysis'], indent=2))\""
