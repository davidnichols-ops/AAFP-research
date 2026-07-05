# Python Weather Agent

A Python agent that returns mock weather data for a city. No API key needed.

## Prerequisites

Build the AAFP Python package (one-time setup):

```bash
cd implementations/rust/crates/aafp-py
python -m venv .venv
source .venv/bin/activate
pip install maturin pytest pytest-asyncio
maturin develop --release
```

## Run

**Terminal 1 — start the agent:**

```bash
cd examples/python-weather-agent
# Use the venv from the build step
source ../../implementations/rust/crates/aafp-py/.venv/bin/activate
python main.py
```

Wait for it to print the address, e.g. `quic://127.0.0.1:52069`.

**Terminal 2 — call it:**

```bash
# From the AAFP repo root:
./implementations/rust/target/release/aafp call weather "San Francisco" --addr quic://127.0.0.1:52069
```

**Expected output:**

```
Weather in San Francisco: 62F, foggy
```

Try other cities too:

```bash
aafp call weather "Tokyo" --addr quic://127.0.0.1:52069
# Weather in Tokyo: 80F, cloudy

aafp call weather "London" --addr quic://127.0.0.1:52069
# Weather in London: 55F, rainy
```

## How It Works

The agent uses the AAFP Python SDK:

```python
from aafp import Agent, Request, Response

async def weather_handler(request: Request):
    city = request.body
    weather = {"city": city, "temp": 72, "condition": "sunny"}
    return Response.text(f"Weather in {city}: {weather['temp']}F, {weather['condition']}")

builder = Agent.serve("weather")
builder.handler(weather_handler)
server = await builder.start()
```

- `Agent.serve("weather")` creates an agent with the "weather" capability
- `builder.handler(weather_handler)` sets the Python async function that handles requests
- `await builder.start()` binds to a local port and begins accepting calls

The handler receives a `Request` with the caller's message and returns a `Response`.
Everything is async — the handler can call other APIs, databases, or agents.
