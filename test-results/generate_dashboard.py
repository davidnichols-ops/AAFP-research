#!/usr/bin/env python3
"""Generate the AAFP test results dashboard.

Reads all JSON result files from test-results/{interop,performance,conformance,unit}/
and generates a single-page HTML dashboard at test-results/dashboards/index.html.

Usage:
    python3 test-results/generate_dashboard.py

The dashboard is self-contained (no external dependencies, no CDN, no JS framework).
It uses vanilla JS + CSS for maximum portability — works offline, works in any browser.
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path

# Directory structure
ROOT = Path(__file__).parent.parent
RESULTS_DIR = Path(__file__).parent
CATEGORIES = ["interop", "performance", "conformance", "unit"]
DASHBOARD_DIR = RESULTS_DIR / "dashboards"
DASHBOARD_FILE = DASHBOARD_DIR / "index.html"


def load_results():
    """Load all JSON result files from all category directories."""
    all_results = {}
    for category in CATEGORIES:
        cat_dir = RESULTS_DIR / category
        results = []
        if cat_dir.exists():
            for json_file in sorted(cat_dir.glob("*.json")):
                try:
                    with open(json_file) as f:
                        data = json.load(f)
                        data["_filename"] = json_file.name
                        results.append(data)
                except (json.JSONDecodeError, IOError) as e:
                    results.append({
                        "_filename": json_file.name,
                        "test_name": json_file.stem,
                        "status": "error",
                        "summary": f"Failed to load: {e}",
                        "timestamp": datetime.now().isoformat(),
                        "details": [],
                        "metrics": {},
                    })
        all_results[category] = results
    return all_results


def count_status(results, status):
    """Count how many results have a given status."""
    return sum(1 for r in results if r.get("status") == status)


def generate_interop_matrix(all_results):
    """Generate the interop test matrix HTML."""
    interop = all_results.get("interop", [])
    if not interop:
        return "<p class='empty'>No interop tests run yet.</p>"

    rows = []
    for r in interop:
        status_class = r.get("status", "unknown")
        icon = {"pass": "✓", "fail": "✗", "skip": "⊘", "error": "⚠"}.get(status_class, "?")
        ts = r.get("timestamp", "—")[:19]
        env = r.get("environment", {})
        commit = env.get("commit", "—")[:7]
        duration = r.get("duration_ms", "—")
        summary = r.get("summary", "—")

        rows.append(f"""
        <tr class="{status_class}">
          <td class="icon">{icon}</td>
          <td>{r.get("test_name", r.get("_filename", "—"))}</td>
          <td>{summary}</td>
          <td>{duration} ms</td>
          <td class="mono">{commit}</td>
          <td class="mono">{ts}</td>
        </tr>""")

    return f"""
    <table class="results-table">
      <thead>
        <tr><th></th><th>Test</th><th>Summary</th><th>Duration</th><th>Commit</th><th>Timestamp</th></tr>
      </thead>
      <tbody>{''.join(rows)}
      </tbody>
    </table>"""


def generate_performance_charts(all_results):
    """Generate performance benchmark charts."""
    perf = all_results.get("performance", [])
    if not perf:
        return "<p class='empty'>No performance benchmarks run yet.</p>"

    charts = []
    for r in perf:
        metrics = r.get("metrics", {})
        benchmarks = r.get("benchmarks", {})
        if not metrics and not benchmarks:
            continue

        name = r.get("test_name", r.get("_filename", "benchmark"))
        status = r.get("status", "unknown")
        track = r.get("track", "")
        description = r.get("description", "")

        # Build a unified metrics dict from either format
        unified = {}
        if metrics:
            for k, v in metrics.items():
                if isinstance(v, (int, float)):
                    unified[k] = v
        if benchmarks:
            for bench_name, bench_data in benchmarks.items():
                if isinstance(bench_data, dict):
                    # Extract median_time_ns or median_time_us
                    if "median_time_ns" in bench_data:
                        unified[bench_name + " (ns)"] = bench_data["median_time_ns"]
                    elif "median_time_us" in bench_data:
                        unified[bench_name + " (µs)"] = bench_data["median_time_us"] * 1000
                    if "throughput_elem_per_s" in bench_data:
                        unified[bench_name + " (elem/s)"] = bench_data["throughput_elem_per_s"]

        if not unified:
            continue

        # Generate bar chart from unified metrics
        # Separate time metrics (ns) from throughput metrics (elem/s)
        time_metrics = {k: v for k, v in unified.items() if "(ns)" in k or "(µs)" in k}
        thrpt_metrics = {k: v for k, v in unified.items() if "(elem/s)" in k or "throughput" in k.lower()}

        bars = []
        if time_metrics:
            max_val = max(time_metrics.values()) if time_metrics else 1
            for metric_name, value in sorted(time_metrics.items(), key=lambda x: x[1]):
                pct = (value / max_val * 100) if max_val > 0 else 0
                if value >= 1_000_000:
                    display_val = f"{value/1_000_000:.2f} ms"
                elif value >= 1_000:
                    display_val = f"{value/1_000:.2f} µs"
                else:
                    display_val = f"{value:.0f} ns"
                bars.append(f"""
                <div class="bar-row">
                  <span class="bar-label">{metric_name}</span>
                  <div class="bar-track"><div class="bar-fill" style="width:{pct}%"></div></div>
                  <span class="bar-value">{display_val}</span>
                </div>""")

        if thrpt_metrics:
            max_val = max(thrpt_metrics.values()) if thrpt_metrics else 1
            for metric_name, value in sorted(thrpt_metrics.items(), key=lambda x: -x[1]):
                pct = (value / max_val * 100) if max_val > 0 else 0
                if value >= 1_000_000:
                    display_val = f"{value/1_000_000:.2f}M/s"
                elif value >= 1_000:
                    display_val = f"{value/1_000:.1f}K/s"
                else:
                    display_val = f"{value:.0f}/s"
                bars.append(f"""
                <div class="bar-row">
                  <span class="bar-label">{metric_name}</span>
                  <div class="bar-track"><div class="bar-fill throughput" style="width:{pct}%"></div></div>
                  <span class="bar-value">{display_val}</span>
                </div>""")

        env = r.get("environment", {})
        track_badge = f'<span class="track-badge">{track}</span>' if track else ""
        desc_line = f'<div class="chart-desc">{description}</div>' if description else ""

        # Key findings (if present)
        key_findings = r.get("key_findings", {})
        findings_html = ""
        if key_findings and isinstance(key_findings, dict):
            findings_items = []
            for k, v in key_findings.items():
                if isinstance(v, str):
                    findings_items.append(f"<li><strong>{k.replace('_', ' ').title()}:</strong> {v}</li>")
            if findings_items:
                findings_html = f'<div class="key-findings"><h4>Key Findings</h4><ul>{"".join(findings_items)}</ul></div>'

        charts.append(f"""
        <div class="chart-card">
          <h3>{name} {track_badge} <span class="status-badge {status}">{status}</span></h3>
          {desc_line}
          <div class="chart-env">CPU: {env.get("cpu", "—")} · Rust: {env.get("rust_version", "—")}</div>
          <div class="bar-chart">{''.join(bars)}
          </div>
          {findings_html}
        </div>""")

    return "\n".join(charts) if charts else "<p class='empty'>No performance metrics available.</p>"


def generate_conformance_table(all_results):
    """Generate conformance test results table."""
    conf = all_results.get("conformance", [])
    if not conf:
        return "<p class='empty'>No conformance tests run yet.</p>"

    rows = []
    for r in conf:
        status_class = r.get("status", "unknown")
        icon = {"pass": "✓", "fail": "✗", "skip": "⊘", "error": "⚠"}.get(status_class, "?")
        details = r.get("details", [])
        passed = sum(1 for d in details if d.get("status") == "pass")
        total = len(details)
        ts = r.get("timestamp", "—")[:19]

        rows.append(f"""
        <tr class="{status_class}">
          <td class="icon">{icon}</td>
          <td>{r.get("test_name", r.get("_filename", "—"))}</td>
          <td>{passed}/{total}</td>
          <td>{r.get("summary", "—")}</td>
          <td class="mono">{ts}</td>
        </tr>""")

    return f"""
    <table class="results-table">
      <thead>
        <tr><th></th><th>Suite</th><th>Passed</th><th>Summary</th><th>Timestamp</th></tr>
      </thead>
      <tbody>{''.join(rows)}
      </tbody>
    </table>"""


def generate_unit_table(all_results):
    """Generate unit test results table."""
    unit = all_results.get("unit", [])
    if not unit:
        return "<p class='empty'>No unit test results recorded yet.</p>"

    rows = []
    for r in unit:
        status_class = r.get("status", "unknown")
        icon = {"pass": "✓", "fail": "✗", "skip": "⊘", "error": "⚠"}.get(status_class, "?")
        metrics = r.get("metrics", {})
        ts = r.get("timestamp", "—")[:19]
        env = r.get("environment", {})
        commit = env.get("commit", "—")[:7]

        rows.append(f"""
        <tr class="{status_class}">
          <td class="icon">{icon}</td>
          <td>{r.get("test_name", r.get("_filename", "—"))}</td>
          <td>{metrics.get("tests", "—")}</td>
          <td>{metrics.get("passed", "—")}</td>
          <td>{metrics.get("failed", "—")}</td>
          <td>{metrics.get("ignored", "—")}</td>
          <td>{r.get("duration_ms", "—")} ms</td>
          <td class="mono">{commit}</td>
          <td class="mono">{ts}</td>
        </tr>""")

    return f"""
    <table class="results-table">
      <thead>
        <tr><th></th><th>Suite</th><th>Tests</th><th>Passed</th><th>Failed</th><th>Ignored</th><th>Duration</th><th>Commit</th><th>Timestamp</th></tr>
      </thead>
      <tbody>{''.join(rows)}
      </tbody>
    </table>"""


def generate_summary_cards(all_results):
    """Generate the top-level summary cards."""
    cards = []
    for category in CATEGORIES:
        results = all_results.get(category, [])
        total = len(results)
        passed = count_status(results, "pass")
        failed = count_status(results, "fail")
        errors = count_status(results, "error")
        skipped = count_status(results, "skip")

        if total == 0:
            color = "neutral"
            status_text = "No data"
        elif failed > 0 or errors > 0:
            color = "fail"
            status_text = f"{failed + errors} failing"
        elif total > 0 and passed == total:
            color = "pass"
            status_text = "All passing"
        else:
            color = "warn"
            status_text = f"{passed}/{total} passing"

        cards.append(f"""
        <div class="summary-card {color}" onclick="document.getElementById('{category}').scrollIntoView({{behavior:'smooth'}})">
          <div class="card-icon">{ {"pass": "✓", "fail": "✗", "warn": "⚠", "neutral": "○"}.get(color, "○")}</div>
          <div class="card-body">
            <div class="card-title">{category.title()}</div>
            <div class="card-status">{status_text}</div>
            <div class="card-detail">{total} test{"" if total == 1 else "s"} · {passed} passed · {failed} failed · {skipped} skipped</div>
          </div>
        </div>""")

    return "\n".join(cards)


def generate_html(all_results):
    """Generate the full HTML dashboard."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Get latest commit info from any result
    latest_env = {}
    for cat_results in all_results.values():
        for r in cat_results:
            env = r.get("environment", {})
            if env.get("commit"):
                latest_env = env
                break
        if latest_env:
            break

    summary_cards = generate_summary_cards(all_results)
    interop_html = generate_interop_matrix(all_results)
    perf_html = generate_performance_charts(all_results)
    conf_html = generate_conformance_table(all_results)
    unit_html = generate_unit_table(all_results)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AAFP Test Results Dashboard</title>
  <style>
    :root {{
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --text-dim: #8b949e;
      --pass: #3fb950;
      --fail: #f85149;
      --warn: #d29922;
      --accent: #58a6ff;
      --neutral: #6e7681;
    }}
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 0;
    }}
    .header {{
      background: linear-gradient(135deg, #161b22 0%, #0d1117 100%);
      border-bottom: 1px solid var(--border);
      padding: 2rem 2rem 1.5rem;
    }}
    .header h1 {{
      font-size: 1.75rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }}
    .header h1 .badge {{
      font-size: 0.7rem;
      background: var(--accent);
      color: var(--bg);
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      font-weight: 600;
    }}
    .header .meta {{
      color: var(--text-dim);
      font-size: 0.85rem;
      margin-top: 0.5rem;
      font-family: 'SF Mono', Monaco, monospace;
    }}
    .container {{
      max-width: 1400px;
      margin: 0 auto;
      padding: 2rem;
    }}
    .summary-grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }}
    .summary-card {{
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.25rem;
      display: flex;
      align-items: center;
      gap: 1rem;
      cursor: pointer;
      transition: border-color 0.2s, transform 0.1s;
    }}
    .summary-card:hover {{
      border-color: var(--accent);
      transform: translateY(-2px);
    }}
    .summary-card.pass {{ border-left: 4px solid var(--pass); }}
    .summary-card.fail {{ border-left: 4px solid var(--fail); }}
    .summary-card.warn {{ border-left: 4px solid var(--warn); }}
    .summary-card.neutral {{ border-left: 4px solid var(--neutral); }}
    .card-icon {{
      font-size: 2rem;
      font-weight: 700;
    }}
    .summary-card.pass .card-icon {{ color: var(--pass); }}
    .summary-card.fail .card-icon {{ color: var(--fail); }}
    .summary-card.warn .card-icon {{ color: var(--warn); }}
    .summary-card.neutral .card-icon {{ color: var(--neutral); }}
    .card-title {{ font-size: 1.1rem; font-weight: 600; }}
    .card-status {{ font-size: 0.9rem; color: var(--text-dim); }}
    .card-detail {{ font-size: 0.8rem; color: var(--text-dim); margin-top: 0.25rem; }}
    .section {{
      margin-bottom: 2.5rem;
    }}
    .section h2 {{
      font-size: 1.3rem;
      font-weight: 600;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }}
    .section h2 .count {{
      font-size: 0.8rem;
      color: var(--text-dim);
      font-weight: 400;
    }}
    .results-table {{
      width: 100%;
      border-collapse: collapse;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }}
    .results-table th {{
      background: #21262d;
      padding: 0.75rem 1rem;
      text-align: left;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }}
    .results-table td {{
      padding: 0.75rem 1rem;
      border-top: 1px solid var(--border);
      font-size: 0.9rem;
    }}
    .results-table tr.pass {{ border-left: 3px solid var(--pass); }}
    .results-table tr.fail {{ border-left: 3px solid var(--fail); }}
    .results-table tr.skip {{ border-left: 3px solid var(--neutral); }}
    .results-table tr.error {{ border-left: 3px solid var(--warn); }}
    .results-table tr.pass .icon {{ color: var(--pass); font-weight: 700; }}
    .results-table tr.fail .icon {{ color: var(--fail); font-weight: 700; }}
    .results-table tr.skip .icon {{ color: var(--neutral); }}
    .results-table tr.error .icon {{ color: var(--warn); }}
    .mono {{ font-family: 'SF Mono', Monaco, monospace; font-size: 0.85rem; color: var(--text-dim); }}
    .empty {{ color: var(--text-dim); font-style: italic; padding: 1rem; }}
    .chart-card {{
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.25rem;
      margin-bottom: 1rem;
    }}
    .chart-card h3 {{
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }}
    .chart-env {{
      font-size: 0.75rem;
      color: var(--text-dim);
      margin-bottom: 1rem;
      font-family: 'SF Mono', Monaco, monospace;
    }}
    .bar-chart {{ display: flex; flex-direction: column; gap: 0.5rem; }}
    .bar-row {{
      display: grid;
      grid-template-columns: 200px 1fr 80px;
      align-items: center;
      gap: 0.75rem;
    }}
    .bar-label {{ font-size: 0.85rem; color: var(--text-dim); }}
    .bar-track {{
      background: #21262d;
      border-radius: 4px;
      height: 24px;
      overflow: hidden;
    }}
    .bar-fill {{
      background: linear-gradient(90deg, var(--accent) 0%, #79c0ff 100%);
      height: 100%;
      border-radius: 4px;
      transition: width 0.5s ease;
    }}
    .bar-fill.throughput {{
      background: linear-gradient(90deg, #56d364 0%, #2ea043 100%);
    }}
    .bar-value {{
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 0.85rem;
      text-align: right;
    }}
    .status-badge {{
      font-size: 0.7rem;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      font-weight: 600;
      text-transform: uppercase;
    }}
    .status-badge.pass {{ background: rgba(63,185,80,0.2); color: var(--pass); }}
    .status-badge.fail {{ background: rgba(248,81,73,0.2); color: var(--fail); }}
    .track-badge {{
      font-size: 0.7rem;
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      font-weight: 600;
      background: rgba(56,139,253,0.15);
      color: var(--accent);
      font-family: 'SF Mono', Monaco, monospace;
    }}
    .chart-desc {{
      font-size: 0.85rem;
      color: var(--text-dim);
      margin-bottom: 0.5rem;
    }}
    .key-findings {{
      margin-top: 1rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
    }}
    .key-findings h4 {{
      font-size: 0.8rem;
      color: var(--text-dim);
      margin: 0 0 0.5rem 0;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }}
    .key-findings ul {{
      list-style: none;
      padding: 0;
      margin: 0;
    }}
    .key-findings li {{
      font-size: 0.82rem;
      color: var(--text);
      padding: 0.2rem 0;
    }}
    .key-findings strong {{
      color: var(--accent);
    }}
    .footer {{
      text-align: center;
      color: var(--text-dim);
      font-size: 0.8rem;
      padding: 2rem;
      border-top: 1px solid var(--border);
      margin-top: 2rem;
    }}
    .footer a {{ color: var(--accent); text-decoration: none; }}
  </style>
</head>
<body>
  <div class="header">
    <h1>AAFP Test Results <span class="badge">rev6-rc1</span></h1>
    <div class="meta">
      Generated: {now} ·
      Commit: {latest_env.get("commit", "—")[:7]} ·
      Rust: {latest_env.get("rust_version", "—")} ·
      OS: {latest_env.get("os", "—")} ·
      CPU: {latest_env.get("cpu", "—")}
    </div>
  </div>

  <div class="container">
    <div class="summary-grid">
      {summary_cards}
    </div>

    <div class="section" id="interop">
      <h2>Interoperability Tests <span class="count">({len(all_results.get("interop", []))} tests)</span></h2>
      {interop_html}
    </div>

    <div class="section" id="performance">
      <h2>Performance Benchmarks <span class="count">({len(all_results.get("performance", []))} benchmarks)</span></h2>
      {perf_html}
    </div>

    <div class="section" id="conformance">
      <h2>Conformance Tests <span class="count">({len(all_results.get("conformance", []))} suites)</span></h2>
      {conf_html}
    </div>

    <div class="section" id="unit">
      <h2>Unit Tests <span class="count">({len(all_results.get("unit", []))} suites)</span></h2>
      {unit_html}
    </div>
  </div>

  <div class="footer">
    AAFP — Agent-Agent First Networking Protocol ·
    <a href="https://github.com/davidnichols-ops/AAFP-research">GitHub</a> ·
    Generated by <code>test-results/generate_dashboard.py</code>
  </div>
</body>
</html>"""


def main():
    """Load all results and generate the dashboard."""
    DASHBOARD_DIR.mkdir(parents=True, exist_ok=True)

    all_results = load_results()

    # Print summary to console
    print("AAFP Test Results Dashboard Generator")
    print("=" * 50)
    for category in CATEGORIES:
        results = all_results.get(category, [])
        passed = count_status(results, "pass")
        failed = count_status(results, "fail")
        total = len(results)
        print(f"  {category:15s}: {passed}/{total} passed, {failed} failed")

    html = generate_html(all_results)

    with open(DASHBOARD_FILE, "w") as f:
        f.write(html)

    print(f"\nDashboard written to: {DASHBOARD_FILE}")
    print(f"Open with: open {DASHBOARD_FILE}")


if __name__ == "__main__":
    main()
