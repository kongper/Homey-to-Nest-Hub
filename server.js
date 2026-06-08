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
  if (!m) return true; // unparseable expression -> don't filter
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
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null; // no config yet -> dashboard tells user to set one up
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

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
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
  const config = loadConfig();
  const entries = normalizeEntities(config);
  if (!entries.length) {
    return res.json({ configured: false, entities: [] });
  }

  // When ?showHidden=1, entities that would be hidden by showIf are returned
  // anyway, each flagged with `hidden: true` so the UI can reveal/dim them.
  const showHidden = req.query.showHidden === '1' || req.query.showHidden === 'true';

  try {
    const { devices, zones } = await getHomeyData();
    const entities = entries
      .map((entry) => {
        const device = devices[entry.deviceId];
        if (!device) {
          return {
            deviceId: entry.deviceId,
            label: entry.label || entry.deviceId,
            missing: true,
            hidden: false,
            capabilities: [],
          };
        }
        const summary = summariseDevice(device, zones);
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
          deviceId: device.id,
          label: entry.label || summary.name,
          name: summary.name,
          zoneName: summary.zoneName,
          class: summary.class,
          available: summary.available,
          missing: false,
          hidden,
          size: ['big', 'small', 'list', 'weather'].includes(entry.size) ? entry.size : 'small',
          capabilities,
        };
      })
      .filter(Boolean);

    res.json({
      configured: true,
      title: config.title || 'Home Dashboard',
      updatedAt: new Date().toISOString(),
      entities,
    });
  } catch (err) {
    res.status(502).json({ error: String(err?.message || err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Homey dashboard listening on http://0.0.0.0:${PORT}`);
  console.log(`Discovery page: http://localhost:${PORT}/discover.html`);
});
