# Flight Search (Cursor skill)

Cursor skill: compare round-trip fares from Aviasales, Trip.com, and optionally Google Flights (SerpAPI), then score a shortlist with AirHint. It does not book tickets.

Copy this folder to `~/.cursor/skills/flight-search/` or into a project's `.cursor/skills/flight-search/`.

The agent must collect origin, destination, dates (or range + trip length), travelers, cabin, baggage, and budget from the user. It does not ship with anyone's personal routes.

## Commands

```bash
node scripts/search_flights.js describe
node scripts/search_flights.js search --input '{"origin":"AAA","destination":"BBB","depart_date":"YYYY-MM-DD","return_date":"YYYY-MM-DD","adults":1,"children":0,"infants":0,"cabin":"economy","checked_baggage_kg":20}'
node scripts/search_flights.js airhint --input '{"offers":[{"origin":"AAA","destination":"BBB","depart_date":"YYYY-MM-DD","return_date":"YYYY-MM-DD","airline":"XX","price":10000,"currency":"RUB"}]}'
```

Optional saved-date scan: copy `config/watchlist.example.json` to `config/watchlist.json`, fill real IATA codes and dates, then:

```bash
node scripts/search_flights.js watch
```

`watchlist.json` and `state/last-results.json` are gitignored so personal trips stay local.

## Setup

See [references/setup.md](references/setup.md). Aviasales goes through the companion `travel-search-ru` skill unless `TRAVEL_SEARCH_RU_SCRIPT` points elsewhere. Google Flights needs `SERPAPI_API_KEY` in the environment or macOS Keychain.
