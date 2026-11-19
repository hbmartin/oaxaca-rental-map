#!/usr/bin/env python3
"""Build the self-hosted street basemap in basemap/.

    npm run build:basemap        (or: python3 scripts/build_basemap.py)

1. Downloads Planetiler, the Geofabrik Mexico OpenStreetMap extract and lake centerlines (about
   830 MB in all, cached in .cache/ so later builds reuse them; --refresh-osm fetches a newer extract).
2. Builds an OpenMapTiles-schema extract of the Oaxaca area, the schema OpenFreeMap's Positron
   style is written for.
3. Keeps only the tiles each zoom level can show inside the page's maxBounds, and writes
   basemap/oaxaca.pmtiles.
4. Fetches the Positron style, its sprites and every glyph range the tile labels use.

Needs Java 21+ and Python 3.10+; installs the `pmtiles` package into .cache/venv on first run.
Commit basemap/ afterwards. index.html reads basemap/style.json and rewrites its relative URLs.
"""
import argparse
import datetime
import gzip
import hashlib
import json
import math
import os
import shutil
import sqlite3
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
SOURCES = CACHE / "sources"
OUT = ROOT / "basemap"

PLANETILER_VERSION = "0.10.2"
PLANETILER_RELEASE = f"https://github.com/onthegomap/planetiler/releases/download/v{PLANETILER_VERSION}"
# Planetiler's own small test copies. Oaxaca is inland and the page never shows the low zooms that
# use Natural Earth, so these stand in for the ~1 GB of global ocean and Natural Earth data.
PLANETILER_TEST_DATA = f"https://github.com/onthegomap/planetiler/raw/v{PLANETILER_VERSION}/planetiler-core/src/test/resources"
PMTILES_PACKAGE = "pmtiles==3.8.1"
OPENFREEMAP = "https://tiles.openfreemap.org"
USER_AGENT = "basemap-build-script/1.0"

# These must match the map in index.html.
MAX_BOUNDS = (-96.87, 16.94, -96.55, 17.18)  # west, south, east, north: Leaflet maxBounds
LEAFLET_MIN_ZOOM = 11
MAX_TILE_ZOOM = 14          # OpenMapTiles stops here; MapLibre overzooms beyond it
VIEW_PX = (2200, 1440)      # largest map viewport planned for, in CSS pixels
GL_PADDING = 1.2            # the Leaflet adapter renders 10% beyond each edge
MARGIN = 0.02               # degrees beyond maxBounds, for drag overshoot


def log(msg):
    print(msg, flush=True)


def fetch(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    tmp.replace(dest)
    return dest


def fetch_bytes(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req) as r:
        return r.read()


def ensure_pmtiles():
    """Re-run this script inside .cache/venv, which has the pmtiles writer installed."""
    venv = CACHE / "venv"
    py = venv / "bin" / "python"
    if Path(sys.prefix).resolve() == venv.resolve():
        return
    if not py.exists():
        log("Creating .cache/venv with " + PMTILES_PACKAGE)
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
        subprocess.run([str(py), "-m", "pip", "install", "-q", PMTILES_PACKAGE], check=True)
    os.execv(str(py), [str(py), __file__, *sys.argv[1:]])


# --- Tile maths (Web Mercator, XYZ) ---

def lon_to_x(lon, z):
    return (lon + 180.0) / 360.0 * (1 << z)


def lat_to_y(lat, z):
    r = math.radians(lat)
    return (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * (1 << z)


def x_to_lon(x, z):
    return x / (1 << z) * 360.0 - 180.0


def y_to_lat(y, z):
    n = math.pi - 2.0 * math.pi * y / (1 << z)
    return math.degrees(math.atan(math.sinh(n)))


def extent(z):
    """Area the page can show using GL tiles of level z, as (west, south, east, north).

    The adapter runs MapLibre one zoom below Leaflet, so level-z tiles cover Leaflet zooms z+1 up to
    z+2, and the view is widest at z+1. Once the view is smaller than maxBounds, Leaflet keeps it
    inside them; when it is larger, Leaflet centres it on them.
    """
    z = max(z, LEAFLET_MIN_ZOOM - 1)
    lz = z + 1
    w, s, e, n = MAX_BOUNDS
    world = 256 * (1 << lz)  # Leaflet pixels at zoom lz
    cx = lon_to_x((w + e) / 2, 0) * world
    cy = (lat_to_y(n, 0) + lat_to_y(s, 0)) / 2 * world
    hw, hh = VIEW_PX[0] / 2 * GL_PADDING, VIEW_PX[1] / 2 * GL_PADDING
    view = (x_to_lon((cx - hw) / world, 0), y_to_lat((cy + hh) / world, 0),
            x_to_lon((cx + hw) / world, 0), y_to_lat((cy - hh) / world, 0))
    return (min(view[0], w - MARGIN), min(view[1], s - MARGIN),
            max(view[2], e + MARGIN), max(view[3], n + MARGIN))


def tile_range(z):
    w, s, e, n = extent(z)
    last = (1 << z) - 1
    clamp = lambda v: min(max(int(math.floor(v)), 0), last)
    return clamp(lon_to_x(w, z)), clamp(lat_to_y(n, z)), clamp(lon_to_x(e, z)), clamp(lat_to_y(s, z))


# --- Minimal Mapbox Vector Tile reader: just enough to collect label strings ---

def _varint(buf, i):
    shift = result = 0
    while True:
        b = buf[i]; i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7


def _fields(buf):
    i, n = 0, len(buf)
    while i < n:
        key, i = _varint(buf, i)
        wire = key & 7
        if wire == 0:
            value, i = _varint(buf, i)
        elif wire == 1:
            value, i = None, i + 8
        elif wire == 2:
            length, i = _varint(buf, i)
            value, i = buf[i:i + length], i + length
        elif wire == 5:
            value, i = None, i + 4
        else:
            raise ValueError(f"unsupported protobuf wire type {wire}")
        yield key >> 3, value


def tile_strings(data):
    """Every string property value in a vector tile (Tile.layers[].values[].string_value)."""
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    for field, layer in _fields(data):
        if field != 3:
            continue
        for lf, value in _fields(layer):
            if lf != 4:
                continue
            for vf, v in _fields(value):
                if vf == 1 and v is not None:
                    yield v.decode("utf-8", "replace")


# --- Build steps ---

def planetiler(args):
    jar = CACHE / f"planetiler-{PLANETILER_VERSION}.jar"
    if not jar.exists():
        log(f"Downloading Planetiler {PLANETILER_VERSION}")
        fetch(f"{PLANETILER_RELEASE}/planetiler.jar", jar)
    expected = fetch_bytes(f"{PLANETILER_RELEASE}/planetiler.jar.sha256").decode().split()[0]
    actual = hashlib.sha256(jar.read_bytes()).hexdigest()
    if actual != expected:
        jar.unlink()
        sys.exit(f"Planetiler checksum mismatch ({actual} != {expected}); deleted, run again.")

    for name in ("water-polygons-split-3857.zip", "natural_earth_vector.sqlite.zip"):
        if not (SOURCES / name).exists():
            fetch(f"{PLANETILER_TEST_DATA}/{name}", SOURCES / name)
    osm = SOURCES / "mexico.osm.pbf"
    if args.refresh_osm and osm.exists():
        osm.unlink()

    w, s, e, n = extent(0)
    mbtiles = CACHE / "oaxaca.mbtiles"
    cmd = ["java", f"-Xmx{args.memory}", "-jar", str(jar),
           "--download", "--area=mexico", f"--osm_path={osm}",
           f"--download_dir={SOURCES}", f"--tmpdir={CACHE / 'tmp'}",
           f"--water_polygons_path={SOURCES / 'water-polygons-split-3857.zip'}",
           f"--natural_earth_path={SOURCES / 'natural_earth_vector.sqlite.zip'}",
           f"--bounds={w:.4f},{s:.4f},{e:.4f},{n:.4f}", f"--maxzoom={MAX_TILE_ZOOM}",
           "--languages=es,en", f"--output={mbtiles}", "--force"]
    log("Running Planetiler (downloads the Mexico extract on first run):\n  " + " ".join(cmd))
    subprocess.run(cmd, check=True, cwd=CACHE)
    return mbtiles, osm


def write_pmtiles(mbtiles, dest):
    from pmtiles.convert import mbtiles_to_header_json
    from pmtiles.tile import zxy_to_tileid
    from pmtiles.writer import write

    ranges = {z: tile_range(z) for z in range(MAX_TILE_ZOOM + 1)}
    conn = sqlite3.connect(mbtiles)
    meta = dict(conn.execute("SELECT name, value FROM metadata"))
    keep, dropped = [], 0
    for z, x, tms in conn.execute("SELECT zoom_level, tile_column, tile_row FROM tiles"):
        y = (1 << z) - 1 - tms
        x0, y0, x1, y1 = ranges[z]
        if x0 <= x <= x1 and y0 <= y <= y1:
            keep.append((zxy_to_tileid(z, x, y), z, x, tms))
        else:
            dropped += 1
    keep.sort()

    codepoints, per_zoom = set(), {}
    with write(str(dest)) as writer:
        for tileid, z, x, tms in keep:
            data = conn.execute("SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                                (z, x, tms)).fetchone()[0]
            if data[:2] != b"\x1f\x8b":
                data = gzip.compress(data, mtime=0)
            for text in tile_strings(data):
                codepoints.update(ord(c) for c in text)
            per_zoom[z] = per_zoom.get(z, 0) + 1
            writer.write_tile(tileid, data)
        header, metadata = mbtiles_to_header_json(meta)
        w, s, e, n = extent(0)
        header.update(min_lon_e7=int(w * 1e7), min_lat_e7=int(s * 1e7), max_lon_e7=int(e * 1e7), max_lat_e7=int(n * 1e7),
                      center_lon_e7=int(-96.7254 * 1e7), center_lat_e7=int(17.0607 * 1e7), center_zoom=12)
        writer.finalize(header, metadata)
    conn.close()
    log(f"Wrote {dest.relative_to(ROOT)}: {len(keep)} tiles ({dropped} outside the viewable area dropped), "
        f"{dest.stat().st_size / 1e6:.2f} MB")
    return codepoints, per_zoom, meta


def style_assets(codepoints):
    style = json.loads(fetch_bytes(f"{OPENFREEMAP}/styles/positron"))
    sprite_src, glyph_src = style["sprite"], style["glyphs"]

    sprites = OUT / "sprites"
    shutil.rmtree(sprites, ignore_errors=True)
    for suffix in (".json", ".png", "@2x.json", "@2x.png"):
        fetch(sprite_src + suffix, sprites / ("ofm" + suffix))

    fontstacks = set()
    for layer in style["layers"]:
        font = layer.get("layout", {}).get("text-font")
        if isinstance(font, list) and all(isinstance(f, str) for f in font):
            fontstacks.add(",".join(font))
        elif font is not None:
            sys.exit(f"Unexpected text-font in layer {layer['id']}: {font!r}; extend style_assets().")
    starts = sorted({0} | {cp // 256 * 256 for cp in codepoints if cp <= 0xFFFF})
    fonts = OUT / "fonts"
    shutil.rmtree(fonts, ignore_errors=True)
    for stack in sorted(fontstacks):
        for start in starts:
            rng = f"{start}-{start + 255}"
            url = glyph_src.replace("{fontstack}", urllib.parse.quote(stack)).replace("{range}", rng)
            fetch(url, fonts / stack / f"{rng}.pbf")
    log(f"Fetched {len(fontstacks)} fontstacks × {len(starts)} glyph ranges and 4 sprite files")

    # Only the URLs change. index.html turns these into absolute URLs at load time.
    del style["sources"]["ne2_shaded"]  # raster hillshade the style declares but no layer uses
    style["sources"]["openmaptiles"] = {"type": "vector", "url": "pmtiles://basemap/oaxaca.pmtiles"}
    style["glyphs"] = "basemap/fonts/{fontstack}/{range}.pbf"
    style["sprite"] = "basemap/sprites/ofm"
    (OUT / "style.json").write_text(json.dumps(style, ensure_ascii=False, indent=1) + "\n")
    return sorted(fontstacks), [f"{s}-{s + 255}" for s in starts]


def main():
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    ap.add_argument("--refresh-osm", action="store_true", help="download a fresh Mexico extract")
    ap.add_argument("--memory", default="3g", help="Java heap for Planetiler (default 3g)")
    args = ap.parse_args()
    ensure_pmtiles()
    if shutil.which("java") is None:
        sys.exit("Java 21+ is required (for Planetiler).")
    CACHE.mkdir(exist_ok=True)
    OUT.mkdir(exist_ok=True)

    mbtiles, osm = planetiler(args)
    codepoints, per_zoom, meta = write_pmtiles(mbtiles, OUT / "oaxaca.pmtiles")
    fontstacks, ranges = style_assets(codepoints)

    osm_date = datetime.datetime.fromtimestamp(osm.stat().st_mtime, datetime.timezone.utc).date().isoformat()
    build = {
        "built": datetime.date.today().isoformat(),
        "osm_extract": "Geofabrik mexico-latest.osm.pbf",
        "osm_extract_downloaded": osm_date,
        "planetiler": PLANETILER_VERSION,
        "schema": "OpenMapTiles " + meta.get("version", ""),
        "style": f"{OPENFREEMAP}/styles/positron (sources, glyphs and sprite rewritten)",
        "tiles_per_zoom": {str(z): per_zoom[z] for z in sorted(per_zoom)},
        "extent_per_zoom": {str(z): [round(v, 4) for v in extent(z)] for z in range(MAX_TILE_ZOOM + 1)},
        "fontstacks": fontstacks,
        "glyph_ranges": ranges,
    }
    (OUT / "build.json").write_text(json.dumps(build, indent=1) + "\n")
    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    log(f"basemap/ is {total / 1e6:.2f} MB. Commit it.")


if __name__ == "__main__":
    main()
