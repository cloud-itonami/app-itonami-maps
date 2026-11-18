# Natural Earth on Yataverse — evidence of 2026-11-18

Tracking: [AWAI-3464](https://linear.app/kotobalabs/issue/AWAI-3464).

## Mirror

Upstream: `nvkelso/natural-earth-vector@ca96624a56bd078437bca8184e78163e5039ad19`, downloaded
again and checked against the pinned digests, then `gzip -n -9 -c` and `yataverse put`
(read back and CID recomputed by the CLI; signed storage receipt verified).

| file | upstream SHA-256 / bytes | block CID | block bytes | receipt request id |
| -- | -- | -- | -- | -- |
| ne_50m_admin_0_countries | `3e458fc0…7fdeb` / 3,083,490 | `bafkreieif7bmrdeglutkvsqaycc7cjlss2ueyx2fjd6f3srzd47el336tq` | 1,022,494 | `0xf01a6f0940aa323a330db0373c3a3ef89b35a9e20257e8f2c7a7b54d88fa99c3` |
| ne_10m_roads | `66a0c7b4…0248` / 50,474,096 | `bafkreif42rfyf2kyupx6crew5btgays52kyx7xx4nslioz2tnero4s63za` | 6,785,581 | `0xa7ebb9e407fb84a438abe19bddc24032cde148151b6190e9f52792d165dcc4a1` |

An independent `curl https://yataverse.com/ipfs/<cid> | shasum -a 256` matched both blocks.
CORS on `/ipfs/<cid>`: `Access-Control-Allow-Origin` only for `https://tauri.localhost`;
none for `http://tauri.localhost`, `tauri://localhost` or a localhost dev server.

## App

`npm test`: 28 pass, including decoding both real blocks and a check that each CID names the
descriptor's SHA-256. Clean debug APK (shared AWAI-3393 lock): LOAD `Align 0x4000`,
`zipalign -c -P 16` OK, APK sha256 `d7a6f65d2908932a4af554b15000f8fba4722e0305afc21f08f018aa757ef0dc`.

Disposable Android 15 AVD (deleted afterwards), window on `https://tauri.localhost`:

1. Road download: the consent dialog names service `yataverse` and `GET /ipfs/bafkreif42…`
   (`02-consent.jpg`). Allow once → downloaded, both digests checked, converted on the device:
   650,631 nodes, the same count as the earlier GitHub-sourced build, in under a minute
   (`04-roads-done.jpg`).
2. Border download: Allow once → map attribution switches to Natural Earth 1:50m.
3. Force-stop and relaunch: both are reloaded from the device; host IPC still reports
   `network.itonami.maps` (`07-restart.jpg`).

## Not established

- Desktop (`tauri://localhost`) and plain-browser downloads: blocked by CORS until Yataverse
  allows a read-only origin for them.
- Retention or replication of the blocks: a receipt covers store-and-read-back only.
- A physical device.
