# Oaxaca Rental Map

A single-page interactive map of residential rentals around Oaxaca de Juárez, combining two sources:

- **Real Estate Oaxaca** — the 12 listings on [realestateoaxaca.com/rentals-residential](https://www.realestateoaxaca.com/rentals-residential) (round pins, Nos. 1–12)
- **Propiedades.com** — the 7 rentals tagged furnished (*Amueblado*) among the 104 results on [propiedades.com's Oaxaca Centro rentals](https://propiedades.com/oaxaca-centro-oaxaca-de-juarez/renta) (rounded-square pins, Nos. 13–19)

Both sources were read on 18 Nov 2026. Prices, availability and lease status will drift; check each listing's page before acting on it.

## Viewing it

Open `index.html` in any modern browser. It has no build step, server requirement, or API key. It loads Leaflet 1.9.4, MapLibre GL JS 5.6.1 and the MapLibre–Leaflet adapter 0.0.22 from CDNs, plus two typefaces from Google Fonts.

The default basemap is [OpenFreeMap Positron](https://openfreemap.org/), with detailed streets, buildings, and street/place names. POI and water-feature name labels are hidden to keep rental pins prominent. Positron stays light regardless of the surrounding interface's system theme. Loading street tiles requires an internet connection and WebGL. If the renderer or tiles fail, the page shows its embedded simplified map and a Retry button (Reload if a browser library failed to load); listing filters, pins, and uncertainty circles remain usable. The embedded geometry is a fallback, not a full offline installation: the browser libraries and fonts still require a network connection or a browser cache.

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

## Credits

Street basemap: OpenFreeMap Positron, © OpenMapTiles, data © OpenStreetMap contributors. The visible attribution is retained on the map. Municipal boundaries: CONABIO, 2023. The simplified fallback also uses Natural Earth highways and built-up areas. Listing text is summarized from the two source sites; all listings belong to their advertisers.
