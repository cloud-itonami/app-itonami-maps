// Geometry, search and view math on the bundled 1:110m basemap.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  basemapProblems, clampView, compactFromGeoJSON, countryAt, fitView, focusBBox, panBy, project,
  screenToWorld, searchCountries, unproject, zoomAt, MAX_ZOOM, MIN_ZOOM, BASEMAP_SCHEMA,
} from "../src/geo.js";

const map = JSON.parse(await readFile(new URL("../src/data/world-110m.json", import.meta.url), "utf8"));

test("the bundled basemap is valid, pinned and covers the world", () => {
  assert.deepEqual(basemapProblems(map), []);
  assert.equal(map.schema, BASEMAP_SCHEMA);
  assert.equal(map.source.revision, "ca96624a56bd078437bca8184e78163e5039ad19");
  assert.match(map.source.license, /Public domain/);
  assert.ok(map.countries.length >= 170, `${map.countries.length} countries`);
  for (const a3 of ["JPN", "USA", "BRA", "FRA", "NOR", "AUS", "ATA", "ZAF", "RUS"]) assert.ok(map.countries.some((c) => c.a3 === a3), a3);
});

test("a tap resolves to the country under it, holes included", () => {
  const at = (lon, lat) => countryAt(map, lon, lat)?.a3 ?? null;
  assert.equal(at(139.7, 35.7), "JPN");
  assert.equal(at(2.35, 48.85), "FRA");
  assert.equal(at(-100, 40), "USA");
  assert.equal(at(-47.9, -15.8), "BRA");
  assert.equal(at(-30, 0), null, "open Atlantic");
  assert.equal(at(28, -29.5), "LSO", "Lesotho is inside South Africa's hole");
  assert.equal(at(25, -30), "ZAF");
  assert.equal(at(178.5, -17.8), "FJI", "Fiji spans the antimeridian");
});

test("search finds Japanese names, English names and ISO codes", () => {
  assert.equal(searchCountries(map, "日本")[0].a3, "JPN");
  assert.equal(searchCountries(map, "jp")[0].a3, "JPN", "alpha-2 ranks first");
  assert.equal(searchCountries(map, "FRA")[0].a3, "FRA");
  assert.equal(searchCountries(map, "ブラジル")[0].a3, "BRA");
  assert.equal(searchCountries(map, "germ")[0].a3, "DEU");
  assert.deepEqual(searchCountries(map, "   "), []);
  assert.ok(searchCountries(map, "a").length <= 8);
});

test("projection round-trips and wraps", () => {
  for (const [lon, lat] of [[0, 0], [139.7, 35.7], [-74, 40.7], [-179.9, -60]]) {
    const [x, y] = project(lon, lat);
    const [lon2, lat2] = unproject(x, y);
    assert.ok(Math.abs(lon - lon2) < 1e-9 && Math.abs(lat - lat2) < 1e-9, `${lon},${lat}`);
  }
  assert.ok(Math.abs(unproject(1.25, 0.5)[0] - -90) < 1e-9, "x beyond 1 is the next copy east");
});

test("views stay inside the world and zoom keeps the pointer fixed", () => {
  const W = 400, H = 800;
  const v = clampView({ x: 1.3, y: -5, z: 1 }, H);
  assert.ok(v.z === Math.max(MIN_ZOOM, H) && v.x >= 0 && v.x < 1 && v.y >= 0 && v.y <= 1);
  assert.equal(clampView({ x: 0.5, y: 0.5, z: 1e12 }, H).z, MAX_ZOOM);
  const base = { x: 0.5, y: 0.4, z: 2048 };
  const before = screenToWorld(base, W, H, 100, 200);
  const after = screenToWorld(zoomAt(base, W, H, 100, 200, 3), W, H, 100, 200);
  assert.ok(Math.abs(before[0] - after[0]) < 1e-12 && Math.abs(before[1] - after[1]) < 1e-12);
  const moved = panBy(base, H, 2048 * 0.1, 0);
  assert.ok(Math.abs(moved.x - 0.4) < 1e-12, "dragging right moves the view west");
});

test("framing a country uses its main landmass across the antimeridian", () => {
  const rus = map.countries.find((c) => c.a3 === "RUS");
  assert.ok(rus.bbox[2] - rus.bbox[0] > 180);
  const box = focusBBox(rus, map.scale);
  assert.ok(box[2] - box[0] < 180);
  const jpn = map.countries.find((c) => c.a3 === "JPN");
  const v = fitView(focusBBox(jpn, map.scale), 400, 800);
  const [lon, lat] = unproject(v.x, v.y);
  assert.ok(lon > 128 && lon < 146 && lat > 30 && lat < 42, `${lon},${lat}`);
});

test("conversion keeps codes, names and holes from GeoJSON and rejects junk", () => {
  const square = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];
  const fc = { type: "FeatureCollection", features: [
    { type: "Feature", properties: { ISO_A3_EH: "AAA", ISO_A2_EH: "AA", NAME_EN: "Outer", NAME_JA: "外" }, geometry: { type: "Polygon", coordinates: [square(0, 0, 10), square(4, 4, 2)] } },
    { type: "Feature", properties: { ISO_A3_EH: "-99", ADM0_A3: "BBB", NAME: "Fallback" }, geometry: { type: "MultiPolygon", coordinates: [[square(20, 0, 1)], [square(30, 0, 1)]] } },
    { type: "Feature", properties: { ISO_A3_EH: "-99", ADM0_A3: "-99" }, geometry: { type: "Polygon", coordinates: [square(50, 0, 1)] } },
  ] };
  const m = compactFromGeoJSON(fc, { scale: 10 });
  assert.deepEqual(basemapProblems(m), []);
  assert.deepEqual(m.countries.map((c) => c.a3), ["AAA", "BBB"]);
  assert.equal(countryAt(m, 1, 1).ja, "外");
  assert.equal(countryAt(m, 5, 5), null, "inside the hole");
  assert.equal(countryAt(m, 30.5, 0.5).a3, "BBB");
  assert.throws(() => compactFromGeoJSON({ type: "Feature" }), /FeatureCollection/);
  assert.deepEqual(basemapProblems({ schema: "x" }), ["schema"]);
});
