#!/usr/bin/env python3
"""Regenerate examples/graph-viewer-demo.html — the public, privacy-safe demo.

The graph is 100% synthetic: a fictional project ("demo-observatory") built
from a seeded vocabulary, so no real note content, file path or conversation
text can ever leak into the demo. The renderer template embedded below is the
same one the private vault viewer uses; only the payload differs.

Usage:
    python3 scripts/make-graph-demo.py                # regenerate the demo
    python3 scripts/make-graph-demo.py --seed 42      # different graph
    python3 scripts/make-graph-demo.py --out /tmp/x.html

Requires: numpy (pip install numpy).
"""

import argparse
import colorsys
import json
import math
import random

import numpy as np

PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8">
<title>Graph Viewer Demo — synthetic data (quadtree renderer)</title>
<style>
 body{margin:0;font:13px system-ui,sans-serif;background:#0d1117;color:#eee;overflow:hidden}
 #net{position:fixed;inset:0;background:#0d1117;cursor:grab}
 #net.drag{cursor:grabbing}
 /* ---- sidebar drawer ---- */
 #side{position:fixed;left:0;top:0;bottom:0;width:320px;z-index:9;display:flex;flex-direction:column;
       gap:10px;padding:14px 14px 10px;box-sizing:border-box;overflow:hidden;
       background:rgba(13,17,23,.96);border-right:1px solid #30363d;
       transition:width .18s ease;font-size:13px}
 #side.noanim{transition:none}
 #side.closed{width:0 !important;border-right-width:0;padding-left:0;padding-right:0}
 #grip{position:fixed;top:0;bottom:0;width:9px;z-index:11;cursor:col-resize}
 #grip::after{content:'';position:absolute;left:3px;top:0;bottom:0;width:3px;background:transparent}
 #grip:hover::after, #grip.active::after{background:#58a6ff}
 #side h1{font-size:13px;margin:0 0 2px;color:#8b949e;font-weight:600;letter-spacing:.4px}
 #menuBtn{position:fixed;top:10px;left:10px;z-index:10;width:34px;height:34px;border-radius:8px;
          border:1px solid #30363d;background:rgba(13,17,23,.9);color:#eee;cursor:pointer;font-size:15px}
 #side section{display:flex;flex-direction:column;gap:6px;min-height:0}
 #q{padding:7px 10px;border-radius:6px;border:1px solid #30363d;background:#161b22;color:#eee;width:100%;
    box-sizing:border-box}
 button.tg{padding:6px 10px;border-radius:6px;border:1px solid #30363d;background:#161b22;color:#eee;
           cursor:pointer;width:100%;text-align:left}
 #results{flex:1 1 auto;min-height:0;overflow:auto;border:1px solid #21262d;border-radius:8px;
          padding:6px;display:none;background:rgba(1,4,9,.5)}
 #results .hit{padding:3px 4px;border-radius:4px} #results .hit:hover{background:#161b22}
 .hit{cursor:pointer;color:#58a6ff} .hit:hover{text-decoration:underline}
 #secInfo{flex:1 1 auto;min-height:0}
 #info{flex:1 1 auto;min-height:0;overflow:auto;border:1px solid #21262d;border-radius:8px;
       padding:8px 10px;line-height:1.5;background:rgba(1,4,9,.5);overflow-wrap:anywhere}
 #info.hidden{display:none}
 #results{overflow-wrap:anywhere}
 #foot{margin-top:auto;display:flex;justify-content:space-between;opacity:.7;font-size:12px}
 hr{border:0;border-top:1px solid #21262d;margin:2px 0;width:100%}
</style></head><body>
<canvas id="net"></canvas>
<button id="menuBtn" title="buka/tutup sidebar">☰</button>
<div id="grip" title="drag untuk melebarkan/persempit; klik-ganda untuk buka/tutup"></div>
<aside id="side">
  <h1>GRAPH VIEWER DEMO</h1>
  <section>
    <input id="q" placeholder="cari label / file / community… (Enter)">
    <div id="results"></div>
  </section>
  <hr>
  <section>
    <button class="tg" id="tg">edges: auto</button>
  </section>
  <hr>
  <section id="secInfo">
    <div id="info"></div>
  </section>
  <div id="foot"><span id="stat">memuat…</span></div>
</aside>
<script>
"use strict";
/* ===== data ===== */
const DATA = __DATA__;
const COLS = __COLS__;
const NW = DATA.nodes.length, NE = DATA.links.length;
const xs = new Float32Array(NW), ys = new Float32Array(NW);
const ccolCache = new Map();
const ccolor = g => { let c = ccolCache.get(g); if (c) return c;
  let h = 0; for (let i = 0; i < g.length; i++) h = (h*31 + g.charCodeAt(i)) >>> 0;
  c = COLS[h % COLS.length]; ccolCache.set(g, c); return c; };
const colorOf = new Array(NW);
for (let i = 0; i < NW; i++) { const n = DATA.nodes[i]; xs[i] = n.x; ys[i] = n.y;
  colorOf[i] = (n.c && n.c !== '#97C2FC') ? n.c : ccolor(n.g); }
const id2idx = new Map(DATA.nodes.map((n, i) => [n.id, i]));
const ER = new Uint32Array(NE * 2);
for (let i = 0; i < NE; i++) { ER[2*i] = id2idx.get(DATA.links[i][0]) ?? 0xffffffff;
                               ER[2*i+1] = id2idx.get(DATA.links[i][1]) ?? 0xffffffff; }
/* adjacency: idx -> daftar {j: tetangga, r: jenis relasi} — untuk semantic sidebar */
const ADJ = new Array(NW);
for (let i = 0; i < NE; i++) {
  const a = ER[2*i], b = ER[2*i+1];
  if (a === 0xffffffff || b === 0xffffffff) continue;
  const rel = DATA.links[i][2] || 'terkait';
  (ADJ[a] ??= []).push({ j: b, r: rel });
  (ADJ[b] ??= []).push({ j: a, r: rel });
}

/* ===== quadtree (point quadtree, capacity 8, dibangun sekali) ===== */
class Rect {
  constructor(x, y, hw, hh) { this.x = x; this.y = y; this.hw = hw; this.hh = hh; }
  contains(x, y) { return x >= this.x - this.hw && x < this.x + this.hw &&
                          y >= this.y - this.hh && y < this.y + this.hh; }
  intersects(x0, y0, x1, y1) { return x0 <= this.x + this.hw && x1 >= this.x - this.hw &&
                                      y0 <= this.y + this.hh && y1 >= this.y - this.hh; }
}
class QuadTree {
  constructor(b, depth) { this.b = b; this.pts = []; this.divided = false; this.depth = depth; }
  insert(i, x, y) {
    if (!this.b.contains(x, y)) return false;
    if (!this.divided) {
      this.pts.push(i);
      if (this.pts.length > 8 && this.depth < 14) this.subdivide();
      return true;
    }
    return this.nw.insert(i, x, y) || this.ne.insert(i, x, y) ||
           this.sw.insert(i, x, y) || this.se.insert(i, x, y);
  }
  subdivide() {
    const { x, y, hw, hh } = this.b, hw2 = hw / 2, hh2 = hh / 2, d = this.depth + 1;
    this.nw = new QuadTree(new Rect(x - hw2, y - hh2, hw2, hh2), d);
    this.ne = new QuadTree(new Rect(x + hw2, y - hh2, hw2, hh2), d);
    this.sw = new QuadTree(new Rect(x - hw2, y + hh2, hw2, hh2), d);
    this.se = new QuadTree(new Rect(x + hw2, y + hh2, hw2, hh2), d);
    this.divided = true;
    const old = this.pts; this.pts = [];
    for (const i of old) this.insert(i, xs[i], ys[i]);
  }
}
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (let i = 0; i < NW; i++) { if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i];
                               if (ys[i] < minY) minY = ys[i]; if (ys[i] > maxY) maxY = ys[i]; }
const root = new QuadTree(new Rect((minX+maxX)/2, (minY+maxY)/2,
                                   (maxX-minX)/2 + 1, (maxY-minY)/2 + 1), 0);
for (let i = 0; i < NW; i++) root.insert(i, xs[i], ys[i]);

/* ===== view & render ===== */
let dirty = true, sel = -1, hoverI = -1, edgesMode = 'auto';
const cv = document.getElementById('net'), ctx = cv.getContext('2d');
let W = 0, H = 0, dpr = 1;
function resize() { dpr = window.devicePixelRatio || 1;
  W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = W + 'px'; cv.style.height = H + 'px'; dirty = true; }
addEventListener('resize', resize); resize();

const view = { cx: (minX+maxX)/2, cy: (minY+maxY)/2, scale: Math.min(W/(maxX-minX), H/(maxY-minY)) * 0.95 };
const statEl = document.getElementById('stat');

let frames = 0, fpsT = performance.now();
function tickFps() { frames++;
  const now = performance.now();
  if (now - fpsT >= 500) { statEl.textContent = `${Math.round(frames*1000/(now-fpsT))} fps · ${NW} node · ${NE} link`;
    frames = 0; fpsT = now; } }

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
  const s = view.scale;
  const x0 = view.cx - W / 2 / s, x1 = view.cx + W / 2 / s;
  const y0 = view.cy - H / 2 / s, y1 = view.cy + H / 2 / s;


  const drawEdges = edgesMode === 'on' || (edgesMode === 'auto' && s >= 0.9);
  if (drawEdges) {
    const m = 60 / s;
    ctx.strokeStyle = 'rgba(255,255,255,0.38)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < NE; i++) {
      const a = ER[2*i], b = ER[2*i+1];
      if (a === 0xffffffff || b === 0xffffffff) continue;
      const ax = xs[a], ay = ys[a], bx = xs[b], by = ys[b];
      if ((ax < x0 - m && bx < x0 - m) || (ax > x1 + m && bx > x1 + m) ||
          (ay < y0 - m && by < y0 - m) || (ay > y1 + m && by > y1 + m)) continue;
      ctx.moveTo((ax - view.cx) * s + W / 2, (ay - view.cy) * s + H / 2);
      ctx.lineTo((bx - view.cx) * s + W / 2, (by - view.cy) * s + H / 2);
    }
    ctx.stroke();
  }

  const nodePx = 4 * s;
  const dotMode = nodePx < 2.5;
  {
    const rr = nodePx;
    (function walk(qt) {
      if (!qt.b.intersects(x0, y0, x1, y1)) return;
      if (qt.divided) { walk(qt.nw); walk(qt.ne); walk(qt.sw); walk(qt.se); return; }
      for (let k = 0; k < qt.pts.length; k++) {
        const i = qt.pts[k];
        const sx = (xs[i] - view.cx) * s + W / 2, sy = (ys[i] - view.cy) * s + H / 2;
        if (sx < -4 || sx > W + 4 || sy < -4 || sy > H + 4) continue;
        if (i === sel) continue;
        ctx.fillStyle = colorOf[i];
        if (dotMode) ctx.fillRect(sx - rr, sy - rr, rr * 2, rr * 2);
        else { ctx.beginPath(); ctx.arc(sx, sy, rr, 0, 6.2832); ctx.fill(); }
      }
    })(root);
  }

  if (sel >= 0 && ADJ[sel]) {   // tetangga node terpilih: ring putih tipis
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    for (const e of ADJ[sel]) {
      const sx = (xs[e.j] - view.cx) * s + W / 2, sy = (ys[e.j] - view.cy) * s + H / 2;
      if (sx < -10 || sx > W + 10 || sy < -10 || sy > H + 10) continue;
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(nodePx + 3, 6), 0, 6.2832); ctx.stroke();
    }
  }
  const focus = sel >= 0 ? sel : hoverI;
  if (focus >= 0) {
    const sx = (xs[focus] - view.cx) * s + W / 2, sy = (ys[focus] - view.cy) * s + H / 2;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, Math.max(nodePx + 4, 7), 0, 6.2832); ctx.stroke();
    const n = DATA.nodes[focus];
    const label = String(n.l || n.id).slice(0, 60);
    ctx.font = '12px system-ui'; const tw = ctx.measureText(label).width;
    const lx = Math.min(sx + 10, W - tw - 20), ly = Math.max(sy - 18, 12);
    ctx.fillStyle = 'rgba(1,4,9,.85)'; ctx.fillRect(lx - 4, ly - 2, tw + 10, 20);
    ctx.fillStyle = '#eee'; ctx.fillText(label, lx, ly + 12);
  }
}

function loop() { tickFps(); if (dirty) { dirty = false; render(); } requestAnimationFrame(loop); }
requestAnimationFrame(loop);

/* ===== interaksi canvas ===== */
let dragging = false, lastX = 0, lastY = 0, moved = 0;
function nearest(wx, wy, px) {
  const r = px / view.scale; let best = -1, bd = r * r;
  (function q(qt) {
    if (!qt.b.intersects(wx - r, wy - r, wx + r, wy + r)) return;
    if (qt.divided) { q(qt.nw); q(qt.ne); q(qt.sw); q(qt.se); return; }
    for (const i of qt.pts) { const dx = xs[i] - wx, dy = ys[i] - wy, dd = dx*dx + dy*dy;
      if (dd < bd) { bd = dd; best = i; } }
  })(root);
  return best;
}
cv.addEventListener('mousedown', e => { dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
  cv.classList.add('drag'); });
addEventListener('mousemove', e => {
  if (dragging) {
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    view.cx -= dx / view.scale; view.cy -= dy / view.scale;
    lastX = e.clientX; lastY = e.clientY; dirty = true; return;
  }
  if (e.target !== cv) { if (hoverI !== -1) { hoverI = -1; dirty = true; } return; }
  const wx = view.cx + (e.clientX - W / 2) / view.scale;
  const wy = view.cy + (e.clientY - H / 2) / view.scale;
  const best = nearest(wx, wy, 12);
  if (best !== hoverI) { hoverI = best; dirty = true;
    cv.style.cursor = best >= 0 ? 'pointer' : 'grab'; }
});
addEventListener('mouseup', e => {
  if (!dragging) return; dragging = false; cv.classList.remove('drag');
  if (moved < 5) {
    const wx = view.cx + (e.clientX - W / 2) / view.scale;
    const wy = view.cy + (e.clientY - H / 2) / view.scale;
    selectNode(nearest(wx, wy, 14), false);
  }
});
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const f = Math.exp(-e.deltaY * 0.0012);
  const ns = Math.min(40, Math.max(0.02, view.scale * f));
  const wx = view.cx + (e.clientX - W / 2) / view.scale;
  const wy = view.cy + (e.clientY - H / 2) / view.scale;
  view.cx = wx - (e.clientX - W / 2) / ns;
  view.cy = wy - (e.clientY - H / 2) / ns;
  view.scale = ns; dirty = true;
}, { passive: false });

/* ===== sidebar ===== */
const side = document.getElementById('side'), menuBtn = document.getElementById('menuBtn');
const infoEl = document.getElementById('info'), resultsEl = document.getElementById('results'), grip = document.getElementById('grip');
/* ---- resize & collapse dinamis oleh mouse ---- */
const DEF_W = 320; let sideW = +(localStorage.getItem('sideW') || DEF_W);
side.style.width = sideW + 'px';
function setSide(w, animate = true) {
  if (!animate) side.classList.add('noanim');
  if (w < 70) { side.classList.add('closed'); side.style.width = '0px'; grip.style.left = '-4px'; }
  else { side.classList.remove('closed'); side.style.width = w + 'px'; sideW = w;
         grip.style.left = (w - 4) + 'px';
         localStorage.setItem('sideW', w); }
  if (!animate) requestAnimationFrame(() => side.classList.remove('noanim'));
}
setSide(sideW, false);
menuBtn.onclick = () => setSide(side.classList.contains('closed') ? (sideW || DEF_W) : 0);
let rsizing = false, rstartX = 0, rstartW = 0;
grip.addEventListener('mousedown', e => {
  e.stopPropagation(); rsizing = true; rstartX = e.clientX;
  rstartW = side.classList.contains('closed') ? 0 : side.getBoundingClientRect().width;
  grip.classList.add('active'); document.body.style.cursor = 'col-resize';
  side.classList.add('noanim'); e.preventDefault();
});
addEventListener('mousemove', e => {
  if (!rsizing) return;
  const nw = rstartW + (e.clientX - rstartX);
  setSide(nw, false);
  grip.style.left = (Math.max(nw, 0)) - 4 + 'px';
});
addEventListener('mouseup', e => {
  if (!rsizing) return; rsizing = false;
  grip.classList.remove('active'); document.body.style.cursor = '';
  side.classList.remove('noanim');
  setSide(side.getBoundingClientRect().width < 70 ? 0 : Math.max(side.getBoundingClientRect().width, 70));
});
grip.addEventListener('dblclick', () => setSide(side.classList.contains('closed') ? (sideW || DEF_W) : 0));
function selectNode(i, fly) {
  sel = i; showInfo(i);
  if (fly && i >= 0) { view.cx = xs[i]; view.cy = ys[i];
    view.scale = Math.max(view.scale, 2.5); }
  dirty = true;
}
function showInfo(i) {
  if (i < 0) { infoEl.classList.add('hidden'); return; }
  const n = DATA.nodes[i];
  const nb = ADJ[i] || [];
  const deg = nb.length;
  const shown = nb.slice(0, 40).sort((a, b) => a.r.localeCompare(b.r));
  infoEl.innerHTML = '<b>' + String(n.l || n.id).replace(/</g, '&lt;') + '</b>' +
    '<br><small>' + n.g + '</small>' +
    (n.t ? '<br><small>tipe: ' + n.t + '</small>' : '') +
    (n.f ? '<br><small>file: ' + n.f.replace(/</g, '&lt;') + '</small>' : '') +
    '<hr style="border:0;border-top:1px solid #21262d;margin:6px 0">' +
    '<small><b>' + deg + ' node terkait</b>' + (deg > 40 ? ' (40 ditampilkan)' : '') + '</small>' +
    '<div style="margin-top:4px">' +
    shown.map(e => { const m = DATA.nodes[e.j];
      return '<div class="hit" data-j="' + e.j + '" title="' + e.r + '">' +
        String(m.l || m.id).replace(/</g, '&lt;') +
        ' <small>— ' + e.r + '</small></div>'; }).join('') +
    '</div>';
  infoEl.classList.remove('hidden');
  infoEl.querySelectorAll('.hit').forEach(el => el.onclick = () => selectNode(+el.dataset.j, true));
}

document.getElementById('tg').onclick = e => {
  edgesMode = edgesMode === 'auto' ? 'on' : edgesMode === 'on' ? 'off' : 'auto';
  e.target.textContent = 'edges: ' + edgesMode; dirty = true;
};
document.getElementById('q').onkeydown = e => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim().toLowerCase(); if (q.length < 3) return;
  const all = [];
  for (let i = 0; i < NW; i++) { const n = DATA.nodes[i];
    if ((n.l || '').toLowerCase().includes(q) || n.f.toLowerCase().includes(q) || n.g.toLowerCase().includes(q)) all.push(i); }
  resultsEl.style.display = 'block';
  resultsEl.innerHTML = '<small>' + all.length + ' hasil — klik untuk fokus</small>' +
    all.slice(0, 60).map(i => { const n = DATA.nodes[i];
      return '<div class="hit" data-i="' + i + '">' + String(n.l || n.id).replace(/</g, '&lt;') +
             ' <small>(' + n.g + ')</small></div>'; }).join('');
  resultsEl.querySelectorAll('.hit').forEach(el => el.onclick = () => selectNode(+el.dataset.i, true));
};
addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement !== document.getElementById('q')) {
    e.preventDefault(); setSide(sideW || DEF_W);
    document.getElementById('q').focus();
  }
  if (e.key === 'Escape') { sel = -1; showInfo(-1); dirty = true; }
});
statEl.textContent = 'siap';
</script></body></html>"""

RNG = None  # set in main()


def build_graph():
    # ===== 1) data sintetis: graph fiksi "demo-observatory" =====
    themes = [
        ("Auth & Sessions", ["token refresh", "session store", "OAuth callback", "password hash", "MFA prompt", "device fingerprint"]),
        ("Billing Pipeline", ["invoice queue", "proration rule", "retry ladder", "dunning email", "tax rounding", "refund path"]),
        ("Search Index", ["shard rebalance", "query planner", "stemming rule", "ranking signal", "synonym map", "index compaction"]),
        ("Dashboard UI", ["chart virtualization", "theme tokens", "keyboard nav", "empty state", "grid breakpoint", "toast queue"]),
        ("Ingest Workers", ["backpressure valve", "dead-letter bin", "idempotency key", "batch window", "schema drift", "checkpoint store"]),
        ("Notifications", ["digest builder", "quiet hours", "channel fallback", "template render", "bounce classify", "preference sync"]),
        ("Storage Layer", ["compaction policy", "snapshot clone", "cold tiering", "block cache", "write amplification", "erasure coding"]),
        ("API Gateway", ["rate limiter", "request trace", "circuit breaker", "canary route", "payload guard", "latency budget"]),
        ("Docs & Guides", ["quickstart draft", "runbook audit", "glossary pass", "architecture note", "decision record", "onboarding path"]),
        ("Research Notes", ["vector clock", "crdt merge", "probabilistic filter", "sketch summary", "consensus quorum", "gossip protocol"]),
    ]
    project = "demo-observatory"

    nodes, links = [], []
    edges = set()
    def add_edge(a, b, rel):
        if a == b: return
        key = (min(a, b), max(a, b))
        if key in edges: return
        edges.add(key)
        links.append([nodes[a]["id"], nodes[b]["id"], rel])

    types = [("document", 0.45), ("concept", 0.3), ("code", 0.2), ("rationale", 0.05)]

    for ti, (theme, vocab) in enumerate(themes):
        size = random.randint(60, 130)
        base = random.sample(vocab, min(len(vocab), size // 4))
        idxs = []
        for k in range(size):
            t = random.choices([t for t, _ in types], weights=[w for _, w in types])[0]
            if t == "document":
                label = random.choice(["Plan", "Note", "Review", "Retro"]) + ": " + random.choice(base).title()
                f = f"01 - Projects/{project}/plans/2026-0{random.randint(1,9)}-{random.randint(10,28)}-{random.choice(base).replace(' ','-')}.md"
            elif t == "concept":
                label = random.choice(base).title()
                f = f"02 - Areas/{theme}/concepts/{random.choice(base).replace(' ','-')}.md"
            elif t == "code":
                label = random.choice(["src/" + theme.split()[0].lower(), "src/core"]) + "/" + random.choice(base).replace(' ', '_') + random.choice([".ts", ".py", ".mjs"])
                f = label
            else:
                label = "Why " + random.choice(base) + " works this way"
                f = f"03 - Resources/{theme}/rationale.md"
            nodes.append({"id": f"n{len(nodes)}", "l": label, "c": "", "g": theme,
                          "f": f, "t": t, "x": 0, "y": 0})
            idxs.append(len(nodes) - 1)
        # edge dalam community: hubungan mirip graph asli (tree + extra)
        for k in range(1, size):
            add_edge(idxs[random.randint(0, k - 1)], idxs[k], random.choice(
                ["references", "conceptually_related_to", "contains", "rationale_for"]))
        for _ in range(size // 3):
            add_edge(random.choice(idxs), random.choice(idxs), random.choice(
                ["references", "conceptually_related_to"]))
        # percakapan arcsip: komunitas ringan yang menunjuk ke theme ini
        if ti % 2 == 0:
            conv = f"Conv: debugging {random.choice(base)}"
            csize = random.randint(6, 12)
            cidx = []
            for k in range(csize):
                nodes.append({"id": f"n{len(nodes)}", "l": f"{conv} — bagian {k+1}", "c": "",
                              "g": conv, "f": f"05 - Conversations/{project}/{conv.replace(' ', '-').lower()}-{k+1}.md",
                              "t": "document", "x": 0, "y": 0})
                cidx.append(len(nodes) - 1)
            for k in range(1, csize):
                add_edge(cidx[k - 1], cidx[k], "followed_by")
            for _ in range(3):
                add_edge(random.choice(cidx), random.choice(idxs), "references")

    # beberapa hub lintas-community
    hubs = [random.randrange(len(nodes)) for _ in range(6)]
    for h in hubs:
        for _ in range(14):
            add_edge(h, random.randrange(len(nodes)), "references")


    return nodes, links

def layout(nodes, links):
    # ===== 2) layout force-directed (metode sama dengan graph asli) =====
    N = len(nodes)
    ids = {n["id"]: i for i, n in enumerate(nodes)}
    E = np.array(sorted(set(tuple(sorted((ids[a], ids[b]))) for a, b, _ in links)), dtype=np.int32)
    com = np.array([nodes[i]["g"] for i in range(N)])
    from collections import Counter
    order = [c for c, _ in Counter(com).most_common()]
    cell = {}
    x = y = 0; row_h = 0; used = 0
    Wg = math.ceil(math.sqrt(sum(math.ceil(math.sqrt(s)) * 14 + 6 for s in Counter(com).values())))
    posc = {}
    for c in order:
        s = math.ceil(math.sqrt(Counter(com)[c])) * 14 + 6
        if used + s > Wg: x = 0; y += row_h + 20; row_h = 0; used = 0
        posc[c] = (x + s / 2, y + s / 2); x += s + 20; used += s; row_h = max(row_h, s)
    pos = np.array([[posc[c][0] + np.random.randn() * 30, posc[c][1] + np.random.randn() * 30] for c in com])
    W = 9000.0
    pos = (pos - pos.min(0)) / (pos.max(0) - pos.min(0) + 1e-9) * W - W / 2
    k = 0.45 * math.sqrt(W * W / N); t = W * 0.03
    rng = RNG
    for it in range(260):
        anchors = rng.choice(N, 48, replace=False)
        diff = pos[:, None, :] - pos[anchors][None, :, :]
        d = np.sqrt((diff ** 2).sum(-1)) + 1e-6
        disp = ((k * k / d)[:, :, None] * diff / d[:, :, None]).sum(1)
        a, b = E[:, 0], E[:, 1]
        de = pos[a] - pos[b]; dl = np.sqrt((de ** 2).sum(-1)) + 1e-6
        f = (dl / k)[:, None] * de / dl[:, None]
        np.add.at(disp, a, -f); np.add.at(disp, b, f)
        dn = np.sqrt((disp ** 2).sum(-1)) + 1e-9
        pos += (disp / dn[:, None]) * np.minimum(dn[:, None], t)
        t *= 0.965
    pos -= pos.min(0)
    return pos


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--seed', type=int, default=20261003)
    ap.add_argument('--out', default='examples/graph-viewer-demo.html')
    args = ap.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    global RNG
    RNG = np.random.default_rng(args.seed)

    nodes, links = build_graph()
    pos = layout(nodes, links)
    for n, (px, py) in zip(nodes, pos):
        n["x"], n["y"] = round(float(px), 1), round(float(py), 1)

    cols = []
    for i in range(24):
        h = (i * 0.618033988749895) % 1.0
        r, gg, b = colorsys.hls_to_rgb(h, 0.60, 0.52)
        cols.append('#%02x%02x%02x' % (int(r * 255), int(gg * 255), int(b * 255)))

    data = json.dumps({"nodes": nodes, "links": links},
                      ensure_ascii=False, separators=(',', ':'))
    html = PAGE_TEMPLATE.replace('__DATA__', data).replace('__COLS__', json.dumps(cols))
    with open(args.out, 'w') as f:
        f.write(html)
    print(f'{args.out}: {len(nodes)} node, {len(links)} link sintetis, {len(html)/1e6:.1f} MB')
    print('audit privasi: grep -c <string-identitas> ' + args.out + '  # harus 0')


if __name__ == '__main__':
    main()
