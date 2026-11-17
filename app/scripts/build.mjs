// Static build: dist/ holds the whole app for the Tauri v3 shell and for a
// plain static host. No bundler and no runtime dependency.
// - The shared Kotoba client runtime is copied from vendor/ only if its digest
//   matches vendor/PINS.json.
// - descriptor.json is validated by that runtime, and the page and Tauri CSP
//   must carry exactly the connect-src it derives from the declared operations.
// - JSON data becomes ES modules, so the page needs no fetch at all.
import { mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { clientRuntimeProblems, clientRuntimeConnectSrc } from "../vendor/kotoba-client-runtime.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = resolve(root, "dist");
const meta = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const app = meta.itonami;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const pins = JSON.parse(await readFile(resolve(root, "vendor/PINS.json"), "utf8"));
for (const [name, digest] of Object.entries(pins.files)) {
  if (sha(await readFile(resolve(root, "vendor", name))) !== digest) throw new Error(`canonical runtime pin drift: ${name}`);
}

const descriptor = JSON.parse(await readFile(resolve(root, "src/descriptor.json"), "utf8"));
const capabilities = descriptor.operations.map((op) => op.capability);
const problems = clientRuntimeProblems(descriptor, capabilities, []);
if (problems.length) throw new Error(`invalid descriptor: ${JSON.stringify(problems)}`);
export const connectSrc = clientRuntimeConnectSrc(descriptor, capabilities, [], []).replace(/^connect-src /, "");
export const CSP = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost ${connectSrc}; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
const html = await readFile(resolve(root, "src/index.html"), "utf8");
if (!html.includes(`content="${CSP}"`)) throw new Error("index.html CSP is not the one derived from descriptor.json");
const conf = JSON.parse(await readFile(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
if (conf.app.security.csp !== CSP) throw new Error("tauri.conf.json CSP is not the one derived from descriptor.json");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const sources = ["index.html", "style.css", "app.js", "geo.js", "map.js", "store.js", "detail.js", "route.js", "roads.js"];
for (const name of sources) await copyFile(resolve(root, "src", name), join(out, name));
for (const name of Object.keys(pins.files)) await copyFile(resolve(root, "vendor", name), join(out, name));
await writeFile(join(out, "descriptor.json"), JSON.stringify(descriptor, null, 2) + "\n");
await writeFile(join(out, "descriptor.js"), `export default ${JSON.stringify(descriptor)};\n`);
const basemap = (await readFile(resolve(root, "src/data/world-110m.json"), "utf8")).trim();
await writeFile(join(out, "basemap.js"), `export default ${basemap};\n`);
const placeList = (await readFile(resolve(root, "src/data/places-50m.json"), "utf8")).trim();
await writeFile(join(out, "places.js"), `export default ${placeList};\n`);

const names = [...sources, ...Object.keys(pins.files), "descriptor.json", "descriptor.js", "basemap.js", "places.js"];
const files = {};
for (const name of names) files[name] = sha(await readFile(join(out, name)));
await writeFile(join(out, "release.json"), JSON.stringify({
  schema: "awai.app.artifact.v1", id: app.id, version: meta.version, tauri: "3.0.0-alpha.6", runtimePins: pins, files,
}, null, 2) + "\n");
console.log(`${app.title} static build: ${names.length} pinned files`);
