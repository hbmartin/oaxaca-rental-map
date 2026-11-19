// Headless browser checks for the rental map's street basemap.
//
//   npm test                       all checks against a local server (about 90 s)
//   npm test -- ready,dark         only the named groups (see GROUPS below)
//   BASE_URL=https://… npm test    against a deployed copy instead of a local server
//   PW_CHANNEL=chrome npm test     use installed Google Chrome instead of Playwright's Chromium
//
// Screenshots land in test-results/. Exits non-zero if any check fails.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-results');
const GROUPS = ['align', 'ready', 'dark', 'libs', 'nowebgl', 'ctorfail', 'boundaries', 'phone', 'slow'];
const ONLY = process.argv[2] ? process.argv[2].split(',') : GROUPS;

// Requests the checks block or delay to simulate failures.
const NET = {
  libs: 'https://unpkg.com/**',
  style: 'https://tiles.openfreemap.org/styles/**',
  tiles: 'https://tiles.openfreemap.org/planet/**',
  slow: 'https://tiles.openfreemap.org/styles/**',
};

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

// Captures the page's Leaflet map, which lives inside the app's closure.
const HOOK = () => {
  let _L;
  Object.defineProperty(window, 'L', { configurable: true, get() { return _L; }, set(v) {
    _L = v;
    if (v && v.Map && !v.__hooked) { v.__hooked = true; v.Map.addInitHook(function () { window.__map = this; }); }
  } });
};

let BASE;
async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 820 }, colorScheme: opts.colorScheme || 'light' });
  await ctx.addInitScript(HOOK);
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  page.errors = []; page.warns = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') page.warns.push(m.text()); });
  if (opts.routes) for (const [pat, fn] of opts.routes) await page.route(pat, fn);
  return { ctx, page };
}

const probe = page => page.evaluate(() => {
  const m = window.__map; let gl = null, layer = null;
  m.eachLayer(l => { if (l.getMaplibreMap) { layer = l; gl = l.getMaplibreMap() || null; } });
  const st = document.getElementById('map-status');
  return {
    ready: document.getElementById('mapwrap').classList.contains('streets-ready'),
    status: st.hidden ? '' : document.getElementById('map-status-text').textContent,
    retry: !document.getElementById('map-retry').hidden,
    retryText: document.getElementById('map-retry').textContent,
    credits: document.querySelector('.leaflet-control-attribution').textContent,
    hasLayer: !!layer, hasGL: !!gl,
    lc: m.getCenter(), lz: m.getZoom(),
    gc: gl && gl.getCenter(), gz: gl && gl.getZoom(),
  };
});
const withGL = (page, fn, arg) => page.evaluate(([src, a]) => {
  let gl; window.__map.eachLayer(l => { if (l.getMaplibreMap) gl = l.getMaplibreMap(); });
  return (0, eval)('(' + src + ')')(gl, a);
}, [fn.toString(), arg]);

// Offset between the GL map centre and the Leaflet centre, in screen pixels at the Leaflet zoom.
function misalignPx(p) {
  const scale = 256 * Math.pow(2, p.lz) / 360;
  const merc = x => Math.log(Math.tan(Math.PI / 4 + x * Math.PI / 360)) * 180 / Math.PI;
  return Math.hypot((p.gc.lng - p.lc.lng) * scale, (merc(p.gc.lat) - merc(p.lc.lat)) * scale);
}
const waitReady = (page, t = 60000) => page.waitForFunction(() => document.getElementById('mapwrap').classList.contains('streets-ready'), null, { timeout: t });
const waitRetry = (page, t = 30000) => page.waitForFunction(() => !document.getElementById('map-retry').hidden, null, { timeout: t });
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });
const url = () => BASE + 'index.html';

const checks = {
  async align(browser) {
    const { ctx, page } = await newPage(browser);
    await page.goto(url());
    await waitReady(page);
    await page.waitForTimeout(500);
    const box = await page.locator('#map').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const out = {};
    await page.mouse.move(cx, cy); await page.mouse.down();
    await page.mouse.move(cx - 160, cy - 90, { steps: 12 }); await page.mouse.up();
    await page.waitForTimeout(400);
    out.drag = misalignPx(await probe(page));
    await shot(page, 'after-drag');
    await page.focus('#map'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(800);
    out.keys = misalignPx(await probe(page));
    await page.click('#fit'); await page.waitForTimeout(1500);
    out.fit = misalignPx(await probe(page));
    await page.click('.leaflet-control-zoom-in'); await page.waitForTimeout(1200);
    out.zoom = misalignPx(await probe(page));
    await page.setViewportSize({ width: 1100, height: 760 }); await page.waitForTimeout(800);
    out.resize = misalignPx(await probe(page));
    const fmt = Object.entries(out).map(([k, v]) => k + '=' + v.toFixed(1) + 'px').join(' ');
    record('panning, zoom and resize keep the streets aligned with the pins', Object.values(out).every(v => v < 2) && !page.errors.length, fmt + (page.errors.length ? ' errors: ' + page.errors.join(' | ') : ''));
    await ctx.close();
  },

  async ready(browser) {
    const { ctx, page } = await newPage(browser);
    const t0 = Date.now();
    await page.goto(url(), { waitUntil: 'domcontentloaded' });
    const rows = await page.locator('#list .row').count();
    await waitReady(page);
    const ready = await probe(page);
    record('ready: listings render before the basemap, credits switch to the street sources', rows > 0 && /CONABIO/.test(ready.credits) && /OpenStreetMap/.test(ready.credits) && !/Natural Earth/.test(ready.credits), `"${ready.credits}" (${Date.now() - t0} ms to ready, ${rows} rows at DOMContentLoaded)`);
    const hidden = await withGL(page, gl => gl.getStyle().layers
      .filter(l => l.type === 'symbol' && gl.getLayoutProperty(l.id, 'visibility') === 'none').map(l => l.id));
    record('water, waterway and airport labels are hidden; others kept', ['waterway_line_label', 'water_name_point_label', 'water_name_line_label', 'airport'].every(id => hidden.includes(id)) && hidden.length === 4, 'hidden: ' + hidden.join(', '));

    // An error after ready must not drop the streets.
    await withGL(page, gl => gl.fire('error', { error: new Error('synthetic tile failure') }));
    await page.route(NET.tiles, r => r.abort());
    await page.evaluate(() => window.__map.setView([17.13, -96.62], 16, { animate: false }));
    await page.waitForTimeout(2500);
    const afterErr = await probe(page);
    record('errors after ready keep the street map', afterErr.ready && afterErr.hasGL && !afterErr.status, `${page.warns.filter(w => /Street basemap/.test(w)).length} warnings, status "${afterErr.status}"`);
    await page.unroute(NET.tiles);

    // WebGL context loss and restore.
    await page.evaluate(() => window.__map.setView([17.0607, -96.7254], 14, { animate: false }));
    await page.waitForTimeout(1500);
    await withGL(page, gl => { const c = gl.getCanvas(); window.__lose = (c.getContext('webgl2') || c.getContext('webgl')).getExtension('WEBGL_lose_context'); window.__lose.loseContext(); });
    await page.waitForTimeout(800);
    const lost = await probe(page);
    record('context loss shows the simplified map with Retry', !lost.ready && /paused/.test(lost.status) && lost.retry && /Natural Earth/.test(lost.credits), `status "${lost.status}"`);
    await page.evaluate(() => window.__lose.restoreContext());
    await waitReady(page, 20000).catch(() => {});
    const restored = await probe(page);
    record('context restore brings the streets back', restored.ready && !restored.status, 'ready=' + restored.ready);

    // Removing the layer right after the adapter schedules its next-frame work.
    await page.evaluate(() => { const m = window.__map; m.fire('resize'); m.eachLayer(l => { if (l.getMaplibreMap) m.removeLayer(l); }); });
    await page.waitForTimeout(500);
    record('removing the layer mid-resize throws nothing', !page.errors.length, page.errors.join(' | '));
    await ctx.close();
  },

  async dark(browser) {
    const { ctx, page } = await newPage(browser, { colorScheme: 'dark' });
    await page.goto(url());
    await waitReady(page);
    await page.evaluate(() => window.__map.setView([17.0640, -96.7230], 14.5, { animate: false }));
    await page.waitForTimeout(1500);
    const ink = await page.evaluate(() => ({
      page: getComputedStyle(document.body).getPropertyValue('--ink').trim(),
      map: getComputedStyle(document.getElementById('mapwrap')).getPropertyValue('--ink').trim(),
      diamond: getComputedStyle(document.querySelector('.lm i')).backgroundColor,
      keyText: getComputedStyle(document.querySelector('#key li')).color,
      leader: getComputedStyle(document.querySelector('.pin .leader line')).stroke,
    }));
    await shot(page, 'dark-ready');
    const dark = 'rgb(23, 32, 27)';
    record('dark mode: the map panel uses the light palette while streets show', ink.page === '#E4EBE4' && ink.map === '#17201B' && ink.diamond === dark && ink.keyText === dark && ink.leader === dark, JSON.stringify(ink));
    await ctx.close();

    const fb = await newPage(browser, { colorScheme: 'dark', routes: [[NET.style, r => r.abort()]] });
    await fb.page.goto(url());
    await waitRetry(fb.page);
    const fbInk = await fb.page.evaluate(() => getComputedStyle(document.getElementById('mapwrap')).getPropertyValue('--ink').trim());
    const p = await probe(fb.page);
    await shot(fb.page, 'dark-fallback');
    record('style blocked: fallback with Retry, dark palette restored', fbInk === '#E4EBE4' && !p.ready && /unavailable/.test(p.status) && p.retry && !p.hasLayer && !/OpenStreetMap/.test(p.credits), `ink ${fbInk}, status "${p.status}", credits "${p.credits}"`);
    await fb.ctx.close();
  },

  async libs(browser) {
    const blocked = { on: true };
    const { ctx, page } = await newPage(browser, { routes: [[NET.libs, r => blocked.on ? r.abort() : r.continue()]] });
    const t0 = Date.now();
    await page.goto(url(), { waitUntil: 'load' });
    const loadMs = Date.now() - t0;
    await waitRetry(page, 15000);
    const p = await probe(page);
    const pins = await page.locator('.pin-host:not([hidden])').count();
    record('map libraries blocked: listings and pins work, fallback with Retry', pins > 0 && /unavailable/.test(p.status) && p.retryText === 'Retry', `${pins} pins, load in ${loadMs} ms, status "${p.status}"`);
    blocked.on = false;
    await page.click('#map-retry');
    await waitReady(page, 60000).catch(() => {});
    const r = await probe(page);
    record('Retry after unblocking loads the streets', r.ready && !r.status, `ready=${r.ready} errors=${page.errors.length}`);
    await ctx.close();
  },

  async nowebgl(browser) {
    const init = () => { const orig = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/.test(t) ? null : orig.call(this, t, ...a); }; };
    const { ctx, page } = await newPage(browser, { init });
    const reqs = []; page.on('request', r => reqs.push(r.url()));
    await page.goto(url()); await page.waitForTimeout(2000);
    const p = await probe(page);
    const libReqs = reqs.filter(u => /maplibre|pmtiles/.test(u)).length;
    record('no WebGL: no MapLibre download, WebGL message, no Retry', !libReqs && /WebGL/.test(p.status) && !p.retry && /Natural Earth/.test(p.credits), `status "${p.status}", library requests ${libReqs}`);
    await ctx.close();
  },

  async ctorfail(browser) {
    // WebGL passes the precheck, then the MapLibre constructor fails to get a context.
    const init = () => { const orig = HTMLCanvasElement.prototype.getContext; let n = 0; HTMLCanvasElement.prototype.getContext = function (t, ...a) { if (/webgl/.test(t) && n++ > 0) return null; return orig.call(this, t, ...a); }; };
    const { ctx, page } = await newPage(browser, { init });
    await page.goto(url());
    await waitRetry(page);
    await page.evaluate(() => window.__map.panBy([120, 60], { animate: false }));
    await page.evaluate(() => window.__map.setZoom(14));
    await page.waitForTimeout(1200);
    const p = await probe(page);
    const leftovers = await page.locator('.leaflet-gl-layer').count();
    record('constructor failure cleans up (no stray container, no errors on pan/zoom)', /unavailable/.test(p.status) && !p.hasLayer && leftovers === 0 && !page.errors.length, `containers ${leftovers}, errors: ${page.errors.join(' | ') || 'none'}`);
    await ctx.close();
  },

  async boundaries(browser) {
    const { ctx, page } = await newPage(browser);
    await page.goto(url());
    await waitReady(page);
    await page.locator('#list .row-btn').first().click();
    await page.waitForTimeout(1200);
    const order = () => page.evaluate(() => {
      const paths = [...document.querySelectorAll('.leaflet-overlay-pane svg path')].map(p => p.getAttribute('class') || '');
      return {
        lastEdge: paths.map(c => /muni-edge/.test(c)).lastIndexOf(true),
        firstOther: paths.findIndex(c => /ring|uncert/.test(c)),
        hasUncert: paths.some(c => /uncert/.test(c)),
        keyHidden: document.getElementById('key-boundary').hidden,
      };
    });
    const before = await order();
    await page.click('#boundaries'); await page.waitForTimeout(200);
    const off = await order();
    await page.click('#boundaries'); await page.waitForTimeout(200);
    const on = await order();
    record('boundaries stay under the rings and uncertainty circle after re-toggling', on.hasUncert && on.lastEdge >= 0 && on.lastEdge < on.firstOther, JSON.stringify(on));
    record('the boundary key entry hides with the boundaries', off.keyHidden === true && on.keyHidden === false && before.keyHidden === false, `off=${off.keyHidden} on=${on.keyHidden}`);
    await ctx.close();
  },

  async phone(browser) {
    const { ctx, page } = await newPage(browser, { viewport: { width: 375, height: 812 } });
    await page.goto(url());
    const check = async label => {
      const g = await page.evaluate(() => {
        const a = document.querySelector('.leaflet-control-attribution');
        const k = document.getElementById('key').getBoundingClientRect();
        return { attrTop: a.getBoundingClientRect().top, keyBottom: k.bottom, credits: a.textContent };
      });
      record(`phone (${label}): the map key sits above the credits`, g.keyBottom <= g.attrTop + 0.5, `key bottom ${g.keyBottom.toFixed(0)} / credits top ${g.attrTop.toFixed(0)}, "${g.credits}"`);
    };
    await page.waitForTimeout(300); await check('loading');
    await waitReady(page); await page.waitForTimeout(500); await check('ready');
    await page.locator('#map').scrollIntoViewIfNeeded();
    await shot(page, 'phone-ready');
    await ctx.close();
  },

  async slow(browser) {
    // Delay a basemap request past the 20 s slow threshold.
    const delay = ms => [NET.slow, async r => { await new Promise(res => setTimeout(res, ms)); await r.continue().catch(() => {}); }];
    const fakeHidden = () => {
      window.__hidden = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__hidden ? 'hidden' : 'visible' });
    };
    const hidden = (async () => {
      const { ctx, page } = await newPage(browser, { init: fakeHidden, routes: [delay(26000)] });
      await page.goto(url());
      await page.waitForTimeout(23000);
      const mid = await probe(page);
      await page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
      await waitReady(page, 30000).catch(() => {});
      const end = await probe(page);
      record('hidden tab: no teardown or slow message after 23 s; streets load once visible', mid.status === 'Loading streets…' && end.ready && !end.status, `at 23 s "${mid.status}", then ready=${end.ready}`);
      await ctx.close();
    })();
    const visible = (async () => {
      const { ctx, page } = await newPage(browser, { routes: [delay(26000)] });
      await page.goto(url());
      await page.waitForTimeout(23000);
      const mid = await probe(page);
      await waitReady(page, 30000).catch(() => {});
      const end = await probe(page);
      record('slow load: message with Retry at 20 s, then the streets swap in', /slow/.test(mid.status) && mid.retry && end.ready && !end.status, `at 23 s "${mid.status}", then ready=${end.ready}`);
      await ctx.close();
    })();
    await Promise.all([hidden, visible]);
  },
};

fs.mkdirSync(OUT, { recursive: true });
let server = null;
if (process.env.BASE_URL) BASE = process.env.BASE_URL.replace(/\/?$/, '/');
else { server = await startServer(ROOT, 0); BASE = `http://127.0.0.1:${server.address().port}/`; }
console.log('Testing ' + BASE);
const browser = await chromium.launch({
  channel: process.env.PW_CHANNEL || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  for (const g of ONLY) {
    if (!checks[g]) { record('unknown check group ' + g, false, 'groups: ' + GROUPS.join(', ')); continue; }
    try { await checks[g](browser); } catch (e) { record(g + ' (harness)', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' ')); }
  }
} finally {
  await browser.close();
  if (server) server.close();
}
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
process.exitCode = failed ? 1 : 0;
