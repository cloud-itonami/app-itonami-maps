// Turn a downloaded Natural Earth admin-0 countries GeoJSON into the bundled
// compact basemap. Run by hand when the pinned source changes; the output is
// committed. The input digest must match the pin below, so a different file
// cannot be bundled silently.
//
//   node scripts/prepare-basemap.mjs <ne_110m_admin_0_countries.geojson>
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { compactFromGeoJSON, basemapProblems } from "../src/geo.js";

export const SOURCE = {
  name: "Natural Earth 1:110m Admin 0 – Countries",
  license: "Public domain (https://www.naturalearthdata.com/about/terms-of-use/)",
  repository: "https://github.com/nvkelso/natural-earth-vector",
  revision: "ca96624a56bd078437bca8184e78163e5039ad19",
  path: "geojson/ne_110m_admin_0_countries.geojson",
  sha256: "6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f",
};

const input = process.argv[2];
if (!input) throw new Error("usage: prepare-basemap.mjs <ne_110m_admin_0_countries.geojson>");
const bytes = await readFile(input);
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== SOURCE.sha256) throw new Error(`input digest ${digest} does not match the pinned source`);
const map = compactFromGeoJSON(JSON.parse(bytes.toString("utf8")), { scale: 100, source: SOURCE });
const problems = basemapProblems(map);
if (problems.length) throw new Error(`invalid basemap: ${problems.slice(0, 5).join(", ")}`);
const out = resolve(fileURLToPath(new URL("../src/data/world-110m.json", import.meta.url)));
await writeFile(out, JSON.stringify(map) + "\n");
console.log(`${map.countries.length} countries → ${out}`);
