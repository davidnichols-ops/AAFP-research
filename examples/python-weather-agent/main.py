import asyncio
from aafp import Agent, Request, Response


async def weather_handler(request: Request):
    """Handle weather requests with mock data (no API key needed)."""
    city = request.body.strip()

    # Mock weather data for demo purposes
    mock_weather = {
        "san francisco": {"temp": 62, "condition": "foggy"},
        "new york": {"temp": 75, "condition": "sunny"},
        "london": {"temp": 55, "condition": "rainy"},
        "tokyo": {"temp": 80, "condition": "cloudy"},
    }

    # Look up the city, or generate a default
    weather = mock_weather.get(city.lower(), {"temp": 72, "condition": "clear"})
    return Response.text(f"Weather in {city}: {weather['temp']}F, {weather['condition']}")


async def main():
    print("Starting weather agent...", flush=True)

    builder = Agent.serve("weather")
    builder.handler(weather_handler)
    server = await builder.start()

    print(f"Agent ID:     {server.id[:16]}...", flush=True)
    print(f"Address:      {server.addr}", flush=True)
    print(f"Capabilities: weather", flush=True)
    print(flush=True)
    print("Call from another terminal:", flush=True)
    print(f'  aafp call weather "San Francisco" --addr {server.addr}', flush=True)
    print(flush=True)
    print("Press Ctrl+C to stop.", flush=True)

    # Keep running until Ctrl+C
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nShutting down...")
