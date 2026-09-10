# Setup

## Requirements

- Node.js 18+
- `travel-search-ru` skill for Aviasales (or set `TRAVEL_SEARCH_RU_SCRIPT`)
- outbound HTTPS access to:
  - `https://serpapi.com`
  - `https://www.trip.com`
  - `https://www.airhint.com`
  - `https://mcp.botclaw.ru`

## Google Flights

Create a SerpAPI account and store the key in macOS Keychain. Do not add it to `SKILL.md`, shell history, source control, or chat.

Run these commands in Terminal; the hidden prompt prevents the key from entering shell history:

```bash
read -s "KEY?Вставьте ключ SerpAPI: "; echo
security add-generic-password -U -a "$USER" -s SERPAPI_API_KEY -w "$KEY"
unset KEY
```

The script reads `SERPAPI_API_KEY` from the environment first and falls back to this Keychain entry.

SerpAPI calls may consume paid search credits. Flexible-date searches first shortlist dates through the Aviasales calendar to limit Google Flights requests.

## Aviasales

By default the script calls:

```text
~/.cursor/skills/travel-search-ru/scripts/travel_search.js
```

Override this location with `TRAVEL_SEARCH_RU_SCRIPT` if needed.

## AirHint

AirHint is a fare predictor, not a booking site. The script calls:

```text
GET https://www.airhint.com/predict/{airline}/{origin}/{destination}/{depart_date}/{return_date}?price=10000&currency=RUB
```

Always pass both dates for round trips. See [airhint.md](airhint.md) for how to read Buy/Wait and low confidence.

## Baggage

Google Flights, Trip.com, and Aviasales do not consistently expose checked-baggage allowance in search responses. The script marks baggage as included only when response text explicitly states a sufficient checked weight. Otherwise it reports `unknown` or `paid`; verify the final fare rules on the provider page.
