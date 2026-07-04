#!/bin/bash
# AAFP 100-Agent Load Test (Track S2)
#
# Runs the load test with 100 agents across 4 topologies:
#   - Mesh (10 connections/agent, 100 msgs/edge = 1000 msgs/agent, 100K total)
#   - Star (1 edge, 1000 msgs/edge = 1000 msgs/agent, 99K total)
#   - Ring (1 edge, 1000 msgs/edge = 1000 msgs/agent, 100K total)
#   - Random (K=5, 200 msgs/edge = 1000 msgs/agent, 100K total)
#
# Usage:
#   bash test-results/performance/run-load-test-100.sh
#
# Requirements:
#   - ulimit -n 65536 (for 100 agents with many connections)
#   - ~2GB free RAM (100 agents * ~10MB each)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUST_DIR="$REPO_ROOT/implementations/rust"
OUTPUT_DIR="$SCRIPT_DIR"
BINARY="$RUST_DIR/target/release/loadtest"

# Increase file descriptor limit
ulimit -n 65536 2>/dev/null || true

echo "=== AAFP 100-Agent Load Test (Track S2) ==="
echo "Date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "System: $(uname -s) $(uname -r), $(nproc 2>/dev/null || sysctl -n hw.ncpu) CPUs"
echo "FD limit: $(ulimit -n)"
echo ""

# Build the loadtest binary in release mode for performance
echo "Building loadtest binary (release mode)..."
cd "$RUST_DIR"
cargo build --release -p aafp-loadtest --features cli --bin loadtest 2>&1 | tail -3
echo ""

# Combined results file
COMBINED="$OUTPUT_DIR/load-test-100-agents.json"
echo "{" > "$COMBINED"
echo "  \"test_name\": \"AAFP 100-Agent Load Test\"," >> "$COMBINED"
echo "  \"date\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"," >> "$COMBINED"
echo "  \"system\": \"$(uname -s) $(uname -r), $(nproc 2>/dev/null || sysctl -n hw.ncpu) CPUs\"," >> "$COMBINED"
echo "  \"fd_limit\": $(ulimit -n)," >> "$COMBINED"
echo "  \"results\": {" >> "$COMBINED"

FIRST=true

# Mesh: 100 agents, 10 connections/agent, 100 msgs/edge, 1KB, 120s
echo "--- Mesh Topology ---"
MESH_FILE="$OUTPUT_DIR/load-test-100-mesh.json"
$BINARY --agents 100 --messages 100 --size 1024 --topology mesh --max-conn 10 --duration 120 --concurrency 8 --output "$MESH_FILE"
MESH_RESULT=$(cat "$MESH_FILE")
if [ "$FIRST" = true ]; then FIRST=false; else echo "," >> "$COMBINED"; fi
echo "  \"mesh\": $MESH_RESULT" >> "$COMBINED"
echo ""

# Star: 100 agents, 1000 msgs/edge, 1KB, 120s
echo "--- Star Topology ---"
STAR_FILE="$OUTPUT_DIR/load-test-100-star.json"
$BINARY --agents 100 --messages 1000 --size 1024 --topology star --duration 120 --concurrency 8 --output "$STAR_FILE"
STAR_RESULT=$(cat "$STAR_FILE")
if [ "$FIRST" = true ]; then FIRST=false; else echo "," >> "$COMBINED"; fi
echo "  \"star\": $STAR_RESULT" >> "$COMBINED"
echo ""

# Ring: 100 agents, 1000 msgs/edge, 1KB, 120s
echo "--- Ring Topology ---"
RING_FILE="$OUTPUT_DIR/load-test-100-ring.json"
$BINARY --agents 100 --messages 1000 --size 1024 --topology ring --duration 120 --concurrency 8 --output "$RING_FILE"
RING_RESULT=$(cat "$RING_FILE")
if [ "$FIRST" = true ]; then FIRST=false; else echo "," >> "$COMBINED"; fi
echo "  \"ring\": $RING_RESULT" >> "$COMBINED"
echo ""

# Random: 100 agents, K=5, 200 msgs/edge, 1KB, 120s
echo "--- Random Topology ---"
RAND_FILE="$OUTPUT_DIR/load-test-100-random.json"
$BINARY --agents 100 --messages 200 --size 1024 --topology random --degree 5 --duration 120 --concurrency 8 --output "$RAND_FILE"
RAND_RESULT=$(cat "$RAND_FILE")
if [ "$FIRST" = true ]; then FIRST=false; else echo "," >> "$COMBINED"; fi
echo "  \"random\": $RAND_RESULT" >> "$COMBINED"
echo ""

echo "  }" >> "$COMBINED"
echo "}" >> "$COMBINED"

echo ""
echo "=== Results Summary ==="
for topo in mesh star ring random; do
    FILE="$OUTPUT_DIR/load-test-100-$topo.json"
    if [ -f "$FILE" ]; then
        SENT=$(python3 -c "import json; d=json.load(open('$FILE')); print(d['messages_sent'])")
        RECV=$(python3 -c "import json; d=json.load(open('$FILE')); print(d['messages_received'])")
        FAIL=$(python3 -c "import json; d=json.load(open('$FILE')); print(d['messages_failed'])")
        ERR=$(python3 -c "import json; d=json.load(open('$FILE')); print(f\"{d['error_rate']*100:.4f}\")")
        TPS=$(python3 -c "import json; d=json.load(open('$FILE')); print(f\"{d['throughput_msgps']:.0f}\")")
        P50=$(python3 -c "import json; d=json.load(open('$FILE')); print(f\"{d['latency']['p50_us']:.0f}\")")
        P99=$(python3 -c "import json; d=json.load(open('$FILE')); print(f\"{d['latency']['p99_us']:.0f}\")")
        echo "  $topo: sent=$SENT recv=$RECV fail=$FAIL error=${ERR}% throughput=${TPS}msg/s p50=${P50}us p99=${P99}us"
    fi
done

echo ""
echo "Combined results: $COMBINED"
echo "=== Done ==="
