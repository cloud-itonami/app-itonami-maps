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
import { execFileSync } from "node:child_process";
import { bundleModules } from "./guest-bundle.mjs";
import { checkNoSubmit } from "./check-no-submit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = resolve(root, "dist");
const meta = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const app = meta.itonami;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const pins = JSON.parse(await readFile(resolve(root, "vendor/PINS.json"), "utf8"));
for (const [name, digest] of Object.entries(pins.files)) {
  if (sha(await readFile(resolve(root, "vendor", name))) !== digest) throw new Error(`canonical runtime pin drift: ${name}`);
}

// restricted-wasm-v1 (KOTOBA-159). The candidate operations (src/candidates.json) are declared only
// when their service has a confirmed disclosure (src/disclosures.json); the Yataverse operator is not
// confirmed yet (Itonami item 68), so today nothing is declared and the app makes no request.
const candidates = JSON.parse(await readFile(resolve(root, "src/candidates.json"), "utf8"));
const disclosures = JSON.parse(await readFile(resolve(root, "src/disclosures.json"), "utf8")).services;
const declaredOps = candidates.operations.filter((op) => disclosures[op.service]).map((op) => ({ ...op, disclosure: disclosures[op.service] }));
// The sandboxed guest has no storage until the runtime's host-mediated storage (KOTOBA-968).
export const descriptor = {
  schema: "kotoba.app.client-runtime.v1", target: "browser", profile: "restricted-wasm-v1", entry: "index.html",
  "local-state": { adapter: "memory", schema: "itonami.maps.v1", version: 1 }, workers: [], operations: declaredOps,
};
const capabilities = descriptor.operations.map((op) => op.capability);
const problems = clientRuntimeProblems(descriptor, capabilities, []);
if (problems.length) throw new Error(`invalid descriptor: ${JSON.stringify(problems)}`);
export const connectSrc = clientRuntimeConnectSrc(descriptor, capabilities, [], []).replace(/^connect-src /, "");
const selector = (name) => { const op = declaredOps.find((o) => o.operation === name); return op ? { capability: op.capability, service: op.service, operation: op.operation } : null; };
const operations = { detail: selector("download-admin0-countries-50m"), roads: selector("download-roads-10m") };

// The guest: guest.html with the app's modules inlined (guest-bundle.mjs) and style.css inline.
const modules = {};
for (const name of ["app.js", "geo.js", "map.js", "store.js", "detail.js", "route.js", "roads.js", "mirror.js", "guest-port.js"]) modules[name] = await readFile(resolve(root, "src", name), "utf8");
modules["candidates.js"] = `export default ${JSON.stringify(candidates)};\n`;
modules["operations.js"] = `export default ${JSON.stringify(operations)};\n`;
modules["basemap.js"] = `export default ${(await readFile(resolve(root, "src/data/world-110m.json"), "utf8")).trim()};\n`;
modules["places.js"] = `export default ${(await readFile(resolve(root, "src/data/places-50m.json"), "utf8")).trim()};\n`;
export const guestScript = bundleModules(modules, "app.js");
checkNoSubmit(guestScript, "the restricted guest script");
export const guestStyle = await readFile(resolve(root, "src/style.css"), "utf8");
if (/<\/style/i.test(guestStyle)) throw new Error("src/style.css contains </style");
const cspHash = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const preamble = /^const GUEST_PREAMBLE = '<script>([^'\\]*)<\/script>';$/m.exec(await readFile(resolve(root, "vendor/kotoba-client-runtime.js"), "utf8"))?.[1];
if (!preamble) throw new Error("the canonical runtime has no GUEST_PREAMBLE this build can hash");
export const CSP = `default-src 'none'; script-src 'self' ${cspHash(preamble)} ${cspHash(guestScript)}; style-src 'self' ${cspHash(guestStyle)}; img-src 'self' data:; connect-src ipc: http://ipc.localhost${connectSrc === "'none'" ? "" : " " + connectSrc}; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
const confPath = resolve(root, "src-tauri/tauri.conf.json");
const conf = JSON.parse(await readFile(confPath, "utf8"));
if (conf.app.security.csp !== CSP) {
  if (!process.argv.includes("--update-csp")) throw new Error("tauri.conf.json CSP is not the one derived from the descriptor and the guest; run `node scripts/build.mjs --update-csp` and commit it");
  conf.app.security.csp = CSP;
  await writeFile(confPath, JSON.stringify(conf) + "\n");
}
let commit = null; let dirty = false;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "";
} catch { commit = process.env.ITONAMI_SOURCE_COMMIT ?? null; dirty = process.env.ITONAMI_SOURCE_DIRTY === "true"; }
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("restricted-wasm-v1 pins the guest to its source commit: build from a git checkout or set ITONAMI_SOURCE_COMMIT");
const template = await readFile(resolve(root, "src/guest.html"), "utf8");
for (const marker of ["{{STYLE}}", "{{SCRIPT}}"]) if (template.split(marker).length !== 2) throw new Error(`guest.html must contain ${marker} once`);
export const guest = template.replace("{{STYLE}}", () => guestStyle).replace("{{SCRIPT}}", () => guestScript);
checkNoSubmit(guest, "the restricted guest");
if (guest.length > 8388608) throw new Error("the guest exceeds the 8 MiB mount budget");
const guestBytes = new TextEncoder().encode(guest);
const artifact = { revision: commit, sha256: sha(guestBytes), "max-bytes": guestBytes.byteLength };
const foreign = declaredOps.map((o) => o.disclosure?.["foreign-info-url"]).find(Boolean);
const foreignInfo = foreign ? (() => { const u = new URL(foreign); u.hash = ""; return u.href; })() : null;

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const host = await readFile(resolve(root, "src/host.html"), "utf8");
if (host.split("@CSP@").length !== 2) throw new Error("host.html has no CSP build marker");
await writeFile(join(out, "index.html"), host.replace("@CSP@", () => CSP));
const hostSources = ["host.js", "host.css", "allowed-sending.js"];
for (const name of hostSources) await copyFile(resolve(root, "src", name), join(out, name));
for (const name of Object.keys(pins.files)) await copyFile(resolve(root, "vendor", name), join(out, name));
await writeFile(join(out, "descriptor.json"), JSON.stringify(descriptor, null, 2) + "\n");
await writeFile(join(out, "host-data.js"), `export default ${JSON.stringify({ descriptor, artifact, guest, foreignInfo }, null, 1)};\n`);
const names = ["index.html", ...hostSources, ...Object.keys(pins.files), "descriptor.json", "host-data.js"];
const files = {};
for (const name of names) files[name] = sha(await readFile(join(out, name)));
await writeFile(join(out, "release.json"), JSON.stringify({
  schema: "awai.app.artifact.v1", id: app.id, version: meta.version, tauri: "3.0.0-alpha.6", profile: descriptor.profile, runtimePins: pins,
  guest: artifact, source_commit: commit, dirty, files,
}, null, 2) + "\n");
console.log(`${app.title} static build (${descriptor.profile}): ${names.length} pinned files, ${declaredOps.length} declared operations, guest ${guestBytes.byteLength} bytes`);
