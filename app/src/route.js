// On-device routing over the Natural Earth 1:10m road network. Pure code: no
// DOM, no network. The road file is turned into a compact graph once (typed
// arrays, kept in IndexedDB) and every route is computed here with A*.
//
// This is intercity-scale routing on major roads and ferries, not street-level
// navigation: Natural Earth carries highways and main roads only.

export const GRAPH_SCHEMA = "itonami.maps.roadgraph.v1";
const Q = 1000; // vertices are merged at 0.001° (~100 m), joining digitised junctions

// Assumed travel speeds (km/h) by Natural Earth road `type`. Estimates only.
export const SPEED_KMH = {
  "Major Highway": 90, Beltway: 80, Bypass: 70, "Secondary Highway": 70, Road: 50,
  Unknown: 50, Track: 20, "Ferry Route": 20, "Ferry, seasonal": 20,
};
const KINDS = Object.keys(SPEED_KMH);
const FERRY = new Set(["Ferry Route", "Ferry, seasonal"]);
const MAX_SPEED_MS = 90 / 3.6;

const R = 6371008.8;
export function haversine(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function linesOf(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates];
  if (geometry?.type === "MultiLineString") return geometry.coordinates;
  return [];
}

/** Natural Earth roads FeatureCollection → compact undirected graph (CSR). */
export function buildRoadGraph(geojson, { source = null } = {}) {
  if (geojson?.type !== "FeatureCollection" || !Array.isArray(geojson.features)) throw new TypeError("FeatureCollection required");
  const ids = new Map();
  const xs = [], ys = [];
  const node = (lon, lat) => {
    const x = Math.round(lon * Q), y = Math.round(lat * Q);
    const key = x * 400000 + y; // unique for |x| ≤ 180000, |y| ≤ 90000
    let id = ids.get(key);
    if (id === undefined) { id = xs.length; ids.set(key, id); xs.push(x); ys.push(y); }
    return id;
  };
  const ea = [], eb = [], ekind = [], ename = [];
  const names = [""], nameIds = new Map([["", 0]]);
  for (const f of geojson.features) {
    const p = f?.properties ?? {};
    const kind = Math.max(0, KINDS.indexOf(p.type ?? "Unknown"));
    const label = String(p.name ?? p.label ?? "").trim().slice(0, 80);
    let nid = nameIds.get(label);
    if (nid === undefined) { nid = names.length; names.push(label); nameIds.set(label, nid); }
    for (const line of linesOf(f.geometry)) {
      let prev = -1;
      for (const [lon, lat] of line) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const id = node(lon, lat);
        if (prev >= 0 && prev !== id) { ea.push(prev); eb.push(id); ekind.push(kind); ename.push(nid); }
        prev = id;
      }
    }
  }
  stitchDanglingEnds(xs, ys, ea, eb, ekind, ename);
  const n = xs.length, m = ea.length;
  const degree = new Int32Array(n + 1);
  for (let i = 0; i < m; i++) { degree[ea[i] + 1]++; degree[eb[i] + 1]++; }
  for (let i = 0; i < n; i++) degree[i + 1] += degree[i];
  const offsets = degree;
  const fill = offsets.slice(0, n);
  const target = new Int32Array(2 * m), meters = new Float32Array(2 * m), kind = new Uint8Array(2 * m), name = new Int32Array(2 * m);
  for (let i = 0; i < m; i++) {
    const a = ea[i], b = eb[i];
    const d = haversine(xs[a] / Q, ys[a] / Q, xs[b] / Q, ys[b] / Q);
    for (const [u, v] of [[a, b], [b, a]]) {
      const slot = fill[u]++;
      target[slot] = v; meters[slot] = d; kind[slot] = ekind[i]; name[slot] = ename[i];
    }
  }
  return { schema: GRAPH_SCHEMA, q: Q, source, kinds: KINDS, names, x: Int32Array.from(xs), y: Int32Array.from(ys), offsets, target, meters, kind, name };
}

export const STITCH_METERS = 3000;

/**
 * Natural Earth lines often stop near, not on, the road they join. Connect
 * each dead end to the nearest node within STITCH_METERS that is not already
 * close by along the road itself (more than LOCAL_HOPS links away). The added
 * link keeps the kind of the road it leaves.
 */
const LOCAL_HOPS = 12;
function stitchDanglingEnds(xs, ys, ea, eb, ekind, ename) {
  const n = xs.length, m = ea.length;
  const degree = new Int32Array(n), firstEdge = new Int32Array(n).fill(-1);
  for (let i = 0; i < m; i++) {
    degree[ea[i]]++; degree[eb[i]]++;
    if (firstEdge[ea[i]] < 0) firstEdge[ea[i]] = i;
    if (firstEdge[eb[i]] < 0) firstEdge[eb[i]] = i;
  }
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + degree[i];
  const fill = start.slice(0, n), adj = new Int32Array(2 * m);
  for (let i = 0; i < m; i++) { adj[fill[ea[i]]++] = eb[i]; adj[fill[eb[i]]++] = ea[i]; }
  const mark = new Int32Array(n).fill(-1);
  const near = (root) => { // nodes within LOCAL_HOPS links of root
    const seen = [root]; mark[root] = root;
    for (let h = 0, frontier = [root]; h < LOCAL_HOPS && frontier.length; h++) {
      const next = [];
      for (const u of frontier) for (let s = start[u]; s < start[u + 1]; s++) { const v = adj[s]; if (mark[v] !== root) { mark[v] = root; seen.push(v); next.push(v); } }
      frontier = next;
    }
    return seen;
  };
  const CELL = 50; // 0.05° grid in Q units
  const cells = new Map();
  const cellKey = (cx, cy) => cx * 100000 + cy;
  for (let i = 0; i < n; i++) {
    const k = cellKey(Math.floor(xs[i] / CELL), Math.floor(ys[i] / CELL));
    let list = cells.get(k); if (!list) cells.set(k, (list = [])); list.push(i);
  }
  for (let i = 0; i < n; i++) {
    if (degree[i] !== 1) continue;
    near(i);
    const cx = Math.floor(xs[i] / CELL), cy = Math.floor(ys[i] / CELL);
    const lon = xs[i] / Q, lat = ys[i] / Q;
    let best = -1, bestD = STITCH_METERS;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of cells.get(cellKey(cx + dx, cy + dy)) ?? []) {
        if (mark[j] === i) continue;
        const d = haversine(lon, lat, xs[j] / Q, ys[j] / Q);
        if (d < bestD) { bestD = d; best = j; }
      }
    }
    if (best < 0) continue;
    ea.push(i); eb.push(best); ekind.push(ekind[firstEdge[i]]); ename.push(0);
  }
}

export function graphProblems(g) {
  if (!g || g.schema !== GRAPH_SCHEMA || g.q !== Q) return ["schema"];
  const n = g.x?.length;
  if (!(g.x instanceof Int32Array) || !(g.y instanceof Int32Array) || g.y.length !== n) return ["nodes"];
  if (!(g.offsets instanceof Int32Array) || g.offsets.length !== n + 1) return ["offsets"];
  const m = g.target?.length;
  if (!(g.target instanceof Int32Array) || g.offsets[n] !== m || g.meters?.length !== m || g.kind?.length !== m || g.name?.length !== m) return ["edges"];
  if (!Array.isArray(g.names) || !Array.isArray(g.kinds)) return ["labels"];
  return [];
}

/** Grid index (1° cells) for nearest-node lookup. Built after load. */
export function indexGraph(g) {
  const cells = new Map();
  for (let i = 0; i < g.x.length; i++) {
    const key = Math.floor(g.x[i] / Q) * 1000 + Math.floor(g.y[i] / Q);
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(i);
  }
  return { ...g, cells };
}

/** Nearest road node within maxMeters of lon/lat, or -1. */
export function nearestNode(g, lon, lat, maxMeters = 50000) {
  const cx = Math.floor(lon), cy = Math.floor(lat);
  let best = -1, bestD = Infinity;
  for (let ring = 0; ring <= 2; ring++) {
    for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
      const xx = ((cx + dx + 180) % 360 + 360) % 360 - 180;
      for (const i of g.cells.get(xx * 1000 + (cy + dy)) ?? []) {
        const d = haversine(lon, lat, g.x[i] / Q, g.y[i] / Q);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    if (best >= 0 && bestD <= ring * 50000) break; // a closer node cannot lie further out
  }
  return bestD <= maxMeters ? best : -1;
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, value) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(value);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = value;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lastK = k.pop(), lastV = v.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lastK) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lastK; v[i] = lastV;
    }
    return top;
  }
}

/**
 * Fastest route by estimated time between two nodes (A*, admissible
 * heuristic). Returns null when they are not connected.
 */
export function shortestPath(g, from, to, { avoidFerries = false } = {}) {
  const n = g.x.length;
  const cost = new Float64Array(n).fill(Infinity);
  const via = new Int32Array(n).fill(-1); // edge slot used to reach the node
  const done = new Uint8Array(n);
  const tx = g.x[to] / Q, ty = g.y[to] / Q;
  const h = (i) => haversine(g.x[i] / Q, g.y[i] / Q, tx, ty) / MAX_SPEED_MS;
  const speed = g.kinds.map((k) => (SPEED_KMH[k] ?? 50) / 3.6);
  const ferry = g.kinds.map((k) => FERRY.has(k));
  const heap = new Heap();
  cost[from] = 0; heap.push(h(from), from);
  let settled = 0;
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1; settled++;
    if (u === to) break;
    for (let s = g.offsets[u]; s < g.offsets[u + 1]; s++) {
      const k = g.kind[s];
      if (avoidFerries && ferry[k]) continue;
      const v = g.target[s];
      if (done[v]) continue;
      const c = cost[u] + g.meters[s] / speed[k];
      if (c < cost[v]) { cost[v] = c; via[v] = s; heap.push(c + h(v), v); }
    }
  }
  if (!done[to]) return null;
  const slots = [];
  for (let v = to; v !== from;) { const s = via[v]; slots.push(s); v = sourceOf(g, s); }
  slots.reverse();
  const coords = [[g.x[from] / Q, g.y[from] / Q]];
  let meters = 0;
  const steps = [];
  for (const s of slots) {
    const v = g.target[s];
    coords.push([g.x[v] / Q, g.y[v] / Q]);
    meters += g.meters[s];
    const label = g.names[g.name[s]] || "", kind = g.kinds[g.kind[s]];
    const last = steps[steps.length - 1];
    if (last && last.name === label && last.kind === kind) { last.meters += g.meters[s]; last.seconds += g.meters[s] / speed[g.kind[s]]; }
    else steps.push({ name: label, kind, meters: g.meters[s], seconds: g.meters[s] / speed[g.kind[s]] });
  }
  return { coords, meters, seconds: cost[to], steps: mergeShortSteps(steps), settled };
}

function sourceOf(g, slot) {
  // offsets is sorted: binary search for the node whose range holds slot.
  let lo = 0, hi = g.offsets.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (g.offsets[mid] <= slot) lo = mid; else hi = mid - 1; }
  return lo;
}

/** Fold steps shorter than 2 km into their neighbour so the list stays readable. */
function mergeShortSteps(steps) {
  const out = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (last && (s.meters < 2000 || (last.name === s.name && last.kind === s.kind))) { last.meters += s.meters; last.seconds += s.seconds; }
    else out.push({ ...s });
  }
  return out;
}

/** Route between two lon/lat points, snapping each to the nearest road. */
export function route(g, start, end, options = {}) {
  const a = nearestNode(g, start[0], start[1]), b = nearestNode(g, end[0], end[1]);
  if (a < 0) return { error: "no-road-near-start" };
  if (b < 0) return { error: "no-road-near-end" };
  if (a === b) return { error: "same-place" };
  const path = shortestPath(g, a, b, options);
  if (!path) return { error: "not-connected" };
  const snapStart = haversine(start[0], start[1], g.x[a] / Q, g.y[a] / Q);
  const snapEnd = haversine(end[0], end[1], g.x[b] / Q, g.y[b] / Q);
  return { ...path, snapStart, snapEnd };
}

// ── places (bundled, for search) ─────────────────────────────────────────────
export const PLACES_SCHEMA = "itonami.maps.places.v1";

/** Natural Earth populated places → compact list [name, ja, country, iso2, lon, lat, pop]. */
export function compactPlaces(geojson, { source = null } = {}) {
  const places = [];
  for (const f of geojson.features) {
    const p = f.properties ?? {};
    const lon = Number(p.LONGITUDE), lat = Number(p.LATITUDE);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    places.push([String(p.NAME_EN ?? p.NAME), p.NAME_JA ? String(p.NAME_JA) : null, String(p.ADM0NAME ?? ""), /^[A-Z]{2}$/.test(p.ISO_A2) ? p.ISO_A2 : null,
      Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4, Number.isSafeInteger(p.POP_MAX) ? p.POP_MAX : 0]);
  }
  places.sort((a, b) => b[6] - a[6] || a[0].localeCompare(b[0]));
  return { schema: PLACES_SCHEMA, source, places };
}

const fold = (text) => String(text ?? "").normalize("NFKC").toLowerCase();

export function searchPlaces(list, query, limit = 8) {
  const q = fold(query).trim();
  if (!q) return [];
  const out = [];
  for (const p of list.places) {
    const fields = [p[0], p[1], p[2]].map(fold);
    let score = -1;
    if (fields[0] === q || fields[1] === q) score = 0;
    else if (fields[0].startsWith(q) || fields[1].startsWith(q)) score = 1;
    else if (fields.some((f) => f.includes(q))) score = 2;
    if (score >= 0) out.push([score, p]);
    if (out.length > 400) break;
  }
  out.sort((a, b) => a[0] - b[0] || b[1][6] - a[1][6]);
  return out.slice(0, limit).map(([, p]) => ({ name: p[0], ja: p[1], country: p[2], iso2: p[3], lon: p[4], lat: p[5], pop: p[6] }));
}
