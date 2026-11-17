// Canvas renderer. Country outlines are built once as Path2D objects in world
// units (Web Mercator, [0,1]) and drawn with a transform, so panning and
// zooming only change the transform. The world repeats east–west.
import { project } from "./geo.js";

function ringPath(path, ring, scale) {
  for (let i = 0; i < ring.length; i += 2) {
    const [x, y] = project(ring[i] / scale, ring[i + 1] / scale);
    if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
  }
  path.closePath();
}

export function buildPaths(map) {
  const countries = map.countries.map((c) => {
    const path = new Path2D();
    for (const poly of c.polys) for (const ring of poly) ringPath(path, ring, map.scale);
    return { country: c, path };
  });
  const graticule = new Path2D();
  for (let lon = -180; lon <= 180; lon += 30) {
    const [x] = project(lon, 0);
    graticule.moveTo(x, 0); graticule.lineTo(x, 1);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const [, y] = project(0, lat);
    graticule.moveTo(0, y); graticule.lineTo(1, y);
  }
  return { countries, graticule };
}

export function readColors(element) {
  const style = getComputedStyle(element);
  const v = (name) => style.getPropertyValue(name).trim();
  return { sea: v("--sea"), land: v("--land"), border: v("--border"), grid: v("--grid"), selected: v("--selected") };
}

/** Draw one frame. size = CSS px and device pixel ratio of the canvas. */
export function draw(ctx, size, view, paths, colors, selectedA3) {
  const { width, height, dpr } = size;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = colors.sea;
  ctx.fillRect(0, 0, width, height);
  const left = view.x - width / 2 / view.z, right = view.x + width / 2 / view.z;
  const px = 1 / view.z; // one CSS pixel in world units
  for (let copy = Math.floor(left); copy <= Math.floor(right); copy++) {
    ctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, dpr * (width / 2 - (view.x - copy) * view.z), dpr * (height / 2 - view.y * view.z));
    ctx.lineWidth = px;
    ctx.strokeStyle = colors.grid;
    ctx.stroke(paths.graticule);
    ctx.fillStyle = colors.land;
    for (const { path } of paths.countries) ctx.fill(path, "evenodd");
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 0.75 * px;
    for (const { path } of paths.countries) ctx.stroke(path);
    const sel = selectedA3 && paths.countries.find((p) => p.country.a3 === selectedA3);
    if (sel) {
      ctx.fillStyle = colors.selected;
      ctx.globalAlpha = 0.35;
      ctx.fill(sel.path, "evenodd");
      ctx.globalAlpha = 1;
      ctx.strokeStyle = colors.selected;
      ctx.lineWidth = 2 * px;
      ctx.stroke(sel.path);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
