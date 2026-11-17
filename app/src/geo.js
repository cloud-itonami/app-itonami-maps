// Pure geometry for the Maps app: no DOM, no network. The same code turns a
// Natural Earth admin-0 GeoJSON into the compact basemap at build time (Node)
// and on the device after a consented, digest-verified download.

export const BASEMAP_SCHEMA = "itonami.maps.basemap.v1";
export const MAX_LAT = 85.0511287798066; // Web Mercator square world

const clampLat = (lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

/** lon/lat (degrees) → world units in [0,1] (x east, y south). */
export function project(lon, lat) {
  const s = Math.sin((clampLat(lat) * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

/** world units → lon/lat; x may lie outside [0,1] (wrapped copies). */
export function unproject(x, y) {
  const lon = (((x * 360) % 360) + 360) % 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  return [lon, lat];
}

const code = (value) => (typeof value === "string" && /^[A-Z]{2,3}$/.test(value) ? value : null);

function polygonsOf(geometry) {
  if (geometry?.type === "Polygon") return [geometry.coordinates];
  if (geometry?.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

/**
 * GeoJSON FeatureCollection (Natural Earth admin-0 countries) → compact basemap.
 * Coordinates become integers at 1/scale degree; consecutive duplicates and
 * rings with fewer than 4 points after rounding are dropped.
 */
export function compactFromGeoJSON(geojson, { scale = 100, source = null } = {}) {
  if (geojson?.type !== "FeatureCollection" || !Array.isArray(geojson.features)) throw new TypeError("FeatureCollection required");
  const countries = [];
  for (const feature of geojson.features) {
    const p = feature?.properties ?? {};
    const a3 = code(p.ISO_A3_EH) ?? code(p.ISO_A3) ?? code(p.ADM0_A3);
    if (!a3) continue;
    const polys = [];
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const polygon of polygonsOf(feature.geometry)) {
      const rings = [];
      for (const ring of polygon) {
        const flat = [];
        for (const [lon, lat] of ring) {
          const x = Math.round(lon * scale), y = Math.round(lat * scale);
          const len = flat.length;
          if (len && flat[len - 2] === x && flat[len - 1] === y) continue;
          flat.push(x, y);
          if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
        }
        if (flat.length >= 8) rings.push(flat);
      }
      if (rings.length) polys.push(rings);
    }
    if (!polys.length) continue;
    countries.push({
      a3,
      a2: code(p.ISO_A2_EH) ?? code(p.ISO_A2),
      name: String(p.NAME_EN ?? p.NAME ?? a3),
      ja: typeof p.NAME_JA === "string" && p.NAME_JA ? p.NAME_JA : null,
      continent: typeof p.CONTINENT === "string" ? p.CONTINENT : null,
      bbox: [w / scale, s / scale, e / scale, n / scale],
      polys,
    });
  }
  countries.sort((a, b) => a.a3.localeCompare(b.a3) || a.name.localeCompare(b.name));
  return { schema: BASEMAP_SCHEMA, scale, source, countries };
}

/** Structural check of an untrusted basemap. Returns a list of problems. */
export function basemapProblems(map) {
  if (!map || map.schema !== BASEMAP_SCHEMA) return ["schema"];
  if (!Number.isSafeInteger(map.scale) || map.scale < 1 || map.scale > 100000) return ["scale"];
  if (!Array.isArray(map.countries) || map.countries.length === 0) return ["countries"];
  const problems = [];
  for (const c of map.countries) {
    if (!code(c?.a3) || typeof c.name !== "string" || !Array.isArray(c.bbox) || c.bbox.length !== 4 || !Array.isArray(c.polys)) {
      problems.push(`country:${c?.a3 ?? "?"}`);
      continue;
    }
    for (const poly of c.polys) for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 8 || ring.length % 2 || !ring.every(Number.isSafeInteger)) problems.push(`ring:${c.a3}`);
    }
  }
  return problems;
}

/** Even-odd ring test on integer coordinates. */
function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function countryContains(country, lon, lat, scale) {
  const [w, s, e, n] = country.bbox;
  if (lon < w || lon > e || lat < s || lat > n) return false;
  const x = lon * scale, y = lat * scale;
  return country.polys.some((poly) => {
    let inside = false;
    for (const ring of poly) if (inRing(ring, x, y)) inside = !inside;
    return inside;
  });
}

export function countryAt(map, lon, lat) {
  return map.countries.find((c) => countryContains(c, lon, lat, map.scale)) ?? null;
}

const fold = (text) => String(text ?? "").normalize("NFKC").toLowerCase();

/** Search by Japanese or English name, or ISO code. Exact codes rank first. */
export function searchCountries(map, query, limit = 8) {
  const q = fold(query).trim();
  if (!q) return [];
  const scored = [];
  for (const c of map.countries) {
    const fields = [c.a3, c.a2, c.ja, c.name].map(fold);
    let score = -1;
    if (fields[0] === q || fields[1] === q) score = 0;
    else if (fields[2] === q || fields[3] === q) score = 1;
    else if (fields.some((f) => f.startsWith(q))) score = 2;
    else if (fields.some((f) => f.includes(q))) score = 3;
    if (score >= 0) scored.push([score, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
  return scored.slice(0, limit).map(([, c]) => c);
}

/**
 * The bbox to frame a country. A country whose rings cross the antimeridian
 * (Russia, Fiji, the US) has a world-wide bbox, so frame its largest polygon.
 */
export function focusBBox(country, scale) {
  const [w, , e] = country.bbox;
  if (e - w <= 180) return country.bbox;
  let best = null, bestLen = -1;
  for (const poly of country.polys) if (poly[0].length > bestLen) { best = poly[0]; bestLen = poly[0].length; }
  let bw = Infinity, bs = Infinity, be = -Infinity, bn = -Infinity;
  for (let i = 0; i < best.length; i += 2) {
    bw = Math.min(bw, best[i]); be = Math.max(be, best[i]);
    bs = Math.min(bs, best[i + 1]); bn = Math.max(bn, best[i + 1]);
  }
  return [bw / scale, bs / scale, be / scale, bn / scale];
}

// A view is the world point at the screen centre and the world size in CSS px.
export const MIN_ZOOM = 256;
export const MAX_ZOOM = 256 * 2 ** 9; // beyond this the 1:50m data shows its steps

/** The world always fills the screen height; x wraps, y stays inside. */
export function clampView(view, height) {
  const z = Math.max(MIN_ZOOM, height, Math.min(MAX_ZOOM, view.z));
  const half = height / 2 / z;
  const x = ((view.x % 1) + 1) % 1;
  const y = Math.max(half, Math.min(1 - half, view.y));
  return { x, y, z };
}

/** View that frames bbox [w,s,e,n] inside width×height with padding. */
export function fitView(bbox, width, height, padding = 24) {
  const [w, s, e, n] = bbox;
  const [x0, y1] = project(w, s), [x1, y0] = project(e, n);
  const dx = Math.max(x1 - x0, 1e-6), dy = Math.max(y1 - y0, 1e-6);
  const z = Math.min((width - 2 * padding) / dx, (height - 2 * padding) / dy);
  return clampView({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, z }, height);
}

export function screenToWorld(view, width, height, sx, sy) {
  return [view.x + (sx - width / 2) / view.z, view.y + (sy - height / 2) / view.z];
}

/** Zoom by factor around a screen point, keeping that point fixed. */
export function zoomAt(view, width, height, sx, sy, factor) {
  const [wx, wy] = screenToWorld(view, width, height, sx, sy);
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.z * factor));
  return clampView({ x: wx - (sx - width / 2) / z, y: wy - (sy - height / 2) / z, z }, height);
}

export function panBy(view, height, dx, dy) {
  return clampView({ x: view.x - dx / view.z, y: view.y - dy / view.z, z: view.z }, height);
}
