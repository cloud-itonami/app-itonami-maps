// restricted-wasm-v1 (KOTOBA-159): the guest artifact, the release gate, and the disabled features
// tied to the code.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as runtime from "../vendor/kotoba-client-runtime.js";
import { deployAllowed, disabledFeatures } from "../scripts/deploy-gate.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

test("the guest is one self-contained document, pinned and verified by the canonical runtime", async () => {
  const { default: host } = await import(new URL("dist/host-data.js", root));
  const release = JSON.parse(await read("dist/release.json"));
  assert.deepEqual(release.guest, host.artifact);
  assert.match(host.artifact.revision, /^[0-9a-f]{40}$/);
  assert.ok(host.guest.length <= 8388608);
  assert.equal((await runtime.verifyClientArtifact(new TextEncoder().encode(host.guest), host.artifact)).verified, true);
  await assert.rejects(runtime.verifyClientArtifact(new TextEncoder().encode(host.guest.replace("地図", "地団")), host.artifact), /digest mismatch/);
  const scripts = [...host.guest.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  assert.ok(!/<link\b|<script\b[^>]*\bsrc=/i.test(host.guest));
  assert.ok(scripts[0][2].includes('{"detail":null,"roads":null}'), "both downloads arrive as null while undeclared");
  const file = join(tmpdir(), `maps-guest-${process.pid}.mjs`);
  await writeFile(file, scripts[0][2]);
  execFileSync(process.execPath, ["--check", file]);
});

test("release gate: blocked while a feature from before the move is off (negative control)", async () => {
  const ok200 = async () => new Response("", { status: 200 });
  assert.equal((await deployAllowed({ fetchImpl: ok200 })).ok, false);
  assert.deepEqual(await deployAllowed({ fetchImpl: ok200, features: [] }), { ok: true, reasons: [] });
  const pkg = JSON.parse(await read("package.json"));
  for (const s of ["build:desktop", "build:android"]) assert.ok(pkg.scripts[s].startsWith("node scripts/deploy-gate.mjs && "), s);
});

test("the disabled features match the code", async () => {
  const ids = (await disabledFeatures()).map((f) => f.id);
  const descriptor = JSON.parse(await read("dist/descriptor.json"));
  const declared = (name) => descriptor.operations.some((o) => o.operation === name);
  assert.equal(ids.includes("detail-download"), !declared("download-admin0-countries-50m"));
  assert.equal(ids.includes("route-search"), !declared("download-roads-10m"));
  assert.equal(ids.includes("kept-on-device"), descriptor["local-state"].adapter === "memory");
});
