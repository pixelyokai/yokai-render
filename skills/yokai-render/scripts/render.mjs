#!/usr/bin/env node
/* yokai-render: frame-perfect video of any web page, rendered instead of recorded.

   Launches headless Chrome on the real GPU, installs a virtual clock before any page script runs
   (requestAnimationFrame, performance.now, Date, setTimeout/setInterval, CSS + Web Animations), then
   steps that clock one frame at a time, screenshots each frame losslessly and pipes it into ffmpeg.
   Time only moves when we say so, so output is a flawless N fps even if the page can't run that fast live.

   Requires: Node 22+, Google Chrome or Chromium, ffmpeg.

   Usage
     node render.mjs <url | file.html> [options]

   Options
     --size WxH          viewport in CSS px                                  (default 1080x1350)
     --scale N           device pixel ratio: frames are W*N x H*N            (default 2)
     --out-scale N       downscale the encode, 0.5 = supersampled            (default 1)
     --fps N             frames per second                                   (default 60)
     --duration S        seconds to render                                   (default 8)
     --warmup S          simulated seconds to run before frame 0             (default 1.5)
     --format F          mp4 | mp4-444 | prores | png                        (default mp4)
     --crf N             x264 quality, lower = better, 0 = lossless          (default 10)
     --transparent       transparent page background (needs prores or png)
     --color-scheme S    emulate prefers-color-scheme: light | dark
     --timezone TZ       emulate a time zone, e.g. America/New_York
     --script FILE       run a walkthrough script on the virtual clock (see SKILL.md)
     --fit               measure first, then grow the viewport height so nothing is cut off
     --pad R             pad the video to aspect ratio R, e.g. 16:9 (no cropping, no stretching)
     --pad-color C       auto (page background) | #rrggbb | transparent      (default auto)
     --out PATH          output file or folder        (default renders/<name>-<timestamp>.<ext>)

   Env: CHROME_PATH, FFMPEG_PATH override binary discovery.
*/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (msg) => { const e = new Error(msg); e.userFacing = true; throw e; };
const USAGE = 'Usage: node render.mjs <url | file.html> [--size 1080x1350] [--duration 8] [--fps 60] [--format mp4|mp4-444|prores|png]\n'
  + '       [--color-scheme dark] [--timezone Area/City] [--script walkthrough.js] [--fit] [--pad 16:9] [--pad-color auto]\n'
  + 'Run with --help for every option.';

// ---------------------------------------------------------------- args
const BOOL = new Set(['transparent', 'fit', 'help']);
const opts = {};
let target;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { if (target) { console.error(`Unexpected argument: ${a}\n${USAGE}`); process.exit(1); } target = a; continue; }
    const name = a.slice(2);
    if (BOOL.has(name)) { opts[name] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) { console.error(`--${name} needs a value.\n${USAGE}`); process.exit(1); }
    opts[name] = value; i++;
  }
}
if (opts.help) { console.log(fs.readFileSync(new URL(import.meta.url)).toString().match(/\/\*([\s\S]*?)\*\//)[1]); process.exit(0); }
if (!target) { console.error(USAGE); process.exit(1); }
if (typeof WebSocket === 'undefined') { console.error('Node 22+ is required (global WebSocket).'); process.exit(1); }

const num = (name, def, { min = -Infinity, int = false } = {}) => {
  const v = opts[name] === undefined ? def : Number(opts[name]);
  if (!Number.isFinite(v) || v < min || (int && !Number.isInteger(v))) { console.error(`--${name} must be a ${int ? 'whole ' : ''}number${min > -Infinity ? ` >= ${min}` : ''} (got "${opts[name]}").`); process.exit(1); }
  return v;
};
const sizeMatch = /^(\d+)x(\d+)$/.exec(opts.size ?? '1080x1350');
if (!sizeMatch) { console.error(`--size must look like 1080x1350 (got "${opts.size}").`); process.exit(1); }
let [VW, VH] = [Number(sizeMatch[1]), Number(sizeMatch[2])];
const SCALE = num('scale', 2, { min: 0.1 });
const OUT_SCALE = num('out-scale', 1, { min: 0.05 });
const FPS = num('fps', 60, { min: 1 });
const DURATION = num('duration', 8, { min: 0.01 });
const WARMUP = num('warmup', 1.5, { min: 0 });
const CRF = num('crf', 10, { min: 0, int: true });
const FORMAT = opts.format ?? 'mp4';
const TRANSPARENT = !!opts.transparent;
const FIT = !!opts.fit;
const COLOR_SCHEME = opts['color-scheme'];
const TIMEZONE = opts.timezone;
const FRAMES = Math.max(1, Math.round(DURATION * FPS));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

const EXT = { mp4: 'mp4', 'mp4-444': 'mp4', prores: 'mov', png: '' }[FORMAT];
if (EXT === undefined) { console.error(`Unknown --format ${FORMAT}. Use mp4, mp4-444, prores or png.`); process.exit(1); }
if (TRANSPARENT && FORMAT.startsWith('mp4')) { console.error('--transparent needs --format prores or png. H.264 has no alpha, so transparent areas would come out black.'); process.exit(1); }
if (COLOR_SCHEME && !['light', 'dark'].includes(COLOR_SCHEME)) { console.error('--color-scheme must be light or dark.'); process.exit(1); }

let PAD = null;
if (opts.pad) {
  const m = /^(\d+(?:\.\d+)?)[:x/](\d+(?:\.\d+)?)$/.exec(opts.pad);
  if (!m) { console.error(`--pad must be a ratio like 16:9 (got "${opts.pad}").`); process.exit(1); }
  PAD = { rw: Number(m[1]), rh: Number(m[2]) };
}
const PAD_COLOR_ARG = (opts['pad-color'] ?? 'auto').toLowerCase();
if (!/^(auto|transparent|#?[0-9a-f]{6})$/.test(PAD_COLOR_ARG)) { console.error('--pad-color must be auto, transparent or #rrggbb.'); process.exit(1); }
if (PAD_COLOR_ARG === 'transparent' && !TRANSPARENT) { console.error('--pad-color transparent needs --transparent (and --format prores or png).'); process.exit(1); }

const SCRIPT = opts.script ? (() => {
  if (!fs.existsSync(opts.script)) { console.error(`--script file not found: ${opts.script}`); process.exit(1); }
  return fs.readFileSync(opts.script, 'utf8');
})() : null;

const isHttp = /^https?:/.test(target);
if (!isHttp && !fs.existsSync(target)) { console.error(`Not a URL and no such file: ${target}`); process.exit(1); }
const url = isHttp ? target : pathToFileURL(path.resolve(target)).href;

const pageName = (isHttp ? new URL(target).pathname.split('/').filter(Boolean).pop() : path.basename(target))?.replace(/\.html?$/, '') || 'page';
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const out = path.resolve(opts.out ?? path.join('renders', FORMAT === 'png' ? `${pageName}-${stamp}` : `${pageName}-${stamp}.${EXT}`));
fs.mkdirSync(FORMAT === 'png' ? out : path.dirname(out), { recursive: true });

// ---------------------------------------------------------------- binaries
const findChrome = () => {
  const local = process.env.LOCALAPPDATA || '';
  return [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(local, 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].find((p) => p && fs.existsSync(p));
};
const findFfmpeg = () => {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(winget)) {
    for (const dir of fs.readdirSync(winget).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
      const base = path.join(winget, dir);
      for (const sub of fs.readdirSync(base)) {
        const exe = path.join(base, sub, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return 'ffmpeg';
};
const CHROME = findChrome();
if (!CHROME) { console.error('Chrome not found. Set CHROME_PATH.'); process.exit(1); }
const GPU = { win32: ['--use-angle=d3d11'], darwin: ['--use-angle=metal'] }[process.platform] || [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the virtual clock, installed before page scripts
const CLOCK = `(() => {
  if (window.__vt) return;
  const epoch = Date.now();
  let now = 0;                                     // virtual ms since page start
  let rafQ = [], rafId = 0;
  const timers = new Map(); let timerId = 0;
  const seen = new WeakMap();                      // animation -> virtual start time
  window.requestAnimationFrame = (cb) => { const id = ++rafId; rafQ.push({ id, cb }); return id; };
  window.cancelAnimationFrame = (id) => { rafQ = rafQ.filter((r) => r.id !== id); };
  performance.now = () => now;
  const OrigDate = Date;
  function VDate(...a) {
    if (!new.target) return new OrigDate(epoch + now).toString();
    return a.length ? new OrigDate(...a) : new OrigDate(epoch + now);
  }
  VDate.prototype = OrigDate.prototype;
  VDate.now = () => epoch + now; VDate.parse = OrigDate.parse; VDate.UTC = OrigDate.UTC;
  window.Date = VDate;
  window.setTimeout = (fn, ms = 0, ...args) => { const id = ++timerId; timers.set(id, { fn, at: now + Math.max(0, +ms || 0), args }); return id; };
  window.setInterval = (fn, ms = 0, ...args) => { const id = ++timerId; const every = Math.max(1, +ms || 1); timers.set(id, { fn, at: now + every, every, args }); return id; };
  window.clearTimeout = window.clearInterval = (id) => timers.delete(id);
  const runTimers = (until) => {
    for (let guard = 0; guard < 10000; guard++) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      const [id, t] = next;
      now = Math.max(now, t.at);
      if (t.every) t.at += t.every; else timers.delete(id);
      try { typeof t.fn === 'function' ? t.fn(...t.args) : (0, eval)(t.fn); } catch (e) { console.error(e); }
    }
  };
  const syncAnimations = () => {
    for (const a of document.getAnimations()) {
      if (!seen.has(a)) seen.set(a, now - (a.currentTime || 0));
      if (a.playState !== 'paused') a.pause();
      a.currentTime = Math.max(0, now - seen.get(a));
    }
  };
  window.__vt = {
    step(ms) {
      const target = now + ms;
      runTimers(target);
      now = target;
      syncAnimations();
      const q = rafQ; rafQ = [];
      for (const r of q) { try { r.cb(now); } catch (e) { console.error(e); } }
      syncAnimations();                             // pick up animations the callbacks just started
      return now;
    },
    get now() { return now; },
  };
})();`;

// ---------------------------------------------------------------- walkthrough helpers for --script
// Every wait is a page setTimeout, so scripts follow the virtual clock exactly.
const HELPERS = `(() => {
  if (window.__render) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const resolve = (t) => {
    if (typeof t !== 'string') return t;
    const el = document.querySelector(t);
    if (!el) throw new Error('render script: nothing matches ' + JSON.stringify(t));
    return el;
  };
  const byText = (text, selector = 'button, a, [role="button"], [role="menuitem"], [role="option"], label') => {
    const el = $$(selector).find((e) => e.textContent && e.textContent.includes(text));
    if (!el) throw new Error('render script: no ' + selector + ' containing ' + JSON.stringify(text));
    return el;
  };
  const waitFor = async (what, timeout = 5000) => {
    for (let t = 0; t <= timeout; t += 50) {
      const v = typeof what === 'function' ? what() : document.querySelector(what);
      if (v) return v;
      await sleep(50);
    }
    throw new Error('render script: timed out waiting for ' + (typeof what === 'string' ? what : 'condition'));
  };

  // A visible pointer, so viewers can follow what the script does.
  let el = null, x = innerWidth * 0.6, y = innerHeight * 0.75;
  const ensure = () => {
    if (el) return el;
    const bg = getComputedStyle(document.body).backgroundColor;
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const g = c.getContext('2d'); g.fillStyle = bg; g.fillRect(0, 0, 1, 1);
    const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
    const dark = a > 0 && (0.2126 * r + 0.7152 * gg + 0.0722 * b) < 128;
    const fill = dark ? '#fafafa' : '#171717', stroke = dark ? '#171717' : '#ffffff';
    el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;opacity:0;'
      + 'transition-property:transform,opacity;transition-timing-function:cubic-bezier(0.77,0,0.175,1);'
      + 'filter:drop-shadow(0 2px 3px rgb(0 0 0 / .3));transform:translate(' + x + 'px,' + y + 'px)';
    el.innerHTML = '<svg width="24" height="26" viewBox="0 0 24 26" fill="none" style="display:block;transform-origin:3px 2px;transition:scale 110ms cubic-bezier(0.23,1,0.32,1)">'
      + '<path d="M3 2.5 20.5 12l-7.6 1.9L9.4 21.6 3 2.5Z" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.append(el);
    return el;
  };
  const place = (nx, ny, ms) => {
    const p = ensure(); x = nx; y = ny;
    p.style.transitionDuration = ms + 'ms, 200ms';
    p.style.opacity = '1';
    p.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  };
  const moveTo = async (target, { ms = 650, dx = 0.5, dy = 0.5 } = {}) => {
    const r = resolve(target).getBoundingClientRect();
    place(r.left + r.width * dx, r.top + r.height * dy, ms);
    await sleep(ms + 40);
  };
  const press = async () => {
    const svg = ensure().firstElementChild;
    svg.style.scale = '0.82'; await sleep(110); svg.style.scale = '1';
  };
  const pointer = {
    moveTo, press,
    place: (nx, ny, ms = 600) => place(nx, ny, ms),
    hide: () => { if (el) el.style.opacity = '0'; },
  };

  const fire = (target, type, Ctor, init) => target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, ...init }));
  // A real-looking click: the full pointer/mouse sequence at the element's centre, then focus.
  const click = async (target, { ms = 650, pointer: show = true } = {}) => {
    const t = resolve(target);
    if (show) { await moveTo(t, { ms }); await press(); }
    const r = t.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1 };
    fire(t, 'pointerdown', PointerEvent, { ...at, pointerType: 'mouse', isPrimary: true });
    fire(t, 'mousedown', MouseEvent, at);
    if (typeof t.focus === 'function') t.focus({ preventScroll: true });
    fire(t, 'pointerup', PointerEvent, { ...at, buttons: 0, pointerType: 'mouse', isPrimary: true });
    fire(t, 'mouseup', MouseEvent, { ...at, buttons: 0 });
    fire(t, 'click', MouseEvent, { ...at, buttons: 0 });
  };
  const caretToEnd = (t) => {
    t.focus({ preventScroll: true });
    if (t.isContentEditable) {
      const range = document.createRange(); range.selectNodeContents(t); range.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    } else if ('selectionStart' in t) {
      try { t.selectionStart = t.selectionEnd = t.value.length; } catch {}
    }
  };
  // Types into the focused field (or 'into'), one character at a time, through real input events.
  const type = async (text, { perChar = 45, into } = {}) => {
    if (into) caretToEnd(resolve(into));
    for (const ch of text) {
      const t = document.activeElement;
      if (!document.execCommand('insertText', false, ch) && t && 'value' in t) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(t), 'value')?.set;
        setter ? setter.call(t, t.value + ch) : (t.value += ch);
        t.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      }
      await sleep(perChar);
    }
  };
  // Keydown + keyup on the focused element. Handlers run; browser defaults (submit, scroll) don't.
  const key = (k, init = {}, target) => {
    const t = target ? resolve(target) : (document.activeElement || document.body);
    fire(t, 'keydown', KeyboardEvent, { key: k, ...init });
    fire(t, 'keyup', KeyboardEvent, { key: k, ...init });
  };

  window.__render = { sleep, $, $$, byText, waitFor, click, type, key, caretToEnd, pointer };
})();`;

// Page background as [r, g, b] (alpha 0 when transparent). Canvas resolves any CSS colour syntax.
const BACKGROUND = `(() => {
  const toRGBA = (c) => { const cv = document.createElement('canvas'); cv.width = cv.height = 1; const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data]; };
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const v = toRGBA(getComputedStyle(el).backgroundColor);
    if (v[3] > 0) return v;
  }
  return [255, 255, 255, 255];
})()`;

// Tallest the document gets, including fixed/absolute overlays sticking out below the fold.
const MEASURE = `(() => {
  const d = document.documentElement, b = document.body;
  let h = Math.max(d.scrollHeight, b ? b.scrollHeight : 0);
  for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [popover], dialog[open]')) {
    const r = el.getBoundingClientRect(); if (r.height) h = Math.max(h, r.bottom + scrollY);
  }
  return Math.ceil(h);
})()`;

// ---------------------------------------------------------------- run
let chrome = null, ffmpeg = null, ws = null, profile = null, wroteOutput = false;
const cleanup = () => {
  try { ffmpeg?.stdin.destroy(); } catch {}
  try { chrome?.kill(); } catch {}
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const pageErrors = [];
const consoleErrors = [];
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  if (!ws || ws.readyState !== 1) return rej(new Error('Chrome connection closed.'));
  const id = ++msgId; pending.set(id, { res, rej, method }); ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const tty = process.stdout.isTTY;
let lastLog = 0;
const progress = (label, done, total, t0) => {
  const rate = done / Math.max(0.001, (Date.now() - t0) / 1000);
  const line = `  ${label} ${done}/${total}  ${rate.toFixed(1)} fps  ~${Math.ceil((total - done) / rate)}s left`;
  if (tty) process.stdout.write(`\r${line}   `);
  else if (Date.now() - lastLog > 5000 || done === total) { console.log(line); lastLog = Date.now(); }
};

async function startChrome() {
  const port = 9500 + Math.floor(Math.random() * 400);
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yokai-render-'));
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    ...GPU, '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', '--allow-file-access-from-files',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--force-color-profile=srgb',
    'about:blank',
  ], { stdio: 'ignore' });
  chrome.on('error', (e) => { console.error(`Chrome failed to start: ${e.message}. Set CHROME_PATH.`); process.exit(1); });
  let targets;
  for (let i = 0; i < 60; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.length) break; } catch {}
    await sleep(250);
  }
  if (!targets?.length) fail('Chrome did not start (no DevTools endpoint).');
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('Could not connect to Chrome.')); });
  ws.onclose = () => { for (const { rej } of pending.values()) rej(new Error('Chrome connection closed.')); pending.clear(); };
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { res, rej, method } = pending.get(d.id); pending.delete(d.id);
      d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result);
    }
    if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
      consoleErrors.push(d.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  if (COLOR_SCHEME) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: COLOR_SCHEME }] });
  if (TIMEZONE) {
    try { await send('Emulation.setTimezoneOverride', { timezoneId: TIMEZONE }); }
    catch { fail(`--timezone ${TIMEZONE} isn't a time zone Chrome knows (use IANA names like America/New_York).`); }
  }
  if (TRANSPARENT) {
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style'); s.textContent = 'html, body { background: transparent !important; }'; document.head.append(s);
    });` });
  }
  await send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK });
  if (SCRIPT) await send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });
}

// Loads (or reloads) the page from a clean slate, runs warmup, and starts the script at video time 0.
async function loadPage(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: SCALE, mobile: false });
  if (isHttp) await send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'all' }).catch(() => {});
  await send('Page.navigate', { url });
  let ready = false;
  for (let i = 0; i < 120 && !(ready = await evaluate('document.readyState === "complete" && !!window.__vt').catch(() => false)); i++) await sleep(250);
  if (!ready) fail('The page never finished loading, or blocked the virtual clock (a Content-Security-Policy can do this). Check the URL in a browser.');
  await evaluate('document.fonts.ready.then(() => true)', true);
  await sleep(1500);                                   // let module imports, shader compiles and image decodes land
  const frameMs = 1000 / FPS;
  for (let i = 0; i < Math.round(WARMUP * FPS); i++) {
    await evaluate(`window.__vt.step(${frameMs})`);
    if (i % 15 === 0) await sleep(20);                 // give async work (decodes, compiles) a real moment
  }
  if (SCRIPT) {
    await evaluate(`(async () => { const { sleep, $, $$, byText, waitFor, click, type, key, caretToEnd, pointer } = window.__render;\n${SCRIPT}\n})()`
      + `.catch((e) => { window.__renderError = (e && e.message) || String(e); })`);
  }
}

async function main() {
  if (isHttp) {
    try { const r = await fetch(url); if (!r.ok) fail(`${url} answered HTTP ${r.status}.`); }
    catch (e) { if (e.userFacing) throw e; fail(`Can't reach ${url} (${e.message}). Is the server running?`); }
  }
  await startChrome();
  const frameMs = 1000 / FPS;
  // Steps the clock one frame; stops the render if the walkthrough script has failed.
  const step = async () => {
    const err = await evaluate(`(window.__vt.step(${frameMs}), window.__renderError || null)`);
    if (err) fail(`Your --script failed, so the video would be wrong: ${err.replace(/^render script: /, '')}`);
  };

  // --fit: run the whole timeline without screenshots (fast), track the tallest the page gets.
  if (FIT) {
    await loadPage(VW, VH);
    let tallest = VH;
    const t0 = Date.now();
    console.log(`Measuring (--fit): ${FRAMES} frames without screenshots`);
    for (let f = 0; f < FRAMES; f++) {
      await step();
      if (f % 3 === 0 || f === FRAMES - 1) tallest = Math.max(tallest, await evaluate(MEASURE));
      if (f % 30 === 0 || f === FRAMES - 1) progress('measure', f + 1, FRAMES, t0);
    }
    if (tty) process.stdout.write('\n');
    const cap = VH * 4;
    if (tallest > cap) { console.warn(`  Page grew to ${tallest}px; capping the viewport at ${cap}px. Something may be growing without limit.`); tallest = cap; }
    if (tallest > VH) { console.log(`  Content reaches ${tallest}px: viewport ${VW}x${VH} -> ${VW}x${tallest}`); VH = tallest; }
    else console.log('  Everything fits in the viewport as given.');
    pageErrors.length = 0; consoleErrors.length = 0;   // the real pass reports its own
  }

  await loadPage(VW, VH);

  // Output geometry: frames -> optional downscale -> optional pad to ratio.
  const scaledW = even(VW * SCALE * OUT_SCALE), scaledH = even(VH * SCALE * OUT_SCALE);
  let finalW = scaledW, finalH = scaledH, padFilter = [];
  if (PAD) {
    const ratio = PAD.rw / PAD.rh;
    if (scaledW / scaledH < ratio) finalW = even(Math.ceil(scaledH * ratio));
    else finalH = even(Math.ceil(scaledW / ratio));
    let color;
    if (PAD_COLOR_ARG === 'transparent' || (PAD_COLOR_ARG === 'auto' && TRANSPARENT)) color = 'black@0';
    else if (PAD_COLOR_ARG === 'auto') {
      const [r, g, b] = await evaluate(BACKGROUND);
      color = '0x' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    } else color = '0x' + PAD_COLOR_ARG.replace('#', '');
    if (finalW !== scaledW || finalH !== scaledH) {
      // Centre the frame; offsets stay even so 4:2:0 chroma lines up.
      const x = Math.floor((finalW - scaledW) / 4) * 2, y = Math.floor((finalH - scaledH) / 4) * 2;
      padFilter = [`pad=${finalW}:${finalH}:${x}:${y}:color=${color}`];
    }
    console.log(`  Padding to ${PAD.rw}:${PAD.rh} with ${color === 'black@0' ? 'transparent' : '#' + color.slice(2)}: ${scaledW}x${scaledH} -> ${finalW}x${finalH}`);
  }
  const filters = [
    ...(OUT_SCALE !== 1 ? [`scale=${scaledW}:${scaledH}:flags=lanczos+accurate_rnd+full_chroma_int`] : []),
    ...padFilter,
  ];

  // Encoder. PNG frames also go through ffmpeg whenever they need scaling or padding.
  const direct = FORMAT === 'png' && filters.length === 0;
  let ffmpegDone = null, ffmpegExit = null;
  if (!direct) {
    const lossless = CRF === 0;
    const enc = {
      // High profile can't do lossless; x264's High 4:4:4 Predictive can, even for 4:2:0.
      mp4: ['-c:v', 'libx264', '-preset', 'slow', '-crf', String(CRF), '-tune', 'animation', '-pix_fmt', 'yuv420p', '-profile:v', lossless ? 'high444' : 'high', '-movflags', '+faststart'],
      'mp4-444': ['-c:v', 'libx264', '-preset', 'slow', '-crf', String(CRF), '-tune', 'animation', '-pix_fmt', 'yuv444p', '-profile:v', 'high444', '-movflags', '+faststart'],
      prores: ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0'],
      png: ['-c:v', 'png', '-pix_fmt', TRANSPARENT ? 'rgba' : 'rgb24', '-start_number', '0'],
    }[FORMAT];
    wroteOutput = true;
    const dest = FORMAT === 'png' ? path.join(out, 'frame-%05d.png') : out;
    ffmpeg = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
      ...(filters.length ? ['-vf', filters.join(',')] : []), ...enc, ...(FORMAT === 'png' ? [] : ['-r', String(FPS)]), dest],
      { stdio: ['pipe', 'inherit', 'inherit'] });
    ffmpegDone = new Promise((res) => {
      ffmpeg.on('error', (e) => { ffmpegExit = { error: `ffmpeg failed to start: ${e.message}. Install ffmpeg or set FFMPEG_PATH.` }; res(); });
      ffmpeg.on('close', (code) => { ffmpegExit ??= { code }; res(); });
    });
    ffmpeg.stdin.on('error', () => {});              // a dead encoder is reported below, not as a crash
  }
  const assertEncoder = () => {
    if (!ffmpegExit) return;
    fail(ffmpegExit.error ?? `ffmpeg stopped early (exit ${ffmpegExit.code}); its message is above. Nothing usable was written.`);
  };

  console.log(`Rendering ${url}\n  ${FRAMES} frames @ ${FPS} fps (${DURATION}s), frames ${VW * SCALE}x${VH * SCALE}, output ${direct ? 'PNG frames' : `${finalW}x${finalH} ${FORMAT}`}`);
  const t0 = Date.now();
  for (let f = 0; f < FRAMES; f++) {
    await step();
    const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: false });
    const buf = Buffer.from(data, 'base64');
    if (direct) fs.writeFileSync(path.join(out, `frame-${String(f).padStart(5, '0')}.png`), buf);
    else {
      assertEncoder();
      if (!ffmpeg.stdin.write(buf)) await Promise.race([new Promise((r) => ffmpeg.stdin.once('drain', r)), ffmpegDone]);
    }
    if (f % 10 === 0 || f === FRAMES - 1) progress('frame', f + 1, FRAMES, t0);
  }
  if (tty) process.stdout.write('\n');
  if (ffmpeg) {
    ffmpeg.stdin.end();
    await ffmpegDone;
    if (ffmpegExit?.error || ffmpegExit?.code !== 0) assertEncoder();
  }
  ws.close();
  if (pageErrors.length) console.warn(`Page errors during render:\n  ${[...new Set(pageErrors)].slice(0, 5).join('\n  ')}`);
  if (consoleErrors.length) console.warn(`Console errors during render:\n  ${[...new Set(consoleErrors)].slice(0, 5).join('\n  ')}`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${out}`);
}

main().then(() => process.exit(0), (e) => {
  console.error(e.userFacing ? e.message : `Render failed: ${e.stack || e.message}`);
  // Don't leave a half-written video behind that looks like a result.
  if (wroteOutput && FORMAT !== 'png') { cleanup(); try { fs.rmSync(out, { force: true }); } catch {} }
  process.exit(1);
});
