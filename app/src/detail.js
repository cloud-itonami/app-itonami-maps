// Download the pinned Natural Earth 1:50m countries file from Yataverse
// (mirror.js). It runs only through the shared Kotoba broker, which shows the
// operation, endpoint and data categories and asks every time. Denying sends
// no request. The block is accepted only if its SHA-256 matches the
// descriptor, and the decompressed file must match the upstream digest; the
// copy kept on the device is re-verified the same way on every load.
import { createClientOperationBroker, verifyClientArtifact } from "./kotoba-client-runtime.js";
import { compactFromGeoJSON, basemapProblems } from "./geo.js";
import { MIRRORED, upstreamFile } from "./mirror.js";

const KEY = "detail:ne_50m_admin_0_countries";

export function detailOperation(descriptor) {
  const op = descriptor.operations.find((o) => o.operation === "download-admin0-countries-50m");
  if (!op) throw new Error("detail operation is not declared");
  return op;
}

export async function decodeDetail(bytes, op) {
  const verified = await verifyClientArtifact(bytes, op.artifact);
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

export function createDetailSource({ descriptor, store, consentHost }) {
  const op = detailOperation(descriptor);
  const selector = { capability: op.capability, service: op.service, operation: op.operation };
  const broker = createClientOperationBroker({
    runtime: descriptor,
    // The runtime validates the whole descriptor, so every declared capability
    // is requested; only this one operation is eligible through this broker.
    requestedCapabilities: descriptor.operations.map((o) => o.capability),
    approvedOperations: [op],
    hostSupportedOperations: [[op.capability, op.service, op.operation]],
    consentHost,
  });
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
    async download(signal) {
      const artifact = await broker.invoke(selector, { input: op.endpoint.origin + op.endpoint.path }, { signal });
      const bytes = new Uint8Array(await artifact.blob.arrayBuffer());
      const map = await decodeDetail(bytes, op);
      const kept = await store.set(KEY, bytes);
      return { map, kept };
    },
    async forget() { return store.delete(KEY); },
  };
}
