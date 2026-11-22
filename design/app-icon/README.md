# GeoZipTag app icon

A bevelled cream shutter-ring lens with an India-facing globe as its glass, a 3D coral location pin, and (on the home-screen version) a mini GeoZipTag
stamp card with its tab, in a bright sky with soft clouds. Sky gradient: `#8FDBFF` →
`#3D97F2` → `#1C3F9E`. Ring cream `#FFFBF2`, pin coral `#FF9A7E` → `#C9432F`.

Drawn on Android's 108-unit adaptive-icon grid (visible area 18–90, safe circle
radius 33); all solid artwork stays inside the safe circle.

| File | Used for |
|---|---|
| `geoziptag-app-icon-full.svg` | Home-screen icon (with stamp card): iPhone, web app icons, legacy Android |
| `geoziptag-app-icon-fg.svg` + `-bg.svg` | Android adaptive foreground and background layers |
| `geoziptag-app-icon-mono.svg` | Android 13+ themed icon (single colour) |
| `geoziptag-app-icon-small.svg` | Simplified icon (no card) for small places: stamp tab, app header, favicon |
| `globe-artwork-approved.svg` | The original approved globe artwork (a small raster). The icon now redraws the globe as vector map data in the same style, so it stays sharp at any size |

PNG exports live in the app's `res/mipmap-*` and `assets/` folders.

## The globe

The globe is vector map data from [Natural Earth](https://www.naturalearthdata.com/)
(public domain): the 1:50m land layer for the continents, and India's outline from
Natural Earth's **India point-of-view** 1:10m countries file, which shows Jammu &
Kashmir and Ladakh (including Gilgit-Baltistan and Aksai Chin) as part of India.
It is an orthographic projection rotated so the pin tip lands on New Delhi.

## Rebuilding

`tools/build-globe.mjs` projects the map data (download `ne_50m_land.geojson` and
`ne_10m_admin_0_countries_ind.geojson` from the natural-earth-vector repository into
`data/`, and install `d3-geo`). `tools/make-icon.js` draws the icon SVGs and PNGs
with Playwright.
