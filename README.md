# Поиск авиабилетов (скилл Cursor)

Скилл Cursor: сравнивает цены туда-обратно на Aviasales, Trip.com и при необходимости Google Flights (SerpAPI), затем оценивает шортлист через AirHint (покупать / подождать). Билеты не бронирует.

Скопируйте папку в `~/.cursor/skills/flight-search/` или в `.cursor/skills/flight-search/` внутри проекта.

Агент сначала собирает у пользователя откуда/куда, даты (или диапазон + длительность поездки), состав, класс, багаж и бюджет. Готовых личных маршрутов в скилле нет.

## Команды

```bash
node scripts/search_flights.js describe
node scripts/search_flights.js search --input '{"origin":"AAA","destination":"BBB","depart_date":"YYYY-MM-DD","return_date":"YYYY-MM-DD","adults":1,"children":0,"infants":0,"cabin":"economy","checked_baggage_kg":20}'
node scripts/search_flights.js airhint --input '{"offers":[{"origin":"AAA","destination":"BBB","depart_date":"YYYY-MM-DD","return_date":"YYYY-MM-DD","airline":"XX","price":10000,"currency":"RUB"}]}'
```

Опциональный скан сохранённых дат: скопируйте `config/watchlist.example.json` в `config/watchlist.json`, подставьте реальные IATA-коды и даты, затем:

```bash
node scripts/search_flights.js watch
```

Файлы `watchlist.json` и `state/last-results.json` в `.gitignore`, чтобы личные поездки не попадали в git.

## Настройка

См. [references/setup.md](references/setup.md). Aviasales идёт через соседний скилл `travel-search-ru`, если не задан `TRAVEL_SEARCH_RU_SCRIPT`. Для Google Flights нужен `SERPAPI_API_KEY` в окружении или в связке ключей macOS.
