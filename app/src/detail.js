// Download the pinned Natural Earth 1:50m countries file from Yataverse
// (mirror.js). It runs only through the shared Kotoba broker, which shows the
// operation, endpoint and data categories and asks every time. Denying sends
// no request. The block is accepted only if its SHA-256 matches the
// descriptor, and the decompressed file must match the upstream digest; the
// copy kept on the device is re-verified the same way on every load.
//
// restricted-wasm-v1 (KOTOBA-159): this runs in the sandboxed guest. The download is one operation
// on the host port (guest-port.js); the canonical broker on the host page asks and verifies. The
// operation is declared only when its recipient's disclosure is confirmed: until then `selector` is
// null and download() refuses before anything is sent.
import { compactFromGeoJSON, basemapProblems } from "./geo.js";
import { MIRRORED, upstreamFile } from "./mirror.js";

const KEY = "detail:ne_50m_admin_0_countries";

export function detailOperation(candidates) {
  const op = candidates.operations.find((o) => o.operation === "download-admin0-countries-50m");
  if (!op) throw new Error("detail operation is not a candidate");
  return op;
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
/** The artifact pin, checked on bytes already on this device (the guest has no runtime of its own). */
export async function verifyPinnedBytes(bytes, declaration) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > declaration["max-bytes"]) throw new Error("detail data exceeds its byte budget");
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (sha256 !== declaration.sha256) throw new Error("detail data digest mismatch");
  return { blob: new Blob([bytes]), sha256, revision: declaration.revision, verified: true };
}

export async function decodeDetail(bytes, op) {
  const verified = await verifyPinnedBytes(bytes, op.artifact);
  const file = await upstreamFile(verified.blob, op.operation);
  const geojson = JSON.parse(new TextDecoder().decode(file));
  const map = compactFromGeoJSON(geojson, {
    scale: 1000,
    source: {
      name: "Natural Earth 1:50m Admin 0 – Countries",
      license: "Public domain (https://www.naturalearthdata.com/about/terms-of-use/)",
      revision: op.artifact.revision, sha256: MIRRORED[op.operation].upstreamSha256,
      mirror: { cid: MIRRORED[op.operation].cid, sha256: verified.sha256 },
    },
  });
  const problems = basemapProblems(map);
  if (problems.length) throw new Error(`downloaded data is not a usable basemap (${problems[0]})`);
  return map;
}

export function createDetailSource({ op, selector, invoke, store }) {
  return {
    operation: op,
    /** Detail data already on this device, re-verified; null if none. */
    async loadSaved() {
      const saved = await store.get(KEY);
      if (!(saved instanceof Uint8Array)) return null;
      try { return await decodeDetail(saved, op); }
      catch { await store.delete(KEY); return null; }
    },
    /** Ask for consent, download, verify and keep. Throws if denied or invalid. */
    declared: Boolean(selector),
    async download(signal) {
      if (!selector) throw new Error("この取得は、送り先が確定するまで宣言されていません");
      const artifact = await invoke(selector, { input: op.endpoint.origin + op.endpoint.path }, { signal });
      const bytes = new Uint8Array(await artifact.blob.arrayBuffer());
      const map = await decodeDetail(bytes, op);
      const kept = await store.set(KEY, bytes);
      return { map, kept };
    },
    async forget() { return store.delete(KEY); },
  };
}
