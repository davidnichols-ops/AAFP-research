#!/usr/bin/env python3
"""AAFP test runner — runs all test suites and writes JSON results.

This script runs the full AAFP test suite (Rust unit tests, Go unit tests,
interop tests, conformance tests) and writes structured JSON results to
test-results/{category}/ for the dashboard generator.

Usage:
    python3 test-results/run_all_tests.py              # run everything
    python3 test-results/run_all_tests.py --rust-only   # only Rust tests
    python3 test-results/run_all_tests.py --go-only     # only Go tests
    python3 test-results/run_all_tests.py --interop     # only interop tests
    python3 test-results/run_all_tests.py --perf        # only performance benchmarks

After running, generate the dashboard:
    python3 test-results/generate_dashboard.py
"""

import argparse
import json
import os
import platform
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).parent.parent
RUST_DIR = ROOT / "implementations" / "rust"
GO_DIR = ROOT / "implementations" / "go"
RESULTS_DIR = Path(__file__).parent


def get_env_info():
    """Collect environment information for reproducibility."""
    env = {
        "os": f"{platform.system()} {platform.release()}",
        "cpu": platform.processor() or "unknown",
        "python_version": sys.version.split()[0],
        "timestamp": datetime.now().isoformat(),
    }

    # Rust version
    try:
        rust_ver = subprocess.run(
            ["rustc", "--version"], capture_output=True, text=True, timeout=5
        )
        env["rust_version"] = rust_ver.stdout.strip()
    except Exception:
        env["rust_version"] = "unknown"

    # Go version
    try:
        go_ver = subprocess.run(
            ["go", "version"], capture_output=True, text=True, timeout=5
        )
        env["go_version"] = go_ver.stdout.strip()
    except Exception:
        env["go_version"] = "unknown"

    # Git commit
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5, cwd=ROOT,
        )
        env["commit"] = commit.stdout.strip()
    except Exception:
        env["commit"] = "unknown"

    env["aafp_version"] = "rev6-rc1"
    return env


def write_result(category, filename, result):
    """Write a JSON result file to the appropriate category directory."""
    cat_dir = RESULTS_DIR / category
    cat_dir.mkdir(parents=True, exist_ok=True)
    filepath = cat_dir / filename
    with open(filepath, "w") as f:
        json.dump(result, f, indent=2)
    print(f"  → wrote {filepath}")


def run_rust_unit_tests(env):
    """Run Rust workspace unit tests and write results."""
    print("\n[Rust Unit Tests]")
    start = time.time()

    result = subprocess.run(
        ["cargo", "test", "--workspace", "--", "--test-threads=4"],
        capture_output=True, text=True,
        cwd=RUST_DIR, timeout=300,
    )

    duration_ms = int((time.time() - start) * 1000)
    output = result.stdout + result.stderr

    # Parse test results from cargo output
    # Look for: "test result: ok. 1011 passed; 0 failed; 2 ignored"
    tests = passed = failed = ignored = 0
    for line in output.split("\n"):
        if "test result:" in line:
            parts = line.split()
            for i, part in enumerate(parts):
                if part == "passed;":
                    passed = int(parts[i - 1])
                elif part == "failed;":
                    failed = int(parts[i - 1])
                elif part == "ignored":
                    ignored = int(parts[i - 1].rstrip(";"))
            tests = passed + failed + ignored

    status = "pass" if result.returncode == 0 else "fail"

    write_result("unit", "rust-unit.json", {
        "test_name": "rust-workspace-unit-tests",
        "test_category": "unit",
        "timestamp": env["timestamp"],
        "environment": env,
        "status": status,
        "duration_ms": duration_ms,
        "summary": f"{passed} passed, {failed} failed, {ignored} ignored",
        "details": [],
        "metrics": {
            "tests": tests,
            "passed": passed,
            "failed": failed,
            "ignored": ignored,
        },
    })
    return status == "pass"


def run_go_unit_tests(env):
    """Run Go unit tests and write results."""
    print("\n[Go Unit Tests]")
    start = time.time()

    result = subprocess.run(
        ["go", "test", "./...", "-v", "-count=1"],
        capture_output=True, text=True,
        cwd=GO_DIR, timeout=300,
    )

    duration_ms = int((time.time() - start) * 1000)
    output = result.stdout + result.stderr

    # Parse Go test output
    # Look for: "--- PASS: TestName" or "--- FAIL: TestName"
    passed = output.count("--- PASS:")
    failed = output.count("--- FAIL:")
    skipped = output.count("--- SKIP:")
    tests = passed + failed + skipped

    status = "pass" if result.returncode == 0 else "fail"

    write_result("unit", "go-unit.json", {
        "test_name": "go-unit-tests",
        "test_category": "unit",
        "timestamp": env["timestamp"],
        "environment": env,
        "status": status,
        "duration_ms": duration_ms,
        "summary": f"{passed} passed, {failed} failed, {skipped} skipped",
        "details": [],
        "metrics": {
            "tests": tests,
            "passed": passed,
            "failed": failed,
            "ignored": skipped,
        },
    })
    return status == "pass"


def run_rust_conformance(env):
    """Run Rust conformance tests and write results."""
    print("\n[Rust Conformance Tests]")
    start = time.time()

    result = subprocess.run(
        ["cargo", "test", "-p", "aafp-conformance", "--", "--test-threads=4"],
        capture_output=True, text=True,
        cwd=RUST_DIR, timeout=120,
    )

    duration_ms = int((time.time() - start) * 1000)
    output = result.stdout + result.stderr

    passed = failed = 0
    for line in output.split("\n"):
        if "test result:" in line:
            parts = line.split()
            for i, part in enumerate(parts):
                if part == "passed;":
                    passed = int(parts[i - 1])
                elif part == "failed;":
                    failed = int(parts[i - 1])

    status = "pass" if result.returncode == 0 else "fail"

    write_result("conformance", "rust-conformance.json", {
        "test_name": "rust-rfc-conformance",
        "test_category": "conformance",
        "timestamp": env["timestamp"],
        "environment": env,
        "status": status,
        "duration_ms": duration_ms,
        "summary": f"{passed} passed, {failed} failed",
        "details": [],
        "metrics": {"passed": passed, "failed": failed},
    })
    return status == "pass"


def run_python_interop(env):
    """Run Python↔Rust interop tests and write results."""
    print("\n[Python↔Rust Interop Tests]")
    py_dir = RUST_DIR / "crates" / "aafp-py"

    # Check if maturin and pytest are available
    venv_python = py_dir / ".venv" / "bin" / "python"
    if not venv_python.exists():
        print("  SKIP: Python venv not found. Run: cd crates/aafp-py && maturin develop")
        write_result("interop", "python-mcp-sdk.json", {
            "test_name": "python-mcp-sdk-interop",
            "test_category": "interop",
            "timestamp": env["timestamp"],
            "environment": env,
            "status": "skip",
            "duration_ms": 0,
            "summary": "Python venv not found — run maturin develop first",
            "details": [],
            "metrics": {},
        })
        return True

    start = time.time()
    result = subprocess.run(
        [str(venv_python), "-m", "pytest", "tests/", "-v", "--json-report",
         "--json-report-file=/tmp/aafp_pytest.json"],
        capture_output=True, text=True,
        cwd=py_dir, timeout=120,
    )
    duration_ms = int((time.time() - start) * 1000)

    # Try to read pytest JSON report
    passed = failed = 0
    details = []
    try:
        with open("/tmp/aafp_pytest.json") as f:
            report = json.load(f)
            passed = len(report.get("summary", {}).get("passed", []))
            failed = len(report.get("summary", {}).get("failed", []))
            for test in report.get("tests", []):
                details.append({
                    "step": test.get("nodeid", "unknown"),
                    "status": "pass" if test.get("outcome") == "passed" else "fail",
                    "duration_ms": int(test.get("duration", 0) * 1000),
                    "notes": test.get("call", {}).get("longrepr", ""),
                })
    except Exception:
        # Fallback: parse stdout
        output = result.stdout + result.stderr
        passed = output.count(" PASSED")
        failed = output.count(" FAILED")

    status = "pass" if result.returncode == 0 else "fail"

    write_result("interop", "python-mcp-sdk.json", {
        "test_name": "python-mcp-sdk-interop",
        "test_category": "interop",
        "timestamp": env["timestamp"],
        "environment": env,
        "status": status,
        "duration_ms": duration_ms,
        "summary": f"{passed} passed, {failed} failed — Python MCP client ↔ Rust rmcp server",
        "details": details,
        "metrics": {"passed": passed, "failed": failed},
    })
    return status == "pass"


def main():
    parser = argparse.ArgumentParser(description="Run AAFP test suites")
    parser.add_argument("--rust-only", action="store_true", help="Only run Rust tests")
    parser.add_argument("--go-only", action="store_true", help="Only run Go tests")
    parser.add_argument("--interop", action="store_true", help="Only run interop tests")
    parser.add_argument("--perf", action="store_true", help="Only run performance benchmarks")
    args = parser.parse_args()

    env = get_env_info()
    print(f"AAFP Test Runner")
    print(f"  Commit: {env['commit'][:7]}")
    print(f"  Rust: {env['rust_version']}")
    print(f"  OS: {env['os']}")

    all_passed = True

    if not args.go_only and not args.interop and not args.perf:
        all_passed &= run_rust_unit_tests(env)
        all_passed &= run_rust_conformance(env)

    if not args.rust_only and not args.interop and not args.perf:
        all_passed &= run_go_unit_tests(env)

    if args.interop or (not args.rust_only and not args.go_only and not args.perf):
        all_passed &= run_python_interop(env)

    print(f"\n{'=' * 50}")
    if all_passed:
        print("ALL TESTS PASSED ✓")
    else:
        print("SOME TESTS FAILED ✗")
        sys.exit(1)

    print(f"\nGenerate dashboard: python3 test-results/generate_dashboard.py")


if __name__ == "__main__":
    main()
