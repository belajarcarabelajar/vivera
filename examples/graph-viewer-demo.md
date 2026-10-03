# Graph Viewer Demo

[graph-viewer-demo.html](./graph-viewer-demo.html) is a fully self-contained
(~0.2 MB, zero dependencies, works offline from `file://`) demonstration of the
knowledge-graph viewer used with the Vivera vault pipeline.

**The data in this demo is 100% synthetic.** It is generated from a seeded
random vocabulary (`demo-observatory`, a fictional project) so the demo can be
published without exposing any real note content, file paths, or conversation
text. Only the renderer and layout pipeline are the real thing.

## What it demonstrates

- **Point quadtree rendering** — the tree is built once over static positions;
  every frame only walks leaves intersecting the viewport, so panning and
  zooming stay at ~60 fps regardless of node count.
- **Level-of-detail** — nodes render as rects, circles or are skipped
  entirely depending on screen-space size; edges are viewport-culled per frame
  with a single batched `stroke()`.
- **Sidebar semantic navigation** — clicking a node lists its direct
  neighbours with their edge relation (`references`,
  `conceptually_related_to`, …); each entry is clickable and flies the camera
  to that node, enabling chained graph exploration.
- **Mouse-dynamic sidebar** — drag the right edge to resize, drag fully left
  to collapse, drag out again to reopen; `/` focuses search, `Esc` clears.

## How the real version differs

The production graph (`graphify-out/graph.json` inside the private vault)
carries real documents, code concepts and archived conversations. The viewer
itself is data-agnostic: it consumes `{nodes, links}` with static x/y
positions produced by a force-directed layout computed offline (numpy, sampled
repulsion + edge attraction), then embeds them as one JSON payload in the page.

Open the HTML file directly in any browser — no server needed.

## Regenerating the demo

The committed HTML is produced by [`scripts/make-graph-demo.py`](../scripts/make-graph-demo.py),
which is fully seeded — same seed, byte-identical output:

```bash
python3 scripts/make-graph-demo.py                     # default seed → examples/graph-viewer-demo.html
python3 scripts/make-graph-demo.py --seed 42 --out /tmp/alt.html
```

Requires numpy. The privacy property holds by construction: the generator's
vocabulary is fictional, so no real-world string can enter the output — and a
quick `grep` audit against identity strings is part of the script's own
final output.
