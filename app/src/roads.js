// The road network for on-device routing. Downloading it is the second
// declared external operation: the pinned Natural Earth 1:10m roads file,
// gzipped on Yataverse (mirror.js), fetched only through the shared Kotoba
// broker after a fresh approval. The block's SHA-256 and the decompressed
// file's upstream digest are both checked. Denying sends no request. The file is turned
// into a compact graph on this device and only the graph is kept (IndexedDB).
// Every route is then computed locally with no network.
//
// restricted-wasm-v1 (KOTOBA-159): the download is one operation on the host port (guest-port.js),
// declared only when its recipient is confirmed; until then `selector` is null and download() refuses.
import { buildRoadGraph, graphProblems, indexGraph } from "./route.js";
import { MIRRORED, upstreamFile } from "./mirror.js";

const KEY = "roads:ne_10m_roads";

export function roadsOperation(candidates) {
  const op = candidates.operations.find((o) => o.operation === "download-roads-10m");
  if (!op) throw new Error("road operation is not a candidate");
  return op;
}

/** Verified artifact (from the broker) → road graph. */
export async function graphFromArtifact(artifact, op) {
  if (artifact?.verified !== true || artifact.sha256 !== op.artifact.sha256) throw new Error("road data was not verified");
  const file = await upstreamFile(artifact.blob, op.operation);
  const geojson = JSON.parse(new TextDecoder().decode(file));
  const graph = buildRoadGraph(geojson, {
    source: {
      name: "Natural Earth 1:10m Roads", license: "Public domain (https://www.naturalearthdata.com/about/terms-of-use/)",
      revision: op.artifact.revision, sha256: artifact.sha256,
      upstreamSha256: MIRRORED[op.operation].upstreamSha256, mirror: MIRRORED[op.operation].cid,
    },
  });
  const problems = graphProblems(graph);
  if (problems.length) throw new Error(`road data is not a usable graph (${problems[0]})`);
  return graph;
}

export function createRoadSource({ op, selector, invoke, store }) {
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
    declared: Boolean(selector),
    async download({ signal, onPhase = () => {} } = {}) {
      if (!selector) throw new Error("この取得は、送り先が確定するまで宣言されていません");
      const artifact = await invoke(selector, { input: op.endpoint.origin + op.endpoint.path }, { signal });
      onPhase("convert");
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the status repaint
      const graph = await graphFromArtifact(artifact, op);
      const kept = await store.set(KEY, graph);
      return { graph: indexGraph(graph), kept };
    },
    async forget() { return store.delete(KEY); },
  };
}
