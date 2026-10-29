// Network profiles: a JSON timeline of link settings per direction ("down" = server → viewer, "up" = viewer → server).
// {
//   "name": "...", "description": "...", "loop": false,
//   "defaults": { "both": {...}, "down": {...}, "up": {...} },          // applied before the profile starts and under every step
//   "steps": [ { "label": "8M", "duration": 25, "down": { "rateMbps": 8 } },
//              { "repeat": 3, "steps": [ ... ] },                         // nested blocks are flattened
//              { "label": "cut", "duration": 2, "outage": true } ]      // outage: true = both directions down
// }
// Link keys are those of LINK_DEFAULTS in link.mjs. Each step is defaults + step, never the previous step, so a step
// reads the same wherever it is placed.
import { readFileSync } from 'node:fs';
import { LINK_DEFAULTS, checkLinkConfig } from './link.mjs';

const DIRS = ['down', 'up'];

function flatten(steps, out, where) {
  for (const [i, step] of steps.entries()) {
    const at = `${where}[${i}]`;
    if (step.repeat !== undefined) {
      if (!(step.repeat >= 1) || !Array.isArray(step.steps)) throw new Error(`${at}: repeat needs a count and steps`);
      for (let n = 0; n < step.repeat; n++) flatten(step.steps, out, `${at}.steps`);
      continue;
    }
    if (!(step.duration > 0)) throw new Error(`${at}: duration (seconds) must be > 0`);
    out.push({ ...step, where: at });
  }
  return out;
}

function merge(defaults, step, dir, rateScale, where) {
  const cfg = { ...LINK_DEFAULTS, ...defaults.both, ...defaults[dir], ...step.both, ...step[dir] };
  if (step.outage === true) cfg.outage = true;
  if (cfg.rateMbps !== null && rateScale !== 1) cfg.rateMbps = +(cfg.rateMbps * rateScale).toFixed(4);
  return checkLinkConfig(cfg, `${where}.${dir}`);
}

// timeScale shortens or stretches every step; rateScale moves every rate (e.g. to test the same shape around a
// different quality threshold).
export function loadProfile(source, { timeScale = 1, rateScale = 1 } = {}) {
  const raw = typeof source === 'string' ? JSON.parse(readFileSync(source, 'utf8')) : source;
  const defaults = raw.defaults || {};
  const base = {};
  for (const dir of DIRS) base[dir] = merge(defaults, {}, dir, rateScale, 'defaults');
  let start = 0;
  const steps = flatten(raw.steps || [], [], 'steps').map((step, index) => {
    const duration = step.duration * timeScale;
    // A label often names its length ("cut-10s"); when the time is scaled, say how long the step really is.
    const declared = step.label || `step${index}`;
    const label = timeScale === 1 ? declared : `${declared}[${+duration.toFixed(2)}s]`;
    const out = { index, label, declaredLabel: declared, start: +start.toFixed(3), duration: +duration.toFixed(3) };
    for (const dir of DIRS) out[dir] = merge(defaults, step, dir, rateScale, step.where);
    start += duration;
    return out;
  });
  if (!steps.length) throw new Error('profile has no steps');
  return { name: raw.name || 'profile', description: raw.description || '', loop: !!raw.loop, timeScale, rateScale, base, steps, total: +start.toFixed(3) };
}

// Index of the step active `elapsed` seconds after the start; past the end the last step holds unless the profile loops
// (udp-proxy.mjs does not ask past the end: at profile-end it applies the defaults again).
export function stepAt(profile, elapsed) {
  let t = elapsed;
  if (profile.loop) t = ((t % profile.total) + profile.total) % profile.total;
  for (let i = profile.steps.length - 1; i >= 0; i--) if (t >= profile.steps[i].start) return i;
  return 0;
}

// Compact form of a link config for logs: only what differs from an unimpaired link.
export function brief(cfg) {
  const out = {};
  for (const [key, value] of Object.entries(cfg)) if (value !== LINK_DEFAULTS[key] || key === 'rateMbps') out[key] = value;
  return out;
}
