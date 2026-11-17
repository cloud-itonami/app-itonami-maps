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

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFile(resolve(root, p), "utf8");
const descriptor = JSON.parse(await read("src/descriptor.json"));
const op = detailOperation(descriptor);

test("the descriptor declares exactly one pinned, read-only download", () => {
  assert.deepEqual(clientRuntimeProblems(descriptor, [op.capability], []), []);
  assert.equal(descriptor.operations.length, 1);
  assert.equal(op.consent, "each-operation");
  assert.equal(op.endpoint.method, "GET");
  assert.equal(op.endpoint.origin, "https://raw.githubusercontent.com");
  assert.ok(op.endpoint.path.includes(op.artifact.revision), "the path is pinned to the same revision");
  assert.equal(op["redirect-origins"], undefined, "no redirect is followed");
  assert.equal(descriptor.workers.length, 0);
  assert.equal(descriptor["local-state"].adapter, "indexeddb");
});

test("page and Tauri CSP allow only the declared origin besides IPC", async () => {
  const derived = clientRuntimeConnectSrc(descriptor, [op.capability], [], []);
  assert.equal(derived, "connect-src https://raw.githubusercontent.com");
  const html = await read("src/index.html");
  const conf = JSON.parse(await read("src-tauri/tauri.conf.json"));
  for (const csp of [html.match(/Content-Security-Policy" content="([^"]+)"/)[1], conf.app.security.csp]) {
    const connect = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("connect-src"));
    assert.equal(connect, "connect-src ipc: http://ipc.localhost https://raw.githubusercontent.com");
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
async function brokerWith(answer) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { calls.push(String(input?.url ?? input)); return new Response("{}"); };
  try {
    const runtime = await import("../vendor/kotoba-client-runtime.js");
    const host = fakeConsentHost(runtime, answer);
    const broker = createClientOperationBroker({
      runtime: descriptor, requestedCapabilities: [op.capability], approvedOperations: [op],
      hostSupportedOperations: [[op.capability, op.service, op.operation]], consentHost: host.handle,
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

test("an undeclared request is refused before any dialog or request", async () => {
  const { broker, calls, host, restore } = await brokerWith("deny");
  try {
    const sel = { capability: op.capability, service: op.service, operation: op.operation };
    await assert.rejects(broker.invoke(sel, { input: `${op.endpoint.origin}/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson` }), /does not match/);
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

test("the real pinned 1:50m file decodes to a usable basemap", { skip: !(await exists("../.agent-output/ne/ne_50m_admin_0_countries.geojson")) && "pinned 1:50m file not downloaded locally" }, async () => {
  const bytes = new Uint8Array(await readFile(resolve(root, "../.agent-output/ne/ne_50m_admin_0_countries.geojson")));
  const map = await decodeDetail(bytes, op);
  assert.ok(map.countries.length > 200);
  assert.equal(map.source.sha256, op.artifact.sha256);
});

async function exists(p) { try { await readFile(resolve(root, p)); return true; } catch { return false; } }
