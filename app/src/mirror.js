// Natural Earth files are served from Awai's own content-addressed storage
// (Yataverse, yataverse.com) instead of GitHub. Each is the pinned upstream
// file gzipped with `gzip -n -9` (deterministic; the 1:10m roads would not fit
// one 16 MiB block otherwise) and stored as one raw block.
//
// Two pins hold: the broker accepts the downloaded block only with the
// descriptor's SHA-256 (the gzip bytes, which the CID also names), and the
// decompressed file must match the upstream Natural Earth digest below.
export const MIRRORED = Object.freeze({
  "download-admin0-countries-50m": Object.freeze({
    cid: "bafkreieif7bmrdeglutkvsqaycc7cjlss2ueyx2fjd6f3srzd47el336tq",
    upstream: "nvkelso/natural-earth-vector@ca96624a56bd078437bca8184e78163e5039ad19 geojson/ne_50m_admin_0_countries.geojson",
    upstreamSha256: "3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb",
    upstreamBytes: 3083490,
  }),
  "download-roads-10m": Object.freeze({
    cid: "bafkreif42rfyf2kyupx6crew5btgays52kyx7xx4nslioz2tnero4s63za",
    upstream: "nvkelso/natural-earth-vector@ca96624a56bd078437bca8184e78163e5039ad19 geojson/ne_10m_roads.geojson",
    upstreamSha256: "66a0c7b438e92fd124822cc5921cfa11042f48c294ade5e0f03f2c6640fd0248",
    upstreamBytes: 50474096,
  }),
});

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** Gzip bytes (already verified by the broker) → the upstream file, checked against its own digest. */
export async function upstreamFile(gzipBlob, operation) {
  const pin = MIRRORED[operation];
  if (!pin) throw new Error(`no mirror pin for ${operation}`);
  let bytes;
  try {
    const stream = gzipBlob.stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { throw new Error("mirrored data is not valid gzip"); }
  if (bytes.byteLength !== pin.upstreamBytes) throw new Error("mirrored data does not match the Natural Earth file (size)");
  if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== pin.upstreamSha256) throw new Error("mirrored data does not match the Natural Earth file (digest)");
  return bytes;
}
