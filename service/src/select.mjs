// Tile selection: which tiles cover a region (collision) or are visible from a camera (rendering).

import { boxToMcAabb } from './geo.mjs';

function aabbOverlap(a, min, max) {
  return a.min[0] <= max[0] && a.max[0] >= min[0] && a.min[1] <= max[1] && a.max[1] >= min[1] && a.min[2] <= max[2] && a.max[2] >= min[2];
}

function nodeAabb(frame, node) {
  // Cache per frame; frames are long-lived per world.
  if (node._aabbFrame !== frame) {
    node._aabb = boxToMcAabb(frame, node.box);
    node._aabbFrame = frame;
  }
  return node._aabb;
}

export function isFine(node, targetError) {
  return node.geometricError <= targetError || !node.mayHaveChildren;
}

/** Nearest ancestor that has drawable content (the tile shown while this one loads). */
export function contentParent(node) {
  for (let p = node.parent; p; p = p.parent) if (p.hasContent) return p;
  return null;
}

/** Ids of all ancestors with drawable content, nearest first (fallbacks while a tile loads). */
export function contentChain(node, max = 12) {
  const out = [];
  for (let p = node.parent; p && out.length < max; p = p.parent) if (p.hasContent) out.push(p.id);
  return out;
}

/**
 * All content tiles at collision detail overlapping the MC-space box [min, max].
 * Waits for every needed external tileset to load.
 */
export async function collectRegionTiles(client, frame, min, max, targetError) {
  const root = await client.getRoot();
  const out = [];
  const walk = async (node) => {
    if (!aabbOverlap(nodeAabb(frame, node), min, max)) return;
    if (!node.expanded) await client.expand(node);
    const refine = node.children.length > 0 && (node.geometricError > targetError || !node.hasContent);
    if (refine) await Promise.all(node.children.map(walk));
    else if (node.hasContent) out.push(node);
  };
  await walk(root);
  return out;
}

/**
 * True if a node can be drawn (or fully replaced by drawable descendants) without waiting for
 * an external tileset to download. Kicks off the missing downloads.
 */
function ready(client, node, depth = 0) {
  if (!node.expanded) {
    client.expand(node).catch((e) => console.warn('[tiles] expand failed:', e.message));
    return false;
  }
  if (node.hasContent) return true;
  if (depth > 4) return true;
  let ok = node.children.length > 0;
  for (const c of node.children) if (!ready(client, c, depth + 1)) ok = false;
  return ok;
}

/**
 * Screen-space-error driven selection around a camera. Never waits: a tile is only replaced by
 * its children once all of them are known, so no area ever drops out while the tree loads.
 * The allowed error grows smoothly with distance, which keeps the tile count bounded without
 * whole-scene detail jumps.
 */
export async function selectRenderTiles(client, frame, cam, opts) {
  const root = await client.getRoot();
  const { maxSse, sseFactor, far, fineRadius, targetError, maxTiles, falloff } = opts;
  const out = [];
  let pending = 0;
  const visit = (node) => {
    const bb = nodeAabb(frame, node);
    const dx = bb.center[0] - cam[0], dy = bb.center[1] - cam[1], dz = bb.center[2] - cam[2];
    const dist = Math.max(0, Math.hypot(dx, dy, dz) - bb.radius);
    if (dist > far) return;
    const sse = (node.geometricError * sseFactor) / Math.max(dist, 1);
    const allowed = maxSse * (1 + dist / falloff);
    const wantRefine = !node.hasContent || sse > allowed || (dist < fineRadius && node.geometricError > targetError);
    if (wantRefine && node.mayHaveChildren) {
      let childrenReady = node.expanded;
      if (!node.expanded) ready(client, node);
      else for (const c of node.children) if (!ready(client, c)) childrenReady = false;
      if (childrenReady || !node.hasContent) {
        if (!childrenReady) pending++;
        for (const c of node.children) visit(c);
        return;
      }
      pending++; // keep showing this tile until its children are known
    }
    if (node.hasContent) out.push({ node, dist });
  };
  visit(root);
  out.sort((a, b) => a.dist - b.dist);
  return { tiles: out.length > maxTiles ? out.slice(0, maxTiles) : out, pending };
}
