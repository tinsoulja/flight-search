# AirHint

Price predictor, not a flight seller. Never book through AirHint.

## Request

Always use both departure and return dates. One-way URLs return a cheaper range and must not be used for round trips.

```bash
node scripts/search_flights.js airhint --input '{"origin":"AAA","destination":"BBB","depart_date":"YYYY-MM-DD","return_date":"YYYY-MM-DD","airline":"XX","price":10000,"currency":"RUB"}'
```

Batch the shortlist that will be shown:

```bash
node scripts/search_flights.js airhint --input '{"offers":[{"origin":"AAA","destination":"BBB","depart_date":"YYYY-MM-DD","return_date":"YYYY-MM-DD","airline":"XX","price":10000}]}'
```

`airline` is a two-character IATA code. If Google Flights returns a name like `Etihad Airways`, take the code from the flight number (`EY 854` → `EY`).

## How to read the result

- `suggestion`: `Buy` or `Wait`.
- `confidence`: 0–100. Below 40 is `booking_signal: "inconclusive"`.
- `price_range.floor` / `typical` / `ceiling`: predicted low, typical, and high fare.
- `current_vs_typical`: current price minus typical. Negative means cheaper than typical.
- `max_saving`: remaining drop vs the floor, if the model is right.
- `route_level_range: true`: several airlines got the same range — treat it as a route forecast, not a specific flight.

A low-confidence `Buy` is not a reason to buy. Treat confidence below 40 as inconclusive even if the raw suggestion is Buy.

AirHint is statistical. Say so. If it fails, keep the fare shortlist and name AirHint as unavailable.
