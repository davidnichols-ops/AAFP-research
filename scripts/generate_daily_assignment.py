#!/usr/bin/env python3
"""
AAFP Daily Assignment Generator

Generates and emails a daily assignment to David Nichols.
Run: python3 scripts/generate_daily_assignment.py

The CEO (Devin) uses this to send daily tasks to David (the operator).
"""

import smtplib
import sys
import os
from datetime import datetime, timedelta
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# ─── Configuration ───────────────────────────────────────────────
TO_EMAIL = "david.nichols.ops@gmail.com"
FROM_EMAIL = "david.nichols.ops@gmail.com"
SUBJECT_PREFIX = "AAFP Daily Assignment"

# Phase 2 roadmap (10 steps, ~10 days)
PHASE_2_STEPS = [
    {
        "id": "P2.1",
        "title": "3-Line Developer API",
        "days": "Day 1-2",
        "description": """Create a high-level API that hides all protocol complexity.

Target API:
  Agent::serve().capability("echo").handler(|req| async { Ok(Response::text(req.text())) }).start().await
  let agent = Agent::connect().await?;
  agent.discover("echo").call(Request::text("hello")).await?

Implementation:
- Create crates/aafp-sdk/src/simple.rs
- Agent::serve() → ServeBuilder with sensible defaults
- Agent::connect() → auto-discovery, auto-relay, auto-NAT
- ServeBuilder::capability(name), .handler(closure), .start()
- DiscoveryBuilder::call(request) → discover, connect, send, receive
- All complexity (keypair, bind addr, seeds, NAT, relay) auto-configured
- Defaults: generate keypair if none, bind 0.0.0.0:0, auto-discover seeds

Files:
- crates/aafp-sdk/src/simple.rs (NEW)
- crates/aafp-sdk/src/lib.rs (add module)
- crates/aafp-sdk/tests/simple_api.rs (NEW — integration test)

Verification:
- [ ] cargo test -p aafp-sdk --test simple_api passes
- [ ] A new user can write a working agent in 3 lines
- [ ] No protocol knowledge required to use the API""",
        "context": "This is the most important Phase 2 deliverable. The entire strategic vision depends on developers being able to use AAFP without understanding the protocol. The 3-line API is the acid test for adoption."
    },
    {
        "id": "P2.2",
        "title": "CLI Polish",
        "days": "Day 2-3",
        "description": """Make the CLI feel like a natural developer tool.

Improvements to aafp-cli:
- aafp serve --capability echo → start serving in one command
- aafp call echo "hello" → discover + call in one command
- aafp peers → list connected peers (NAT status, relay status)
- aafp metrics → show agent metrics
- aafp health → show health status
- aafp logs --follow → stream structured logs
- Colored output, progress indicators
- aafp quickstart → interactive setup wizard

Files:
- crates/aafp-cli/src/main.rs (add commands)
- crates/aafp-cli/src/commands/ (add serve.rs, call.rs, peers.rs, metrics.rs)

Verification:
- [ ] aafp serve --capability echo starts a working agent
- [ ] aafp call echo "hello" gets a response
- [ ] cargo test -p aafp-cli passes""",
        "context": "The CLI is the first thing a developer touches. It needs to feel natural and fast, not like a debugging tool."
    },
    {
        "id": "P2.3",
        "title": "Quickstart Tutorial",
        "days": "Day 3-4",
        "description": """Create a tutorial that a complete beginner can follow in 5 minutes.

Create docs/QUICKSTART.md:
- Install (one command)
- Serve an agent (one command)
- Call an agent (one command)
- Build with Rust (3-line example)
- Build with Python (3-line example)

Rules:
- NO mention of QUIC, CBOR, UCAN, DHT, NAT, relay, ML-DSA-65
- NO mention of protocol versions, RFCs, amendments
- Just: install, serve, call
- Include expected output for each command

Files:
- docs/QUICKSTART.md (NEW)

Verification:
- [ ] A person who has never heard of AAFP can follow it in 5 minutes
- [ ] All commands in the tutorial actually work""",
        "context": "The quickstart is what developers see first. If it's confusing, they leave. If it works in 5 minutes, they stay."
    },
    {
        "id": "P2.4",
        "title": "Python SDK High-Level API",
        "days": "Day 4-5",
        "description": """Create a high-level Python API matching the Rust simple API.

Target:
  from aafp import Agent
  agent = Agent.serve(capability="echo")
  @agent.handler
  async def echo(request):
      return {"text": request["text"]}
  await agent.start()

  # Call
  agent = Agent.connect()
  result = await agent.discover("echo").call({"text": "hello"})

Implementation:
- Create aafp-py/src/simple.rs — Python-friendly wrapper
- Expose Agent.serve(), Agent.connect(), agent.discover(), agent.call()
- Hide all Rust types behind Python-friendly interfaces
- Async/await native (asyncio)
- Type hints for IDE autocomplete

Files:
- crates/aafp-py/src/simple.rs (NEW)
- crates/aafp-py/src/lib.rs (add module)
- crates/aafp-py/tests/test_simple.py (NEW)

Verification:
- [ ] Python developer can build an agent in 3 lines
- [ ] Python agent can call Rust agent
- [ ] No Rust knowledge required""",
        "context": "Python is the #1 language for AI/ML developers. If AAFP doesn't have a great Python SDK, we lose 80% of our potential audience."
    },
    {
        "id": "P2.5",
        "title": "Examples That Work",
        "days": "Day 5-6",
        "description": """Create 5 working examples that people can clone and run.

1. examples/echo-agent/ — Minimal echo agent (Rust, 10 lines)
2. examples/translation-pipeline/ — Chain 3 agents: OCR → translate → summarize
3. examples/python-weather-agent/ — Python agent that calls a weather API
4. examples/relay-setup/ — Deploy a relay node on a cloud VM
5. examples/multi-agent-chat/ — 3 agents that chat with each other

Each example:
- Has a README with "run in 2 minutes" instructions
- Has docker compose up support
- Has no protocol jargon in the README
- Works out of the box on localhost

Files:
- examples/echo-agent/ (NEW)
- examples/translation-pipeline/ (NEW)
- examples/python-weather-agent/ (NEW)
- examples/relay-setup/ (NEW)
- examples/multi-agent-chat/ (NEW)

Verification:
- [ ] All 5 examples run with cargo run or python main.py
- [ ] All 5 READMEs have no protocol jargon
- [ ] All 5 work on localhost without configuration""",
        "context": "Examples are how developers learn. They clone, run, understand, then modify. The examples must be dead simple."
    },
    {
        "id": "P2.6",
        "title": "Prometheus + Grafana Dashboard",
        "days": "Day 6-7",
        "description": """Make observability plug-and-play.

Implementation:
- Add crates/aafp-sdk/src/prometheus.rs — Prometheus exporter
- Agent::with_metrics_endpoint("0.0.0.0:9090") — enable Prometheus
- Metrics: aafp_connections_active, aafp_messages_total, aafp_handshakes_total
- Create deploy/grafana/aafp-dashboard.json — pre-built dashboard
- Update docker-compose.yml to include Prometheus + Grafana
- docker compose up → Grafana at localhost:3000, dashboard auto-loaded

Files:
- crates/aafp-sdk/src/prometheus.rs (NEW)
- deploy/grafana/aafp-dashboard.json (NEW)
- deploy/grafana/datasource.yml (NEW)
- docker-compose.yml (update)

Verification:
- [ ] docker compose up starts AAFP + Prometheus + Grafana
- [ ] Dashboard shows live metrics
- [ ] Metrics are accurate (match AgentMetrics)""",
        "context": "Observability is what makes operators comfortable deploying AAFP in production. A pre-built Grafana dashboard is table stakes."
    },
    {
        "id": "P2.7",
        "title": "Documentation Site",
        "days": "Day 7-8",
        "description": """Create a developer documentation site.

Implementation:
- Use mdbook (Rust-native, simple)
- Structure:
  - Getting Started: Quick start, install, first agent
  - Guides: Serve an agent, call an agent, deploy a relay
  - SDK Reference: Rust API, Python API, CLI
  - Concepts: What is AAFP? (no jargon), How discovery works (simplified)
  - Deployment: Docker, K8s, systemd, cloud VM
  - Examples: 5 working examples
- NO RFCs on the docs site (those are for implementers)
- Deploy to GitHub Pages

Files:
- docs-site/ (NEW — mdbook project)
- .github/workflows/docs.yml (NEW — deploy to GitHub Pages)

Verification:
- [ ] Documentation site builds and deploys
- [ ] A developer can go from zero to running agent using only the docs
- [ ] No protocol jargon on the docs site""",
        "context": "The docs site is the front door. It needs to be clean, fast, and jargon-free. RFCs stay in the repo for implementers."
    },
    {
        "id": "P2.8",
        "title": "Install Script + Homebrew",
        "days": "Day 8-9",
        "description": """Make installation one command.

Implementation:
- Create scripts/install.sh (detect OS, download binary, verify checksum)
- Create deploy/homebrew/aafp.rb (Homebrew formula)
- Create GitHub Actions release workflow (build for macOS + Linux)
- Document install in QUICKSTART.md

Files:
- scripts/install.sh (NEW)
- deploy/homebrew/aafp.rb (NEW)
- .github/workflows/release.yml (NEW)

Verification:
- [ ] curl -sSf https://aafp.dev/install | sh installs AAFP
- [ ] aafp --version works after install
- [ ] brew install works (if formula submitted)""",
        "context": "If installation takes more than one command, developers leave. One curl pipe to sh, or one brew install. That's it."
    },
    {
        "id": "P2.9",
        "title": "Integration Tests for Developer Experience",
        "days": "Day 9-10",
        "description": """Test the developer experience end-to-end.

Create tests/developer_experience.rs:
1. 3-line API test: Agent::serve().capability("echo").handler(...).start() works
2. CLI test: aafp serve --capability echo + aafp call echo "hello" works
3. Python SDK test: Python agent can call Rust agent
4. Docker test: docker compose up starts working agents
5. Metrics test: Prometheus endpoint returns valid metrics
6. Quickstart test: Follow QUICKSTART.md steps programmatically

Files:
- crates/aafp-tests/tests/developer_experience.rs (NEW)

Verification:
- [ ] All developer experience tests pass
- [ ] CI runs them on every PR""",
        "context": "If the developer experience breaks, we need to know immediately. These tests are the safety net."
    },
    {
        "id": "P2.10",
        "title": "Phase 2 Completion Report",
        "days": "Day 10",
        "description": """Compile Phase 2 results and plan Phase 3.

Create docs/PHASE_2_COMPLETE.md:
- What was delivered
- Developer experience metrics (lines of code, time to first agent)
- What's next (Phase 3: ecosystem)

Update NORTH_STAR.md: Mark Phase 2 items as complete.

Files:
- docs/PHASE_2_COMPLETE.md (NEW)
- NORTH_STAR.md (update)

Verification:
- [ ] Phase 2 report exists
- [ ] NORTH_STAR.md reflects Phase 2 completion
- [ ] Phase 3 is ready to start""",
        "context": "Phase 2 is the bridge from 'it works' to 'people can use it.' Once done, we shift to ecosystem building (Phase 3)."
    },
]


def get_current_step(day_offset=0):
    """Determine which step we're on based on day offset from Phase 2 start."""
    # Phase 2 started on 2026-07-05 (day after completion)
    phase2_start = datetime(2026, 7, 5)
    today = datetime.now()
    days_elapsed = (today - phase2_start).days + day_offset

    if days_elapsed < 0:
        return None, "Phase 2 hasn't started yet. Phase 1 is complete."

    # Map days to steps (some steps take 2 days)
    day_map = [
        (0, 0),   # Day 1 → P2.1
        (1, 0),   # Day 2 → P2.1 (continued)
        (2, 1),   # Day 3 → P2.2
        (3, 2),   # Day 4 → P2.3
        (4, 3),   # Day 5 → P2.4
        (5, 4),   # Day 6 → P2.5
        (6, 5),   # Day 7 → P2.6
        (7, 6),   # Day 8 → P2.7
        (8, 7),   # Day 9 → P2.8
        (9, 8),   # Day 10 → P2.9
        (10, 9),  # Day 11 → P2.10
    ]

    for day, step_idx in day_map:
        if days_elapsed == day:
            return PHASE_2_STEPS[step_idx], None

    if days_elapsed > 10:
        return None, "Phase 2 is complete! Ready for Phase 3 (ecosystem). See PHASE_3_ARCHITECTURE.md."

    # Default to current day's step
    for day, step_idx in reversed(day_map):
        if days_elapsed >= day:
            return PHASE_2_STEPS[step_idx], None

    return PHASE_2_STEPS[0], None


def generate_assignment(step, date_str):
    """Generate the email body for a daily assignment."""
    body = f"""AAFP Daily Assignment — {date_str}

Track: Phase 2, {step['id']} — {step['title']}
Estimated time: {step['days']}

═══════════════════════════════════════════════════════════════

WHAT TO BUILD TODAY

{step['description']}

═══════════════════════════════════════════════════════════════

CONTEXT

{step['context']}

═══════════════════════════════════════════════════════════════

REMINDERS

- Commit after each completed step
- Run: cargo fmt --all -- --check && cargo clippy --workspace -- -D warnings && cargo test --workspace
- Push to origin after commit
- Report completion or blockers to Devin
- If stuck, ask — don't guess

═══════════════════════════════════════════════════════════════

Project: AAFP — Agent Operating System
Phase 2: Developer Experience
Roadmap: PHASE_2_ROADMAP.md
CEO: Devin | Operator: David Nichols

— Devin (CEO)
"""
    return body


def send_email(subject, body):
    """Send email via local sendmail."""
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = FROM_EMAIL
    msg["To"] = TO_EMAIL

    try:
        with smtplib.SMTP("localhost") as server:
            server.sendmail(FROM_EMAIL, [TO_EMAIL], msg.as_string())
        return True
    except Exception as e:
        # Fallback: use mail command
        try:
            process = os.popen(f'mail -s "{subject}" {TO_EMAIL}', "w")
            process.write(body)
            process.close()
            return True
        except Exception as e2:
            print(f"Email failed: {e}\nFallback failed: {e2}", file=sys.stderr)
            return False


def main():
    date_str = datetime.now().strftime("%Y-%m-%d")

    # Allow specifying a step manually: python3 generate_daily_assignment.py P2.3
    if len(sys.argv) > 1:
        step_id = sys.argv[1].upper()
        step = next((s for s in PHASE_2_STEPS if s["id"] == step_id), None)
        if not step:
            print(f"Unknown step: {step_id}")
            print(f"Available: {', '.join(s['id'] for s in PHASE_2_STEPS)}")
            sys.exit(1)
    else:
        step, error = get_current_step()
        if error:
            print(error)
            subject = f"{SUBJECT_PREFIX} — {date_str}"
            send_email(subject, f"AAFP Daily Assignment — {date_str}\n\n{error}")
            return

    subject = f"{SUBJECT_PREFIX} — {date_str} — {step['id']} {step['title']}"
    body = generate_assignment(step, date_str)

    # Print to console
    print(body)
    print("\n" + "=" * 60 + "\n")

    # Send email
    if send_email(subject, body):
        print(f"Email sent to {TO_EMAIL}")
    else:
        print(f"Email failed — assignment printed above")


if __name__ == "__main__":
    main()
