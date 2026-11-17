# 地図 (Maps) — Awai app

A world map that runs on the user's device: a Tauri **3.0.0-alpha.6** app
(`tauri-runtime-wry`, OS WebView) for Android and desktop, and the same static
files for a plain static host. Tracking: AWAI-3143 (parent AWAI-3142).

## What it does

- Shows the whole world with country borders, works with no network.
- Drag to pan (the world wraps east–west), wheel / pinch / double-click / `+` `−`
  buttons to zoom, arrow keys and `+` `-` `0` on the focused map.
- Tap a country to see its Japanese and English name, ISO 3166-1 alpha-2 /
  alpha-3 code and continent. Search by Japanese name, English name or ISO code.
- Optional: download more detailed borders (Natural Earth 1:50m, 3.1 MB). This
  is the only network use and goes through the shared Kotoba consent broker
  (below). The downloaded copy is kept in IndexedDB and re-verified on every
  start; it can be removed from the panel.

## Data

| file | source | license |
|---|---|---|
| `src/data/world-110m.json` (bundled) | Natural Earth 1:110m Admin 0 – Countries, `nvkelso/natural-earth-vector` @ `ca96624a56bd078437bca8184e78163e5039ad19`, input SHA-256 `6866c877…c977f` | public domain |
| 1:50m download (optional) | same repository and revision, `geojson/ne_50m_admin_0_countries.geojson`, SHA-256 `3e458fc0…7fdeb`, 3,083,490 bytes | public domain |

`scripts/prepare-basemap.mjs <geojson>` regenerates the bundled file and refuses
any input whose digest differs from the pin. Both files go through the same
`compactFromGeoJSON` in `src/geo.js` (integers at 0.01° for 1:110m, 0.001° for
1:50m). Natural Earth shows *de facto* boundaries; it is not a statement on
disputed territory.

## Network and consent

`src/descriptor.json` (`kotoba.app.client-runtime.v1`) declares one operation:
`GET https://raw.githubusercontent.com/nvkelso/natural-earth-vector/<pinned revision>/geojson/ne_50m_admin_0_countries.geojson`,
`consent: each-operation`, data categories `ip-address`, `user-agent`, no
redirects, artifact pinned by revision, SHA-256 and a 4,000,000-byte budget.

- The request is made only by the vendored canonical broker
  (`vendor/kotoba-client-runtime.js`, kotoba-lang/kotoba
  `lib/kotoba.wasmWebcomponent/src` @ `91ed14c0`, digest pinned in
  `vendor/PINS.json`). No product-local consent logic.
- Every download shows the trusted consent dialog. **Deny sends no request.**
- The build derives `connect-src` from the descriptor and fails if the page CSP
  or `src-tauri/tauri.conf.json` differ. Apart from Tauri IPC the only allowed
  origin is `https://raw.githubusercontent.com`.
- The page itself uses no `fetch`: data and descriptor are built into ES modules.
- Android requests `INTERNET` only for this download. The Tauri host grants one
  read-only command (`awai_host_info`) and no filesystem, shell, HTTP or
  installer plugin.

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
