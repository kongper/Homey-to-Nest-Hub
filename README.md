# Homey Dashboard

A small web page for your local network that shows live capability values for a hand-picked
set of devices on your Athom Homey Pro. It talks to Homey's **local API** with a Personal
Access Token, runs as a **Docker container**, and you choose exactly which devices and
capabilities appear via a `config.json` file.

```
Browser (LAN)  ──>  Node/Express container  ──>  Homey local API (http://<homey-ip>)
                    · serves the dashboard       (token kept server-side, never in the browser)
                    · proxies + caches requests
```

## What you need

1. A **Homey Pro** reachable on your LAN, and its IP address (Homey app → Settings → General, or your router).
2. A **Personal Access Token / API Key**: go to <https://my.homey.app> → **Settings → API Keys** → create a key with read access to **Devices** and **Zones**. Copy the full token (looks like `ba78f646-...:21b9f8d2...`).
3. **Docker** + **Docker Compose** on an always-on machine on the same network (PC, NAS, Raspberry Pi…).

## Setup

From this folder:

```bash
# 1. Configure connection
cp .env.example .env
#    edit .env -> set HOMEY_ADDRESS and HOMEY_TOKEN

# 2. Start with an empty config so the discovery page works
echo '{ "entities": [] }' > config.json

# 3. Build and run
docker compose up -d --build
```

Open `http://<host-ip>:8080/discover.html` on any device on your network. This lists **every**
Homey device with its `deviceId`, capability names (e.g. `measure_temperature`, `onoff`,
`alarm_contact`) and current values. Use the search box and the **Copy ID** buttons.

## Choosing what to display

Edit `config.json` (start from `config.example.json`):

```json
{
  "title": "Home Dashboard",
  "entities": [
    {
      "deviceId": "0c5...id-from-discover-page",
      "label": "Living room sensor",
      "capabilities": ["measure_temperature", "measure_humidity"]
    },
    {
      "deviceId": "9af...another-id",
      "label": "Front door",
      "capabilities": ["alarm_contact"]
    },
    {
      "deviceId": "1bd...dishwasher-id",
      "label": "Oppvask",
      "capabilities": ["remaining_time"],
      "showIf": "!=empty"
    }
  ]
}
```

- `deviceId` — copy from the discovery page.
- `label` — what to show as the card title (optional; defaults to the device name).
- `capabilities` — the capability IDs to display. Omit or leave empty to show **all** of a device's capabilities.
- `size` — `"big"`, `"small"`, `"list"`, or `"weather"` (default `"small"`). Controls how the card is laid out; see box levels below.
- `showIf` — optional condition; the card is shown only while it holds. Forms:
    - Numeric: `"<20"`, `"<=20"`, `">80"`, `">=80"`, `"==0"`, `"!=0"`.
    - Boolean: `"==true"`, `"==false"`, `"!=true"`, `"!=false"`.
    - Emptiness: `"!=empty"` (show only when **not** empty) or `"==empty"`. "Empty" means `null`, `false`, `0`, blank, or an all-zero string like `00:00`.

    Examples: a battery tile that only appears when low — `"capabilities": ["measure_battery"], "showIf": "<20"`; a motion alert only while active — `"showIf": "==true"`; a dishwasher timer that hides at `00:00` — `"capabilities": ["remaining_time"], "showIf": "!=empty"`. (Values of the wrong type are ignored; if a card has several matching values, all must satisfy the condition. `"==true"` matches only boolean `true`, not the number `1`.)

### Box levels

The `size` property chooses one of three levels:

- **Big** (`"size": "big"`) — extra-large centered value, **2 per row**.
- **Small** (`"size": "small"`, the default) — centered value, **4 per row**.
- **List** (`"size": "list"`) — title, status dot and the value(s) all on **one line**, no labels. List cards are gathered into a section **below** all the other cards, 2 per row.
- **Weather** (`"size": "weather"`) — title on top, then the value(s) on one line below with no labels — ideal for a temperature plus a `weather_description` icon (`"capabilities": ["measure_temperature", "weather_description"]`). Spans 2 columns in the top grid.

Big and Small show a single centered value; if you give them more than one capability they fall back to labelled rows. Big, Small and Weather share the top grid and can mix on the same row (a Big or Weather takes the space of two Smalls). Cards appear in the order listed in `config.json` within each section.

Apply changes with:

```bash
docker compose restart
```

The dashboard at `http://<host-ip>:8080/` auto-refreshes every 5 seconds. Booleans render as
On/Off (or Alarm/Clear for `alarm_*` capabilities); numbers show with their units; a status dot
shows online / unavailable / alarm.

## Weather icons (YR)

The capability `weather_description` is rendered as a **YR weather icon** instead of text.
The value is matched against English and Norwegian (bokmål/nynorsk) descriptions as well as
raw met.no symbol codes (e.g. `partlycloudy_day`), so `"Clear sky"`, `"klarvær"`, and
`"clearsky"` all resolve to the same icon. Day/night variants are chosen by local time
(06:00–21:00 = day), unless the value itself carries a `_day` / `_night` suffix. Unrecognised
values fall back to showing the text.

The icons are bundled in `public/icons/weather/` and the lookup table in
`public/weather-symbols.js` — both generated from
[`@yr/weather-symbols`](https://github.com/YR/weather-symbols) (icons © 2015–2017 Yr /
met.no, MIT licensed). Everything is served locally, so no internet access is needed.

Put the YR forecast device on the dashboard like any other, e.g.:

```json
{ "deviceId": "yr-device-id", "label": "Vær", "size": "big", "capabilities": ["weather_description"] }
```

## Running without Docker (optional)

Requires **Node.js 24+** (the `homey-api` client mandates it).

```bash
npm install
HOMEY_ADDRESS=http://192.168.1.50 HOMEY_TOKEN=xxx node server.js
# -> http://localhost:3000
```

## Endpoints

| Path            | Purpose                                                        |
| --------------- | ------------------------------------------------------------- |
| `/`             | The dashboard (configured devices).                           |
| `/discover.html`| Lists all devices/capabilities with IDs for setup.            |
| `/api/state`    | JSON: only the configured entities + current values.          |
| `/api/discover` | JSON: all devices + all capabilities.                         |
| `/api/health`   | `{ "ok": true }` health check.                                |

## Notes & troubleshooting

- The token lives only in the container's environment and is never sent to the browser; the
  page only ever calls this server, which avoids the CORS issues you'd hit calling Homey directly.
- **Homey error / cannot connect:** check `HOMEY_ADDRESS` (include `http://`), that the host can
  reach the Homey IP, and that the token has Devices + Zones permissions. Logs: `docker compose logs -f`.
- **Device not found (red card):** the `deviceId` changed or the device was removed — re-check it on the discovery page.
- `CACHE_TTL` (seconds) controls how often the server refetches from Homey, to keep load light.
