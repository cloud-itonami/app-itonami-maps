# 地図 (Maps) — Awai app

A world map that runs on the user's device: a Tauri **3.0.0-alpha.6** app
(`tauri-runtime-wry`, OS WebView) for Android and desktop, and the same static
files for a plain static host. Tracking: AWAI-3143 (map), AWAI-3145 (routes),
parent AWAI-3142.

## What it does

- Shows the whole world with country borders, works with no network.
- Drag to pan (the world wraps east–west), wheel / pinch / double-click / `+` `−`
  buttons to zoom, arrow keys and `+` `-` `0` on the focused map.
- Tap a country to see its Japanese and English name, ISO 3166-1 alpha-2 /
  alpha-3 code and continent. Search by Japanese name, English name or ISO code.
- **Routes between two places, computed on this device.** Pick the start and the
  end by city name (1,251 bundled Natural Earth places, Japanese or English) or
  by tapping the map, optionally avoid ferries, and get the route on the map with
  its distance, an estimated driving time and the main roads used. It needs the
  road network once (below); every route is then calculated locally with A* and
  nothing about the places or the route leaves the device.
- Optional: download more detailed borders (Natural Earth 1:50m, 3.1 MB). This
  is the only network use and goes through the shared Kotoba consent broker
  (below). The downloaded copy is kept in IndexedDB and re-verified on every
  start; it can be removed from the panel.

## Routing scope

Natural Earth 1:10m roads hold highways, main roads and ferries only, so this is
**intercity-scale guidance, not street-level navigation**. The graph merges
vertices at 0.001° and joins a dead end to a road within 3 km that is not already
close along its own line, because Natural Earth lines often stop short of the
road they meet. Times use assumed speeds by road type (90 km/h major highway …
20 km/h ferry) and leave out traffic, signals and rests. Measured on the pinned
data: Tokyo–Osaka 520 km, Paris–Berlin 1,126 km, New York–Los Angeles 4,526 km;
some routes detour where the data has gaps (London–Paris 953 km). Current
location (GPS) and turn-by-turn guidance are not implemented.

## Data

| file | source | license |
|---|---|---|
| `src/data/world-110m.json` (bundled) | Natural Earth 1:110m Admin 0 – Countries, `nvkelso/natural-earth-vector` @ `ca96624a56bd078437bca8184e78163e5039ad19`, input SHA-256 `6866c877…c977f` | public domain |
| `src/data/places-50m.json` (bundled) | Natural Earth 1:50m Populated Places, same revision, input SHA-256 `da4662b7…8ee7` (`scripts/prepare-places.mjs`) | public domain |
| road network download (optional) | same repository and revision, `geojson/ne_10m_roads.geojson`, SHA-256 `66a0c7b4…0248`, 50,474,096 bytes; served gzipped from Yataverse (below); converted on the device to a ~25 MB graph kept in IndexedDB | public domain |
| 1:50m download (optional) | same repository and revision, `geojson/ne_50m_admin_0_countries.geojson`, SHA-256 `3e458fc0…7fdeb`, 3,083,490 bytes; served gzipped from Yataverse (below) | public domain |

### Mirror on Yataverse

The two downloads come from Awai's own content-addressed storage, not GitHub
(AWAI-3464). Each upstream file was gzipped with `gzip -n -9` and stored as one
raw block (CIDv1, raw, sha2-256) on `yataverse.com`; the roads file would not
fit the 16 MiB block limit otherwise, and the download shrinks about 7×.

| file | CID | block SHA-256 | block bytes |
|---|---|---|---|
| 1:50m countries | `bafkreieif7bmrdeglutkvsqaycc7cjlss2ueyx2fjd6f3srzd47el336tq` | `882fc2c8…ef7e9c` | 1,022,494 |
| 1:10m roads | `bafkreif42rfyf2kyupx6crew5btgays52kyx7xx4nslioz2tnero4s63za` | `bcd44b82…bdbc8` | 6,785,581 |

Two pins apply: the broker accepts the block only with the descriptor's SHA-256
(the same digest the CID names; a test checks this), and `src/mirror.js` accepts
the decompressed file only with the upstream Natural Earth size and SHA-256.
The upload returned signed Yataverse storage receipts; a receipt says the
gateway stored and read back the bytes, not that they are retained or replicated.

To re-mirror: download the pinned upstream file, `gzip -n -9 -c`, then
`yataverse put`; the CID must equal the one above.

`scripts/prepare-basemap.mjs <geojson>` regenerates the bundled file and refuses
any input whose digest differs from the pin. Both files go through the same
`compactFromGeoJSON` in `src/geo.js` (integers at 0.01° for 1:110m, 0.001° for
1:50m). Natural Earth shows *de facto* boundaries; it is not a statement on
disputed territory.

## Network and consent

`src/descriptor.json` (`kotoba.app.client-runtime.v1`) declares two operations,
each a fixed `GET https://yataverse.com/ipfs/<cid>` with `consent: each-operation`, data categories `ip-address`, `user-agent`, no
redirects and an artifact pinned by revision, SHA-256 and byte budget:

| operation | capability | file | budget |
|---|---|---|---|
| `download-admin0-countries-50m` | `maps.basemap.download` | `ne_50m_admin_0_countries.geojson` (gzip) | 2,000,000 B |
| `download-roads-10m` | `maps.roads.download` | `ne_10m_roads.geojson` (gzip) | 8,000,000 B |

Approving one does not approve the other; each request asks again. Route
endpoints and results are never sent anywhere.

- The requests are made only by the vendored canonical broker
  (`vendor/kotoba-client-runtime.js`, kotoba-lang/kotoba
  `lib/kotoba.wasmWebcomponent/src` @ `91ed14c0`, digest pinned in
  `vendor/PINS.json`). No product-local consent logic.
- Every download shows the trusted consent dialog. **Deny sends no request.**
- The build derives `connect-src` from the descriptor and fails if the page CSP
  or `src-tauri/tauri.conf.json` differ. Apart from Tauri IPC the only allowed
  origin is `https://yataverse.com`.
- The Tauri window uses `useHttpsScheme`, so the Android WebView origin is
  `https://tauri.localhost`, the origin Yataverse answers with CORS on `/ipfs`.
  Desktop (`tauri://localhost`) and a plain browser get no CORS header there,
  so the two downloads work only in the Android app until Yataverse allows a
  read-only CORS origin for them. Switching the scheme also moved the app's
  IndexedDB to a new origin: state saved by earlier builds is not carried over.
- The page itself uses no `fetch`: data and descriptor are built into ES modules.
- Android requests `INTERNET` only for these two downloads. The Tauri host grants one
  read-only command (`awai_host_info`) and no filesystem, shell, HTTP or
  installer plugin.

Known limits of the road download: the shared runtime bounds a download body to
120 s; at 6.8 MB that needs about 0.5 Mbit/s. Parsing it needs several hundred MB of WebView memory, and on the
arm64 API 35 emulator the conversion took about 4 minutes.

## Build and test

```
npm install
npm test              # static build + node tests (geometry, search, CSP, consent, pins)
npm run build:desktop # native desktop executable, no bundle
npm run build:android # arm64 APK (JDK 21, Android SDK 37, NDK 27.0.12077973)
```

`dist/release.json` lists the SHA-256 of every shipped file. A manifest detects
byte drift; it does not authenticate a publisher. The APK from `build:android`
is unsigned/debug-identity only. Production signing, Itonami Store catalog
enrollment and NixOS packaging are separate release work and are not claimed here.
