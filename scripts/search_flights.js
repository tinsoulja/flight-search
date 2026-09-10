#!/usr/bin/env node
"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 90_000;
const MAX_BYTES = 5 * 1024 * 1024;
const SKILL_ROOT = path.resolve(__dirname, "..");
const WATCHLIST_PATH = path.join(SKILL_ROOT, "config/watchlist.json");
const WATCH_STATE_PATH = path.join(SKILL_ROOT, "state/last-results.json");

const INPUT_SCHEMA = {
  type: "object",
  required: ["origin", "destination", "depart_date", "return_date"],
  properties: {
    origin: { type: "string", description: "IATA airport code" },
    destination: { type: "string", description: "IATA airport code" },
    depart_date: { type: "string", format: "date" },
    return_date: { type: "string", format: "date" },
    adults: { type: "integer", minimum: 1, default: 1 },
    children: { type: "integer", minimum: 0, default: 0 },
    infants: { type: "integer", minimum: 0, default: 0 },
    cabin: {
      type: "string",
      enum: ["economy", "premium_economy", "business", "first"],
      default: "economy",
    },
    checked_baggage_kg: { type: "integer", minimum: 0, default: 20 },
    limit_per_provider: { type: "integer", minimum: 1, maximum: 10, default: 5 },
  },
};

const AIRHINT_OFFER_SCHEMA = {
  type: "object",
  required: [
    "origin",
    "destination",
    "depart_date",
    "return_date",
    "airline",
    "price",
  ],
  properties: {
    origin: { type: "string", description: "IATA airport code" },
    destination: { type: "string", description: "IATA airport code" },
    depart_date: { type: "string", format: "date" },
    return_date: { type: "string", format: "date" },
    airline: { type: "string", description: "IATA airline code, e.g. EY" },
    price: { type: "number" },
    currency: { type: "string", default: "RUB" },
  },
};

const AIRHINT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    ...AIRHINT_OFFER_SCHEMA.properties,
    offers: {
      type: "array",
      items: AIRHINT_OFFER_SCHEMA,
      description: "Batch of round-trip offers to score",
    },
  },
};

const AIRHINT_WEAK_CONFIDENCE = 40;
const AIRHINT_DELAY_MS = 250;

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeError(category) {
  const error = new Error(category);
  error.category = category;
  return error;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "flight-search/1.0",
        ...(options.headers || {}),
      },
    });
    if (!response.ok) throw safeError("provider_http_error");
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_BYTES) {
      throw safeError("provider_response_too_large");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw safeError("provider_response_too_large");
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error.category) throw error;
    if (error.name === "AbortError") throw safeError("provider_timeout");
    throw safeError("provider_network_error");
  } finally {
    clearTimeout(timeout);
  }
}

function validateInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw safeError("invalid_input");
  }
  for (const key of INPUT_SCHEMA.required) {
    if (typeof raw[key] !== "string" || !raw[key]) throw safeError("invalid_input");
  }
  if (!/^[A-Z]{3}$/.test(raw.origin) || !/^[A-Z]{3}$/.test(raw.destination)) {
    throw safeError("invalid_input");
  }
  if (Number.isNaN(Date.parse(raw.depart_date)) || Number.isNaN(Date.parse(raw.return_date))) {
    throw safeError("invalid_input");
  }
  if (raw.return_date <= raw.depart_date) throw safeError("invalid_input");
  return {
    origin: raw.origin,
    destination: raw.destination,
    depart_date: raw.depart_date,
    return_date: raw.return_date,
    adults: raw.adults ?? 1,
    children: raw.children ?? 0,
    infants: raw.infants ?? 0,
    cabin: raw.cabin ?? "economy",
    checked_baggage_kg: raw.checked_baggage_kg ?? 20,
    limit_per_provider: Math.min(Math.max(raw.limit_per_provider ?? 5, 1), 10),
  };
}

function baggageFromText(values, requiredKg) {
  const text = values.filter(Boolean).join(" | ").toLowerCase();
  if (/checked baggage[^|]*(for a fee|additional fee|not included)/i.test(text)) {
    return { status: "paid", required_kg: requiredKg };
  }
  const patterns = [
    /(\d{1,2})\s*kg[^|]{0,50}checked baggage/gi,
    /checked baggage[^|]{0,50}(\d{1,2})\s*kg/gi,
    /багаж[^|]{0,50}(\d{1,2})\s*кг/gi,
  ];
  const weights = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) weights.push(Number(match[1]));
  }
  const confirmedKg = weights.length ? Math.min(...weights) : null;
  if (confirmedKg !== null && confirmedKg >= requiredKg) {
    return { status: "included", required_kg: requiredKg, confirmed_kg: confirmedKg };
  }
  return { status: "unknown", required_kg: requiredKg };
}

async function searchAviasales(input) {
  const script = process.env.TRAVEL_SEARCH_RU_SCRIPT ||
    path.join(os.homedir(), ".cursor/skills/travel-search-ru/scripts/travel_search.js");
  const payload = {
    origin: input.origin,
    destination: input.destination,
    depart_date: input.depart_date,
    return_date: input.return_date,
    adults: input.adults,
    children: input.children,
    infants: input.infants,
    trip_class: {
      economy: 0,
      business: 1,
      first: 2,
      premium_economy: 3,
    }[input.cabin],
    direct: false,
    limit: input.limit_per_provider,
  };
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [script, "search-flights", "--input", JSON.stringify(payload)],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES },
    );
    const data = JSON.parse(stdout);
    return {
      provider: "aviasales",
      search_url: data.url || null,
      offers: (data.flights || []).map((flight) => ({
        provider: "aviasales",
        price: flight.price_per_adult,
        currency: flight.currency,
        outbound_departure: flight.departure_at,
        return_departure: flight.return_at,
        airline: flight.airline,
        flight_number: flight.flight_number,
        stops: flight.transfers,
        outbound_stops: null,
        return_stops: null,
        duration_minutes: flight.duration_minutes,
        baggage: { status: "unknown", required_kg: input.checked_baggage_kg },
        booking_url: data.url || null,
      })),
      notes: data.notes || [],
    };
  } catch {
    throw safeError("aviasales_unavailable");
  }
}

async function searchTrip(input) {
  const original = `Перелёт ${input.origin} — ${input.destination} туда-обратно, ` +
    `${input.depart_date} — ${input.return_date}`;
  const data = await fetchJson("https://www.trip.com/ai-resource/searchFlightTicket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      originCityCode: input.origin,
      destinationCityCode: input.destination,
      departureDate: input.depart_date,
      returnDate: input.return_date,
      locale: "ru-RU",
      oneWayOrRoundTrip: "RT",
      originalInput: original,
      originalInputInEnglish:
        `Round trip ${input.origin} to ${input.destination}, ` +
        `${input.depart_date} to ${input.return_date}`,
    }),
  });
  const offers = (data.recommendedListOfOtherFlights || [])
    .filter((flight) =>
      String(flight.departureTime || "").startsWith(input.depart_date) &&
      String(flight.returnDepartureTime || "").startsWith(input.return_date))
    .slice(0, input.limit_per_provider)
    .map((flight) => ({
      provider: "trip.com",
      price: Number(flight.pricePerTicket),
      currency: flight.currency,
      outbound_departure: flight.departureTime,
      outbound_arrival: flight.arrivalTime,
      return_departure: flight.returnDepartureTime,
      return_arrival: flight.returnArrivalTime,
      airline: flight.airline,
      flight_number: flight.flightNumber,
      stops: Math.max(
        Number(flight.numberOfStops || 0),
        Number(flight.returnNumberOfStops || 0),
      ),
      outbound_stops: flight.numberOfStops,
      return_stops: flight.returnNumberOfStops,
      duration: flight.flightDuration,
      return_duration: flight.returnFlightDuration,
      baggage: baggageFromText(Object.values(flight), input.checked_baggage_kg),
      booking_url: flight.flightTicketLink || data.bookFlightLink || null,
    }));
  return {
    provider: "trip.com",
    search_url: data.bookFlightLink || null,
    offers,
    notes: offers.length ? [] : ["No exact-date priced offers returned"],
  };
}

function googleBaggage(flightGroup, requiredKg) {
  const values = [];
  for (const flight of flightGroup.flights || []) {
    values.push(...(flight.extensions || []));
  }
  values.push(...(flightGroup.extensions || []));
  return baggageFromText(values, requiredKg);
}

async function getSerpApiKey() {
  if (process.env.SERPAPI_API_KEY) return process.env.SERPAPI_API_KEY;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-a",
      process.env.USER || os.userInfo().username,
      "-s",
      "SERPAPI_API_KEY",
      "-w",
    ], { timeout: 10_000, maxBuffer: 4096 });
    const key = stdout.trim();
    return key || null;
  } catch {
    return null;
  }
}

async function searchGoogle(input) {
  const apiKey = await getSerpApiKey();
  if (!apiKey) throw safeError("serpapi_key_missing");
  const cabin = {
    economy: "1",
    premium_economy: "2",
    business: "3",
    first: "4",
  }[input.cabin];
  const params = new URLSearchParams({
    engine: "google_flights",
    api_key: apiKey,
    departure_id: input.origin,
    arrival_id: input.destination,
    outbound_date: input.depart_date,
    return_date: input.return_date,
    type: "1",
    travel_class: cabin,
    adults: String(input.adults),
    children: String(input.children),
    infants_in_seat: String(input.infants),
    currency: "RUB",
    hl: "ru",
    gl: "ru",
    sort_by: "2",
    deep_search: "true",
  });
  const data = await fetchJson(`https://serpapi.com/search.json?${params}`);
  if (data.error) throw safeError("google_flights_error");
  const groups = [...(data.best_flights || []), ...(data.other_flights || [])];
  const offers = groups.slice(0, input.limit_per_provider).map((group) => {
    const flights = group.flights || [];
    const first = flights[0] || {};
    const last = flights.at(-1) || {};
    return {
      provider: "google_flights",
      price: group.price,
      currency: "RUB",
      outbound_departure: first.departure_airport?.time || null,
      outbound_arrival: last.arrival_airport?.time || null,
      airlines: [...new Set(flights.map((flight) => flight.airline).filter(Boolean))],
      flight_numbers: flights.map((flight) => flight.flight_number).filter(Boolean),
      stops: Math.max(flights.length - 1, 0),
      outbound_stops: Math.max(flights.length - 1, 0),
      return_stops: null,
      duration_minutes: group.total_duration,
      baggage: googleBaggage(group, input.checked_baggage_kg),
      booking_url: data.search_metadata?.google_flights_url || null,
    };
  });
  return {
    provider: "google_flights",
    search_url: data.search_metadata?.google_flights_url || null,
    offers,
    notes: ["Round-trip return details may require selecting an outbound flight"],
  };
}

async function search(input) {
  const providers = [
    ["google_flights", searchGoogle],
    ["trip.com", searchTrip],
    ["aviasales", searchAviasales],
  ];
  const settled = await Promise.allSettled(
    providers.map(([, provider]) => provider(input)),
  );
  const results = [];
  const unavailable_providers = [];
  settled.forEach((item, index) => {
    if (item.status === "fulfilled") results.push(item.value);
    else {
      unavailable_providers.push({
        provider: providers[index][0],
        category: item.reason?.category || "provider_unavailable",
      });
    }
  });
  const offers = results.flatMap((result) => result.offers)
    .filter((offer) => Number.isFinite(Number(offer.price)))
    .sort((a, b) => Number(a.price) - Number(b.price));
  return {
    query: input,
    searched_at: new Date().toISOString(),
    offers,
    provider_results: results,
    unavailable_providers,
  };
}

function airlineCode(offer) {
  const direct = Array.isArray(offer.airline) ? offer.airline[0] : offer.airline;
  if (typeof direct === "string" && /^[A-Z0-9]{2}$/.test(direct.trim())) {
    return direct.trim().toUpperCase();
  }
  const numbers = offer.flight_number || offer.flight_numbers;
  const first = Array.isArray(numbers) ? numbers[0] : numbers;
  const match = typeof first === "string" && first.trim().match(/^([A-Z0-9]{2})\s*\d/);
  return match ? match[1] : null;
}

function validateAirhintOffer(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw safeError("invalid_input");
  }
  const origin = typeof raw.origin === "string" ? raw.origin.toUpperCase() : "";
  const destination = typeof raw.destination === "string" ? raw.destination.toUpperCase() : "";
  const airline = airlineCode(raw);
  const price = Number(raw.price);
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) {
    throw safeError("invalid_input");
  }
  if (Number.isNaN(Date.parse(raw.depart_date)) || Number.isNaN(Date.parse(raw.return_date))) {
    throw safeError("invalid_input");
  }
  if (raw.return_date <= raw.depart_date) throw safeError("invalid_input");
  if (!airline || !Number.isFinite(price) || price <= 0) throw safeError("invalid_input");
  return {
    origin,
    destination,
    depart_date: raw.depart_date,
    return_date: raw.return_date,
    airline,
    price,
    currency: raw.currency || "RUB",
  };
}

function airhintLink(input) {
  return `https://www.airhint.com/predict/${input.airline}/${input.origin}/` +
    `${input.destination}/${input.depart_date}/${input.return_date}` +
    `?price=${input.price}&currency=${encodeURIComponent(input.currency)}`;
}

function interpretAirhint(input, data) {
  const range = Array.isArray(data.price_range) ? data.price_range.map(Number) : [];
  const floor = Number.isFinite(range[0]) ? range[0] : null;
  const ceiling = Number.isFinite(range[1]) ? range[1] : null;
  const typical = Number.isFinite(range[2]) ? range[2] : null;
  const confidence = Number(data.confidence);
  const suggestion = data.suggestion === "Buy" || data.suggestion === "Wait"
    ? data.suggestion
    : null;
  const weak_signal = !Number.isFinite(confidence) || confidence < AIRHINT_WEAK_CONFIDENCE;
  return {
    suggestion,
    confidence: Number.isFinite(confidence) ? confidence : null,
    recommendation: data.recommendation || [],
    price_range: { floor, ceiling, typical },
    max_saving: data.max_saving || null,
    current_vs_typical: typical === null ? null : input.price - typical,
    weak_signal,
    booking_signal: weak_signal ? "inconclusive" : suggestion === "Buy" ? "buy" : "wait",
    link: airhintLink(input),
  };
}

async function predictAirhint(input) {
  const data = await fetchJson(airhintLink(input), {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0",
    },
  });
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw safeError("airhint_unavailable");
  }
  return {
    query: input,
    ...interpretAirhint(input, data),
  };
}

function rangeKey(prediction) {
  const range = prediction.price_range || {};
  return `${range.floor}|${range.ceiling}|${range.typical}`;
}

async function predictAirhintOffers(rawOffers) {
  const predictions = [];
  for (const raw of rawOffers) {
    let input;
    try {
      input = validateAirhintOffer(raw);
    } catch {
      predictions.push({
        query: raw,
        unavailable: true,
        category: "invalid_input",
      });
      continue;
    }
    try {
      predictions.push(await predictAirhint(input));
    } catch {
      predictions.push({
        query: input,
        unavailable: true,
        category: "airhint_unavailable",
        link: airhintLink(input),
      });
    }
    await wait(AIRHINT_DELAY_MS);
  }
  const ranges = [...new Set(
    predictions
      .filter((item) => item.price_range)
      .map(rangeKey),
  )];
  const airlines = new Set(
    predictions.map((item) => item.query?.airline).filter(Boolean),
  );
  return {
    searched_at: new Date().toISOString(),
    route_level_range: airlines.size > 1 && ranges.length === 1,
    predictions,
  };
}

function compactOffer(offer, previousPrice) {
  const price = Number(offer.price);
  return {
    provider: offer.provider,
    price,
    currency: offer.currency,
    price_change: Number.isFinite(previousPrice) ? price - previousPrice : null,
    airline: offer.airline || offer.airlines || null,
    flight_number: offer.flight_number || offer.flight_numbers || null,
    stops: offer.stops,
    outbound_stops: offer.outbound_stops ?? null,
    return_stops: offer.return_stops ?? null,
    outbound_layover_minutes: offer.outbound_layover_minutes ?? null,
    return_layover_minutes: offer.return_layover_minutes ?? null,
    duration_minutes: offer.duration_minutes || null,
    duration: offer.duration || null,
    return_duration: offer.return_duration || null,
    baggage: offer.baggage,
    booking_url: offer.booking_url,
  };
}

function durationTextToMinutes(value) {
  if (typeof value !== "string") return null;
  const hours = value.match(/(\d+)\s*h/i);
  const minutes = value.match(/(\d+)\s*m/i);
  if (!hours && !minutes) return null;
  return Number(hours?.[1] || 0) * 60 + Number(minutes?.[1] || 0);
}

function passesWeeklyFilters(offer, filters) {
  const stopCounts = [
    offer.outbound_stops,
    offer.return_stops,
    offer.stops,
  ].filter((value) => Number.isFinite(Number(value)));
  if (
    Number.isFinite(filters?.max_stops) &&
    stopCounts.some((value) => Number(value) > filters.max_stops)
  ) {
    return false;
  }
  if (
    offer.provider === "aviasales" &&
    Number.isFinite(filters?.max_roundtrip_duration_minutes) &&
    (
      !Number.isFinite(Number(offer.duration_minutes)) ||
      Number(offer.duration_minutes) > filters.max_roundtrip_duration_minutes
    )
  ) {
    return false;
  }
  if (
    offer.provider === "trip.com" &&
    Number.isFinite(filters?.max_leg_duration_minutes)
  ) {
    const outbound = durationTextToMinutes(offer.duration);
    const inbound = durationTextToMinutes(offer.return_duration);
    if (Number.isFinite(outbound) && outbound > filters.max_leg_duration_minutes) {
      return false;
    }
    if (Number.isFinite(inbound) && inbound > filters.max_leg_duration_minutes) {
      return false;
    }
  }
  return true;
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(concurrency, 1), items.length) },
      () => run(),
    ),
  );
  return results;
}

function previousPriceKey(origin, departDate, returnDate, provider) {
  return `${origin}|${departDate}|${returnDate}|${provider}`;
}

async function watchSavedDates() {
  const config = await readJsonOrNull(WATCHLIST_PATH);
  if (
    !Array.isArray(config?.routes) ||
    !config.routes.length ||
    !Array.isArray(config.departure_dates) ||
    !config.departure_dates.length ||
    !Array.isArray(config.trip_lengths_days) ||
    !config.trip_lengths_days.length
  ) {
    throw safeError("invalid_watchlist");
  }
  const previous = await readJsonOrNull(WATCH_STATE_PATH);
  const previousPrices = new Map();
  for (const result of previous?.results || []) {
    for (const offer of result.offers || []) {
      previousPrices.set(
        previousPriceKey(
          result.origin,
          result.depart_date,
          result.return_date,
          offer.provider,
        ),
        Number(offer.price),
      );
    }
  }

  const unavailable = new Set();
  const combinations = config.routes.flatMap((route) =>
    config.departure_dates.flatMap((departDate) =>
      config.trip_lengths_days.map((tripLengthDays) => validateInput({
        ...route,
        depart_date: departDate,
        return_date: addDays(departDate, tripLengthDays),
        limit_per_provider: config.limit_per_provider || 3,
      }))));

  const scans = await mapWithConcurrency(
    combinations,
    config.aviasales_scan_concurrency || 4,
    async (input) => {
      const retries = config.aviasales_scan_retries || 0;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const aviasales = await searchAviasales(input);
          const offers = aviasales.offers
            .filter((offer) => Number.isFinite(Number(offer.price)))
            .filter((offer) =>
              !Number.isFinite(config.filters?.max_stops) ||
              Number(offer.stops) <= config.filters.max_stops)
            .filter((offer) =>
              !Number.isFinite(config.filters?.max_roundtrip_duration_minutes) ||
              (
                Number.isFinite(Number(offer.duration_minutes)) &&
                Number(offer.duration_minutes) <=
                  config.filters.max_roundtrip_duration_minutes
              ))
            .sort((a, b) => Number(a.price) - Number(b.price));
          await wait(config.aviasales_scan_delay_ms || 0);
          return { input, aviasales, offers };
        } catch {
          if (attempt < retries) await wait(1_500 * (attempt + 1));
        }
      }
      unavailable.add("aviasales");
      await wait(config.aviasales_scan_delay_ms || 0);
      return { input, aviasales: null, offers: [] };
    },
  );

  const finalists = config.routes.flatMap((route) =>
    scans
      .filter(({ input, offers }) => input.origin === route.origin && offers.length)
      .sort((a, b) => Number(a.offers[0].price) - Number(b.offers[0].price))
      .slice(0, config.finalists_per_route || 5));
  const finalistKeys = new Set(finalists.map(({ input }) =>
    `${input.origin}|${input.depart_date}|${input.return_date}`));

  const details = await mapWithConcurrency(finalists, 3, async (scan) => {
    const providers = [];
    if (config.weekly_validation?.google_flights) {
      providers.push(["google_flights", searchGoogle]);
    }
    if (config.weekly_validation?.trip_com) {
      providers.push(["trip.com", searchTrip]);
    }
    if (!providers.length) {
      return {
        input: scan.input,
        offers: scan.offers.length ? [scan.offers[0]] : [],
      };
    }
    const settled = await Promise.allSettled(
      providers.map(([, provider]) => provider(scan.input)),
    );
    const providerResults = scan.aviasales ? [scan.aviasales] : [];
    settled.forEach((item, index) => {
      if (item.status === "fulfilled") providerResults.push(item.value);
      else unavailable.add(providers[index][0]);
    });
    const cheapestByProvider = new Map();
    for (const offer of providerResults.flatMap((result) => result.offers || [])) {
      if (
        Number.isFinite(Number(offer.price)) &&
        passesWeeklyFilters(offer, config.filters) &&
        !cheapestByProvider.has(offer.provider)
      ) {
        cheapestByProvider.set(offer.provider, offer);
      }
    }
    return { input: scan.input, offers: [...cheapestByProvider.values()] };
  });
  const detailByKey = new Map(details.map((detail) => [
    `${detail.input.origin}|${detail.input.depart_date}|${detail.input.return_date}`,
    detail,
  ]));

  const results = scans.map((scan) => {
    const key = `${scan.input.origin}|${scan.input.depart_date}|${scan.input.return_date}`;
    const sourceOffers = finalistKeys.has(key)
      ? detailByKey.get(key)?.offers || scan.offers.slice(0, 1)
      : scan.offers.slice(0, 1);
    return {
      origin: scan.input.origin,
      destination: scan.input.destination,
      depart_date: scan.input.depart_date,
      return_date: scan.input.return_date,
      trip_length_days: Math.round(
        (Date.parse(scan.input.return_date) - Date.parse(scan.input.depart_date)) /
        86_400_000,
      ),
      finalist: finalistKeys.has(key),
      offers: sourceOffers
        .sort((a, b) => Number(a.price) - Number(b.price))
        .map((offer) => compactOffer(
          offer,
          previousPrices.get(previousPriceKey(
            scan.input.origin,
            scan.input.depart_date,
            scan.input.return_date,
            offer.provider,
          )),
        )),
    };
  });
  const allFinalistOffers = results
    .filter(({ finalist }) => finalist)
    .flatMap((result) => result.offers.map((offer) => ({
      origin: result.origin,
      destination: result.destination,
      depart_date: result.depart_date,
      return_date: result.return_date,
      trip_length_days: result.trip_length_days,
      ...offer,
    })))
    .sort((a, b) => a.price - b.price);
  const bestOverall = allFinalistOffers.slice(0, config.top_results || 8);
  const bestByOriginOffers = config.routes.flatMap(({ origin }) =>
    allFinalistOffers
      .filter((offer) => offer.origin === origin)
      .slice(0, config.top_results_per_origin || 5));
  const airhintTargets = [];
  const airhintSeen = new Set();
  for (const offer of [...bestOverall, ...bestByOriginOffers]) {
    const key = [
      offer.origin,
      offer.depart_date,
      offer.return_date,
      airlineCode(offer),
      offer.price,
    ].join("|");
    if (airhintSeen.has(key)) continue;
    airhintSeen.add(key);
    airhintTargets.push(offer);
  }
  const airhint = await predictAirhintOffers(airhintTargets);
  const airhintByKey = new Map(airhint.predictions.map((item) => [
    [
      item.query?.origin,
      item.query?.depart_date,
      item.query?.return_date,
      item.query?.airline,
      item.query?.price,
    ].join("|"),
    item,
  ]));
  function withAirhint(offer) {
    return {
      ...offer,
      airhint: airhintByKey.get([
        offer.origin,
        offer.depart_date,
        offer.return_date,
        airlineCode(offer),
        offer.price,
      ].join("|")) || { unavailable: true },
    };
  }
  if (airhint.predictions.some((item) => item.unavailable)) unavailable.add("airhint");
  const report = {
    routes: config.routes.map(({ origin, destination }) => ({ origin, destination })),
    trip_lengths_days: config.trip_lengths_days,
    filters: config.filters,
    filters_checked_by_trip_com: ["max_stops", "max_leg_duration_minutes"],
    filters_requiring_manual_validation: ["max_layover_minutes"],
    searched_at: new Date().toISOString(),
    combinations_scanned: combinations.length,
    google_finalists_checked: config.weekly_validation?.google_flights
      ? finalists.length
      : 0,
    trip_com_finalists_checked: config.weekly_validation?.trip_com
      ? finalists.length
      : 0,
    airhint_route_level_range: airhint.route_level_range,
    best_overall: bestOverall.map(withAirhint),
    best_by_origin: Object.fromEntries(config.routes.map(({ origin }) => [
      origin,
      allFinalistOffers
        .filter((offer) => offer.origin === origin)
        .slice(0, config.top_results_per_origin || 5)
        .map(withAirhint),
    ])),
    unavailable_providers: [...unavailable],
  };
  await fs.mkdir(path.dirname(WATCH_STATE_PATH), { recursive: true });
  await fs.writeFile(WATCH_STATE_PATH, `${JSON.stringify({
    ...report,
    results,
  }, null, 2)}\n`);
  return report;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "describe") {
    output({
      commands: {
        search: { inputSchema: INPUT_SCHEMA },
        watch: { input: null, description: "Check saved date pairs compactly" },
        airhint: { inputSchema: AIRHINT_INPUT_SCHEMA },
      },
    });
    return 0;
  }
  if (command === "watch") {
    output(await watchSavedDates());
    return 0;
  }
  if (command === "airhint") {
    const index = rest.indexOf("--input");
    if (index === -1 || index + 1 >= rest.length) throw safeError("invalid_input");
    let raw;
    try {
      raw = JSON.parse(rest[index + 1]);
    } catch {
      throw safeError("invalid_input");
    }
    const offers = Array.isArray(raw?.offers) ? raw.offers : [raw];
    if (!offers.length) throw safeError("invalid_input");
    output(await predictAirhintOffers(offers));
    return 0;
  }
  if (command !== "search") throw safeError("usage");
  const index = rest.indexOf("--input");
  if (index === -1 || index + 1 >= rest.length) throw safeError("invalid_input");
  let raw;
  try {
    raw = JSON.parse(rest[index + 1]);
  } catch {
    throw safeError("invalid_input");
  }
  output(await search(validateInput(raw)));
  return 0;
}

main(process.argv.slice(2)).catch((error) => {
  const category = error.category || "internal";
  output({ error: true, category, message: category });
  process.exitCode = 1;
});
