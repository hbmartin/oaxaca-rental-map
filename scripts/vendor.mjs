// Copies the pinned map libraries from node_modules into vendor/, which is committed and served
// as-is (GitHub Pages has no build step). Run after changing their versions in package.json:
//   npm install && npm run vendor
// index.html refers to these paths, so update its MAPLIBRE_* / ADAPTER_JS / PMTILES_JS constants too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PMTILES_LICENSE = 'https://raw.githubusercontent.com/protomaps/PMTiles/5897a82a16b233abac7b8f339c019b931c2bbf54/LICENSE';

const LIBS = [
  { pkg: 'maplibre-gl', dir: 'maplibre-gl', files: ['dist/maplibre-gl.js', 'dist/maplibre-gl.css', 'LICENSE.txt'] },
  { pkg: '@maplibre/maplibre-gl-leaflet', dir: 'maplibre-gl-leaflet', files: ['leaflet-maplibre-gl.js', 'LICENSE'] },
  // The npm package ships without its license file; the repository's applies to the JS library.
  { pkg: 'pmtiles', dir: 'pmtiles', files: ['dist/pmtiles.js'], licenseUrl: PMTILES_LICENSE },
];

const vendor = path.join(ROOT, 'vendor');
fs.rmSync(vendor, { recursive: true, force: true });
for (const lib of LIBS) {
  const src = path.join(ROOT, 'node_modules', lib.pkg);
  const { version } = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  const dest = path.join(vendor, `${lib.dir}-${version}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of lib.files) fs.copyFileSync(path.join(src, f), path.join(dest, path.basename(f)));
  if (lib.licenseUrl) {
    const res = await fetch(lib.licenseUrl);
    if (!res.ok) throw new Error(`License download failed (${res.status}): ${lib.licenseUrl}`);
    fs.writeFileSync(path.join(dest, 'LICENSE'), await res.text());
  }
  console.log(`vendor/${lib.dir}-${version}: ${fs.readdirSync(dest).join(', ')}`);
}
