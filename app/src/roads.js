// The road network for on-device routing. Downloading it is the second
// declared external operation: the pinned Natural Earth 1:10m roads file,
// fetched only through the shared Kotoba broker after a fresh approval, with
// its SHA-256 checked before use. Denying sends no request. The file is turned
// into a compact graph on this device and only the graph is kept (IndexedDB).
// Every route is then computed locally with no network.
import { createClientOperationBroker } from "./kotoba-client-runtime.js";
import { buildRoadGraph, graphProblems, indexGraph } from "./route.js";

const KEY = "roads:ne_10m_roads";

export function roadsOperation(descriptor) {
  const op = descriptor.operations.find((o) => o.operation === "download-roads-10m");
  if (!op) throw new Error("road operation is not declared");
  return op;
}

/** Verified artifact (from the broker) → road graph. */
export async function graphFromArtifact(artifact, op) {
  if (artifact?.verified !== true || artifact.sha256 !== op.artifact.sha256) throw new Error("road data was not verified");
  const geojson = JSON.parse(await artifact.blob.text());
  const graph = buildRoadGraph(geojson, {
    source: {
      name: "Natural Earth 1:10m Roads", license: "Public domain (https://www.naturalearthdata.com/about/terms-of-use/)",
      revision: op.artifact.revision, sha256: artifact.sha256,
    },
  });
  const problems = graphProblems(graph);
  if (problems.length) throw new Error(`road data is not a usable graph (${problems[0]})`);
  return graph;
}

export function createRoadSource({ descriptor, store, consentHost }) {
  const op = roadsOperation(descriptor);
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
    /** The graph built earlier on this device, if it matches the pinned source. */
    async loadSaved() {
      const saved = await store.get(KEY);
      if (!saved) return null;
      if (graphProblems(saved).length || saved.source?.sha256 !== op.artifact.sha256) { await store.delete(KEY); return null; }
      return indexGraph(saved);
    },
    /** Ask, download, verify, convert and keep. onPhase("convert") before the slow step. */
    async download({ signal, onPhase = () => {} } = {}) {
      const artifact = await broker.invoke(selector, { input: op.endpoint.origin + op.endpoint.path }, { signal });
      onPhase("convert");
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the status repaint
      const graph = await graphFromArtifact(artifact, op);
      const kept = await store.set(KEY, graph);
      return { graph: indexGraph(graph), kept };
    },
    async forget() { return store.delete(KEY); },
  };
}
