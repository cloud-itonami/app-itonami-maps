// On-device routing: graph building, dead-end stitching, A*, ferries, place search.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildRoadGraph, graphProblems, indexGraph, nearestNode, route, searchPlaces, haversine, STITCH_METERS, GRAPH_SCHEMA, PLACES_SCHEMA } from "../src/route.js";

const line = (type, name, ...coords) => ({ type: "Feature", properties: { type, name }, geometry: { type: "LineString", coordinates: coords } });
const fc = (...features) => ({ type: "FeatureCollection", features });

test("lines sharing a vertex form one graph; the fastest route is chosen", () => {
  // A highway via a detour and a slow straight road between the same two points.
  const g = indexGraph(buildRoadGraph(fc(
    line("Major Highway", "H1", [0, 0], [0.5, 0.3], [1, 0]),
    line("Track", "T1", [0, 0], [1, 0]),
  )));
  assert.deepEqual(graphProblems(g), []);
  assert.equal(g.schema, GRAPH_SCHEMA);
  const r = route(g, [0, 0], [1, 0]);
  assert.equal(r.steps[0].name, "H1", "90 km/h detour beats the 20 km/h track");
  assert.ok(r.meters > haversine(0, 0, 1, 0));
  assert.ok(Math.abs(r.seconds - r.meters / (90 / 3.6)) < 1);
});

test("a dead end close to another road is stitched; a far one is not", () => {
  const near = indexGraph(buildRoadGraph(fc(line("Road", "A", [0, 0], [1, 0]), line("Road", "B", [1.01, 0], [2, 0]))));
  assert.ok(!route(near, [0, 0], [2, 0]).error, "1.1 km gap is joined");
  const far = indexGraph(buildRoadGraph(fc(line("Road", "A", [0, 0], [1, 0]), line("Road", "B", [1.1, 0], [2, 0]))));
  assert.ok(haversine(1, 0, 1.1, 0) > STITCH_METERS);
  assert.equal(route(far, [0, 0], [2, 0]).error, "not-connected");
});

test("ferries can be avoided", () => {
  const g = indexGraph(buildRoadGraph(fc(
    line("Road", "land", [0, 0], [0, 1]),
    line("Ferry Route", "ferry", [0, 1], [1, 1]),
    line("Road", "land", [1, 1], [1, 0]),
  )));
  assert.ok(route(g, [0, 0], [1, 0]).steps.some((s) => s.kind === "Ferry Route"));
  assert.equal(route(g, [0, 0], [1, 0], { avoidFerries: true }).error, "not-connected");
});

test("endpoints snap to the nearest road within 50 km", () => {
  const g = indexGraph(buildRoadGraph(fc(line("Road", "A", [10, 10], [11, 10]))));
  assert.equal(nearestNode(g, 10.1, 10.1) >= 0, true);
  assert.equal(route(g, [30, 30], [11, 10]).error, "no-road-near-start");
  assert.equal(route(g, [10, 10], [10.0001, 10.0001]).error, "same-place");
  const r = route(g, [10, 10.2], [11, 10]);
  assert.ok(r.snapStart > 20000 && r.snapStart < 25000);
});

test("graphs that do not match the schema are rejected", () => {
  assert.deepEqual(graphProblems(null), ["schema"]);
  const g = buildRoadGraph(fc(line("Road", "A", [0, 0], [1, 0])));
  assert.deepEqual(graphProblems({ ...g, target: new Int32Array(1) }), ["edges"]);
  assert.throws(() => buildRoadGraph({ type: "Feature" }), /FeatureCollection/);
});

const places = JSON.parse(await readFile(new URL("../src/data/places-50m.json", import.meta.url), "utf8"));

test("the bundled places are pinned and searchable in Japanese and English", () => {
  assert.equal(places.schema, PLACES_SCHEMA);
  assert.equal(places.source.revision, "ca96624a56bd078437bca8184e78163e5039ad19");
  assert.ok(places.places.length >= 1200);
  assert.equal(searchPlaces(places, "東京")[0].name, "Tokyo");
  assert.equal(searchPlaces(places, "osaka")[0].ja, "大阪市");
  assert.equal(searchPlaces(places, "パリ")[0].country, "France");
  assert.deepEqual(searchPlaces(places, " "), []);
});

const roadsFile = new URL("../../.agent-output/ne/ne_10m_roads.geojson", import.meta.url);
const haveRoads = await readFile(roadsFile).then(() => true, () => false);
test("real Natural Earth roads give plausible intercity routes", { skip: !haveRoads && "pinned 1:10m roads not downloaded locally" }, async () => {
  const g = indexGraph(buildRoadGraph(JSON.parse(await readFile(roadsFile, "utf8"))));
  const km = (a, b) => { const r = route(g, a, b); assert.ok(!r.error, r.error); return r.meters / 1000; };
  const tokyoOsaka = km([139.69, 35.69], [135.50, 34.69]);
  assert.ok(tokyoOsaka > 450 && tokyoOsaka < 650, `Tokyo–Osaka ${tokyoOsaka}`);
  const parisBerlin = km([2.35, 48.85], [13.40, 52.52]);
  assert.ok(parisBerlin > 950 && parisBerlin < 1300, `Paris–Berlin ${parisBerlin}`);
  assert.equal(route(g, [139.69, 35.69], [2.35, 48.85]).error, "not-connected", "no road from Japan to France");
});
