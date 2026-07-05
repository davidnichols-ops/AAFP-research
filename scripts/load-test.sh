#!/usr/bin/env bash
# AAFP Load Test Runner (Track S1)
#
# Runs a load test with N agents and writes JSON results to
# test-results/performance/load-test-N.json
#
# Usage:
#   ./scripts/load-test.sh [agents] [messages] [size] [topology]
#
# Examples:
#   ./scripts/load-test.sh                    # 10 agents, 100 msgs, 1KB, mesh
#   ./scripts/load-test.sh 100 1000 1024 star # 100 agents, 1000 msgs, 1KB, star
#   ./scripts/load-test.sh 50 500 1024 random # 50 agents, 500 msgs, 1KB, random

set -euo pipefail

AGENTS="${1:-10}"
MESSAGES="${2:-100}"
SIZE="${3:-1024}"
TOPOLOGY="${4:-mesh}"
DURATION="${5:-60}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUST_DIR="$REPO_ROOT/implementations/rust"
RESULTS_DIR="$REPO_ROOT/test-results/performance"

mkdir -p "$RESULTS_DIR"

OUTPUT_FILE="$RESULTS_DIR/load-test-${AGENTS}-agents.json"

echo "═══════════════════════════════════════════════════════════"
echo "  AAFP Load Test"
echo "  Agents:     $AGENTS"
echo "  Messages:   $MESSAGES per agent per edge"
echo "  Size:       $SIZE bytes"
echo "  Topology:   $TOPOLOGY"
echo "  Duration:   $DURATION seconds"
echo "  Output:     $OUTPUT_FILE"
echo "═══════════════════════════════════════════════════════════"

cd "$RUST_DIR"

cargo run --features cli -p aafp-loadtest --bin loadtest -- \
    --agents "$AGENTS" \
    --messages "$MESSAGES" \
    --size "$SIZE" \
    --topology "$TOPOLOGY" \
    --duration "$DURATION" \
    --output "$OUTPUT_FILE"

echo ""
echo "Results written to: $OUTPUT_FILE"
echo "View with: cat $OUTPUT_FILE | python3 -m json.tool"
