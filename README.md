# Oaxaca Rental Map

A single-page interactive map of residential rentals around Oaxaca de Juárez, combining two sources:

- **Real Estate Oaxaca** — the 12 listings on [realestateoaxaca.com/rentals-residential](https://www.realestateoaxaca.com/rentals-residential) (round pins, Nos. 1–12)
- **Propiedades.com** — the 7 rentals tagged furnished (*Amueblado*) among the 104 results on [propiedades.com's Oaxaca Centro rentals](https://propiedades.com/oaxaca-centro-oaxaca-de-juarez/renta) (rounded-square pins, Nos. 13–19)

Both sources were read on 18 Nov 2026. Prices, availability and lease status will drift; check each listing's page before acting on it.

## Viewing it

The page is published with GitHub Pages at **https://hbmartin.github.io/oaxaca-rental-map/**. It has no build step at view time and no API key.

To run it locally, serve the folder over HTTP: `npm run serve` (no `npm install` needed for this), then open http://127.0.0.1:8766/. Other static servers must support HTTP Range requests and serve `.mjs` files with a JavaScript MIME type, such as `text/javascript`. Opening `index.html` straight from disk also works for the listings, filters and pins, but browsers won't let a file page fetch the tile archive, so it shows the simplified map with a note.

Leaflet 1.9.4 (cdnjs) and two typefaces (Google Fonts) load up front. Everything else is served from this repository: MapLibre GL JS 6.19.0, the MapLibre–Leaflet adapter 0.1.4 and PMTiles 4.5.0 in `vendor/`, and the street tiles, style, fonts and sprites in `basemap/`. The map libraries load after the page is running, and only in browsers with WebGL2. MapLibre's ES module loads before the adapter, and its worker loads from beside the entry module. The empty shared module is retained as a vendored compatibility asset; this release does not request it. Retry uses a fresh entry URL if an import stalls.

The street basemap uses [OpenFreeMap](https://openfreemap.org/)'s Positron style over a self-hosted extract of the Oaxaca area (`basemap/oaxaca.pmtiles`), with detailed streets, buildings, and street/place names. Water-feature and airport name labels are hidden to keep rental pins prominent, as is the basemap's own label for the city, which would sit on the page's Zócalo marker; the page draws its own airport marker. Positron stays light regardless of the system theme, so in dark mode the map panel switches to the light palette while the streets are showing. The street map needs WebGL2.

The embedded simplified map stays on screen until the streets have rendered. If the street map can't load, the page keeps the simplified map and offers Retry; if loading is merely slow, it says so and keeps trying. After the streets have rendered, failed tiles are retried automatically, with delays growing from two seconds to a sixty-second cap and an immediate retry when the connection returns.

If a working street map loses its WebGL context or its workers restart, the simplified map covers it while it rebuilds. Once visible map geometry has rendered again, streets return even if some tiles still need background retries. If every visible tile fails, or only invisible or offscreen geometry is available, the fallback and Retry remain available. Reconstruction preserves the current retry delay; complete recovery resets it to two seconds. Listing filters, pins, and uncertainty circles remain usable throughout. The embedded geometry is a fallback, not a full offline installation: Leaflet and the UI typefaces still come from their CDNs.

## Refreshing the basemap

`basemap/` is generated and committed. To rebuild it from current OpenStreetMap data:

```sh
npm run build:basemap   # or: python3 scripts/build_basemap.py [--refresh-osm]
```

It needs Java 21+ and Python 3.10+. The first run downloads about 830 MB into the git-ignored `.cache/`: [Planetiler](https://github.com/onthegomap/planetiler) 0.10.2 (93 MB, checksum-verified), Geofabrik's Mexico extract (650 MB), lake centerlines (81 MB), and Planetiler's small sample ocean and Natural Earth files, which are enough for an inland city. It takes a few minutes; later runs reuse the downloads, and `--refresh-osm` fetches a newer extract. The script:

1. builds an OpenMapTiles-schema extract, the schema Positron is written for;
2. keeps only the tiles each zoom level can show inside the page's `maxBounds` (wider at the lowest zooms, where the view is larger than the bounds) and writes `basemap/oaxaca.pmtiles`;
3. fetches Positron's style, sprites and every glyph range the tile labels use from OpenFreeMap, rewriting only the style's URLs.

`basemap/build.json` records the build date, source versions and per-zoom extents. If you change the map's `maxBounds` or zoom limits in `index.html`, update the matching constants at the top of the script. To change the vendored libraries, edit their versions in `package.json`, then run `npm install && npm run vendor` and update the paths in `index.html`.

## What the page does

- Plots every listing on a map with 2, 5 and 10 km rings around the Zócalo
- Filters by status, source, furnished, bedrooms and max monthly rent
- Converts between MXN and USD at a rate you set (remembered in your browser)
- Sorts by rent, distance from the Zócalo, bedrooms or listing number
- Expands each listing with its details, caveats and a link to the original posting
- Shows or hides municipal boundaries with the map's checkbox (remembered in your browser)

Municipal outlines use the existing generalized CONABIO 2023 geometry. They describe municipal limits, not colonia, barrio, or property boundaries, and are independent of listing selection and uncertainty circles.

## Location accuracy

Pins are approximate. Real Estate Oaxaca listings name a neighborhood or landmark, and Propiedades.com listings give a street but no exact map point. Each pin sits in the stated area, and selecting a listing draws a dashed circle showing how far off it could be. Overlapping pins are nudged apart with a thin line back to their true spot.

## Adding or editing listings

Listings live in the `LISTINGS` array inside the `<script>` near the bottom of `index.html`. Each entry looks like this:

```js
{n:20, src:"pc", id:"unique-id", title:"Short title", area:"Neighborhood · Street",
 price:18000, cur:"MXN", beds:2, baths:1, status:"available",
 near:"One-sentence description.",
 tags:["Furnished","Terrace","65 m²"],
 note:"Optional caveat shown in the detail panel.",
 url:"https://…", ll:[17.0660,-96.7272], prec:400, by:"street",
 q:"Search text for the Google Maps link"}
```

| Field | Meaning |
|---|---|
| `n` | Number shown on the pin and in the list |
| `src` | `"reo"` (Real Estate Oaxaca, the default) or `"pc"` (Propiedades.com) |
| `cur` | `"MXN"` or `"USD"` |
| `status` | `"available"` or `"leased"` |
| `tags` | A tag containing "furnished" makes the listing pass the *Furnished only* filter |
| `ll` | `[latitude, longitude]` of the pin |
| `prec` | Uncertainty radius in metres |
| `by` | How the pin was placed: `"street"`, `"landmark"` or `"area"` (omit for neighborhood) |

## Tests

`tests/verify.mjs` drives the page in headless Chromium and checks the street basemap end to end. It covers alignment while panning and zooming, credits, hidden labels, that every basemap request stays on this site and succeeds across the whole map, opening the file from disk, dark mode, failure and Retry paths (blocked libraries, style or tile archive, no WebGL2, a failing WebGL constructor, context loss), boundary toggling, the phone layout, and slow or background-tab loading. The `runtime` group verifies the shipped MapLibre version and checks attribution sanitization against dangerous event attributes and encoded executable URLs while preserving ordinary HTTPS links.

The `slow` group holds only the initial archive-header request until the slow-message or hidden-tab check completes, then releases it. Recovery gets its own 60-second deadline; later tile requests are not artificially delayed.

The local `recovery` group uses real HTTP fault fixtures to check stalled and failed module and stylesheet retries, blocked module workers, late abandoned imports and classic scripts, archive-header failures during WebGL loss, complete and partial context restoration, worker restarts, and tile retry backoff while panning and rebuilding. It checks recovery after a retry has nothing left to refresh, visible geometry versus transparent or padded-canvas content, stable label filters, and interceptor exceptions that fail their scenario without aborting the run. Partial-map fixtures use actual geometry from the committed tile archive. Leaflet is served locally only for the page's exact pinned CDN URL, with version checks against the installed test dependency.

The fixtures control the named application tile-retry callback to check the two-second minimum, sixty-second cap, online recovery and reset after successful loading without waiting several minutes. Some also shorten the slow-loading threshold, rewrite asset URLs, substitute styles, or exercise GL events in a served copy of the page; every HTML replacement must match exactly once. These transformations do not change the production page. The group is included in the default local run and excluded when `BASE_URL` selects a deployed copy.

```sh
npm install
npx playwright install chromium   # once; or set PW_CHANNEL=chrome to use installed Google Chrome
npm test                          # full suite; starts its own local server
npm test -- recovery,libs,archive,ready  # focused recovery and loading checks
npm test -- ready,dark            # other groups: align, runtime, selfhost, file, nowebgl, ctorfail, boundaries, phone, slow
BASE_URL=https://example.org/map/ npm test   # against a deployed copy
```

Screenshots and `results.json` are written to `test-results/`. `npm run serve` starts the same local server on port 8766 for viewing the page.

## Credits

Street basemap: tiles © [OpenMapTiles](https://openmaptiles.org/), built with [Planetiler](https://github.com/onthegomap/planetiler) from data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL) via Geofabrik; style, fonts and sprites from [OpenFreeMap](https://openfreemap.org/) Positron. Map libraries: MapLibre GL JS (BSD-3-Clause), MapLibre–Leaflet adapter (ISC) and PMTiles (BSD-3-Clause); their licenses are in `vendor/`. The visible attribution is retained on the map. Municipal boundaries: CONABIO, 2023. The simplified fallback also uses Natural Earth highways and built-up areas. Listing text is summarized from the two source sites; all listings belong to their advertisers.
