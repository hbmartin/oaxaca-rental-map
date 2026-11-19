// Deterministic browser regressions for native request stalls and street-map recovery.
// The fixtures use this repository's libraries and assets; no production hooks are needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PMTiles } from 'pmtiles';
import { startServer } from '../scripts/serve.mjs';

const CSS_PATH = '/vendor/maplibre-gl-6.19.0/maplibre-gl.css';
const MAPLIBRE_PATH = '/vendor/maplibre-gl-6.19.0/maplibre-gl.mjs';
const MAPLIBRE_DIR = '/vendor/maplibre-gl-6.19.0/';
const ARCHIVE_PATH = '/basemap/oaxaca.pmtiles';
const TILE_PATH = '/recovery-tiles/';
const PMTILES_PATH = '/vendor/pmtiles-4.5.0/pmtiles.js';
const WAIT = 12000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, message, timeout = WAIT) {
  const end = Date.now() + timeout;
  while (!await test()) {
    if (Date.now() >= end) throw new Error(message);
    await sleep(20);
  }
}
function replaceOnce(source, pattern, replacement) {
  const clone = flags => new RegExp(pattern.source, flags);
  const matches = typeof pattern === 'string' ? source.split(pattern).length - 1 :
    [...source.matchAll(clone(pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'))].length;
  assert.equal(matches, 1, `fixture replacement must match exactly once: ${pattern}`);
  return source.replace(typeof pattern === 'string' ? pattern : clone(pattern.flags), replacement);
}
function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
// Resume a held archive request with the same Range behavior as the ordinary server.
function archiveResponse(root, req, res) {
  if (res.destroyed) return;
  const file = path.join(root, ARCHIVE_PATH);
  const size = fs.statSync(file).size;
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  fs.createReadStream(file, { start, end }).pipe(res);
}
function fixtureStyle(base, source) {
  return {
    version: 8,
    glyphs: 'basemap/fonts/{fontstack}/{range}.pbf',
    sprite: 'basemap/sprites/ofm',
    sources: { fixture: source || { type: 'vector', tiles: [`${base}${TILE_PATH}{z}/{x}/{y}.pbf`], minzoom: 12, maxzoom: 12 } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#edf0e9' } },
      { id: 'water', type: 'fill', source: 'fixture', 'source-layer': 'water', paint: { 'fill-color': '#cadce5' } },
    ],
  };
}

// Only the named application retry callback uses this test clock. Its requested delays and
// production constants are preserved; the driver chooses when to execute a scheduled retry.
const retryClock = () => {
  const set = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
  let next = -1;
  window.__recoveryClock = { scheduled: [], timers: new Map(), idle: [], fire() {
    const entry = [...this.timers.values()].find(t => t.active);
    if (!entry) throw new Error('No tile retry is scheduled');
    entry.active = false;
    entry.fn(...entry.args);
    return entry.delay;
  } };
  window.setTimeout = function (fn, delay, ...args) {
    if (typeof fn !== 'function' || fn.name !== 'retryTiles') return set(fn, delay, ...args);
    const entry = { id: next--, fn, delay, args, active: true };
    __recoveryClock.scheduled.push(delay);
    __recoveryClock.timers.set(entry.id, entry);
    return entry.id;
  };
  window.clearTimeout = function (id) {
    const entry = __recoveryClock.timers.get(id);
    if (entry) entry.active = false;
    else clear(id);
  };
};

export async function runRecovery(browser, { root, record, newPage, probe, withGL, waitReady, waitRetry }) {
  const app = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, CSS_PATH));
  const leaflet = path.join(root, 'node_modules/leaflet/dist/leaflet.js');
  const leafletVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies.leaflet;
  assert.match(leafletVersion, /^\d+\.\d+\.\d+$/, 'Leaflet must be a direct exact dependency pin');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'node_modules/leaflet/package.json'), 'utf8')).version, leafletVersion);
  const leafletURL = `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${leafletVersion}/leaflet.js`;
  assert.equal([...app.matchAll(/<script\s+src="([^"]*leaflet[^"]*)"/g)].map(m => m[1]).join(), leafletURL, 'the page and local fixture must request the same pinned Leaflet');
  // Real committed MVT geometry, prepared before HTTP callbacks so interceptors remain synchronous.
  const archiveBytes = fs.readFileSync(path.join(root, ARCHIVE_PATH));
  const archive = new PMTiles({ getKey: () => 'local-recovery-archive', getBytes: async (offset, length) => ({
    data: archiveBytes.buffer.slice(archiveBytes.byteOffset + offset, archiveBytes.byteOffset + Math.min(offset + length, archiveBytes.length)),
  }) });
  const geometryTiles = new Map();
  for (let x = 945; x <= 950; x++) for (let y = 1849; y <= 1852; y++) {
    const tile = await archive.getZxy(12, x, y);
    assert.ok(tile?.data.byteLength, `the committed archive must contain geometry fixture 12/${x}/${y}`);
    geometryTiles.set(`${TILE_PATH}12/${x}/${y}.pbf`, Buffer.from(tile.data));
  }

  async function run(name, test, report = record) {
    const scope = { cleanup: [], interceptorErrors: [] }, errors = [];
    let detail;
    try { detail = await test(scope); } catch (error) { errors.push(error); }
    finally {
      for (const fn of scope.cleanup.reverse()) {
        try { await fn(); } catch (error) { errors.push(error); }
      }
    }
    errors.push(...scope.interceptorErrors);
    // Interceptor and cleanup errors may arrive after assertions succeed. Record only once
    // every response, browser context and server has been closed for this scenario.
    report('recovery: ' + name, errors.length === 0,
      errors.length ? errors.map(error => String(error.message || error)).join('; ') : detail);
  }
  async function setup(scope, { intercept, html = app, init, style } = {}) {
    const held = new Set(), requests = [];
    let base;
    const server = await startServer(root, 0, '127.0.0.1', (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({ pathname: url.pathname, url: req.url });
      if (url.pathname === '/index.html') { send(res, 200, 'text/html; charset=utf-8', html); return true; }
      if (url.pathname === '/basemap/style.json' && style) { send(res, 200, 'application/json', JSON.stringify(style(base))); return true; }
      return intercept ? intercept(req, res, url, held) : false;
    }, { onInterceptError: error => scope.interceptorErrors.push(error) });
    base = `http://127.0.0.1:${server.address().port}`;
    scope.cleanup.push(async () => {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
    const { ctx, page } = await newPage(browser, { init, routes: [
      [leafletURL, route => route.fulfill({ path: leaflet, contentType: 'text/javascript' })],
      ['https://fonts.googleapis.com/**', route => route.abort()],
      ['https://fonts.gstatic.com/**', route => route.abort()],
    ] });
    scope.cleanup.push(() => ctx.close());
    // Long native stylesheet or module responses must not hold page.goto's load event open.
    await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
    return { page, ctx, base, held, requests };
  }
  const cleanPage = page => assert.deepEqual(page.errors, [], 'the page must not throw JavaScript errors');
  const scriptRequests = fixture => fixture.requests.filter(r => /\.m?js$/.test(r.pathname) && (
    r.pathname === MAPLIBRE_PATH || r.pathname === '/vendor/maplibre-gl-leaflet-0.1.4/leaflet-maplibre-gl.js' ||
    r.pathname === '/vendor/pmtiles-4.5.0/pmtiles.js'
  ));
  async function usableFallback(page) {
    const fallback = await probe(page);
    assert.ok(!fallback.ready && fallback.retry && /Natural Earth/.test(fallback.credits), 'failure must leave the simplified map and Retry available');
    assert.ok(await page.locator('.pin-host:not([hidden])').count(), 'listing pins must remain visible');
    const row = page.locator('#list .row-btn').first();
    await row.click();
    assert.equal(await row.getAttribute('aria-expanded'), 'true', 'listings must remain usable while streets cannot load');
    // Selection opens its popup from moveend. Let that callback finish before closing
    // it, otherwise a later fixture pan can open the stale popup and auto-pan back.
    await page.locator('.leaflet-popup').waitFor({ state: 'visible', timeout: WAIT });
    await row.click();
    await page.evaluate(() => __map.stop());
  }
  const glExists = page => page.waitForFunction(() => {
    let found = false;
    window.__map?.eachLayer(l => { if (l.getMaplibreMap?.()) found = true; });
    return found;
  }, null, { timeout: WAIT });
  async function loseContext(page) {
    await glExists(page);
    await withGL(page, gl => {
      const canvas = gl.getCanvas();
      const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
      window.__recoveryLose = context.getExtension('WEBGL_lose_context');
      if (!window.__recoveryLose) throw new Error('WEBGL_lose_context is unavailable');
      window.__recoveryLose.loseContext();
    });
    await page.waitForFunction(() => /paused/.test(document.getElementById('map-status-text').textContent), null, { timeout: WAIT });
  }
  const allLoaded = page => page.waitForFunction(() => {
    let gl; __map.eachLayer(l => { if (l.getMaplibreMap) gl = l.getMaplibreMap(); });
    const tiles = gl?.style?.tileManagers.fixture?._inViewTiles.getAllTiles();
    return tiles?.length && tiles.every(tile => tile.state === 'loaded');
  }, null, { timeout: WAIT });
  const geometryStyle = (base, { linePaint = {}, fillPaint, lineLayout = {}, fillLayout = {} } = {}) => {
    const style = fixtureStyle(base);
    style.layers = [style.layers[0], { id: 'roads', type: 'line', source: 'fixture', 'source-layer': 'transportation', paint: linePaint, layout: lineLayout }];
    if (fillPaint) style.layers.push({ id: 'land', type: 'fill', source: 'fixture', 'source-layer': 'landcover', paint: fillPaint, layout: fillLayout });
    return style;
  };
  const waitErroredIdle = (page, count = 0) => page.waitForFunction(n => window.__recoverySettledErrors?.length > n, count, { timeout: WAIT });
  async function observeErroredIdle(page) {
    await withGL(page, gl => {
      window.__recoverySettledErrors = [];
      gl.on('idle', () => {
        const tiles = gl.style?.tileManagers.fixture?._inViewTiles.getAllTiles() || [];
        if (gl.areTilesLoaded() && tiles.some(tile => tile.state === 'errored')) __recoverySettledErrors.push(tiles.map(tile => tile.state));
      });
    });
  }
  const activeRetries = page => page.evaluate(() => [...__recoveryClock.timers.values()].filter(timer => timer.active).length);
  const waitAligned = page => page.waitForFunction(() => {
    let gl; __map.eachLayer(layer => { if (layer.getMaplibreMap) gl = layer.getMaplibreMap(); });
    return gl && Math.abs(gl.getZoom() - (__map.getZoom() - 1)) < 0.001 &&
      Math.abs(gl.getCenter().lng - __map.getCenter().lng) < 0.00001;
  }, null, { timeout: WAIT });

  await run('fixture replacements preserve regex flags and ignore the caller lastIndex', async () => {
    const cases = [
      ['aBc', /abc/i, 'done'],
      ['first\nTARGET\nlast', /^TARGET$/m, 'first\ndone\nlast'],
      ['first\nlast', /first.last/s, 'done'],
      ['aBc', /abc/gi, 'done'],
    ];
    for (const [source, pattern, expected] of cases) {
      pattern.lastIndex = 17;
      assert.equal(replaceOnce(source, pattern, 'done'), expected);
      assert.equal(pattern.lastIndex, 17, 'fixture validation/replacement must not mutate the original regex');
    }
    assert.throws(() => replaceOnce('other', /target/i, 'done'), /exactly once/);
    assert.throws(() => replaceOnce('target TARGET', /target/gi, 'done'), /exactly once/);
    assert.throws(() => replaceOnce('target\ntarget', /^target$/m, 'done'), /exactly once/);
    return 'i/m/s/g flags survive; fresh regex clones start at zero; missing/multiple matches fail explicitly';
  });

  for (const trigger of ['timer', 'online']) await run(`an out-of-view tile retry requests a frame after its ${trigger} no-op`, async cleanup => {
    let restored = false, failed = false, tileRequests = 0;
    const f = await setup(cleanup, { init: retryClock, style: base => fixtureStyle(base), intercept(req, res, url) {
      if (!url.pathname.startsWith(TILE_PATH)) return false;
      tileRequests++;
      const reject = restored && !failed && url.pathname === `${TILE_PATH}12/947/1850.pbf`;
      if (reject) failed = true;
      send(res, reject ? 503 : 200, 'application/x-protobuf', reject ? 'one restored tile failed' : Buffer.alloc(0));
      return true;
    } });
    await waitReady(f.page, WAIT);
    await observeErroredIdle(f.page);
    await loseContext(f.page);
    restored = true;
    await f.page.evaluate(() => __recoveryLose.restoreContext());
    await waitErroredIdle(f.page);
    assert.ok(failed);
    await usableFallback(f.page);
    await f.page.evaluate(() => __map.setView([17.06, -96.56], 16, { animate: false }));
    await waitAligned(f.page);
    await allLoaded(f.page);
    await withGL(f.page, gl => {
      window.__emptyViewportIdle = false;
      gl.once('idle', () => { __emptyViewportIdle = true; }); gl.triggerRepaint();
    });
    await f.page.waitForFunction(() => __emptyViewportIdle, null, { timeout: WAIT });
    assert.ok(!(await probe(f.page)).ready, 'an empty but loaded viewport cannot qualify as useful partial geometry while retry work is queued');
    assert.equal(await activeRetries(f.page), 1);
    const viewport = await withGL(f.page, gl => ({ center: gl.getCenter(), leaflet: __map.getCenter(), zoom: __map.getZoom(),
      tiles: gl.style.tileManagers.fixture._inViewTiles.getAllTiles().map(tile => [tile.tileID.canonical.x, tile.tileID.canonical.y, tile.state]) }));
    assert.ok(viewport.tiles.every(tile => tile[0] !== 947 || tile[1] !== 1850),
      'the queued failed coordinates must be outside even the padded GL viewport before testing the no-op: ' + JSON.stringify(viewport));
    await withGL(f.page, gl => {
      const refresh = gl.refreshTiles;
      window.__noopRefreshCalls = [];
      gl.refreshTiles = function(...args) { __noopRefreshCalls.push(args); return refresh.apply(this, args); };
    });
    const before = tileRequests;
    await f.page.evaluate(trigger => trigger === 'timer' ? __recoveryClock.fire() : dispatchEvent(new Event('online')), trigger);
    await waitReady(f.page, WAIT);
    assert.equal(tileRequests, before, 'out-of-view coordinates must make refreshTiles a real no-op, without new HTTP tile requests');
    assert.equal(await f.page.evaluate(() => __noopRefreshCalls.length), 1);
    assert.equal(await activeRetries(f.page), 0);
    cleanPage(f.page);
    return `a native single-tile 503, pan to loaded empty tiles, and ${trigger} queue drain regain ready through a requested render frame`;
  });

  await run('a blocked ESM entry leaves usable listings and imports successfully on Retry', async cleanup => {
    let imports = 0;
    const f = await setup(cleanup, { intercept(req, res, url) {
      if (url.pathname !== MAPLIBRE_PATH) return false;
      if (++imports === 1) {
        send(res, 503, 'text/javascript', 'temporary module failure');
        return true;
      }
      return false;
    } });
    await waitRetry(f.page, WAIT);
    assert.match((await probe(f.page)).status, /unavailable/);
    await usableFallback(f.page);
    await f.page.click('#map-retry');
    await waitReady(f.page, WAIT);
    assert.equal(imports, 2, 'Retry must issue a new native module request after an import failure');
    const urls = f.requests.filter(r => r.pathname === MAPLIBRE_PATH).map(r => new URL(r.url, f.base));
    assert.notEqual(urls[0].href, urls[1].href, 'a failed browser module-map entry must not poison Retry');
    assert.ok(urls[1].searchParams.has('_streetRetry'));
    cleanPage(f.page);
    return 'a native module 503 leaves pins and listing controls working; a distinct Retry URL reaches ready';
  });

  await run('Retry bypasses a native stalled module import before its original response finishes', async cleanup => {
    let original, imports = 0;
    const f = await setup(cleanup, {
      html: replaceOnce(app, /SLOW_MS\s*=\s*20000/, 'SLOW_MS = 200'),
      intercept(req, res, url, held) {
        if (url.pathname !== MAPLIBRE_PATH) return false;
        if (++imports === 1) {
          original = res; held.add(res);
          res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public,max-age=31536000' });
          res.flushHeaders();
          return true;
        }
        return false;
      },
    });
    await waitRetry(f.page, WAIT);
    await usableFallback(f.page);
    await f.page.click('#map-retry');
    await waitReady(f.page, WAIT);
    assert.equal(imports, 2, 'Retry must import a replacement while the original module is still pending');
    const urls = f.requests.filter(r => r.pathname === MAPLIBRE_PATH).map(r => new URL(r.url, f.base));
    assert.notEqual(urls[0].href, urls[1].href);
    assert.ok(urls[1].searchParams.has('_streetRetry'));
    assert.equal(original.writableEnded, false, 'the replacement must recover without completing the held response');
    cleanPage(f.page);
    return 'the original HTTP 200 module body remains held; a second native import with _streetRetry reaches ready';
  });

  await run('a blocked same-origin module worker leaves a fallback and recovers on Retry', async cleanup => {
    let blocked = true, workerRequests = 0;
    const f = await setup(cleanup, {
      init: () => {
        const NativeWorker = window.Worker;
        window.__recoveryWorkers = [];
        window.Worker = class extends NativeWorker {
          constructor(url, options) {
            window.__recoveryWorkers.push({ url: new URL(url, location.href).href, type: options?.type });
            super(url, options);
          }
        };
      },
      intercept(req, res, url) {
        if (!url.pathname.startsWith(MAPLIBRE_DIR) || !/worker.*\.mjs$/.test(url.pathname)) return false;
        workerRequests++;
        if (!blocked) return false;
        send(res, 503, 'text/javascript', 'temporary worker module failure');
        return true;
      },
    });
    await until(() => workerRequests > 0, 'the fixture must block an actual HTTP module-worker request');
    await waitRetry(f.page, WAIT);
    assert.match((await probe(f.page)).status, /unavailable/, 'a worker HTTP failure must fail, rather than merely reach the slow message');
    await usableFallback(f.page);
    blocked = false;
    await f.page.click('#map-retry');
    await waitReady(f.page, WAIT);
    const workers = await f.page.evaluate(() => window.__recoveryWorkers);
    assert.ok(workers.length >= 2, 'Retry must construct a replacement worker');
    assert.ok(workers.every(worker => new URL(worker.url).origin === f.base && worker.type === 'module'),
      'every worker must load as a module from this site, without a blob or remote worker URL');
    assert.ok(workerRequests > 1, 'the unblocked replacement must make a fresh worker HTTP request');
    cleanPage(f.page);
    return 'real worker-module HTTP 503s leave pins and listing controls usable; same-origin module workers recover on Retry';
  });

  await run('Retry bypasses a native stalled CSS response and reuses successful scripts', async cleanup => {
    let original, cssRequests = 0;
    const f = await setup(cleanup, {
      html: replaceOnce(app, /SLOW_MS\s*=\s*20000/, 'SLOW_MS = 200'),
      intercept(req, res, url, held) {
        if (url.pathname !== CSS_PATH) return false;
        cssRequests++;
        if (cssRequests === 1) {
          original = res; held.add(res);
          res.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'public,max-age=31536000' });
          res.flushHeaders(); // Browser has HTTP 200, but the stylesheet body never finishes.
        } else send(res, 200, 'text/css', css);
        return true;
      },
    });
    await waitRetry(f.page, WAIT);
    await f.page.waitForFunction(() => window.maplibregl && L.MaplibreGL && window.pmtiles, null, { timeout: WAIT });
    const before = scriptRequests(f).length;
    assert.equal(before, 3, 'exactly the entry, adapter and PMTiles must have loaded before Retry');
    await f.page.click('#map-retry');
    await waitReady(f.page, WAIT);
    const after = scriptRequests(f).length;
    assert.equal(cssRequests, 2, 'Retry must cause a distinct native HTTP stylesheet request');
    assert.equal(after, before, 'successful scripts must not be downloaded again');
    const retryURL = new URL(f.requests.filter(r => r.pathname === CSS_PATH)[1].url, f.base);
    assert.ok(retryURL.searchParams.has('_streetRetry'), 'the stalled stylesheet retry needs a distinct network URL');
    assert.equal(original.writableEnded, false, 'the page must recover before the original held response ends');
    cleanPage(f.page);
    return 'HTTP 200 body remains held; a second CSS URL reaches ready; successful modules and classic scripts are reused';
  });

  await run('Retry stays independent of a stalled CSS response after an intervening 503', async cleanup => {
    let original, count = 0;
    const f = await setup(cleanup, {
      html: replaceOnce(app, /SLOW_MS\s*=\s*20000/, 'SLOW_MS = 200'),
      intercept(req, res, url, held) {
        if (url.pathname !== CSS_PATH) return false;
        count++;
        if (count === 1) {
          original = res; held.add(res);
          res.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'public,max-age=31536000' });
          res.flushHeaders();
        } else if (count === 2) send(res, 503, 'text/plain', 'temporary retry failure');
        else send(res, 200, 'text/css', css);
        return true;
      },
    });
    await waitRetry(f.page, WAIT);
    await f.page.click('#map-retry');
    await f.page.waitForFunction(() => /unavailable/.test(document.getElementById('map-status-text').textContent), null, { timeout: WAIT });
    await f.page.click('#map-retry');
    await waitReady(f.page, WAIT);
    const urls = f.requests.filter(r => r.pathname === CSS_PATH).map(r => r.url);
    assert.equal(urls.length, 3, 'both retries should make native HTTP requests despite the original stall');
    assert.equal(new Set(urls).size, 3, 'the retry after 503 must also have its own network URL');
    assert.equal(original.writableEnded, false);
    cleanPage(f.page);
    return 'the first response remains held; a 503 retry is followed by a third unique successful URL';
  });

  await run('a failed stylesheet loads on Retry', async cleanup => {
    let count = 0;
    const f = await setup(cleanup, { intercept(req, res, url) {
      if (url.pathname !== CSS_PATH) return false;
      if (++count === 1) send(res, 503, 'text/plain', 'temporary CSS failure');
      else send(res, 200, 'text/css', css);
      return true;
    } });
    await waitRetry(f.page, WAIT);
    assert.match((await probe(f.page)).status, /unavailable/);
    await f.page.click('#map-retry');
    await waitReady(f.page, WAIT);
    assert.equal(count, 2);
    cleanPage(f.page);
    return '503 is forgotten and a new stylesheet request succeeds';
  });

  await run('CSS retry preserves an existing query and fragment', async cleanup => {
    let count = 0;
    const f = await setup(cleanup, {
      html: replaceOnce(replaceOnce(app, 'maplibre-gl.css";', 'maplibre-gl.css?existing=1#test";'), /SLOW_MS\s*=\s*20000/, 'SLOW_MS = 200'),
      intercept(req, res, url, held) {
        if (url.pathname !== CSS_PATH) return false;
        count++;
        if (count === 1) {
          held.add(res); res.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'public,max-age=31536000' }); res.flushHeaders();
        } else send(res, 200, 'text/css', css);
        return true;
      },
    });
    await waitRetry(f.page, WAIT);
    await f.page.click('#map-retry');
    await waitReady(f.page, WAIT);
    const urls = f.requests.filter(r => r.pathname === CSS_PATH).map(r => new URL(r.url, f.base));
    assert.equal(urls.length, 2);
    assert.ok(urls.every(url => url.searchParams.get('existing') === '1'));
    assert.ok(urls[1].searchParams.has('_streetRetry'));
    const href = await f.page.locator('link[rel="stylesheet"]').evaluateAll(links => links.map(l => l.href).find(h => h.includes('maplibre-gl.css')));
    assert.equal(new URL(href).hash, '#test');
    cleanPage(f.page);
    return 'the URL remains a stylesheet; existing=1 and #test survive the distinct retry URL';
  });

  await run('an initial archive failure during WebGL loss keeps a fallback and remains retryable after restore', async cleanup => {
    let first;
    const f = await setup(cleanup, {
      style: base => fixtureStyle(base, { type: 'vector', url: 'pmtiles://basemap/oaxaca.pmtiles' }),
      intercept(req, res, url, held) {
        if (url.pathname !== ARCHIVE_PATH || first) return false;
        first = { req, res }; held.add(res); return true;
      },
    });
    await until(() => first, 'the initial PMTiles header was not requested');
    assert.match(first.req.headers.range || '', /^bytes=0-/, 'the held request must be the initial archive header');
    await loseContext(f.page);
    send(first.res, 503, 'text/plain', 'initial archive header failure');
    // MapLibre 6 destroys its style when the context is lost, so source events can no longer
    // reach the removed style. The paused fallback must stay usable until reconstruction.
    await usableFallback(f.page);
    assert.ok(!(await probe(f.page)).ready, 'the failed archive must not declare a lost-context map ready');
    await f.page.evaluate(() => __recoveryLose.restoreContext());
    await f.page.waitForFunction(() => {
      let layer = false; __map.eachLayer(l => { if (l.getMaplibreMap) layer = true; });
      return !layer && /unavailable/.test(document.getElementById('map-status-text').textContent);
    }, null, { timeout: 4000 });
    const fallback = await probe(f.page);
    assert.ok(!fallback.ready && fallback.retry && !fallback.hasLayer && /Natural Earth/.test(fallback.credits));
    await f.page.click('#map-retry');
    await waitReady(f.page, WAIT);
    cleanPage(f.page);
    return 'a real context loss plus header 503 keeps the fallback; reconstruction removes the failed layer and Retry recovers';
  });

  await run('a late abandoned module cannot replace the adapter runtime or detach Retry from its protocol cache', async cleanup => {
    let originalScript, scriptRequests = 0, archiveRequests = 0;
    const f = await setup(cleanup, {
      html: replaceOnce(app, /SLOW_MS\s*=\s*20000/, 'SLOW_MS = 200'),
      style: base => fixtureStyle(base, { type: 'vector', url: 'pmtiles://basemap/oaxaca.pmtiles' }),
      intercept(req, res, url, held) {
        if (url.pathname === MAPLIBRE_PATH && ++scriptRequests === 1) {
          originalScript = res; held.add(res);
          res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public,max-age=31536000' });
          res.flushHeaders();
          return true;
        }
        if (url.pathname === ARCHIVE_PATH && ++archiveRequests === 1) {
          send(res, 503, 'text/plain', 'temporary header failure in the replacement MapLibre runtime');
          return true;
        }
        return false;
      },
    });
    await waitRetry(f.page, WAIT);
    assert.equal(scriptRequests, 1, 'the initial runtime script should still be held');
    await f.page.click('#map-retry');
    await f.page.waitForFunction(() => window.maplibregl && L.MaplibreGL && window.pmtiles &&
      /unavailable/.test(document.getElementById('map-status-text').textContent), null, { timeout: WAIT });
    assert.equal(scriptRequests, 2, 'Retry must load a second MapLibre script independently of the first');
    assert.equal(archiveRequests, 1, 'the replacement runtime must encounter and cache the initial header 503');
    assert.ok(!(await probe(f.page)).hasLayer, 'the failed replacement map must be removed before testing another Retry');
    await f.page.evaluate(() => { window.__recoveryAdapterRuntime = window.maplibregl; });
    assert.equal(originalScript.destroyed, false, 'the abandoned script must still be a native pending response');
    originalScript.end(Buffer.concat([
      fs.readFileSync(path.join(root, MAPLIBRE_PATH)),
      Buffer.from('\n;globalThis.__recoveryLateModuleExecuted = true;\n'),
    ]));
    await f.page.waitForFunction(() => window.__recoveryLateModuleExecuted, null, { timeout: WAIT });
    assert.ok(await f.page.evaluate(() => window.maplibregl === window.__recoveryAdapterRuntime), 'the abandoned import must finish without replacing the active runtime');
    // The late module really evaluates. Its obsolete loader continuation must not publish it,
    // and Retry must register a fresh PMTiles cache on the successful adapter's runtime.
    await f.page.click('#map-retry');
    await waitReady(f.page, WAIT);
    assert.ok(archiveRequests >= 2, 'Retry must fetch the archive again instead of reusing the adapter runtime\'s rejected header promise');
    assert.equal(scriptRequests, 2, 'both completed runtime scripts must be reused without another download');
    assert.equal(f.requests.filter(r => r.pathname === '/vendor/maplibre-gl-leaflet-0.1.4/leaflet-maplibre-gl.js').length, 1);
    assert.equal(f.requests.filter(r => r.pathname === '/vendor/pmtiles-4.5.0/pmtiles.js').length, 1);
    assert.ok(await withGL(f.page, gl => gl instanceof window.__recoveryAdapterRuntime.Map), 'the working map must still use the runtime captured by its adapter');
    cleanPage(f.page);
    return 'the original module evaluates late without replacing the active runtime; Retry replaces its rejected PMTiles cache and reaches ready';
  });

  await run('an initial successful archive load stays paused until WebGL restores', async cleanup => {
    let first;
    const f = await setup(cleanup, {
      style: base => fixtureStyle(base, { type: 'vector', url: 'pmtiles://basemap/oaxaca.pmtiles' }),
      intercept(req, res, url, held) {
        if (url.pathname !== ARCHIVE_PATH || first) return false;
        first = { req, res }; held.add(res); return true;
      },
    });
    await until(() => first, 'the initial PMTiles header was not requested');
    await loseContext(f.page);
    const receivedHeader = f.page.waitForResponse(response =>
      new URL(response.url()).pathname === ARCHIVE_PATH && /^bytes=0-/.test(response.request().headers().range || ''));
    archiveResponse(root, first.req, first.res);
    const headerResponse = await receivedHeader;
    assert.equal(headerResponse.status(), 206, 'the held header must resume with a successful byte-range response');
    assert.equal(await headerResponse.finished(), null, 'the browser must finish receiving the successful header while WebGL is lost');
    const paused = await probe(f.page);
    assert.ok(!paused.ready && paused.hasGL && paused.retry && /paused/.test(paused.status));
    await f.page.evaluate(() => __recoveryLose.restoreContext());
    await waitReady(f.page, WAIT);
    cleanPage(f.page);
    return 'successful metadata cannot hide the fallback while the context is lost; restoration reaches ready';
  });

  await run('a late classic-script Retry cannot replace the working PMTiles protocol or archive cache', async cleanup => {
    let scripts = 0, lateScript, headers = 0, archiveRequests = 0, rejectNewHeaders = false;
    const captureProtocols = () => {
      let exported;
      window.__recoveryProtocols = [];
      Object.defineProperty(window, 'pmtiles', { configurable: true, get: () => exported, set(value) {
        const NativeProtocol = value.Protocol;
        const Protocol = class extends NativeProtocol {
          constructor(...args) { super(...args); window.__recoveryProtocols.push(this); }
        };
        exported = { ...value, Protocol };
      } });
    };
    const f = await setup(cleanup, {
      html: replaceOnce(app, /SLOW_MS\s*=\s*20000/, 'SLOW_MS = 200'),
      init: captureProtocols,
      style: base => fixtureStyle(base, { type: 'vector', url: 'pmtiles://basemap/oaxaca.pmtiles' }),
      intercept(req, res, url, held) {
        if (url.pathname === PMTILES_PATH) {
          if (++scripts === 1) { send(res, 503, 'text/javascript', 'initial PMTiles script failure'); return true; }
          if (scripts === 2) {
            lateScript = res; held.add(res);
            res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public,max-age=31536000' });
            res.flushHeaders(); return true;
          }
        }
        if (url.pathname === ARCHIVE_PATH) {
          archiveRequests++;
          if (/^bytes=0-/.test(req.headers.range || '')) {
            headers++;
            if (rejectNewHeaders) { send(res, 503, 'text/plain', 'a discarded archive cache cannot recover this header'); return true; }
          }
        }
        return false;
      },
    });
    await f.page.waitForFunction(() => /unavailable/.test(document.getElementById('map-status-text').textContent), null, { timeout: WAIT });
    assert.equal(scripts, 1, 'the initial attempt must have received the PMTiles script 503');
    await f.page.click('#map-retry');
    await until(() => lateScript, 'Retry #2 must hold a real classic-script response');
    await f.page.locator('script[src*="/pmtiles-4.5.0/pmtiles.js"]').evaluate(element => {
      element.addEventListener('load', () => { window.__latePMTilesOnload = true; });
    });
    await waitRetry(f.page, WAIT);
    await f.page.click('#map-retry');
    await waitReady(f.page, WAIT);
    await allLoaded(f.page);
    assert.equal(scripts, 3);
    assert.equal(headers, 1, 'the winning protocol must have a successful cached archive header');
    await f.page.evaluate(base => {
      window.__winningProtocol = __recoveryProtocols.at(-1);
      window.__winningArchive = __winningProtocol.get(base + '/basemap/oaxaca.pmtiles');
      if (!__winningArchive) throw new Error('winning PMTiles archive was not cached');
    }, f.base);
    const protocols = await f.page.evaluate(() => __recoveryProtocols.length);
    rejectNewHeaders = true;
    assert.equal(lateScript.destroyed, false, 'the abandoned classic response must still be pending after the replacement reaches ready');
    lateScript.end(Buffer.concat([fs.readFileSync(path.join(root, PMTILES_PATH)), Buffer.from('\nwindow.__latePMTilesExecuted = true;\n')]));
    // Observe the removed element's real load event as well as execution, then cross the
    // event's microtask checkpoint so the abandoned loader continuation has also drained.
    await f.page.waitForFunction(() => window.__latePMTilesExecuted && window.__latePMTilesOnload, null, { timeout: WAIT });
    assert.equal(await f.page.evaluate(() => __recoveryProtocols.length), protocols, 'abandoned Retry #2 must not register a new protocol after Retry #3 is ready');
    assert.ok(await f.page.evaluate(base => __winningProtocol === __recoveryProtocols.at(-1) &&
      __winningProtocol.get(base + '/basemap/oaxaca.pmtiles') === __winningArchive, f.base));
    const before = archiveRequests;
    await f.page.evaluate(() => __map.setView([17.105, -96.705], 15, { animate: false }));
    await until(() => archiveRequests > before, 'moving to uncached tiles must make actual archive range requests');
    await allLoaded(f.page);
    await waitReady(f.page, WAIT);
    assert.equal(headers, 1, 'uncached tiles must retain the winning header cache even when a new header request would fail');
    cleanPage(f.page);
    return '503 → held Retry #2 → ready Retry #3; late classic execution preserves protocol/archive identity and uncached tiles load without a new header';
  });

  await run('errored tiles after WebGL reconstruction keep the fallback through native idle and recover on tile retry', async cleanup => {
    let fail = false, tileRequests = 0;
    const f = await setup(cleanup, { init: retryClock, style: base => fixtureStyle(base), intercept(req, res, url) {
      if (!url.pathname.startsWith(TILE_PATH)) return false;
      tileRequests++;
      send(res, fail ? 503 : 200, 'application/x-protobuf', fail ? 'restored tile failure' : Buffer.alloc(0));
      return true;
    } });
    await waitReady(f.page, WAIT);
    await allLoaded(f.page);
    await withGL(f.page, gl => {
      window.__restoredIdle = [];
      gl.on('idle', () => {
        const tiles = gl.style?.tileManagers.fixture?._inViewTiles.getAllTiles() || [];
        if (tiles.some(tile => tile.state === 'errored')) __restoredIdle.push({ loaded: gl.areTilesLoaded(), states: tiles.map(tile => tile.state) });
      });
    });
    await loseContext(f.page);
    fail = true;
    const beforeRestore = tileRequests;
    await f.page.evaluate(() => __recoveryLose.restoreContext());
    await until(() => tileRequests > beforeRestore, 'the restored style must request new native tiles');
    await f.page.waitForFunction(() => __restoredIdle.some(idle => idle.loaded), null, { timeout: WAIT });
    await usableFallback(f.page);
    assert.match((await probe(f.page)).status, /recovering/i, 'restoration must distinguish recovery work from an actually lost context');
    await loseContext(f.page);
    assert.match((await probe(f.page)).status, /paused/i, 'a repeated real loss during recovery must restore the paused message');
    await f.page.evaluate(() => { __restoredIdle = []; __recoveryLose.restoreContext(); });
    await f.page.waitForFunction(() => __restoredIdle.length > 0 && [...__recoveryClock.timers.values()].some(timer => timer.active), null, { timeout: WAIT });
    assert.match((await probe(f.page)).status, /recovering/i);
    assert.ok(await f.page.evaluate(() => __recoveryClock.timers.size > 0 && [...__recoveryClock.timers.values()].some(timer => timer.active)));
    fail = false;
    const beforeRetry = tileRequests;
    await f.page.evaluate(() => __recoveryClock.fire());
    await until(() => tileRequests > beforeRetry, 'the application tile retry must issue actual HTTP requests');
    await allLoaded(f.page);
    await waitReady(f.page, WAIT);
    cleanPage(f.page);
    return 'real context reconstruction plus tile 503s reaches native idle/areTilesLoaded without hiding the fallback; successful tile retry restores streets';
  });

  for (const [kind, options, layer] of [['transportation', {}, 'roads'], ['polygon', { lineLayout: { visibility: 'none' }, fillPaint: {} }, 'land']]) {
    await run(`visible real ${kind} geometry restores a partial map while tile backoff continues`, async cleanup => {
    let partial = false, tileRequests = 0;
    const f = await setup(cleanup, { init: retryClock, style: base => geometryStyle(base, options), intercept(req, res, url) {
      if (!url.pathname.startsWith(TILE_PATH)) return false;
      tileRequests++;
      const reject = partial && url.pathname !== `${TILE_PATH}12/947/1850.pbf`;
      send(res, reject ? 503 : 200, 'application/x-protobuf', reject ? 'partial restored viewport' : geometryTiles.get(url.pathname) || Buffer.alloc(0));
      return true;
    } });
    await waitReady(f.page, WAIT);
    await observeErroredIdle(f.page);
    await loseContext(f.page);
    partial = true;
    await f.page.evaluate(() => __recoveryLose.restoreContext());
    await waitErroredIdle(f.page);
    await waitReady(f.page, WAIT);
    const geometry = await withGL(f.page, (gl, layer) => {
      const bounds = __map.getBounds();
      return gl.queryRenderedFeatures([gl.project(bounds.getNorthWest()), gl.project(bounds.getSouthEast())], { layers: [layer] }).length;
    }, layer);
    assert.ok(geometry > 0, 'the successful central MVT must draw real geometry inside the Leaflet viewport, including default paint');
    assert.equal(await activeRetries(f.page), 1, 'publishing a partial map must retain background tile retries');
    for (let round = 0; round < 2; round++) {
      const before = tileRequests;
      await f.page.evaluate(() => __recoveryClock.fire());
      await until(() => tileRequests > before, 'a partial map must continue real HTTP tile retries');
      await f.page.waitForFunction(n => __recoveryClock.scheduled.length >= n, round + 2, { timeout: WAIT });
      assert.ok((await probe(f.page)).ready, 'repeated tile failures must not hide already useful geometry');
    }
    assert.deepEqual(await f.page.evaluate(() => __recoveryClock.scheduled.slice(0, 3)), [2000, 4000, 8000], 'partial readiness must retain, rather than reset, the failure backoff');
    partial = false;
    await f.page.evaluate(() => __recoveryClock.fire());
    await allLoaded(f.page);
    await waitReady(f.page, WAIT);
    assert.equal(await activeRetries(f.page), 0);
    cleanPage(f.page);
    return `real central ${kind} with default paint shows streets after reconstruction; other tile failures retry at 2/4/8 seconds until full recovery`;
    });
  }

  const invisiblePaintCases = [
    ['zero opacity fill and line', { linePaint: { 'line-opacity': 0 }, fillPaint: { 'fill-opacity': 0 } }],
    ['transparent color fill and line', { linePaint: { 'line-color': 'rgba(30,30,30,0)' }, fillPaint: { 'fill-color': 'rgba(30,30,30,0)' } }],
    ['zero width line with hidden fill', { linePaint: { 'line-width': 0 }, fillPaint: {}, fillLayout: { visibility: 'none' } }],
    ['hidden fill and line', { lineLayout: { visibility: 'none' }, fillPaint: {}, fillLayout: { visibility: 'none' } }],
  ];
  for (const [name, options] of invisiblePaintCases) await run(`invisible real geometry cannot qualify a restored partial map: ${name}`, async cleanup => {
    let partial = false;
    const f = await setup(cleanup, { init: retryClock, style: base => {
      const style = geometryStyle(base, options);
      // A nonqualifying circle keeps the source active even when both geometry layers
      // are hidden. The native tile failures must still occur in the hidden-layer case.
      style.layers.push({ id: 'source-keeper', type: 'circle', source: 'fixture', 'source-layer': 'place', paint: { 'circle-opacity': 0 } });
      return style;
    }, intercept(req, res, url) {
      if (!url.pathname.startsWith(TILE_PATH)) return false;
      const reject = partial && url.pathname !== `${TILE_PATH}12/947/1850.pbf`;
      send(res, reject ? 503 : 200, 'application/x-protobuf', reject ? 'invisible partial viewport' : geometryTiles.get(url.pathname) || Buffer.alloc(0));
      return true;
    } });
    await waitReady(f.page, WAIT);
    await observeErroredIdle(f.page);
    await loseContext(f.page);
    partial = true;
    await f.page.evaluate(() => __recoveryLose.restoreContext());
    await waitErroredIdle(f.page);
    const sources = await withGL(f.page, gl => ({
      lines: gl.querySourceFeatures('fixture', { sourceLayer: 'transportation' }).length,
      fills: gl.querySourceFeatures('fixture', { sourceLayer: 'landcover' }).length,
    }));
    assert.ok(sources.lines > 0 && sources.fills > 0, 'the restored tile must contain actual line and polygon geometry despite its invisible paint');
    await usableFallback(f.page);
    assert.match((await probe(f.page)).status, /recovering/i);
    assert.equal(await activeRetries(f.page), 1);
    cleanPage(f.page);
    return `${name} leaves the simplified map and Retry visible despite a successfully decoded real MVT`;
  });

  await run('geometry confined to adapter padding cannot qualify a restored partial map', async cleanup => {
    let partial = false;
    const f = await setup(cleanup, { init: retryClock, style: base => geometryStyle(base), intercept(req, res, url) {
      if (!url.pathname.startsWith(TILE_PATH)) return false;
      const reject = partial && url.pathname !== `${TILE_PATH}12/948/1850.pbf`;
      send(res, reject ? 503 : 200, 'application/x-protobuf', reject ? 'only padded offscreen geometry remains' : geometryTiles.get(url.pathname) || Buffer.alloc(0));
      return true;
    } });
    await waitReady(f.page, WAIT);
    await f.page.evaluate(() => {
      const world = 256 * 2 ** 13;
      const centerX = 948 * 512 - __map.getSize().x / 2 - 8;
      __map.setView([17.06, centerX / world * 360 - 180], 13, { animate: false });
    });
    await waitAligned(f.page);
    await allLoaded(f.page);
    await observeErroredIdle(f.page);
    await loseContext(f.page);
    partial = true;
    await f.page.evaluate(() => __recoveryLose.restoreContext());
    await waitErroredIdle(f.page);
    const geometry = await withGL(f.page, gl => {
      const bounds = __map.getBounds(), box = [gl.project(bounds.getNorthWest()), gl.project(bounds.getSouthEast())];
      return { padded: gl.queryRenderedFeatures(undefined, { layers: ['roads'] }).length,
        visible: gl.queryRenderedFeatures(box, { layers: ['roads'] }).length };
    });
    assert.ok(geometry.padded > 0, 'a real road must render in the padded GL canvas');
    assert.equal(geometry.visible, 0, 'the same roads must all be outside the visible Leaflet map');
    await usableFallback(f.page);
    partial = false;
    await f.page.evaluate(() => __recoveryClock.fire());
    await allLoaded(f.page);
    await waitReady(f.page, WAIT);
    cleanPage(f.page);
    return 'actual roads in adapter padding do not hide the fallback; the explicit Leaflet viewport becomes ready after tile recovery';
  });

  await run('partial real geometry before the first successful render retains the initial failure fallback', async cleanup => {
    const f = await setup(cleanup, { style: base => geometryStyle(base), intercept(req, res, url) {
      if (!url.pathname.startsWith(TILE_PATH)) return false;
      const reject = url.pathname !== `${TILE_PATH}12/947/1850.pbf`;
      send(res, reject ? 503 : 200, 'application/x-protobuf', reject ? 'initial partial viewport fails' : geometryTiles.get(url.pathname));
      return true;
    } });
    await waitRetry(f.page, WAIT);
    assert.match((await probe(f.page)).status, /unavailable/);
    assert.ok(!(await probe(f.page)).hasLayer, 'the initial partial error must still tear down the failed street layer');
    await usableFallback(f.page);
    cleanPage(f.page);
    return 'partial geometry only qualifies after an earlier successful map render; initial tile errors retain the normal unavailable/Retry fallback';
  });

  await run('place filters stay stable through real context restoration and two worker-pool restarts', async cleanup => {
    const f = await setup(cleanup, { style: base => {
      const style = fixtureStyle(base);
      style.layers.push({ id: 'place-filter', type: 'symbol', source: 'fixture', 'source-layer': 'place',
        filter: ['==', ['get', 'class'], 'city'], layout: { 'text-field': ['get', 'name'] } });
      return style;
    }, intercept(req, res, url) {
      if (!url.pathname.startsWith(TILE_PATH)) return false;
      send(res, 200, 'application/x-protobuf', Buffer.alloc(0)); return true;
    } });
    await waitReady(f.page, WAIT);
    const original = await withGL(f.page, gl => gl.getFilter('place-filter'));
    await withGL(f.page, gl => {
      window.__recoveryRebuilds = { styles: 0, losses: [] };
      gl.on('style.load', () => __recoveryRebuilds.styles++);
      gl.on('webglcontextlost', event => __recoveryRebuilds.losses.push({
        type: event.originalEvent.constructor.name, trusted: event.originalEvent.isTrusted,
        contextLost: gl.getCanvas().getContext('webgl2').isContextLost(),
      }));
    });
    await loseContext(f.page);
    await f.page.evaluate(() => __recoveryLose.restoreContext());
    await f.page.waitForFunction(() => __recoveryRebuilds.styles >= 1, null, { timeout: WAIT });
    await waitReady(f.page, WAIT);
    assert.deepEqual(await withGL(f.page, gl => gl.getFilter('place-filter')), original);
    for (let restart = 0; restart < 2; restart++) {
      await f.page.evaluate(() => maplibregl.getGlobalDispatcher().workerPool.restart());
      await f.page.waitForFunction(n => __recoveryRebuilds.styles >= n, restart + 2, { timeout: WAIT });
      await waitReady(f.page, WAIT);
      assert.deepEqual(await withGL(f.page, gl => gl.getFilter('place-filter')), original, 'reconstruction must not append another exclusion expression');
      assert.ok((await probe(f.page)).ready, 'worker replacement must recover automatically without clicking Retry');
    }
    const rebuilds = await f.page.evaluate(() => __recoveryRebuilds);
    assert.equal(rebuilds.losses.length, 3);
    assert.ok(rebuilds.losses[0].trusted && rebuilds.losses[0].contextLost, 'the first cycle must use an actual lost WebGL context');
    assert.ok(rebuilds.losses.slice(1).every(event => event.type === 'Event' && !event.trusted && !event.contextLost),
      'both worker restarts must fire MapLibre synthetic events while WebGL remains healthy');
    cleanPage(f.page);
    return 'one native WebGL restoration and two actual worker-pool replacements automatically reach ready with byte-identical place filters';
  });

  await run('context reconstruction discards pending retry work before a viewport change', async cleanup => {
    let fail = false, tileRequests = 0;
    const f = await setup(cleanup, { init: retryClock, style: base => fixtureStyle(base), intercept(req, res, url) {
      if (!url.pathname.startsWith(TILE_PATH)) return false;
      tileRequests++;
      send(res, fail ? 503 : 200, 'application/x-protobuf', fail ? 'queued before context loss' : Buffer.alloc(0));
      return true;
    } });
    await waitReady(f.page, WAIT);
    fail = true;
    await withGL(f.page, gl => gl.refreshTiles('fixture'));
    await f.page.waitForFunction(() => [...__recoveryClock.timers.values()].some(timer => timer.active), null, { timeout: WAIT });
    await withGL(f.page, gl => {
      const refresh = gl.refreshTiles;
      window.__lostRefreshCalls = 0;
      gl.refreshTiles = function(...args) { __lostRefreshCalls++; return refresh.apply(this, args); };
    });
    await loseContext(f.page);
    assert.ok(await f.page.evaluate(() => [...__recoveryClock.timers.values()].every(timer => !timer.active)), 'the old tile retry timer must be cleared on loss');
    const beforeOnline = tileRequests;
    await f.page.evaluate(() => { __map.setView([17.10, -96.70], 14, { animate: false }); dispatchEvent(new Event('online')); });
    await f.page.waitForTimeout(100);
    assert.equal(tileRequests, beforeOnline, 'online must not refresh a discarded style or replay old tile coordinates');
    assert.equal(await f.page.evaluate(() => __lostRefreshCalls), 0, 'online must not even invoke refreshTiles while the style is lost, including a caught/no-op call');
    fail = false;
    await f.page.evaluate(() => __recoveryLose.restoreContext());
    await waitReady(f.page, WAIT);
    await allLoaded(f.page);
    assert.ok(await f.page.evaluate(() => [...__recoveryClock.timers.values()].every(timer => !timer.active)), 'stale errors must not block the reconstructed viewport from becoming ready');
    cleanPage(f.page);
    return 'a queued real tile failure is cancelled by loss; online does no stale work, and the changed viewport reconstructs successfully';
  });

  await run('interceptor exceptions are recorded after cleanup and do not abort following cases', async () => {
    const privateResults = [], report = (...result) => privateResults.push(result);
    for (const afterHeaders of [false, true]) {
      await run(afterHeaders ? 'private after-headers fixture error' : 'private before-headers fixture error', async scope => {
        const f = await setup(scope, { intercept(req, res, url) {
          if (url.pathname !== '/intentional-interceptor-error') return false;
          if (afterHeaders) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('partial response'); }
          throw new Error(afterHeaders ? 'intentional error after headers' : 'intentional error before headers');
        } });
        const response = await f.page.request.get(f.base + '/intentional-interceptor-error').catch(error => error);
        if (!afterHeaders) assert.equal(response.status(), 500);
        else assert.ok(response instanceof Error, 'a partially written response must be destroyed');
        scope.cleanup.push(async () => { scope.interceptorErrors.push(new Error('cleanup collector marker')); });
        return 'the assertions succeeded, but the fixture must still fail';
      }, report);
    }
    let followingCaseRan = false;
    await run('private following case', async () => { followingCaseRan = true; return 'continued'; }, report);
    assert.equal(privateResults.length, 3);
    assert.deepEqual(privateResults.map(result => result[1]), [false, false, true]);
    assert.match(privateResults[0][2], /intentional error before headers/);
    assert.match(privateResults[1][2], /intentional error after headers/);
    assert.ok(privateResults.slice(0, 2).every(result => /cleanup collector marker/.test(result[2])), 'results must include errors collected during cleanup');
    assert.ok(followingCaseRan);
    return 'private before/after-header exceptions produce failed records only after cleanup; the next scenario still runs';
  });

  await run('tile backoff survives an idle event during pending requests, caps, retries online and resets after recovery', async cleanup => {
    let mode = 'success', pending = [], tileRequests = 0;
    const release = status => {
      const batch = pending; pending = [];
      for (const { res } of batch) if (!res.destroyed) send(res, status, 'application/x-protobuf', status === 200 ? Buffer.alloc(0) : 'temporary tile failure');
      return batch.length;
    };
    const f = await setup(cleanup, { init: retryClock, style: base => fixtureStyle(base), intercept(req, res, url, held) {
      if (!url.pathname.startsWith(TILE_PATH)) return false;
      tileRequests++;
      if (mode === 'success') send(res, 200, 'application/x-protobuf', Buffer.alloc(0));
      else { held.add(res); pending.push({ req, res }); }
      return true;
    } });
    await waitReady(f.page, WAIT);
    await f.page.evaluate(() => __map.setView([17.0607, -96.7254], 13, { animate: false }));
    await allLoaded(f.page);
    await withGL(f.page, gl => {
      gl.on('idle', () => {
        const tileStates = gl.style.tileManagers.fixture._inViewTiles.getAllTiles().map(t => t.state);
        if (tileStates.some(s => s === 'expired' || s === 'loading')) __recoveryClock.idle.push(tileStates);
      });
    });
    mode = 'hold';
    await f.page.evaluate(() => __map.panBy([512, 0], { animate: false }));
    await until(() => pending.length > 0, 'panning should request new fixture tiles');
    release(503);
    const expected = [2000, 4000, 8000, 16000, 32000, 60000, 60000];
    const actual = [];
    for (let round = 0; round < expected.length; round++) {
      await f.page.waitForFunction(n => __recoveryClock.scheduled.length > n, round, { timeout: WAIT });
      const delay = await f.page.evaluate(n => __recoveryClock.scheduled[n], round);
      actual.push(delay);
      // Keep running all rounds even on the buggy baseline, then report the whole observed series.
      await f.page.evaluate(() => __recoveryClock.fire());
      await until(() => pending.length > 0, 'a scheduled retry should make a real HTTP tile request');
      await f.page.waitForFunction(() => {
        let gl; __map.eachLayer(l => { if (l.getMaplibreMap) gl = l.getMaplibreMap(); });
        return gl.style.tileManagers.fixture._inViewTiles.getAllTiles().some(t => t.state === 'expired');
      }, null, { timeout: WAIT });
      const idleBefore = await f.page.evaluate(() => __recoveryClock.idle.length);
      // MapLibre 6 no longer naturally reports idle for the tile-error shortcut in 5.6.1.
      // Inject the public idle event while actual HTTP responses remain held and the tiles
      // are expired, preserving the application's regression check across that engine fix.
      await withGL(f.page, gl => gl.fire('idle'));
      await f.page.waitForFunction(n => __recoveryClock.idle.length > n, idleBefore, { timeout: WAIT });
      release(503);
    }
    await f.page.waitForFunction(n => __recoveryClock.scheduled.length > n, expected.length, { timeout: WAIT });
    const beforeLossHistory = await f.page.evaluate(() => __recoveryClock.scheduled.length);
    await loseContext(f.page);
    await f.page.evaluate(() => __recoveryLose.restoreContext());
    await until(() => pending.length > 0, 'context reconstruction must make new actual tile requests');
    release(503);
    await f.page.waitForFunction(n => __recoveryClock.scheduled.length > n, beforeLossHistory, { timeout: WAIT });
    assert.equal(await f.page.evaluate(() => __recoveryClock.scheduled.at(-1)), 60000, 'a context loss must retain the capped failure backoff until full recovery');
    assert.match((await probe(f.page)).status, /recovering/i);
    // The pending application timer is under test-clock control. No timer is fired here:
    // online itself must initiate HTTP requests, even at the maximum backoff.
    const beforeOnline = tileRequests;
    await f.page.evaluate(() => dispatchEvent(new Event('online')));
    await until(() => tileRequests > beforeOnline && pending.length > 0, 'online must immediately retry without firing the scheduled timer');
    mode = 'success';
    release(200);
    await allLoaded(f.page);
    await waitReady(f.page, WAIT);
    // Force a normal settled render so recovery, not an errored-idle shortcut, resets backoff.
    await f.page.evaluate(() => __map.panBy([-1, 0], { animate: false }));
    await withGL(f.page, (gl, timeout) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no settled idle after tile recovery')), timeout);
      gl.once('idle', () => { clearTimeout(timer); resolve(); });
      gl.triggerRepaint();
    }), WAIT);
    const historyBeforeNewFailure = await f.page.evaluate(() => __recoveryClock.scheduled.length);
    mode = 'hold';
    // A pan may remain inside cached tiles or the map bounds. Refresh the loaded tiles explicitly
    // so the next failure is guaranteed to make an HTTP request regardless of viewport history.
    await withGL(f.page, gl => gl.refreshTiles('fixture'));
    await until(() => pending.length > 0, 'refreshing recovered tiles must make a new request');
    release(503);
    await f.page.waitForFunction(n => __recoveryClock.scheduled.length > n, historyBeforeNewFailure, { timeout: WAIT });
    const reset = await f.page.evaluate(() => __recoveryClock.scheduled.at(-1));
    assert.deepEqual(actual, expected, 'retry delays must double despite idle while requests are pending');
    assert.equal(reset, 2000, 'a genuinely successful tile load must reset backoff');
    assert.ok((await f.page.evaluate(() => __recoveryClock.idle.length)) >= expected.length);
    cleanPage(f.page);
    return `delays ${actual.join(', ')} ms despite injected idle; 60000 ms survives real context loss; online retries and full recovery resets to ${reset} ms`;
  });
}
