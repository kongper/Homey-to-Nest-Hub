import express from 'express';
import { HomeyAPI } from 'homey-api';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOMEY_ADDRESS = process.env.HOMEY_ADDRESS;
const HOMEY_TOKEN = process.env.HOMEY_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL = Number(process.env.CACHE_TTL || 5) * 1000;
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');

// Card levels. "slider" is the only writable one.
const SIZES = ['big', 'small', 'list', 'weather', 'slider'];

// Slider defaults. Positions are always expressed as "% down": 0 = fully open,
// 100 = fully closed, matching how these screens report windowcoverings_set
// (0 = open .. 1 = closed) — so no inversion by default. Devices that follow
// Homey's documented 0-is-closed convention need "invert": true on the card.
const SLIDER_DEFAULTS = {
  capability: 'windowcoverings_set',
  min: 0,
  max: 100,
  step: 5,
  invert: false,
};

if (!HOMEY_ADDRESS || !HOMEY_TOKEN) {
  console.error('Missing HOMEY_ADDRESS or HOMEY_TOKEN environment variable. See .env.example.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Homey connection (lazy + reconnect on failure)
// ---------------------------------------------------------------------------
let homeyApiPromise = null;

function connect() {
  if (!homeyApiPromise) {
    console.log(`Connecting to Homey at ${HOMEY_ADDRESS} ...`);
    homeyApiPromise = HomeyAPI.createLocalAPI({
      address: HOMEY_ADDRESS,
      token: HOMEY_TOKEN,
    }).catch((err) => {
      homeyApiPromise = null; // allow retry on next request
      throw err;
    });
  }
  return homeyApiPromise;
}

// ---------------------------------------------------------------------------
// Cached fetch of devices + zones
// ---------------------------------------------------------------------------
let cache = { ts: 0, data: null };

async function getHomeyData() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL) return cache.data;

  const homey = await connect();
  const [devices, zones] = await Promise.all([
    homey.devices.getDevices(),
    homey.zones.getZones(),
  ]);

  cache = { ts: now, data: { devices, zones } };
  return cache.data;
}

function zoneName(zones, zoneId) {
  const z = zones?.[zoneId];
  return z ? z.name : 'Unassigned';
}

// A value counts as "empty" if it's null/undefined, false, the number 0,
// an empty string, or an all-zero time/number string like "00:00" or "0.0".
function isEmptyValue(v) {
  if (v === null || v === undefined || v === false) return true;
  if (typeof v === 'number') return v === 0;
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' || /^0+([:.]0+)*$/.test(s);
  }
  return false;
}

// String/enum form: "!=docked", "==mowing", or a comma-separated set such as
// "!=docked,charging" (show unless the state is one of those). Enum capabilities
// report their *id* (e.g. "docked"), not the title ("Docked"); the comparison is
// case-insensitive and trims, so either spelling of the id works. Anything that
// still doesn't parse is left unfiltered, as before.
function passesShowIfText(expr, capabilities) {
  const t = expr.match(/^(==|=|!=)\s*(\S.*)$/);
  if (!t) return true; // unparseable expression -> don't filter
  const targets = t[2]
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (!targets.length) return true;
  const strs = capabilities
    .map((c) => c.value)
    .filter((v) => typeof v === 'string' && v.trim() !== '');
  if (!strs.length) return false;
  const hit = (v) => targets.includes(v.trim().toLowerCase());
  return t[1] === '!='
    ? strs.every((v) => !hit(v))
    : strs.every((v) => hit(v));
}

// Evaluate a "showIf" comparison expression (e.g. "<20", ">=80", "!=0") against
// the numeric capability values. Returns true if the card should be shown.
// Non-numeric values are ignored; if there are no numeric values, it returns false.
function passesShowIf(expr, capabilities) {
  const s = String(expr).trim();

  // Empty form: "!=empty" (show when not empty/zero) or "==empty" (show only when empty).
  // "Empty" means null/false/0/blank/all-zero strings like "00:00"; a card is empty
  // when all its shown values are empty.
  const e = s.match(/^(==|=|!=)\s*empty$/i);
  if (e) {
    if (!capabilities.length) return false;
    const allEmpty = capabilities.every((c) => isEmptyValue(c.value));
    return e[1] === '!=' ? !allEmpty : allEmpty;
  }

  // Boolean form: "==true", "=false", "!=true", etc.
  const b = s.match(/^(==|=|!=)\s*(true|false)$/i);
  if (b) {
    const target = b[2].toLowerCase() === 'true';
    const bools = capabilities.map((c) => c.value).filter((v) => typeof v === 'boolean');
    if (!bools.length) return false;
    return bools.every((v) => (b[1] === '!=' ? v !== target : v === target));
  }

  // Numeric form: "<20", ">=80", "!=0", etc.
  const m = s.match(/^(<=|>=|==|=|!=|<|>)\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return passesShowIfText(s, capabilities);
  const op = m[1];
  const n = parseFloat(m[2]);
  const nums = capabilities.map((c) => c.value).filter((v) => typeof v === 'number');
  if (!nums.length) return false;
  return nums.every((v) => {
    switch (op) {
      case '<': return v < n;
      case '<=': return v <= n;
      case '>': return v > n;
      case '>=': return v >= n;
      case '==':
      case '=': return v === n;
      case '!=': return v !== n;
      default: return true;
    }
  });
}

// Normalise a device into a compact shape for the frontend.
function summariseDevice(device, zones) {
  const caps = {};
  const capabilitiesObj = device.capabilitiesObj || {};
  for (const [id, c] of Object.entries(capabilitiesObj)) {
    caps[id] = {
      id,
      title: c.title || id,
      value: c.value,
      units: c.units ?? null,
      type: c.type ?? null,
      getable: c.getable ?? null,
      setable: c.setable ?? null,
      lastUpdated: c.lastUpdated ?? null,
    };
  }
  return {
    id: device.id,
    name: device.name,
    class: device.class ?? null,
    zoneId: device.zone ?? null,
    zoneName: zoneName(zones, device.zone),
    available: device.available ?? null,
    capabilities: caps,
  };
}

// ---------------------------------------------------------------------------
// Config (which devices/capabilities to display)
// ---------------------------------------------------------------------------
// The config is re-read on every request, so edits to config.json take effect on
// the next poll — no container restart needed.
//
// A parse error is reported rather than swallowed: previously a stray comma made
// the dashboard say "no dashboard configured yet", which sends you looking in
// entirely the wrong place.
// Filesystem-level failures, as opposed to "the JSON is wrong". A bind-mounted
// *single file* stops being readable once an editor replaces it on the host
// rather than writing in place — Docker Desktop reports that as ENODATA or a
// stale handle, and it does not heal until the container is restarted. Mounting
// the containing directory instead avoids it entirely (see README).
const IO_ERROR_CODES = new Set(['ENODATA', 'ESTALE', 'EBUSY', 'EIO', 'EACCES', 'EPERM', 'EISDIR']);

let lastConfigError = '';
let lastGoodConfig = null;

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (lastConfigError) console.log(`Config readable again: ${CONFIG_PATH}`);
    lastConfigError = '';
    lastGoodConfig = config;
    return { config, error: null, stale: false };
  } catch (err) {
    const code = err?.code;
    const name = path.basename(CONFIG_PATH);
    let error;
    if (code === 'ENOENT') {
      error = null; // genuinely not set up yet
    } else if (IO_ERROR_CODES.has(code)) {
      error =
        `${name}: ${code} — the container cannot read the file. The bind mount has probably ` +
        `gone stale because the file was replaced on the host; "docker compose restart" fixes it.`;
    } else {
      error = `${name}: ${err?.message || err}`; // malformed JSON
    }
    if (error && error !== lastConfigError) {
      console.error(`Cannot read config — ${error}`);
      lastConfigError = error;
    }
    // Keep serving the last config that parsed, so an unreadable file degrades to
    // "possibly out of date" rather than blanking the whole dashboard.
    if (error && lastGoodConfig) return { config: lastGoodConfig, error, stale: true };
    return { config: null, error, stale: false };
  }
}

// Normalise config.entities into a flat array of entries.
// Supports:
//   1. Array (legacy):       [ { deviceId, size, ... }, ... ]
//   2. Grouped by size:      { <size>: [ { deviceId, ... }, ... ], ... }
// In the grouped form, the size comes from the key.
function normalizeEntities(config) {
  const raw = config && config.entities;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const out = [];
    for (const [size, group] of Object.entries(raw)) {
      if (Array.isArray(group)) {
        for (const entry of group) out.push({ ...entry, size });
      }
    }
    return out;
  }
  return [];
}

// summariseDevice walks a device's whole capability list, and several config
// entries usually point at the same device (one thermometer shown as a big card
// and again as a battery row). Memoise for the life of one request. Returns null
// when the device isn't on Homey.
function deviceSummariser(devices, zones) {
  const memo = new Map();
  return (deviceId) => {
    if (!memo.has(deviceId)) {
      const device = devices[deviceId];
      memo.set(deviceId, device ? summariseDevice(device, zones) : null);
    }
    return memo.get(deviceId);
  };
}

// ---------------------------------------------------------------------------
// Sliders (the only writable cards)
// ---------------------------------------------------------------------------
const clampPct = (n) => Math.min(100, Math.max(0, n));
const numOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// Positions are "% down" (0 = fully open, 100 = fully closed). These screens
// report 0 = open .. 1 = closed, so the raw value is just the fraction closed;
// `invert` flips it for devices that run the other way.
function pctToRaw(pct, invert) {
  const p = clampPct(pct) / 100;
  return Math.round((invert ? 1 - p : p) * 100) / 100;
}
function rawToPct(raw, invert) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const p = clampPct(raw * 100);
  return Math.round((invert ? 100 - p : p) * 10) / 10;
}

// The devices a slider drives. Each entry of `deviceIds` is either a plain id
// string or { id, name, min, max }: `name` is there purely to keep config.json
// readable, and min/max describe how far *that* screen actually travels.
function sliderMembers(entry) {
  const raw = Array.isArray(entry.deviceIds)
    ? entry.deviceIds
    : entry.deviceId
      ? [entry.deviceId]
      : [];
  return raw
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m && typeof m.id === 'string' && m.id)
    .map((m) => ({
      id: m.id,
      name: [m.name, m.label].find((s) => typeof s === 'string' && s.trim()) || null,
      rawMin: numOr(m.min, null),
      rawMax: numOr(m.max, null),
    }));
}

// The slider is always 0-100 %. Each member's min/max says which slice of the
// device's own travel that maps onto, so a screen that must not go past 97 %
// down reaches its own end stop when the slider says 100 %. min/max on the card
// are just the default for members that don't state their own.
function sliderSpec(entry) {
  const dLo = clampPct(numOr(entry.min, SLIDER_DEFAULTS.min));
  const dHi = clampPct(numOr(entry.max, SLIDER_DEFAULTS.max));
  return {
    capability:
      typeof entry.capability === 'string' && entry.capability
        ? entry.capability
        : SLIDER_DEFAULTS.capability,
    step: Math.min(50, Math.max(1, numOr(entry.step, SLIDER_DEFAULTS.step))),
    invert: typeof entry.invert === 'boolean' ? entry.invert : SLIDER_DEFAULTS.invert,
    members: sliderMembers(entry).map((m) => {
      const lo = clampPct(numOr(m.rawMin, Math.min(dLo, dHi)));
      const hi = clampPct(numOr(m.rawMax, Math.max(dLo, dHi)));
      return { id: m.id, name: m.name, min: Math.min(lo, hi), max: Math.max(lo, hi) };
    }),
  };
}

// Slider % -> that device's own % down.
function toDevicePct(pct, member) {
  const p = clampPct(pct) / 100;
  return Math.round((member.min + p * (member.max - member.min)) * 10) / 10;
}
// That device's own % down -> slider %.
function fromDevicePct(devicePct, member) {
  if (typeof devicePct !== 'number' || !Number.isFinite(devicePct)) return null;
  const span = member.max - member.min;
  if (span <= 0) return devicePct >= member.max ? 100 : 0;
  return Math.round(clampPct(((devicePct - member.min) / span) * 100) * 10) / 10;
}

// Every slider in the current config, keyed as "slider:<index>". Both /api/state
// and /api/set derive from this, so a device can only be written if it is listed
// under a slider card here.
function sliderCards(config) {
  return normalizeEntities(config)
    .filter((e) => e.size === 'slider')
    .map((entry, i) => ({ key: `slider:${i}`, entry, spec: sliderSpec(entry) }));
}

function buildSliderEntity(card, summarise) {
  const { key, entry, spec } = card;
  const members = spec.members.map((m) => {
    const summary = summarise(m.id);
    if (!summary) {
      return { deviceId: m.id, label: m.name || m.id, name: m.name || m.id,
               missing: true, available: false, position: null, devicePosition: null,
               min: m.min, max: m.max };
    }
    const cap = summary.capabilities[spec.capability];
    const devicePosition = cap ? rawToPct(cap.value, spec.invert) : null;
    return {
      deviceId: m.id,
      // `label` is the config's own name for the device (falling back to what
      // Homey calls it); `name` is always Homey's.
      label: m.name || summary.name,
      name: summary.name,
      zoneName: summary.zoneName,
      missing: false,
      available: summary.available !== false,
      setable: cap ? cap.setable !== false : false,
      hasCapability: !!cap,
      // `position` is on the slider's 0-100 scale; `devicePosition` is the
      // device's own % down, which for a limited screen tops out below 100.
      position: fromDevicePct(devicePosition, m),
      devicePosition,
      raw: cap ? cap.value : null,
      min: m.min,
      max: m.max,
    };
  });

  // "Usable" is the same test the frontend uses for its per-member warning text,
  // so the status dot and the note underneath it can never disagree.
  const usable = members.filter(
    (m) => !m.missing && m.available && m.hasCapability !== false,
  ).length;

  const known = members.map((m) => m.position).filter((p) => typeof p === 'number');
  const position = known.length
    ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10
    : null;
  const spread = known.length > 1 ? Math.max(...known) - Math.min(...known) : 0;

  return {
    key,
    size: 'slider',
    label: entry.label || members[0]?.label || 'Slider',
    capability: spec.capability,
    // The slider is always the full 0-100 %; per-device travel lives on members.
    min: 0,
    max: 100,
    step: spec.step,
    invert: spec.invert,
    position,
    mixed: spread > Math.max(spec.step, 2),
    missing: members.every((m) => m.missing),
    // Traffic light: green when every member is usable, amber when only some
    // are, red when none are. `available: false` also greys the whole card, so
    // it must stay reserved for the all-dead case.
    available: usable > 0,
    partial: usable > 0 && usable < members.length,
    hidden: false,
    members,
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Discovery: every device with all its capabilities (for picking IDs).
app.get('/api/discover', async (req, res) => {
  try {
    const { devices, zones } = await getHomeyData();
    const list = Object.values(devices)
      .map((d) => summariseDevice(d, zones))
      .sort((a, b) =>
        (a.zoneName + a.name).localeCompare(b.zoneName + b.name, undefined, { sensitivity: 'base' }),
      );
    res.json({ devices: list });
  } catch (err) {
    res.status(502).json({ error: String(err?.message || err) });
  }
});

// The configured dashboard state: only the selected devices/capabilities.
app.get('/api/state', async (req, res) => {
  const { config, error: configError, stale } = loadConfig();
  const entries = normalizeEntities(config);
  if (!entries.length) {
    // configError distinguishes "config.json is broken" from "no config yet".
    return res.json({ configured: false, configError, entities: [] });
  }

  // When ?showHidden=1, entities that would be hidden by showIf are returned
  // anyway, each flagged with `hidden: true` so the UI can reveal/dim them.
  const showHidden = req.query.showHidden === '1' || req.query.showHidden === 'true';

  try {
    const { devices, zones } = await getHomeyData();
    const summarise = deviceSummariser(devices, zones);

    // Sliders are built separately: they span several devices and are never
    // hidden by showIf (a control that disappears is not a control). Both this
    // list and /api/set walk normalizeEntities in the same order, so the nth
    // slider entry here is the nth card there — that's what "slider:<n>" means.
    const cards = sliderCards(config);
    let sliderIdx = 0;

    const entities = entries
      .map((entry, i) => {
        if (entry.size === 'slider') {
          const card = cards[sliderIdx++];
          if (!card || !card.spec.members.length) return null;
          return buildSliderEntity(card, summarise);
        }
        // `key` identifies the card across polls. It comes from the entry's
        // position in config.json, not from its position in the response, so it
        // stays put when a showIf card appears or disappears.
        const key = `card:${i}`;
        const summary = summarise(entry.deviceId);
        if (!summary) {
          return {
            key,
            deviceId: entry.deviceId,
            label: entry.label || entry.deviceId,
            missing: true,
            hidden: false,
            capabilities: [],
          };
        }
        const wanted =
          Array.isArray(entry.capabilities) && entry.capabilities.length
            ? entry.capabilities
            : Object.keys(summary.capabilities);
        const capabilities = wanted
          .map((capId) => summary.capabilities[capId])
          .filter(Boolean);

        // Rule: only show when value(s) match the comparison, e.g. "<20",
        // "==false", or "!=empty". When showHidden is set we keep it but flag it.
        const hidden = !!(entry.showIf && !passesShowIf(entry.showIf, capabilities));
        if (hidden && !showHidden) return null;

        return {
          key,
          deviceId: entry.deviceId,
          label: entry.label || summary.name,
          name: summary.name,
          zoneName: summary.zoneName,
          class: summary.class,
          available: summary.available,
          missing: false,
          hidden,
          size: SIZES.includes(entry.size) ? entry.size : 'small',
          capabilities,
        };
      })
      .filter(Boolean);

    res.json({
      configured: true,
      title: config.title || 'Home Dashboard',
      updatedAt: new Date().toISOString(),
      // Set when these cards come from a cached config because the file itself
      // can no longer be read — the dashboard works, but may be out of date.
      configWarning: stale ? configError : null,
      entities,
    });
  } catch (err) {
    res.status(502).json({ error: String(err?.message || err) });
  }
});

// The one write endpoint. A device can only be written if it is listed under a
// slider card in config.json, and only on that card's capability — the request
// carries a card key, never a device id or capability name.
app.post('/api/set', async (req, res) => {
  const { key, position } = req.body || {};

  if (typeof key !== 'string' || !/^slider:\d+$/.test(key)) {
    return res.status(400).json({ error: 'Bad or missing card key.' });
  }
  if (typeof position !== 'number' || !Number.isFinite(position)) {
    return res.status(400).json({ error: 'position must be a number (0-100 % down).' });
  }

  // A stale/unreadable file still yields the last good config, and moving a
  // screen matters more than the file being current — so only refuse when there
  // is no config at all.
  const { config, error: configError } = loadConfig();
  if (!config) {
    return res.status(500).json({ error: configError || 'No config.' });
  }
  const card = sliderCards(config).find((c) => c.key === key);
  if (!card || !card.spec.members.length) {
    return res.status(404).json({ error: `No slider card ${key} in config.` });
  }
  const { spec } = card;

  try {
    // getHomeyData() connects on its own; take the same client it used.
    const [{ devices }, homey] = await Promise.all([getHomeyData(), connect()]);

    const results = await Promise.all(
      spec.members.map(async (member) => {
        const target = Math.round(clampPct(position) * 10) / 10;
        const devicePct = toDevicePct(target, member);
        const device = devices[member.id];
        // Report failures under the name from config.json when there is one —
        // "Utestue zip sør" is more use on screen than a uuid.
        const name = member.name || device?.name || member.id;
        if (!device) return { deviceId: member.id, name, ok: false, error: 'Device not found on Homey.' };

        const cap = (device.capabilitiesObj || {})[spec.capability];
        if (!cap) {
          return { deviceId: member.id, name, ok: false, error: `No ${spec.capability} capability.` };
        }
        if (cap.setable === false) {
          return { deviceId: member.id, name, ok: false, error: `${spec.capability} is not setable.` };
        }

        try {
          await homey.devices.setCapabilityValue({
            deviceId: member.id,
            capabilityId: spec.capability,
            value: pctToRaw(devicePct, spec.invert),
          });
          return { deviceId: member.id, name, ok: true, position: target, devicePosition: devicePct };
        } catch (err) {
          return { deviceId: member.id, name, ok: false, error: String(err?.message || err) };
        }
      }),
    );

    // A write makes the cached read stale immediately; drop it so the next poll
    // shows the screens actually moving instead of the pre-command position.
    cache = { ts: 0, data: null };

    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    if (!ok.length) {
      return res.status(502).json({ key, ok: false, error: failed[0]?.error || 'All devices failed.', results });
    }
    res.json({
      key,
      ok: true,
      position: Math.round(clampPct(position) * 10) / 10,
      partial: failed.length > 0,
      results,
    });
  } catch (err) {
    res.status(502).json({ key, ok: false, error: String(err?.message || err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Homey dashboard listening on http://0.0.0.0:${PORT}`);
  console.log(`Discovery page: http://localhost:${PORT}/discover.html`);
});
