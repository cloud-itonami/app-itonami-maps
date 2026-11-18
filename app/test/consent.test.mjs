// The single external operation: declared, CSP-bounded, digest-pinned, and
// never sent without an explicit Allow. Run after `npm run build`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { clientRuntimeProblems, clientRuntimeConnectSrc, createClientOperationBroker, verifyClientArtifact } from "../vendor/kotoba-client-runtime.js";
import { decodeDetail, detailOperation } from "../dist/detail.js";
import { roadsOperation, graphFromArtifact } from "../dist/roads.js";
import { MIRRORED, upstreamFile } from "../dist/mirror.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFile(resolve(root, p), "utf8");
const descriptor = JSON.parse(await read("src/descriptor.json"));
const op = detailOperation(descriptor);
const roadsOp = roadsOperation(descriptor);
const capabilities = descriptor.operations.map((o) => o.capability);

test("the descriptor declares exactly two pinned, read-only downloads", () => {
  assert.deepEqual(clientRuntimeProblems(descriptor, capabilities, []), []);
  assert.equal(descriptor.operations.length, 2);
  for (const o of [op, roadsOp]) {
    assert.equal(o.consent, "each-operation");
    assert.equal(o.endpoint.method, "GET");
    assert.equal(o.endpoint.origin, "https://yataverse.com", "served from Awai's own storage");
    assert.equal(o.endpoint.path, `/ipfs/${MIRRORED[o.operation].cid}`);
    assert.equal(o.service, "yataverse");
    assert.equal(o["redirect-origins"], undefined, "no redirect is followed");
    assert.deepEqual(o["data-categories"], ["ip-address", "user-agent"], "no location or route data is sent");
  }
  assert.notEqual(op.capability, roadsOp.capability, "each download is approved on its own");
  assert.match(MIRRORED[roadsOp.operation].upstream, /geojson\/ne_10m_roads\.geojson$/);
  assert.match(MIRRORED[op.operation].upstream, /geojson\/ne_50m_admin_0_countries\.geojson$/);
  assert.equal(descriptor.workers.length, 0);
  assert.equal(descriptor["local-state"].adapter, "indexeddb");
});

test("page and Tauri CSP allow only the declared origin besides IPC", async () => {
  const derived = clientRuntimeConnectSrc(descriptor, capabilities, [], []);
  assert.equal(derived, "connect-src https://yataverse.com");
  const html = await read("src/index.html");
  const conf = JSON.parse(await read("src-tauri/tauri.conf.json"));
  for (const csp of [html.match(/Content-Security-Policy" content="([^"]+)"/)[1], conf.app.security.csp]) {
    const connect = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("connect-src"));
    assert.equal(connect, "connect-src ipc: http://ipc.localhost https://yataverse.com");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self';/);
  }
});

test("only the vendored broker issues network requests", async () => {
  for (const name of await readdir(resolve(root, "dist"))) {
    if (!name.endsWith(".js") || name === "kotoba-client-runtime.js") continue;
    const src = await read(join("dist", name));
    for (const api of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /\bEventSource\b/, /sendBeacon/, /import\s*\(\s*["'`]https?:/, /from\s+["']https?:/]) {
      assert.ok(!api.test(src), `${name} uses ${api}`);
    }
  }
});

test("the Tauri host grants only the read-only host-info command", async () => {
  for (const name of await readdir(resolve(root, "src-tauri/capabilities"))) {
    assert.deepEqual(JSON.parse(await read(join("src-tauri/capabilities", name))).permissions, ["allow-awai-host-info"]);
  }
  const cargo = await read("src-tauri/Cargo.toml");
  assert.match(cargo, /tauri = \{ version = "=3\.0\.0-alpha\.6"/);
  assert.doesNotMatch(cargo, /tauri-plugin-(http|fs|shell)/);
});

test("release manifest pins every shipped file and the vendored runtime", async () => {
  const release = JSON.parse(await read("dist/release.json"));
  for (const name of await readdir(resolve(root, "dist"))) if (name !== "release.json") assert.ok(release.files[name], `${name} is not pinned`);
  const pins = JSON.parse(await read("vendor/PINS.json"));
  for (const [name, digest] of Object.entries(pins.files)) {
    assert.equal(createHash("sha256").update(await readFile(resolve(root, "vendor", name))).digest("hex"), digest);
  }
});

// A stand-in for the trusted consent host: the broker accepts only hosts that
// the runtime itself registered, so build one with a fake document whose
// dialog we drive. Denying must leave fetch untouched.
async function brokerWith(answer, operation = op) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { calls.push(String(input?.url ?? input)); return new Response("{}"); };
  try {
    const runtime = await import("../vendor/kotoba-client-runtime.js");
    const host = fakeConsentHost(runtime, answer);
    const broker = createClientOperationBroker({
      runtime: descriptor, requestedCapabilities: capabilities, approvedOperations: [operation],
      hostSupportedOperations: [[operation.capability, operation.service, operation.operation]], consentHost: host.handle,
    });
    return { broker, calls, host, restore: () => { globalThis.fetch = originalFetch; } };
  } catch (error) { globalThis.fetch = originalFetch; throw error; }
}

function fakeConsentHost(runtime, answer) {
  const listeners = new Map();
  const node = (tag) => {
    const el = {
      tag, children: [], attributes: {}, disabled: false, open: false, textContent: "", isConnected: true,
      append: (...c) => el.children.push(...c), setAttribute: (k, v) => { el.attributes[k] = v; },
      addEventListener: (type, fn) => listeners.set(`${tag}:${el.textContent || type}:${type}`, fn),
      focus() {}, remove() { el.isConnected = false; },
      showModal() { el.open = true; seen.push(true); queueMicrotask(() => respond()); },
      close() { el.open = false; },
    };
    return el;
  };
  const seen = [];
  const doc = { body: node("body"), createElement: node, defaultView: { performance, MouseEvent: class {} } };
  let dialog;
  const realCreate = doc.createElement;
  doc.createElement = (tag) => { const el = realCreate(tag); if (tag === "dialog") dialog = el; return el; };
  const previous = globalThis.document;
  globalThis.document = doc;
  let handle;
  try { handle = runtime.createClientConsentHost({ document: doc }); }
  finally { globalThis.document = previous; }
  function respond() {
    // A script can only deny: Allow counts only after a trusted press.
    if (answer === "deny") listeners.get("button:Deny:click")({});
  }
  void dialog;
  return { handle, seen };
}

test("denying the consent dialog sends no request", async () => {
  const { broker, calls, host, restore } = await brokerWith("deny");
  try {
    await assert.rejects(broker.invoke({ capability: op.capability, service: op.service, operation: op.operation }, { input: op.endpoint.origin + op.endpoint.path }), /not approved/);
    assert.equal(host.seen.length, 1, "the dialog was shown");
    assert.deepEqual(calls, [], "no request was sent");
  } finally { restore(); }
});

test("denying the road download sends no request", async () => {
  const { broker, calls, host, restore } = await brokerWith("deny", roadsOp);
  try {
    await assert.rejects(broker.invoke({ capability: roadsOp.capability, service: roadsOp.service, operation: roadsOp.operation }, { input: roadsOp.endpoint.origin + roadsOp.endpoint.path }), /not approved/);
    assert.equal(host.seen.length, 1);
    assert.deepEqual(calls, []);
    // The border download is a different operation: approval of one cannot be used for the other.
    await assert.rejects(broker.invoke({ capability: op.capability, service: op.service, operation: op.operation }, { input: op.endpoint.origin + op.endpoint.path }), /not eligible/);
  } finally { restore(); }
});

test("road data is used only from a verified artifact with the pinned digest", async () => {
  await assert.rejects(graphFromArtifact({ verified: false, sha256: roadsOp.artifact.sha256, blob: new Blob(["{}"]) }, roadsOp), /not verified/);
  await assert.rejects(graphFromArtifact({ verified: true, sha256: "0".repeat(64), blob: new Blob(["{}"]) }, roadsOp), /not verified/);
});

test("an undeclared request is refused before any dialog or request", async () => {
  const { broker, calls, host, restore } = await brokerWith("deny");
  try {
    const sel = { capability: op.capability, service: op.service, operation: op.operation };
    await assert.rejects(broker.invoke(sel, { input: `${op.endpoint.origin}/ipfs/${MIRRORED[roadsOp.operation].cid}` }), /does not match/);
    await assert.rejects(broker.invoke(sel, { input: "https://example.com" + op.endpoint.path }), /does not match/);
    await assert.rejects(broker.invoke({ ...sel, operation: "other" }, { input: op.endpoint.origin + op.endpoint.path }), /not eligible/);
    assert.equal(host.seen.length, 0);
    assert.deepEqual(calls, []);
  } finally { restore(); }
});

test("downloaded bytes are accepted only with the pinned digest", async () => {
  const sample = new TextEncoder().encode(JSON.stringify({ type: "FeatureCollection", features: [] }));
  await assert.rejects(decodeDetail(sample, op), /digest mismatch/);
  await assert.rejects(verifyClientArtifact(new Uint8Array(op.artifact["max-bytes"] + 1), op.artifact), /byte budget/);
});

// A CIDv1 raw/sha2-256 names the block's SHA-256: base32 of 0x01 0x55 0x12 0x20 <digest>.
function cidDigest(cid) {
  assert.match(cid, /^b[a-z2-7]+$/);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0; const out = [];
  for (const ch of cid.slice(1)) { value = (value << 5) | alphabet.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >> (bits - 8)) & 255); bits -= 8; } }
  assert.deepEqual(out.slice(0, 4), [0x01, 0x55, 0x12, 0x20], "CIDv1, raw codec, sha2-256");
  return Buffer.from(out.slice(4, 36)).toString("hex");
}

test("each Yataverse CID names exactly the digest the descriptor pins", () => {
  for (const o of [op, roadsOp]) assert.equal(cidDigest(MIRRORED[o.operation].cid), o.artifact.sha256);
});

test("a block that is not the gzipped Natural Earth file is refused", async () => {
  await assert.rejects(upstreamFile(new Blob(["not gzip"]), op.operation), /not valid gzip/);
  const other = await new Response(new Blob(["{}"]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
  await assert.rejects(upstreamFile(other, op.operation), /does not match the Natural Earth file/);
  await assert.rejects(upstreamFile(other, "unknown-op"), /no mirror pin/);
});

const NE = "../.agent-output/ne";
test("the real 1:50m block decodes to a usable basemap", { skip: !(await exists(`${NE}/ne_50m_admin_0_countries.geojson.gz`)) && "mirrored 1:50m block not downloaded locally" }, async () => {
  const bytes = new Uint8Array(await readFile(resolve(root, `${NE}/ne_50m_admin_0_countries.geojson.gz`)));
  const map = await decodeDetail(bytes, op);
  assert.ok(map.countries.length > 200);
  assert.equal(map.source.sha256, MIRRORED[op.operation].upstreamSha256);
  assert.equal(map.source.mirror.sha256, op.artifact.sha256);
});

test("the real 1:10m roads block decompresses to the pinned upstream file", { skip: !(await exists(`${NE}/ne_10m_roads.geojson.gz`)) && "mirrored roads block not downloaded locally" }, async () => {
  const bytes = await readFile(resolve(root, `${NE}/ne_10m_roads.geojson.gz`));
  const file = await upstreamFile(new Blob([bytes]), roadsOp.operation);
  assert.equal(file.byteLength, MIRRORED[roadsOp.operation].upstreamBytes);
});

async function exists(p) { try { await readFile(resolve(root, p)); return true; } catch { return false; } }
