// Deterministic browser regressions for native request stalls and street-map recovery.
// The fixtures use this repository's libraries and assets; no production hooks are needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../scripts/serve.mjs';

const CSS_PATH = '/vendor/maplibre-gl-5.6.1/maplibre-gl.css';
const MAPLIBRE_PATH = '/vendor/maplibre-gl-5.6.1/maplibre-gl.js';
const ARCHIVE_PATH = '/basemap/oaxaca.pmtiles';
const TILE_PATH = '/recovery-tiles/';
const WAIT = 12000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, message, timeout = WAIT) {
  const end = Date.now() + timeout;
  while (!await test()) {
    if (Date.now() >= end) throw new Error(message);
    await sleep(20);
  }
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

  async function run(name, test) {
    const cleanup = [];
    try {
      const detail = await test(cleanup);
      record('recovery: ' + name, true, detail);
    } catch (error) {
      record('recovery: ' + name, false, String(error.message || error));
    } finally {
      for (const fn of cleanup.reverse()) await fn().catch(() => {});
    }
  }
  async function setup(cleanup, { intercept, html = app, init, style } = {}) {
    const held = new Set(), requests = [];
    let base;
    const server = await startServer(root, 0, '127.0.0.1', (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({ pathname: url.pathname, url: req.url });
      if (url.pathname === '/index.html') { send(res, 200, 'text/html; charset=utf-8', html); return true; }
      if (url.pathname === '/basemap/style.json' && style) { send(res, 200, 'application/json', JSON.stringify(style(base))); return true; }
      return intercept ? intercept(req, res, url, held) : false;
    });
    base = `http://127.0.0.1:${server.address().port}`;
    cleanup.push(async () => {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
    const { ctx, page } = await newPage(browser, { init, routes: [
      ['https://cdnjs.cloudflare.com/**', route => route.fulfill({ path: leaflet, contentType: 'text/javascript' })],
      ['https://fonts.googleapis.com/**', route => route.abort()],
      ['https://fonts.gstatic.com/**', route => route.abort()],
    ] });
    cleanup.push(() => ctx.close());
    // Long native stylesheet responses must not hold page.goto's load event open.
    await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
    return { page, ctx, base, held, requests };
  }
  const cleanPage = page => assert.deepEqual(page.errors, [], 'the page must not throw JavaScript errors');
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
    const tiles = gl && Object.values(gl.style.sourceCaches.fixture?._tiles || {});
    return tiles?.length && tiles.every(tile => tile.state === 'loaded');
  }, null, { timeout: WAIT });

  await run('Retry bypasses a native stalled CSS response and reuses successful scripts', async cleanup => {
    let original, cssRequests = 0;
    const f = await setup(cleanup, {
      html: app.replace(/SLOW_MS\s*=\s*20000/, 'SLOW_MS = 200'),
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
    const before = f.requests.filter(r => r.pathname.startsWith('/vendor/') && /\.js$/.test(r.pathname)).length;
    assert.equal(before, 3, 'all three street-map scripts should have succeeded before Retry');
    await f.page.click('#map-retry');
    await waitReady(f.page, WAIT);
    const after = f.requests.filter(r => r.pathname.startsWith('/vendor/') && /\.js$/.test(r.pathname)).length;
    assert.equal(cssRequests, 2, 'Retry must cause a distinct native HTTP stylesheet request');
    assert.equal(after, before, 'successful scripts must not be downloaded again');
    const retryURL = new URL(f.requests.filter(r => r.pathname === CSS_PATH)[1].url, f.base);
    assert.ok(retryURL.searchParams.has('_streetRetry'), 'the stalled stylesheet retry needs a distinct network URL');
    assert.equal(original.writableEnded, false, 'the page must recover before the original held response ends');
    cleanPage(f.page);
    return 'HTTP 200 body remains held; a second CSS URL reaches ready; all three scripts downloaded once';
  });

  await run('Retry stays independent of a stalled CSS response after an intervening 503', async cleanup => {
    let original, count = 0;
    const f = await setup(cleanup, {
      html: app.replace(/SLOW_MS\s*=\s*20000/, 'SLOW_MS = 200'),
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
      html: app.replace('maplibre-gl.css";', 'maplibre-gl.css?existing=1#test";').replace(/SLOW_MS\s*=\s*20000/, 'SLOW_MS = 200'),
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

  await run('an initial archive failure during WebGL loss tears down and remains retryable', async cleanup => {
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
    await f.page.waitForFunction(() => {
      let layer = false; __map.eachLayer(l => { if (l.getMaplibreMap) layer = true; });
      return !layer && /unavailable/.test(document.getElementById('map-status-text').textContent);
    }, null, { timeout: 4000 });
    const fallback = await probe(f.page);
    assert.ok(!fallback.ready && fallback.retry && !fallback.hasLayer && /Natural Earth/.test(fallback.credits));
    await f.page.click('#map-retry');
    await waitReady(f.page, WAIT);
    cleanPage(f.page);
    return 'a real context loss plus header 503 removes the failed layer; Retry builds a working replacement';
  });

  await run('a late abandoned script cannot detach Retry from the adapter protocol cache', async cleanup => {
    let originalScript, scriptRequests = 0, archiveRequests = 0;
    const f = await setup(cleanup, {
      html: app.replace(/SLOW_MS\s*=\s*20000/, 'SLOW_MS = 200'),
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
    originalScript.end(fs.readFileSync(path.join(root, MAPLIBRE_PATH)));
    await f.page.waitForFunction(() => window.maplibregl !== window.__recoveryAdapterRuntime, null, { timeout: WAIT });
    // The late body really executes and replaces the browser global. Retry must nevertheless
    // register its fresh PMTiles cache on the runtime captured by the successful adapter.
    await f.page.click('#map-retry');
    await waitReady(f.page, WAIT);
    assert.ok(archiveRequests >= 2, 'Retry must fetch the archive again instead of reusing the adapter runtime\'s rejected header promise');
    assert.equal(scriptRequests, 2, 'both completed runtime scripts must be reused without another download');
    assert.equal(f.requests.filter(r => r.pathname === '/vendor/maplibre-gl-leaflet-0.1.4/leaflet-maplibre-gl.js').length, 1);
    assert.equal(f.requests.filter(r => r.pathname === '/vendor/pmtiles-4.5.0/pmtiles.js').length, 1);
    assert.ok(await withGL(f.page, gl => gl instanceof window.__recoveryAdapterRuntime.Map), 'the working map must still use the runtime captured by its adapter');
    cleanPage(f.page);
    return 'the original script executes late and changes the global; Retry replaces the correct rejected PMTiles cache and reaches ready';
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
    archiveResponse(root, first.req, first.res);
    await f.page.waitForFunction(() => {
      let gl; __map.eachLayer(l => { if (l.getMaplibreMap) gl = l.getMaplibreMap(); });
      return gl?.style.sourceCaches.fixture?._source.loaded();
    }, null, { timeout: WAIT });
    const paused = await probe(f.page);
    assert.ok(!paused.ready && paused.hasGL && paused.retry && /paused/.test(paused.status));
    await f.page.evaluate(() => __recoveryLose.restoreContext());
    await waitReady(f.page, WAIT);
    cleanPage(f.page);
    return 'successful metadata cannot hide the fallback while the context is lost; restoration reaches ready';
  });

  await run('tile backoff survives idle during pending requests, caps, retries online and resets after recovery', async cleanup => {
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
        const tileStates = Object.values(gl.style.sourceCaches.fixture._tiles).map(t => t.state);
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
        return Object.values(gl.style.sourceCaches.fixture._tiles).some(t => t.state === 'expired');
      }, null, { timeout: WAIT });
      const idleBefore = await f.page.evaluate(() => __recoveryClock.idle.length);
      // These are ordinary Leaflet pans. The responses remain held until a real MapLibre idle
      // is observed with expired tiles, reproducing the sourceErrored loaded() shortcut.
      await f.page.evaluate(() => { window.__recoveryPan = setInterval(() => __map.panBy([1, 0], { animate: false }), 40); });
      try {
        await f.page.waitForFunction(n => __recoveryClock.idle.length > n, idleBefore, { timeout: WAIT });
      } finally {
        await f.page.evaluate(() => clearInterval(__recoveryPan));
      }
      release(503);
    }
    await f.page.waitForFunction(n => __recoveryClock.scheduled.length > n, expected.length, { timeout: WAIT });
    // The pending application timer is under test-clock control. No timer is fired here:
    // online itself must initiate HTTP requests, even at the maximum backoff.
    const beforeOnline = tileRequests;
    await f.page.evaluate(() => dispatchEvent(new Event('online')));
    await until(() => tileRequests > beforeOnline && pending.length > 0, 'online must immediately retry without firing the scheduled timer');
    mode = 'success';
    release(200);
    await allLoaded(f.page);
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
    return `delays ${actual.join(', ')} ms; online causes native requests; loaded states reset the delay to ${reset} ms`;
  });
}
