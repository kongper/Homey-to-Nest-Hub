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
const SIZES = ['big', 'small', 'list', 'weather', 'slider', 'thermostat', 'light'];

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
      // Numeric capabilities carry their own limits; a thermostat dial is drawn
      // from these unless config.json narrows them.
      min: c.min ?? null,
      max: c.max ?? null,
      step: c.step ?? null,
      lastUpdated: c.lastUpdated ?? null,
    };
  }
  return {
    id: device.id,
    name: device.name,
    class: device.class ?? null,
    // Homey keeps `available: true` on a Zigbee device it has lost contact
    // with and only sets this. Without it a card happily shows readings that
    // stopped arriving months ago.
    warning: device.warningMessage || null,
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
function normalizeEntities(page) {
  const raw = page && page.entities;
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
// Pages
// ---------------------------------------------------------------------------
// The root page is the top-level `entities`, as it always was. Extra pages live
// under `pages`, each with its own `entities` (plus optional `title`/`label`),
// and are served from this same HTML at /<name> -- one screen per room, one
// config file, one set of card levels.
//
// Everything downstream takes a *page* rather than the config, so a card key
// like "slider:0" is only ever resolved against the page it belongs to: the
// write whitelist stays exactly as narrow as it was.
const ROOT_PAGE = '';

function pageEntries(config) {
  const pages = config && config.pages;
  return pages && typeof pages === 'object' && !Array.isArray(pages) ? pages : {};
}

function pageConfig(config, name) {
  if (!config) return null;
  if (!name || name === ROOT_PAGE) {
    return {
      name: ROOT_PAGE,
      path: '/',
      title: config.title || 'Home Dashboard',
      label: config.label || 'Hjem',
      entities: config.entities,
    };
  }
  const p = pageEntries(config)[name];
  if (!p || typeof p !== 'object') return null;
  return {
    name,
    path: '/' + name,
    title: p.title || name,
    label: p.label || p.title || name,
    entities: p.entities,
  };
}

// What the header renders its links from.
function pageList(config) {
  return [pageConfig(config, ROOT_PAGE)]
    .concat(Object.keys(pageEntries(config)).map((n) => pageConfig(config, n)))
    .filter(Boolean)
    .map((p) => ({ name: p.name, path: p.path, label: p.label }));
}

// summariseDevice walks a device's whole capability list, and several config
// entries usually point at the same device (one thermometer shown as a big card
// and again as a battery row). Memoise for the life of one request. Returns null
// when the device isn't on Homey.
// A stale card is worse than an empty one: it invites you to act on a value
// that stopped being true. Anything with a warning says so on screen.
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
function sliderCards(page) {
  return normalizeEntities(page)
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
      warning: summary.warning,
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

  const warned = members.filter((m) => m.warning);
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
    warning: warned.length ? warned[0].warning : null,
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
// Thermostats (writable: an on/off switch and a target temperature)
// ---------------------------------------------------------------------------
// Like sliders these are never hidden by showIf -- a control that disappears is
// not a control -- and the write path is whitelisted by the card rather than by
// the request: only the two capabilities named here, on that one device.
const THERMO_DEFAULTS = {
  capability: 'target_temperature',
  switchCapability: 'onoff',
  min: 5,
  max: 30,
  step: 0.5,
};

function thermoSpec(entry) {
  const str = (v, fallback) => (typeof v === 'string' && v.trim() ? v : fallback);
  return {
    deviceId: typeof entry.deviceId === 'string' ? entry.deviceId : '',
    capability: str(entry.capability, THERMO_DEFAULTS.capability),
    switchCapability: str(entry.switchCapability, THERMO_DEFAULTS.switchCapability),
    // null means "whatever the device says it accepts".
    min: numOr(entry.min, null),
    max: numOr(entry.max, null),
    step: numOr(entry.step, null),
  };
}

// The dial's range: the config's if it states one, else the capability's own,
// else a sane room-heating range. A heater that accepts 45 degrees is not a
// useful dial on a wall, so narrowing it in config.json is expected.
function thermoRange(spec, cap) {
  const lo = numOr(spec.min, numOr(cap && cap.min, THERMO_DEFAULTS.min));
  let hi = numOr(spec.max, numOr(cap && cap.max, THERMO_DEFAULTS.max));
  if (hi <= lo) hi = lo + 1;
  const step = Math.min(
    10,
    Math.max(0.1, numOr(spec.step, numOr(cap && cap.step, THERMO_DEFAULTS.step))),
  );
  return { min: lo, max: hi, step };
}

// Every thermostat in the current config, keyed "thermo:<index>". Both
// /api/state and /api/set derive from this, in the same order.
function thermoCards(page) {
  return normalizeEntities(page)
    .filter((e) => e.size === 'thermostat')
    .map((entry, i) => ({ key: `thermo:${i}`, entry, spec: thermoSpec(entry) }));
}

function buildThermoEntity(card, summarise) {
  const { key, entry, spec } = card;
  const summary = summarise(spec.deviceId);
  const base = {
    key,
    size: 'thermostat',
    deviceId: spec.deviceId,
    hidden: false,
    capability: spec.capability,
    switchCapability: spec.switchCapability,
  };
  if (!summary) {
    return {
      ...base,
      label: entry.label || spec.deviceId,
      missing: true,
      available: false,
      partial: false,
      onoff: null,
      onoffSetable: false,
      target: null,
      targetSetable: false,
      units: '\u00b0C',
      ...thermoRange(spec, null),
    };
  }
  const tCap = summary.capabilities[spec.capability];
  const sCap = summary.capabilities[spec.switchCapability];
  // Same rule as the slider dot: `available: false` greys out the whole card,
  // so it stays reserved for "nothing here works"; one missing half is amber.
  const usable = (tCap ? 1 : 0) + (sCap ? 1 : 0);
  return {
    ...base,
    label: entry.label || summary.name,
    name: summary.name,
    zoneName: summary.zoneName,
    missing: false,
    available: summary.available !== false && usable > 0,
    partial: summary.available !== false && usable === 1,
    warning: summary.warning,
    onoff: typeof sCap?.value === 'boolean' ? sCap.value : null,
    onoffSetable: !!sCap && sCap.setable !== false,
    target: typeof tCap?.value === 'number' ? tCap.value : null,
    targetSetable: !!tCap && tCap.setable !== false,
    units: (tCap && tCap.units) || '\u00b0C',
    ...thermoRange(spec, tCap),
  };
}

// ---------------------------------------------------------------------------
// Lights (writable: one or more switches, plus an optional dimmer)
// ---------------------------------------------------------------------------
// `switchCapability` may be a list: a two-gang socket wired to one lamp is one
// switch on screen. A device with no dim capability simply renders as a plain
// switch -- that is not an error worth a warning light.
const LIGHT_DEFAULTS = {
  switchCapability: 'onoff',
  capability: 'dim',
  step: 5,
};

function lightSpec(entry) {
  // Two keys, two behaviours, no boolean flag between them:
  //   switchCapability: ["switch_1","switch_2"]  -> one switch driving both
  //   switches: [{capability,name}, ...]         -> a named row per channel
  // A two-channel device is one lamp or two, and only the config knows which.
  const channels = (Array.isArray(entry.switches) ? entry.switches : [])
    .map((c) => (typeof c === 'string' ? { capability: c } : c))
    .filter((c) => c && typeof c.capability === 'string' && c.capability.trim())
    .map((c, i) => ({
      capability: c.capability.trim(),
      name: (typeof c.name === 'string' && c.name.trim()) || `Kanal ${i + 1}`,
      // Some apps expose no capability listener but do publish flow action
      // cards. Name them here and the switch runs the card instead of writing
      // the capability; the capability is still what the card *reads*.
      onAction: typeof c.onAction === 'string' ? c.onAction.trim() : null,
      offAction: typeof c.offAction === 'string' ? c.offAction.trim() : null,
    }));
  const raw = entry.switchCapability ?? LIGHT_DEFAULTS.switchCapability;
  const switches = (Array.isArray(raw) ? raw : [raw])
    .filter((c) => typeof c === 'string' && c.trim())
    .map((c) => c.trim());
  return {
    deviceId: typeof entry.deviceId === 'string' ? entry.deviceId : '',
    channels,
    switchCapabilities: channels.length
      ? channels.map((c) => c.capability)
      : switches.length ? switches : [LIGHT_DEFAULTS.switchCapability],
    // Some apps report a capability as setable that they never registered a
    // listener for, so writing it always fails. "readonly": true says so up
    // front and the card shows the state instead of a control that can't work.
    readonly: entry.readonly === true,
    // The same escape hatch for a light with no channel rows.
    onAction: typeof entry.onAction === 'string' ? entry.onAction.trim() : null,
    offAction: typeof entry.offAction === 'string' ? entry.offAction.trim() : null,
    // "dim": false makes a dimmable lamp behave as a plain switch.
    capability:
      entry.dim === false
        ? null
        : typeof entry.capability === 'string' && entry.capability.trim()
          ? entry.capability.trim()
          : LIGHT_DEFAULTS.capability,
    step: Math.min(50, Math.max(1, numOr(entry.step, LIGHT_DEFAULTS.step))),
  };
}

function lightCards(page) {
  return normalizeEntities(page)
    .filter((e) => e.size === 'light')
    .map((entry, i) => ({ key: `light:${i}`, entry, spec: lightSpec(entry) }));
}

function buildLightEntity(card, summarise) {
  const { key, entry, spec } = card;
  const summary = summarise(spec.deviceId);
  const base = {
    key,
    size: 'light',
    deviceId: spec.deviceId,
    hidden: false,
    capability: spec.capability,
    switchCapabilities: spec.switchCapabilities,
    // The dim track is always a plain 0-100 %.
    min: 0,
    max: 100,
    step: spec.step,
  };
  if (!summary) {
    return {
      ...base,
      label: entry.label || spec.deviceId,
      missing: true,
      available: false,
      partial: false,
      mixed: false,
      channels: [],
      onoff: null,
      onoffSetable: false,
      hasDim: false,
      level: null,
      levelSetable: false,
    };
  }
  const sCaps = spec.switchCapabilities.map((id) => summary.capabilities[id]).filter(Boolean);
  const vals = sCaps.map((c) => c.value).filter((v) => typeof v === 'boolean');
  const dCap = spec.capability ? summary.capabilities[spec.capability] : null;
  return {
    ...base,
    label: entry.label || summary.name,
    name: summary.name,
    zoneName: summary.zoneName,
    missing: false,
    // The switch is what makes this card a card; a missing dimmer just means
    // there is no track to draw.
    available: summary.available !== false && sCaps.length > 0,
    partial:
      summary.available !== false &&
      sCaps.length > 0 &&
      sCaps.length < spec.switchCapabilities.length,
    // One row per channel when the config named them. Each carries its own
    // state, so a two-gang device can be two switches in one card.
    channels: spec.channels.map((c) => {
      const cap = summary.capabilities[c.capability];
      const viaFlow = !!(c.onAction && c.offAction);
      return {
        capability: c.capability,
        name: c.name,
        missing: !cap,
        viaFlow,
        onoff: typeof cap?.value === 'boolean' ? cap.value : null,
        setable: !spec.readonly && (viaFlow || (!!cap && cap.setable !== false)),
      };
    }),
    // On means every gang is on; when they disagree the card says so and a tap
    // turns them all on.
    onoff: vals.length ? vals.every(Boolean) : null,
    mixed: vals.length > 1 && vals.some(Boolean) && !vals.every(Boolean),
    warning: summary.warning,
    viaFlow: !!(spec.onAction && spec.offAction),
    onoffSetable:
      !spec.readonly &&
      ((spec.onAction && spec.offAction) ||
        (sCaps.length === spec.switchCapabilities.length &&
          sCaps.every((c) => c.setable !== false))),
    hasDim: !!dCap,
    // Homey's dim is 0..1; the card is a percentage.
    level: dCap && typeof dCap.value === 'number'
      ? Math.round(clampPct(dCap.value * 100) * 10) / 10
      : null,
    levelSetable: !!dCap && dCap.setable !== false,
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
  // No ?page= is the root dashboard, exactly as before.
  const wanted = typeof req.query.page === 'string' ? req.query.page : ROOT_PAGE;
  const page = pageConfig(config, wanted);
  const pages = pageList(config);
  if (!page) {
    return res.json({ configured: false, configError, pages, page: wanted, entities: [],
                      configWarning: `No page "${wanted}" in config.` });
  }
  const entries = normalizeEntities(page);
  if (!entries.length) {
    // configError distinguishes "config.json is broken" from "no config yet".
    return res.json({ configured: false, configError, pages, page: page.name, entities: [] });
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
    const cards = sliderCards(page);
    let sliderIdx = 0;
    const thermos = thermoCards(page);
    let thermoIdx = 0;
    const lights = lightCards(page);
    let lightIdx = 0;

    const entities = entries
      .map((entry, i) => {
        if (entry.size === 'slider') {
          const card = cards[sliderIdx++];
          if (!card || !card.spec.members.length) return null;
          return buildSliderEntity(card, summarise);
        }
        if (entry.size === 'thermostat') {
          const card = thermos[thermoIdx++];
          if (!card || !card.spec.deviceId) return null;
          return buildThermoEntity(card, summarise);
        }
        if (entry.size === 'light') {
          const card = lights[lightIdx++];
          if (!card || !card.spec.deviceId) return null;
          return buildLightEntity(card, summarise);
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
          warning: summary.warning,
          missing: false,
          hidden,
          size: SIZES.includes(entry.size) ? entry.size : 'small',
          capabilities,
        };
      })
      .filter(Boolean);

    res.json({
      configured: true,
      title: page.title,
      page: page.name,
      pages,
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
  const key = (req.body || {}).key;
  if (typeof key === 'string' && /^thermo:\d+$/.test(key)) return setThermostat(req, res, key);
  if (typeof key === 'string' && /^light:\d+$/.test(key)) return setLight(req, res, key);
  return setSliderPosition(req, res, key);
});

// Which page's card list a write is resolved against. A card key means nothing
// on its own -- "slider:0" is a different device on every page -- so the page
// comes with the request and the whitelist is that page's config, nothing wider.
function writeTarget(req, res) {
  const { config, error: configError } = loadConfig();
  // A stale or unreadable file still yields the last good config, and moving a
  // screen matters more than the file being current -- so only refuse when
  // there is no config at all.
  if (!config) {
    res.status(500).json({ error: configError || 'No config.' });
    return null;
  }
  const name = typeof (req.body || {}).page === 'string' ? req.body.page : ROOT_PAGE;
  const page = pageConfig(config, name);
  if (!page) {
    res.status(404).json({ error: `No page "${name}" in config.` });
    return null;
  }
  return page;
}

// Run one of a device's own flow action cards. The card id is
// "homey:device:<deviceId>:<card>"; `runFlowCardAction` derives the uri from it.
// Note this succeeds even when the device is unreachable — Homey accepts the
// card and the command goes nowhere, which is why the card also shows warnings.
async function runDeviceAction(deviceId, card) {
  const homey = await connect();
  await homey.flow.runFlowCardAction({ id: `homey:device:${deviceId}:${card}`, args: {} });
  cache = { ts: 0, data: null };
}

// Send a set of already-resolved capability writes to one device. Shared by the
// light and thermostat cards, which are both "a switch plus a value". Responds
// itself and returns null when nothing could be written.
async function applyWrites(res, key, deviceId, name, writes) {
  const [{ devices }, homey] = await Promise.all([getHomeyData(), connect()]);
  const device = devices[deviceId];
  if (!device) {
    res.status(404).json({ key, ok: false, error: 'Device not found on Homey.' });
    return null;
  }
  const capsObj = device.capabilitiesObj || {};
  const results = await Promise.all(
    writes.map(async (w) => {
      const cap = capsObj[w.capabilityId];
      if (!cap) return { ...w, name, ok: false, error: `No ${w.capabilityId} capability.` };
      if (cap.setable === false) {
        return { ...w, name, ok: false, error: `${w.capabilityId} is not setable.` };
      }
      try {
        await homey.devices.setCapabilityValue({
          deviceId,
          capabilityId: w.capabilityId,
          value: w.value,
        });
        return { ...w, name, ok: true };
      } catch (err) {
        return { ...w, name, ok: false, error: String(err?.message || err) };
      }
    }),
  );

  // A write makes the cached read stale immediately.
  cache = { ts: 0, data: null };

  const failed = results.filter((r) => !r.ok);
  if (failed.length === results.length) {
    res.status(502).json({ key, ok: false, error: failed[0]?.error || 'All writes failed.', results });
    return null;
  }
  return { results, failed };
}

// A slider write: a card key and a 0-100 % position, applied to every member.
async function setSliderPosition(req, res, key) {
  const { position } = req.body || {};

  if (typeof key !== 'string' || !/^slider:\d+$/.test(key)) {
    return res.status(400).json({ error: 'Bad or missing card key.' });
  }
  if (typeof position !== 'number' || !Number.isFinite(position)) {
    return res.status(400).json({ error: 'position must be a number (0-100 % down).' });
  }

  const page = writeTarget(req, res);
  if (!page) return;
  const card = sliderCards(page).find((c) => c.key === key);
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
}

// A thermostat write: `onoff` (boolean), `temperature` (number) or both. Only
// the capabilities the card names are written, and only on that card's device.
async function setThermostat(req, res, key) {
  const { onoff, temperature } = req.body || {};
  const hasOnoff = typeof onoff === 'boolean';
  const hasTemp = typeof temperature === 'number' && Number.isFinite(temperature);
  if (!hasOnoff && !hasTemp) {
    return res.status(400).json({ error: 'Send onoff (boolean) and/or temperature (number).' });
  }

  const page = writeTarget(req, res);
  if (!page) return;
  const card = thermoCards(page).find((c) => c.key === key);
  if (!card || !card.spec.deviceId) {
    return res.status(404).json({ error: `No thermostat card ${key} in config.` });
  }
  const { spec } = card;

  try {
    const { devices } = await getHomeyData();
    const device = devices[spec.deviceId];
    // Report failures under the name from config.json when there is one.
    const name = card.entry.label || device?.name || spec.deviceId;

    const writes = [];
    if (hasOnoff) writes.push({ capabilityId: spec.switchCapability, value: onoff });
    if (hasTemp) {
      // Clamp to the same range the dial draws, so a stale page cannot send a
      // temperature the card never offered.
      const range = thermoRange(spec, (device?.capabilitiesObj || {})[spec.capability]);
      const v = Math.min(range.max, Math.max(range.min, temperature));
      writes.push({ capabilityId: spec.capability, value: Math.round(v * 10) / 10 });
    }

    const out = await applyWrites(res, key, spec.deviceId, name, writes);
    if (!out) return;
    const tempWrite = out.results.find((r) => r.capabilityId === spec.capability && r.ok);
    res.json({
      key,
      ok: true,
      partial: out.failed.length > 0,
      onoff: hasOnoff ? onoff : null,
      temperature: tempWrite ? tempWrite.value : null,
      results: out.results,
    });
  } catch (err) {
    res.status(502).json({ key, ok: false, error: String(err?.message || err) });
  }
}

// A light write: `onoff` (applied to every gang the card lists) and/or `level`
// (0-100 %, written to the dim capability as Homey's 0..1).
async function setLight(req, res, key) {
  const { onoff, level } = req.body || {};
  const hasOnoff = typeof onoff === 'boolean';
  const hasLevel = typeof level === 'number' && Number.isFinite(level);
  if (!hasOnoff && !hasLevel) {
    return res.status(400).json({ error: 'Send onoff (boolean) and/or level (number, 0-100 %).' });
  }

  const page = writeTarget(req, res);
  if (!page) return;
  const card = lightCards(page).find((c) => c.key === key);
  if (!card || !card.spec.deviceId) {
    return res.status(404).json({ error: `No light card ${key} in config.` });
  }
  if (card.spec.readonly) {
    return res.status(403).json({ key, ok: false, error: 'This card is read-only.' });
  }
  const { spec } = card;

  try {
    const { devices } = await getHomeyData();
    const name = card.entry.label || devices[spec.deviceId]?.name || spec.deviceId;

    // `channel` addresses one named row; without it the switch drives them all.
    const chIdx = (req.body || {}).channel;
    const ch = chIdx === undefined || chIdx === null
      ? null
      : (Number.isInteger(chIdx) ? spec.channels[chIdx] : undefined);
    if (ch === undefined) {
      return res.status(404).json({ key, ok: false, error: `No channel ${chIdx} on ${key}.` });
    }

    // A flow-driven switch bypasses the capability entirely.
    const actions = ch ? ch : spec;
    if (hasOnoff && actions.onAction && actions.offAction) {
      const card = onoff ? actions.onAction : actions.offAction;
      try {
        await runDeviceAction(spec.deviceId, card);
      } catch (err) {
        return res.status(502).json({ key, ok: false, error: String(err?.message || err) });
      }
      if (!hasLevel) {
        return res.json({
          key, ok: true, partial: false, onoff, level: null,
          results: [{ card, name, channel: chIdx ?? null, ok: true }],
        });
      }
    }

    const writes = [];
    if (hasOnoff && !(actions.onAction && actions.offAction)) {
      if (ch) writes.push({ capabilityId: ch.capability, value: onoff, channel: chIdx });
      else for (const capabilityId of spec.switchCapabilities) writes.push({ capabilityId, value: onoff });
    }
    if (hasLevel && spec.capability) {
      // The card is a percentage; Homey's dim is 0..1.
      const pct = Math.round(clampPct(level));
      writes.push({ capabilityId: spec.capability, value: pct / 100, level: pct });
    }

    const out = await applyWrites(res, key, spec.deviceId, name, writes);
    if (!out) return;
    const dim = out.results.find((r) => r.capabilityId === spec.capability && r.ok);
    res.json({
      key,
      ok: true,
      partial: out.failed.length > 0,
      onoff: hasOnoff ? onoff : null,
      level: dim ? dim.level : null,
      results: out.results,
    });
  } catch (err) {
    res.status(502).json({ key, ok: false, error: String(err?.message || err) });
  }
}

// Extra pages are served from the very same HTML as the dashboard: the page
// name comes from the URL, its card list from config.json. Registered last, so
// a real file and every /api route always win.
app.get('/:page', (req, res, next) => {
  const { config } = loadConfig();
  if (!config || !Object.prototype.hasOwnProperty.call(pageEntries(config), req.params.page)) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Homey dashboard listening on http://0.0.0.0:${PORT}`);
  console.log(`Discovery page: http://localhost:${PORT}/discover.html`);
  const { config } = loadConfig();
  for (const p of pageList(config).filter((p) => p.name)) {
    console.log(`Page "${p.label}": http://localhost:${PORT}${p.path}`);
  }
});
