#!/bin/bash
# Multi-node DHT test script (Track R7)
#
# Runs the multi-node DHT integration tests and outputs results as JSON.
# In a production setup, this would start 10 agents in separate processes
# on ports 4433-4442 and run test scenarios against them.
#
# For now, it runs the in-process integration tests which simulate
# multiple nodes using InMemoryDhtNetwork.

set -e

cd "$(dirname "$0")/../implementations/rust"

OUTPUT_DIR="../../test-results/interop"
mkdir -p "$OUTPUT_DIR"

echo "Running multi-node DHT integration tests..."

# Run the tests and capture output
TEST_OUTPUT=$(cargo test -p aafp-tests --test multi_node_dht -- --test-threads=1 2>&1)

# Extract test results
TOTAL=$(echo "$TEST_OUTPUT" | grep "test result:" | awk '{print $4}')
PASSED=$(echo "$TEST_OUTPUT" | grep "test result:" | awk '{print $4}')
FAILED=$(echo "$TEST_OUTPUT" | grep "test result:" | awk '{print $6}')

# Generate JSON report
cat > "$OUTPUT_DIR/multi-node-dht.json" << EOF
{
  "test": "multi-node-dht",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "total": ${TOTAL:-0},
  "passed": ${PASSED:-0},
  "failed": ${FAILED:-0},
  "scenarios": [
    "10-node bootstrap announce lookup",
    "bootstrap from seed",
    "node goes offline records expire",
    "node restarts and re-announces",
    "network partition and heal",
    "churn liveness check",
    "record replication across nodes",
    "recursive lookup multi-node",
    "bootstrap PEX transitive discovery",
    "full DHT lifecycle"
  ],
  "note": "In-process simulation using InMemoryDhtNetwork. Real-world setup requires 10 agents on separate ports."
}
EOF

echo "Results written to $OUTPUT_DIR/multi-node-dht.json"
echo "Total: $TOTAL, Passed: $PASSED, Failed: $FAILED"

if [ "${FAILED:-0}" -gt 0 ]; then
    echo "TESTS FAILED"
    exit 1
fi

echo "All multi-node DHT tests passed!"
