---
name: flight-search
description: Searches and compares round-trip flights from Google Flights, Trip.com, and Aviasales, then scores the shortlist with AirHint buy/wait predictions. Use when the user asks to find or compare airfare, cheap flights, airline tickets, or when to book.
---

# Flight Search

Search only Google Flights, Trip.com, and Aviasales. Never book.

## Before searching

Do not assume origin, destination, dates, travelers, cabin, baggage, or budget. If anything required is missing, ask before running a search.

Required:
- origin and destination (IATA codes or city names to resolve);
- exact dates, or a departure range plus trip duration in days;
- adults, children (with ages), infants;
- cabin;
- required checked baggage weight, if it matters;
- hard budget, if any.

Do not invent missing fields. Optional technical defaults in the CLI (`adults: 1`, `cabin: economy`, `checked_baggage_kg: 20`) apply only after the user confirmed those values or said they do not care.

If the user states transfer or duration limits, keep them. If they do not, ask whether to apply these common filters or search without them:
- no more than one transfer each way;
- each layover no longer than 5 hours;
- each direction no longer than 17 hours total.

When those filters are on, the Aviasales scan enforces transfer count and rejects round-trip aggregate duration above 34 hours as a prefilter. Trip.com validates transfer count and per-direction duration for finalists when exact-date details are available. Treat layover duration as unverified until it is shown on the provider page.

Show unknown baggage separately instead of discarding it.

## Setup

Read [references/setup.md](references/setup.md) if `SERPAPI_API_KEY` is missing or a provider fails.

## Workflow

If the user wants a saved-date check **and** `config/watchlist.json` exists with their routes, run:

```bash
node scripts/search_flights.js watch
```

This command reads `config/watchlist.json`, scans every saved departure and trip length through Aviasales, checks the cheapest finalists through Trip.com, scores the shortlist with AirHint, and compares prices with `state/last-results.json`. It does not spend SerpAPI searches. Do not run `watch` if the watchlist is missing, empty, or still the example file.

Do not use Google Flights unless the user explicitly asks for it. Use Trip.com for routine finalist validation.

1. For flexible dates, use the Aviasales calendar from `travel-search-ru` to shortlist up to five cheap departure dates. Preserve the requested trip length exactly.
2. Before using a new input shape, run:

```bash
node scripts/search_flights.js describe
```

3. Search each shortlisted round trip with the user's values (placeholders below):

```bash
node scripts/search_flights.js search --input '{"origin":"AAA","destination":"BBB","depart_date":"YYYY-MM-DD","return_date":"YYYY-MM-DD","adults":1,"children":0,"infants":0,"cabin":"economy","checked_baggage_kg":20,"limit_per_provider":5}'
```

4. Merge identical itineraries when practical and sort comparable RUB prices ascending.
5. Put results with `baggage.status: "included"` first. Put `unknown` or `paid` baggage in a separate section labeled “Багаж нужно проверить”.
6. Never claim checked baggage is included unless the provider explicitly confirms at least the requested weight for both directions.
7. Prices can change. Include the provider, search timestamp, route, dates, airline name, outbound and return transfer counts separately, outbound and return layover duration separately when available, total duration, price, baggage status, and provider link. Mark unavailable directional values as unknown; never copy one aggregate value into both directions.
8. After the shortlist is ready, score every option you will show with AirHint. `watch` already does this for `best_overall` and `best_by_origin`. After `search`, run:

```bash
node scripts/search_flights.js airhint --input '{"offers":[{"origin":"AAA","destination":"BBB","depart_date":"YYYY-MM-DD","return_date":"YYYY-MM-DD","airline":"XX","price":10000,"currency":"RUB"}]}'
```

Round-trip dates are required. Do not call the one-way predict URL. Read [references/airhint.md](references/airhint.md) before presenting AirHint. Use `booking_signal`, not raw `Buy`/`Wait`: confidence below 40 is inconclusive and must not be framed as a reason to buy. If several airlines share one `price_range`, say it is a route-level forecast. AirHint is not a seller.

## Constraints

- Keep geography, dates, trip duration, traveler composition, cabin, and budget fixed.
- Do not scrape provider HTML or bypass bot protection.
- Do not print API keys or raw provider errors.
- Do not substitute other flight sellers.
- If one provider fails, return partial results and briefly name the unavailable provider.
