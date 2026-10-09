// EarthCraft tile service. Minecraft (client and server side) talks to this over localhost.
//
//   GET /health
//   GET /ground?lat&lon                         -> { height }  ellipsoid height of the ground
//   GET /chunk?lat&lon&h&cx&cz&minY&height      -> 16*16*height block codes
//   GET /render/select?lat&lon&h&x&y&z          -> { tiles: [{id, fine}], pending, attribution }
//   GET /render/tile?id&lat&lon&h               -> binary mesh (see encodeRenderTile)
//   GET /stats

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Frame, Y_BASE, geodeticToEcef, ecefToGeodetic } from './geo.mjs';
import { waterFeatures } from './osm.mjs';
import { TileClient } from './tiles.mjs';
import { collectRegionTiles, selectRenderTiles, isFine, contentParent, contentChain } from './select.mjs';
import { voxelizeArea, mcPositions } from './voxel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(here, '..');

const DEFAULTS = {
  apiKey: '',
  port: 8765,
  rootUrl: 'https://tile.googleapis.com/v1/3dtiles/root.json',
  cacheDir: 'cache',
  diskCache: false, // Google's Map Tiles terms restrict storing tiles; opt in at your own risk
  collisionError: 1.0,
  render: { maxSse: 12, falloff: 600, viewportHeight: 1080, fovDeg: 70, far: 4000, fineRadius: 160, maxTiles: 900 },
  superchunkCache: 48,
  decodedTileCache: 1500,
};

export function loadConfig(file = path.join(serviceDir, 'config.json')) {
  let user = {};
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8'));
  else fs.writeFileSync(file, JSON.stringify({ apiKey: '' }, null, 2));
  const cfg = { ...DEFAULTS, ...user, render: { ...DEFAULTS.render, ...(user.render ?? {}) } };
  if (process.env.EARTHCRAFT_API_KEY) cfg.apiKey = process.env.EARTHCRAFT_API_KEY;
  if (process.env.EARTHCRAFT_ROOT_URL) cfg.rootUrl = process.env.EARTHCRAFT_ROOT_URL;
  if (process.env.EARTHCRAFT_PORT) cfg.port = Number(process.env.EARTHCRAFT_PORT);
  if (process.env.EARTHCRAFT_DISK_CACHE) cfg.diskCache = process.env.EARTHCRAFT_DISK_CACHE !== '0';
  cfg.cacheDir = path.resolve(serviceDir, cfg.cacheDir);
  return cfg;
}

const SC = 64;      // superchunk size (4x4 chunks)
const MARGIN = 16;  // extra columns around a superchunk for ground estimation

export class EarthService {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = new TileClient(cfg);
    this.frames = new Map();
    this.superchunks = new Map();
  }

  frame(lat, lon, h) {
    const key = `${lat},${lon},${h}`;
    let f = this.frames.get(key);
    if (!f) { f = new Frame(lat, lon, h); this.frames.set(key, f); }
    return f;
  }

  async meshesFor(nodes) {
    return Promise.all(nodes.map((n) => this.client.getMesh(n)));
  }

  async ground(lat, lon) {
    // Ground = low percentile of the per-cell lowest surface height around the point. A wide area
    // and per-cell minima keep rooftops, bridges and tree canopies from being taken for the ground
    // when the point lies inside a large building.
    const frame = this.frame(lat, lon, 0);
    const r = 90, cell = 6, n = (2 * r) / cell;
    const nodes = await collectRegionTiles(this.client, frame, [-r, -1000, -r], [r, 9000, r], 8); // coarse tiles are enough for heights
    const meshes = await this.meshesFor(nodes);
    const low = new Float64Array(n * n).fill(Infinity);
    let samples = 0;
    for (const mesh of meshes) for (const prim of mesh.primitives) {
      const mc = mcPositions(frame, prim);
      for (let i = 0; i < mc.length; i += 3) {
        const cx = Math.floor((mc[i] + r) / cell), cz = Math.floor((mc[i + 2] + r) / cell);
        if (cx < 0 || cz < 0 || cx >= n || cz >= n) continue;
        samples++;
        if (mc[i + 1] < low[cz * n + cx]) low[cz * n + cx] = mc[i + 1];
      }
    }
    const cells = Array.from(low).filter(Number.isFinite).sort((a, b) => a - b);
    if (cells.length < 8) throw new Error('no 3D data at this location');
    return { height: cells[Math.floor(cells.length * 0.15)] - Y_BASE, samples, tiles: nodes.length, cells: cells.length };
  }

  superchunk(frame, sx, sz, minY, height) {
    const key = `${frame.lat},${frame.lon},${frame.h0}|${sx},${sz}|${minY},${height}`;
    let entry = this.superchunks.get(key);
    if (entry) { this.superchunks.delete(key); this.superchunks.set(key, entry); return entry; }
    entry = (async () => {
      const t0 = Date.now();
      const x0 = sx * SC - MARGIN, z0 = sz * SC - MARGIN, w = SC + 2 * MARGIN;
      const nodes = await collectRegionTiles(this.client, frame, [x0, minY - 1, z0], [x0 + w, minY + height + 1, z0 + w], this.cfg.collisionError);
      const [meshes, water] = await Promise.all([this.meshesFor(nodes), this.waterFor(frame, x0, z0, w)]);
      const { vox, waterLevel } = voxelizeArea(frame, meshes, x0, z0, w, minY, height, { fallbackGround: Y_BASE - 1, water });
      console.log(`[chunk] superchunk ${sx},${sz}: ${nodes.length} tiles${waterLevel != null ? `, water at y=${waterLevel}` : ''}, ${Date.now() - t0} ms`);
      return { vox, x0, z0, w };
    })();
    entry.catch(() => this.superchunks.delete(key));
    this.superchunks.set(key, entry);
    while (this.superchunks.size > this.cfg.superchunkCache) this.superchunks.delete(this.superchunks.keys().next().value);
    return entry;
  }

  /** OSM water areas around an MC-space area, as MC segment lists. Never fails (no water on errors). */
  async waterFor(frame, x0, z0, w) {
    if (this.cfg.water === false) return [];
    const corners = [[x0, z0], [x0 + w, z0], [x0, z0 + w], [x0 + w, z0 + w]].map(([x, z]) => ecefToGeodetic(...frame.mcToEcef(x, Y_BASE, z)));
    const lats = corners.map((c) => c[0]), lons = corners.map((c) => c[1]);
    let features;
    try {
      features = await waterFeatures(this.cfg, Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons));
    } catch (e) {
      console.warn(`[water] OpenStreetMap not reachable, generating without water: ${e.message}`);
      return [];
    }
    this.waterCache ??= new Map();
    const out = [];
    for (const f of features) {
      const key = `${frame.lat},${frame.lon},${frame.h0}|${f.id}`;
      let mc = this.waterCache.get(key);
      if (!mc) {
        const segs = [];
        let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
        for (const line of f.lines) {
          let prev = null;
          for (const [lat, lon] of line) {
            const p = frame.ecefToMc(...geodeticToEcef(lat, lon, frame.h0));
            if (prev) segs.push(prev[0], prev[2], p[0], p[2]);
            prev = p;
            minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); minz = Math.min(minz, p[2]); maxz = Math.max(maxz, p[2]);
          }
        }
        mc = { segs: Float64Array.from(segs), minx, maxx, minz, maxz };
        this.waterCache.set(key, mc);
      }
      if (mc.maxx >= x0 && mc.minx <= x0 + w && mc.maxz >= z0 && mc.minz <= z0 + w) out.push(mc);
    }
    return out;
  }

  async chunk(frame, cx, cz, minY, height) {
    const sc = await this.superchunk(frame, Math.floor(cx / 4), Math.floor(cz / 4), minY, height);
    const out = new Uint8Array(16 * 16 * height);
    const ox = cx * 16 - sc.x0, oz = cz * 16 - sc.z0, w = sc.w;
    for (let y = 0; y < height; y++) for (let z = 0; z < 16; z++) {
      const src = (y * w + oz + z) * w + ox;
      out.set(sc.vox.subarray(src, src + 16), (y * 16 + z) * 16);
    }
    return out;
  }

  async renderSelect(frame, cam) {
    const r = this.cfg.render;
    const sseFactor = r.viewportHeight / (2 * Math.tan((r.fovDeg * Math.PI) / 360));
    const { tiles, pending } = await selectRenderTiles(this.client, frame, cam, {
      maxSse: r.maxSse, sseFactor, far: r.far, fineRadius: r.fineRadius, targetError: this.cfg.collisionError,
      maxTiles: r.maxTiles, falloff: r.falloff,
    });
    const attribution = new Set();
    for (const t of tiles) {
      const m = this.client.decoded.map.get(t.node.contentUrl);
      if (m?.copyright) for (const part of m.copyright.split(';')) if (part.trim()) attribution.add(part.trim());
    }
    if (this.cfg.water !== false) attribution.add('© OpenStreetMap');
    return {
      // parent/chain: coarser tiles (nearest first) the client shows until all wanted children are loaded.
      tiles: tiles.map((t) => ({ id: t.node.id, fine: isFine(t.node, this.cfg.collisionError), parent: contentParent(t.node)?.id ?? 0, chain: contentChain(t.node) })),
      pending,
      attribution: [...attribution],
    };
  }

  async renderTile(frame, id) {
    const node = this.client.nodes.get(id);
    if (!node || !node.hasContent) return null;
    const mesh = await this.client.getMesh(node);
    return encodeRenderTile(frame, mesh);
  }
}

/**
 * Binary layout (little endian):
 *   "ECT1", int32 primitiveCount, float64 anchorX, anchorY, anchorZ
 *   per primitive: int32 vertexCount, int32 texW, int32 texH, uint8[4] rgba fallback color,
 *                  float32[vertexCount*5] (x, y, z relative to anchor, u, v), uint8[texW*texH*4]
 * Triangles are unindexed (3 consecutive vertices).
 */
export function encodeRenderTile(frame, mesh) {
  let anchor = null;
  let size = 4 + 4 + 24;
  for (const prim of mesh.primitives) {
    const mc = mcPositions(frame, prim);
    if (!anchor && mc.length) anchor = [Math.floor(mc[0]), Math.floor(mc[1]), Math.floor(mc[2])];
    const t = prim.texture;
    size += 16 + prim.indices.length * 20 + (t ? t.width * t.height * 4 : 0);
  }
  anchor ??= [0, 0, 0];
  const buf = Buffer.alloc(size);
  let o = 0;
  buf.write('ECT1', o, 'ascii'); o += 4;
  buf.writeInt32LE(mesh.primitives.length, o); o += 4;
  for (const a of anchor) { buf.writeDoubleLE(a, o); o += 8; }
  for (const prim of mesh.primitives) {
    const mc = mcPositions(frame, prim);
    const t = prim.texture, idx = prim.indices, uv = prim.uvs;
    buf.writeInt32LE(idx.length, o); o += 4;
    buf.writeInt32LE(t ? t.width : 0, o); o += 4;
    buf.writeInt32LE(t ? t.height : 0, o); o += 4;
    buf[o++] = prim.color[0]; buf[o++] = prim.color[1]; buf[o++] = prim.color[2]; buf[o++] = 255;
    for (let k = 0; k < idx.length; k++) {
      const v = idx[k];
      buf.writeFloatLE(mc[v * 3] - anchor[0], o);
      buf.writeFloatLE(mc[v * 3 + 1] - anchor[1], o + 4);
      buf.writeFloatLE(mc[v * 3 + 2] - anchor[2], o + 8);
      buf.writeFloatLE(uv[v * 2], o + 12);
      buf.writeFloatLE(uv[v * 2 + 1], o + 16);
      o += 20;
    }
    if (t) { buf.set(t.data, o); o += t.data.length; }
  }
  return buf;
}

/** Address -> { lat, lon, address } via the Google Geocoding API. "lat, lon" strings are parsed directly. */
export async function geocode(cfg, text) {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)$/);
  if (m) return { lat: Number(m[1]), lon: Number(m[2]), address: `${m[1]}, ${m[2]}` };
  if (!text.trim()) throw Object.assign(new Error('empty query'), { status: 400 });
  const url = new URL(cfg.geocodeUrl ?? 'https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', text);
  url.searchParams.set('key', cfg.apiKey);
  url.searchParams.set('language', 'de');
  const r = await (await fetch(url)).json();
  if (r.status !== 'OK' || !r.results?.length) {
    throw Object.assign(new Error(`Ort nicht gefunden (${r.status}${r.error_message ? ': ' + r.error_message : ''})`), { status: 404 });
  }
  const best = r.results[0];
  return { lat: best.geometry.location.lat, lon: best.geometry.location.lng, address: best.formatted_address };
}

// ---------------------------------------------------------------- HTTP

function num(q, name) {
  const v = Number(q.get(name));
  if (!q.has(name) || !Number.isFinite(v)) throw Object.assign(new Error(`missing/invalid parameter ${name}`), { status: 400 });
  return v;
}

export function createServer(service) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams;
    try {
      switch (url.pathname) {
        case '/preview': {
          // Browser preview of the render data (same tiles the mod draws).
          const html = fs.readFileSync(path.join(serviceDir, 'preview', 'index.html'));
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(html);
        }
        case '/health':
          return json(res, { ok: true, hasKey: !!service.cfg.apiKey });
        case '/stats':
          return json(res, { ...service.client.stats, nodes: service.client.nodes.size, decoded: service.client.decoded.map.size });
        case '/geocode':
          return json(res, await geocode(service.cfg, q.get('q') ?? ''));
        case '/ground':
          return json(res, await service.ground(num(q, 'lat'), num(q, 'lon')));
        case '/chunk': {
          const frame = service.frame(num(q, 'lat'), num(q, 'lon'), num(q, 'h'));
          const data = await service.chunk(frame, num(q, 'cx'), num(q, 'cz'), num(q, 'minY'), num(q, 'height'));
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
          return res.end(data);
        }
        case '/render/select': {
          const frame = service.frame(num(q, 'lat'), num(q, 'lon'), num(q, 'h'));
          return json(res, await service.renderSelect(frame, [num(q, 'x'), num(q, 'y'), num(q, 'z')]));
        }
        case '/render/tile': {
          const frame = service.frame(num(q, 'lat'), num(q, 'lon'), num(q, 'h'));
          const data = await service.renderTile(frame, num(q, 'id'));
          if (!data) return json(res, { error: 'unknown tile' }, 404);
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
          return res.end(data);
        }
        default:
          return json(res, { error: 'not found' }, 404);
      }
    } catch (e) {
      const status = e.status && e.status < 500 && url.pathname !== '/chunk' ? e.status : 503;
      console.warn(`[http] ${url.pathname} failed: ${e.message}`);
      return json(res, { error: e.message }, status);
    }
  });
}

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  if (!cfg.apiKey && cfg.rootUrl.includes('googleapis.com')) {
    console.warn('WARNING: no Google API key set. Put it into service/config.json ("apiKey").');
  }
  const service = new EarthService(cfg);
  createServer(service).listen(cfg.port, '127.0.0.1', () => {
    console.log(`EarthCraft service listening on http://127.0.0.1:${cfg.port}  (tiles: ${new URL(cfg.rootUrl).host})`);
  });
}
