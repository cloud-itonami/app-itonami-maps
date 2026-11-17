// Turn Natural Earth 1:50m populated places into the bundled place list used
// for route search. Run by hand when the pinned source changes; the output is
// committed. The input digest must match the pin.
//
//   node scripts/prepare-places.mjs <ne_50m_populated_places.geojson>
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { compactPlaces } from "../src/route.js";

export const SOURCE = {
  name: "Natural Earth 1:50m Populated Places",
  license: "Public domain (https://www.naturalearthdata.com/about/terms-of-use/)",
  repository: "https://github.com/nvkelso/natural-earth-vector",
  revision: "ca96624a56bd078437bca8184e78163e5039ad19",
  path: "geojson/ne_50m_populated_places.geojson",
  sha256: "da4662b7bbfeb897d02f228c5839131dce27acff5717630f91ccff4f67828ee7",
};

const input = process.argv[2];
if (!input) throw new Error("usage: prepare-places.mjs <ne_50m_populated_places.geojson>");
const bytes = await readFile(input);
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== SOURCE.sha256) throw new Error(`input digest ${digest} does not match the pinned source`);
const list = compactPlaces(JSON.parse(bytes.toString("utf8")), { source: SOURCE });
if (list.places.length < 1000) throw new Error("too few places");
const out = fileURLToPath(new URL("../src/data/places-50m.json", import.meta.url));
await writeFile(out, JSON.stringify(list) + "\n");
console.log(`${list.places.length} places → ${out}`);
