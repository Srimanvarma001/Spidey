# 🕷️ Web Crawler — Architecture

> A procedurally animated spider that walks across whatever webpage it is injected into, plants its feet on real links and words, and drags them out of place.
>
> This document is the design for the code in this repo. `spider-web-crawler.md` is the original brief (what the viral clip shows, and a rough plan); this file is the concrete architecture: what each part does, how the parts talk, the data they share, and why each decision was made.

---

## Contents

1. [Goals and non-goals](#1-goals-and-non-goals)
2. [What the clip shows → requirements](#2-what-the-clip-shows--requirements)
3. [System overview](#3-system-overview)
4. [Repo layout](#4-repo-layout)
5. [Lifecycle](#5-lifecycle)
6. [Coordinate systems](#6-coordinate-systems)
7. [Module: Text layer](#7-module-text-layer)
8. [Module: Body](#8-module-body)
9. [Module: Legs](#9-module-legs)
10. [Module: Grab FX](#10-module-grab-fx)
11. [Module: Renderer](#11-module-renderer)
12. [Frame loop](#12-frame-loop)
13. [Reset and undo](#13-reset-and-undo)
14. [Performance](#14-performance)
15. [Packaging](#15-packaging)
16. [Tuning guide](#16-tuning-guide)
17. [Known limitations](#17-known-limitations)
18. [Test checklist](#18-test-checklist)
19. [Roadmap](#19-roadmap)

---

## 1. Goals and non-goals

**Goals**

- Reproduce the clip: an 8-legged spider with 2-segment legs that walks over a page, grips links, and leaves a trail of restyled, displaced text.
- Work on **any** site with one click, not only on a demo page.
- **Fully reversible.** One key (Esc) or a second click puts the page back exactly as it was.
- One file, no dependencies, no build step. The same `crawler.js` runs from the extension, a bookmarklet, the demo page, or pasted into the console.
- 60 fps on a Wikipedia-sized article.

**Non-goals**

- It is not a data crawler. Nothing is fetched, scraped, or sent anywhere.
- No persistence. Reloading the page resets everything.
- No support for text inside iframes, shadow DOM, or `<canvas>`-rendered pages (Google Docs, Figma).

---

## 2. What the clip shows → requirements

The brief was reconstructed from four frames. Reading those frames closely settles several design questions.

| Seen in the frames | Conclusion | Where it lands in the design |
|---|---|---|
| Blue rounded rectangle, tilted, with a bright dot at one end | Body is a rotated rect; the dot marks the head | [Renderer](#11-module-renderer) |
| 8 polylines from the body, dots at the bends and tips | 2-segment legs; dots are knee and foot joints | [Legs](#9-module-legs) |
| Leg tips end exactly on ISBNs, DOIs, titles, and a thin box is drawn around the element under a tip | Feet snap to page elements; a planted foot "grips" its element | [Legs §9.4](#94-choosing-where-to-land), [Renderer](#11-module-renderer) |
| In ref. 147 the plain text *"Wright, M. Rosemary."*, *"mythandreligion.upatras.gr"* and *"Retrieved 3 January 2023"* stay put while the two **links** in the same line are gone | The original moves `<a>` elements as whole units. Plain text is mostly left alone | [Text layer §7.1](#71-two-kinds-of-target) |
| Where a link was, there is a **blank gap** of the same width; surrounding text does not reflow | The original is hidden in place and a copy is animated | [Grab FX §10.1](#101-why-a-floating-copy-and-not-a-transform-on-the-original) |
| A link title that wraps over two lines in the article appears as one long single-line banner | The moved copy is laid out on one line | [Grab FX §10.2](#102-pick-up) |
| Displaced text shows new fonts (monospace, serif italic), new colours, solid highlight bars, thin outline boxes, and sizes from tiny to ~2× | Random restyle per grabbed element | [Grab FX §10.3](#103-restyle) |
| Most displaced text sits close to where it started; a few pieces are rotated 40–80° | Small drag distance, mostly small rotations with occasional large ones | [Grab FX §10.3](#103-restyle) |
| Legs are orange with green joints in one frame, light blue with pink joints in the others | The spider's colours change over time | [Renderer §11.2](#112-themes) |
| The page scrolls during the clip and the spider stays in view | The spider chases the viewport | [Body §8.2](#82-goals) |

Two points differ from the brief on purpose:

1. **Links are first-class targets.** The brief wraps every word. The frames show links moving as units, so links are preferred; plain words are a secondary target so the spider still has something to grip on pages with few links.
2. **Words are moved as floating copies**, not by transforming the original `<span>` as `inline-block`. See [§10.1](#101-why-a-floating-copy-and-not-a-transform-on-the-original).

---

## 3. System overview

Everything lives in one IIFE in `extension/crawler.js`. Internally it is five modules that share a small amount of state and are driven by one `requestAnimationFrame` loop.

```
                         ┌───────────────────────────────────────────┐
   pointermove ─────────▶│                                           │
   scroll / resize ─────▶│              INPUT + LIFECYCLE            │
   keydown (Esc) ───────▶│   init · event handlers · destroy/undo    │
                         └───────┬─────────────────────────┬─────────┘
                                 │ scanAt                  │ mouse
                                 ▼                         ▼
┌──────────────────────────────────────┐      ┌───────────────────────────┐
│ TEXT LAYER                           │      │ BODY                      │
│  scan()    find links + wrap words   │      │  goal: cursor or wander   │
│  measure() cache rects (doc coords)  │◀─────│  steering, heading        │
│  grid      spatial hash of targets   │ wander└────────────┬──────────────┘
│  nearest() closest free target       │ goal               │ x, y, angle, v
└───────────────┬──────────────────────┘                    ▼
                │ nearest()                   ┌───────────────────────────┐
                └────────────────────────────▶│ LEGS  (×8)                │
                                              │  gait gate, step trigger  │
                                              │  step tween, 2-bone IK    │
                                              └──────┬─────────────┬──────┘
                                           on lift   │             │ hip/knee/foot
                                                     ▼             ▼
                              ┌──────────────────────────┐  ┌──────────────────┐
                              │ GRAB FX                  │  │ RENDERER         │
                              │  hide original           │  │  fixed <canvas>  │
                              │  floating copy + restyle │  │  grips, legs,    │
                              │  drag along the step     │  │  joints, body    │
                              └──────────────────────────┘  └──────────────────┘
                                 writes to the DOM             draws pixels only
```

Two things are added to the page, both as children of `<html>`:

| Element | CSS | Purpose |
|---|---|---|
| `<canvas data-wc>` | `position: fixed; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2147483647` | The spider itself |
| `<div data-wc>` (the *float layer*) | `position: absolute; left: 0; top: 0; overflow: hidden; pointer-events: none; z-index: 2147483646`, sized to the document | Holds the displaced copies of text |

The canvas sits above the float layer, so legs are drawn over the words they are dragging.

Both must add **zero** scrollable overflow, or the page gains a scrollbar the moment the spider appears:

- The canvas is sized with `100%`, not `100vw/100vh`. Viewport units include the scrollbar; percentages on a fixed element do not.
- The float layer is `width: 100%` and `height: body.scrollHeight − 1px`. `scrollHeight` is rounded up to an integer, so at a fractional zoom or device pixel ratio (1.25, 1.5) a layer of exactly that many pixels overhangs the document by a fraction of a pixel, which is enough to create a scrollbar. This was caught in testing at DPR 1.5.
- The layer's `overflow: hidden` clips rotated banners at the document edge for the same reason.

---

## 4. Repo layout

```
spidey/
├── archi.md                 this file
├── spider-web-crawler.md    the original brief
├── README.md                how to run it
├── extension/               loadable as an unpacked Chrome extension
│   ├── manifest.json        Manifest V3
│   ├── background.js        icon click → inject crawler.js into the tab
│   ├── crawler.js           THE WHOLE SPIDER (single source of truth)
│   └── icons/               16 / 48 / 128 px
├── demo/
│   └── index.html           dark, Wikipedia-style references page for local testing
└── tools/
    └── make-icons.ps1       regenerates extension/icons/*.png
```

`crawler.js` exists in exactly one place. The demo page loads it with a relative `<script src="../extension/crawler.js">`, so there is nothing to copy or build.

---

## 5. Lifecycle

```
 inject #1 ──▶ init ──▶ ┌──────────── running ────────────┐ ──▶ destroy ──▶ page restored
                        │  rAF loop: scan? → body → legs  │        ▲
                        │            → draw               │        │
                        └─────────────────────────────────┘        │
 inject #2 (icon clicked again) ───────────────────────────────────┤
 Esc ──────────────────────────────────────────────────────────────┘
```

- **Toggle by re-injection.** The first line of the script checks `window.__webCrawler`. If it exists, the script calls its `destroy()` and returns. So "click the icon again" turns the spider off, and `background.js` needs no state.
- **init**: detect dark/light page, create canvas and float layer, place the body just above the top of the viewport facing down, put all eight feet on their rest spots, register listeners, schedule the first scan, start the loop.
- **destroy**: see [§13](#13-reset-and-undo).

The spider never starts on its own. It only runs after a user action.

---

## 6. Coordinate systems

| Space | Origin | Used for |
|---|---|---|
| **Document** | top-left of the page | body, hips, knees, feet, target rects, floating copies, wander goal |
| **Client** | top-left of the viewport | the raw pointer position, `getClientRects()` results, the canvas |
| **Body-local** | body centre, +x = forward, +y = the spider's right | hip offsets and rest-spot offsets |

Rules:

- All simulation state is in **document** space. A planted foot must not move when the user scrolls, and in document space it does not.
- Client → document: add `scrollX/scrollY` (cached once per frame as `sx/sy`).
- Body-local → document: rotate by the heading, add the body position.

  ```
  wx = body.x + lx·cos θ − ly·sin θ
  wy = body.y + lx·sin θ + ly·cos θ
  ```

- The renderer draws in document space by applying `ctx.translate(-sx, -sy)` once per frame.
- The pointer is stored in **client** space and converted when read. If the user scrolls without moving the mouse, the goal moves with the viewport, which is what you want.

Screen y points down, so a positive rotation is clockwise and body-local +y is the spider's right-hand side.

---

## 7. Module: Text layer

Job: know where every grippable thing is, and answer "what is the nearest free target to this point?" in well under a millisecond.

### 7.1 Two kinds of target

| Kind | What | DOM change needed to make it a target | Priority |
|---|---|---|---|
| **Link** | An `<a>` treated as one unit | none | high |
| **Word** | One word of plain text | its text node is split and the word wrapped in `<span data-wc="w">` | low |

A link counts as a unit when all of these hold, otherwise the walker descends into it and its text is treated as plain words:

- trimmed text length is 1–90 characters
- its box is at least 4×4 px and at most 80 px tall (about three lines)
- it contains no `img, svg, picture, video, canvas, div, p, table, ul, ol, h1–h4` (so image links and card-style links are excluded)

Words must contain at least one letter or digit. Bare punctuation stays as text.

### 7.2 The target record

```js
{
  el,      // the <a> or the word <span>
  link,    // true for links
  x, y,    // top-left of its first line box, document space
  w, h,    // size of that box (w = 0 means "not visible right now")
  leg,     // the leg that has reserved or is standing on it, or null
  gone,    // true once it has been grabbed; never targeted again
  q,       // id of the last nearest() query that visited it (dedupe stamp)
}
```

The rect is `el.getClientRects()[0]`, the **first line fragment**, not the bounding box. For a link that wraps onto a second line the bounding box would be a paragraph-wide rectangle; the first fragment is the part a foot can sensibly stand on, and it is where the floating copy starts from.

### 7.3 `scan()` — find new targets near the viewport

Runs at start, then ~120 ms after any scroll or resize. Only the **scan region** is processed: the viewport plus `scanMargin` (500 px) above and below.

It is strictly phased so that layout is computed once, not once per element:

```
phase 1  READ   TreeWalker over <body> (elements + text nodes)
                 element:  reject if it matches SKIP, or is an already-known link
                           reject if its rect is entirely outside the scan region
                              (this prunes the whole subtree; elements with zero
                               height are not pruned, they may only hold floats)
                           if it is a unit link → collect it, do not descend
                           otherwise descend
                 text:     collect if it contains a letter or digit
phase 2  READ   for each collected text node:
                 drop it if its parent is a flex/grid container (see below)
                 drop it if its own Range rect is outside the scan region
phase 3  WRITE  split each remaining text node on whitespace, wrap words in spans
phase 4  READ   measure()
```

`SKIP` = `script, style, noscript, textarea, input, select, option, button, svg, canvas, video, audio, iframe, object, embed, pre, code, [contenteditable], [data-wc]`.

Why text directly inside a flex or grid container is skipped: such a text run is a single anonymous flex item. Splitting it into several `<span>`s would make each word its own flex item and collapse the spaces between them, visibly breaking the page.

Nothing needs a "seen" flag on text nodes. After wrapping, the words sit inside `[data-wc]` spans (rejected by `SKIP`) and what remains between them is whitespace (rejected by the letter-or-digit test). Links are remembered in a `WeakSet`, so no attribute is written to the page's own elements.

### 7.4 `measure()` — refresh rects and rebuild the grid

Runs after every scan and every `remeasureEvery` (2.5 s), to absorb late layout shifts such as images loading.

1. Drop targets that were grabbed or whose element left the DOM.
2. Read `getClientRects()[0]` for each remaining target and store it in document space.
3. Resize the float layer to the current document size (measured from `<body>`, which the layer is not a child of, so the layer can never prop the document open after the page shrinks).
4. Rebuild the spatial grid.

Step 2 is read-only, so the browser lays out at most once.

### 7.5 Spatial grid

A uniform hash grid with `cell` = 96 px.

- Key: `gy · 4096 + gx` (an integer, so lookups allocate nothing).
- A target is inserted into **every cell its rect overlaps**, so a wide link is found from either end.
- Because a target can sit in several cells, each query increments a counter and stamps visited targets (`t.q`), so each is evaluated once.

### 7.6 `nearest(x, y, radius, hx, hy, reach, skip)`

Scans the cells covering the circle and returns the best free target plus the exact point a foot should land on.

- The landing point is the query point clamped into the rect horizontally (3 px inset), on the rect's vertical centre line. Feet therefore land on the near end of a long link, not always its middle.
- A target is rejected if it is `gone`, reserved by another leg, equal to `skip` (the word the foot just left), further than `radius` from the query, or further than `reach` from `(hx, hy)` (the hip, so a leg is never asked to reach a spot it cannot touch).
- **Links win.** A word's distance is scored as `d · 1.6 + 6`. A word is chosen only when no link is comparably close.

---

## 8. Module: Body

State: `{ x, y, vx, vy, angle, speed, cos, sin }`.

### 8.1 Steering

Each frame the body has a goal `{ x, y, stop, max }`.

```
dist    = |goal − body|
desired = direction to goal · min((dist − stop) · 2.5, max)      (0 inside the stop radius)
v      += (desired − v) · (1 − e^(−steer·dt))                    frame-rate independent smoothing
pos    += v · dt
heading turns toward atan2(vy, vx) along the shortest arc, rate turnRate; frozen below 6 px/s
```

Speed proportional to distance gives a natural ease-in on arrival. Exponential smoothing rather than `v += (…)·k·dt` keeps the motion identical at 60 Hz and 144 Hz.

### 8.2 Goals

| Mode | When | Goal | `stop` | `max` |
|---|---|---|---|---|
| **Follow** | the pointer moved in the last `mouseIdle` (2.5 s) | pointer position | 40 px | `followSpeed` 300 px/s |
| **Wander** | otherwise | a wander point | 0 | `wanderSpeed` 150 px/s |
| **Scurry** | the body is more than 250 px outside the viewport (either mode) | same goal | same | `scurrySpeed` 1300 px/s |

Wander point selection: pick a random point in the middle ~75 % of the viewport, then snap it to the nearest target within 220 px. The spider therefore heads for text, not for empty margins. A new point is chosen when:

- the current one has scrolled out of view, or
- the spider arrived and its pause (0.3–1.4 s) is over, or
- 7 s have passed without arriving.

Scurry is what keeps the spider in frame while the page scrolls, as in the clip.

---

## 9. Module: Legs

Eight legs, four per side, built once.

### 9.1 Geometry

```
                 heading →
        L4    L3    L2    L1
          \    \    /    /            rest spots: fan at restAngles
           ●────●──●────●             [0.55, 1.15, 1.9, 2.6] rad from the heading,
         ╔═══════════════════╗        radius restRadius · (1.1 for pairs 1 and 4,
         ║        body     ◉ ║                             0.95 for pairs 2 and 3)
         ╚═══════════════════╝
           ●────●──●────●             hips: along both long edges of the body
          /    /    \    \
        R4    R3    R2    R1
```

| Constant | Value | Meaning |
|---|---|---|
| `upperLen` | 62 px | hip → knee |
| `lowerLen` | 84 px | knee → foot |
| `REACH` | 146 px | their sum; the furthest a foot can be from its hip |
| `restRadius` | 98 px | distance of the rest spots from the body centre |

The rest spots sit at about two-thirds of full reach, so legs are visibly bent at rest and have room to stretch before they must step.

### 9.2 Per-leg state

```js
{
  side,               // −1 left, +1 right
  group,              // 0 or 1, the tetrapod group
  bend,               // ±1, which side of the hip→foot line the knee is on
  hipX, hipY,         // body-local
  restX, restY,       // body-local
  jitter,             // 0.85–1.15, de-synchronises step thresholds
  hx, hy, kx, ky,     // hip and knee, document space, recomputed every frame
  x, y,               // foot, document space; constant while planted
  stepping, t,        // step tween state, t in 0..1
  stepTime,           // duration of the current step
  fromX, fromY, toX, toY,
  lift,               // 0..1..0 over a step, used to draw the foot larger mid-air
  plantErr,           // how far the foot was from its rest spot when it landed
  target,             // target the planted foot is standing on
  next,               // target reserved for the step in progress
  carry,              // floating copy being dragged by this step
}
```

### 9.3 State machine

```
                    stretched
                 or (behind and other group planted)
   ┌─────────┐ ─────────────────────────────────────▶ ┌──────────┐
   │ PLANTED │        startStep(): lift, maybe grab    │ STEPPING │
   └─────────┘ ◀───────────────────────────────────── └──────────┘
                      t reaches 1: plant(), drop
```

**Step trigger.** With `err` = distance from the foot to its rest spot:

- `behind`    = `err > max(stepDist · jitter, plantErr + 0.6 · stepDist)`
- `stretched` = `|foot − hip| > 0.96 · REACH`

`plantErr` matters because feet snap to words. A foot may land 50 px from its rest spot on purpose. Without the `plantErr` term it would be "behind" the instant it landed and would step again immediately, forever, even with the body standing still. With it, a foot only steps once the body has moved a further `0.6 · stepDist` away from wherever the foot chose to land.

`stretched` is the safety valve. It **ignores the gait gate**: a leg that physically cannot reach its foot steps now. This is what keeps the legs attached during a scurry.

**Gait gate (alternating tetrapod).**

- Group 0: L1, R2, L3, R4
- Group 1: R1, L2, R3, L4

A leg may begin a normal step only if no leg of the *other* group is mid-step. Four feet are always on the ground, and the two groups alternate. `group = (pairIndex + (side > 0 ? 1 : 0)) % 2`.

**Step duration** shortens as the body speeds up so legs can keep pace:

```
stepTime = clamp(stepDist / (1.6 · speed + 1), minStepTime 0.06 s, stepTime 0.15 s)
```

**Idle fidget.** When the body is slower than 12 px/s, every 0.35–1.1 s one random planted leg re-steps to its rest spot ± 30 px. A spider standing still keeps pawing at the text instead of freezing.

### 9.4 Choosing where to land

```
aim     = rest spot + v · (lead + stepTime)        where the rest spot will be, plus a lead
hipThen = hip + v · stepTime                       where the hip will be on landing
aim     = aim pulled inside 0.9 · REACH of hipThen
hit     = nearest(aim, snapRadius 64, hipThen, 0.9 · REACH, skip = word just left)
land    = hit ? hit.point : aim
```

The lead makes the foot land ahead of its rest spot, so the body walks *over* it before it falls behind. If a target was hit it is reserved (`target.leg = leg`) for the whole flight, so two feet never choose the same word.

### 9.5 Step tween

```
t    += dt / stepTime
e     = t²(3 − 2t)                 smoothstep
foot  = lerp(from, to, e)
lift  = sin(π · t)
```

### 9.6 Inverse kinematics

Two bones, solved with the law of cosines. `a` = upper, `b` = lower, `d` = hip → foot distance clamped to `(|a − b|, a + b)`:

```
base  = atan2(foot − hip)
A     = acos((a² + d² − b²) / (2·a·d))       angle at the hip
knee  = hip + a · (cos, sin)(base + bend · A)
```

`bend` is fixed per leg, so a knee can never flip to the other side:

- front two pairs: `bend = −side` → knees point forward
- back two pairs:  `bend = +side` → knees point backward

That gives the arched, splayed silhouette of a real spider seen from above.

**Hard clamp.** If the foot is further than `REACH` from the hip, the solver pulls the foot back onto the reach circle before solving. At scurry speed the body covers ~21 px per frame and can outrun a foot that is mid-step; without the clamp the lower leg segment visibly stretches. With it, `|foot − hip| ≤ REACH` holds on every frame (measured: exactly 146.0 px maximum during a 1300 px/s scurry).

---

## 10. Module: Grab FX

### 10.1 Why a floating copy and not a transform on the original

The brief suggests `display: inline-block` + `transform` on the original span. That fails on the exact thing the clip shows moving, multi-word links:

- an `inline-block` cannot break across lines, so a wrapped link would jump to the next line and **reflow the paragraph** the moment it is grabbed;
- the frames show a blank gap exactly where each link used to be, with no reflow.

So instead:

1. The original gets `visibility: hidden !important`. It keeps its box, so layout does not change at all, and a gap is left behind.
2. A copy (`<span>`, text only) is created in the float layer and animated with `transform`.

Extra benefits: undo is trivial (remove the layer, restore `visibility`), the copy cannot be affected by the page's own CSS, and the page's elements never get a transform (no stacking-context or clipping surprises).

### 10.2 Pick up

Called from `startStep()` for the target the foot was standing on, with probability `linkGrabChance` (0.75) for links and `wordGrabChance` (0.3) for words.

```
text  = el.innerText, whitespace collapsed
copy  = <span> with  all: initial; position: absolute; left: 0; top: 0;
                     white-space: nowrap; transform-origin: 50% 50%; will-change: transform
        + font-family/size/weight/style and colour copied from the original's computed style
        + line-height = original box height (so the glyphs start exactly where they were)
copy.transform = translate(target.x, target.y)
original       → visibility: hidden !important       (previous inline value saved)
target.gone    = true
leg.carry      = { el, x, y, dx, dy, rot, scale }
```

`dx, dy` = the step vector × a random 0.3–0.9. The word is kicked along with the foot but lands short of it, which keeps displaced text near its origin, as in the clip.

### 10.3 Restyle

Applied once, at pick-up.

| Property | Rule |
|---|---|
| Font | random from: system monospace, Courier New, Georgia, Times New Roman, Impact |
| Italic | 30 % |
| Look | 35 % solid **banner** (palette background, dark text, small padding) · 25 % coloured text + 1.5 px **outline box** · 15 % coloured text + translucent tint · 25 % coloured text only |
| Letter-spacing | 0.08 em, 20 % |
| Scale | 30 % big (1.4–2.3×, capped at 1.2× for text over 24 chars) · 20 % tiny (0.4–0.65×) · 50 % about normal (0.9–1.15×) |
| Rotation | 30 % large (±80°) · 70 % slight (±9°) |

Palette (dark pages): `#4fd1ff #ff4f8b #5be37d #ff8a3d #b48cff`.
Palette (light pages): `#0b7fc2 #d81b60 #1a8f3c #d9480f #6f42c1`, with white banner text.

Page darkness is detected once at init: walk up from the element at the centre of the viewport to the first non-transparent `background-color` and test its luminance.

### 10.4 Drag and drop

While the leg is stepping, with the same eased `e` as the foot:

```
transform = translate(x + dx·e, y + dy·e) rotate(rot·e deg) scale(1 + (scale − 1)·e)
```

When the foot plants, the copy stays where it is permanently, `will-change` is removed (so hundreds of dropped words do not each hold a compositor layer), and `leg.carry` is cleared. A dropped copy is not a target; each element is displaced once.

---

## 11. Module: Renderer

One canvas, sized `innerWidth × innerHeight` CSS pixels and backed by `× devicePixelRatio` device pixels.

### 11.1 Draw order (back to front)

1. **Grips**: for every planted leg standing on a target, a 1.5 px box around the target rect in the head colour.
2. **Legs**: polyline hip → knee → foot, 2.4 px, round caps and joins.
3. **Joints**: 3.2 px dots at the knee and foot. The foot dot grows by up to 2.2 px with `lift`, which reads as the foot coming off the page.
4. **Body**: rounded rect `bodyLength × bodyWidth` (52 × 18), rotated to the heading, translucent dark fill, 2.5 px stroke.
5. **Head**: 3.6 px dot near the front end.

### 11.2 Themes

| Theme | Legs | Joints | Body | Head / grips |
|---|---|---|---|---|
| A | light blue | pink | blue | cyan |
| B | orange | green | blue | magenta |

Both come straight from the frames. The active theme advances every `themeEvery` (6 s) and the colours are linearly blended over the last 10 % of each period, so the change is a quick fade and not a pop.

---

## 12. Frame loop

```js
function frame(now) {
  raf = requestAnimationFrame(frame);
  dt  = clamp((now − last) / 1000, 0, 0.05); // a background tab must not teleport the spider, and
                                             // a frame timestamp can be earlier than script start
  sx  = scrollX;  sy = scrollY;

  if (now ≥ scanAt)         scan();          // includes measure()
  else if (now ≥ measureAt) measure();

  updateBody(dt, now);                       // goal → velocity → position → heading
  updateLegs(dt, now);                       // hips, step logic, tween, drag carried word, IK, fidget
  draw(now);
}
```

Order matters: the body moves first, so hips and rest spots used by the legs are current, and the renderer sees a consistent pose.

**Events**

| Event | Handler |
|---|---|
| `pointermove` (passive) | store client x/y and timestamp |
| `scroll` (capture, passive) | `scanAt = min(scanAt, now + 120)`. Capture also catches scrolling inside inner containers |
| `resize` | resize canvas, schedule a scan |
| `keydown` Escape | `destroy()` |

---

## 13. Reset and undo

Every change to the page is recorded as it is made, so `destroy()` can reverse all of it:

| Change made | Recorded in | Undone by |
|---|---|---|
| canvas and float layer added | module variables | `.remove()` (all floating copies go with the layer) |
| original element hidden | `hidden[]` as `[el, previous value, previous priority, had a style attribute]` | restore or remove the inline `visibility`; remove the `style` attribute if the element had none (otherwise an empty `style=""` is left behind) |
| words wrapped in spans | `wrapped[]` | replace each span with its text, then `normalize()` each affected parent to merge the text nodes back together |
| event listeners, rAF | — | removed / cancelled |
| `window.__webCrawler` | — | deleted |

After `destroy()` the DOM is identical to what it was before injection: on the demo page `document.body.innerHTML` compares equal, character for character, before and after a run that displaced ~60 elements and wrapped ~670 words.

`window.__webCrawler` is `{ destroy, config, body, legs }`. `body` and `legs` are the live simulation objects, exposed for debugging and for tests.

---

## 14. Performance

Budget: 16.6 ms per frame. Measured on the demo page: about 0.7 ms per frame for simulation plus canvas drawing, averaged over 480 frames including the initial scan.

| Risk | Mitigation |
|---|---|
| Wrapping every word of a 30 000-word article | Only the viewport ± 500 px is scanned; more is wrapped as the user scrolls |
| Walking a huge DOM on every scan | The walker prunes whole subtrees whose rect is outside the scan region |
| Layout thrashing | `scan()` is phased read → read → write → read. `measure()` is read-only |
| "Nearest word" over thousands of targets | Spatial grid; a query touches ~4–9 cells |
| Moving text every frame | Only `transform` on absolutely positioned copies, which never invalidates layout |
| Compositor memory | `will-change: transform` only while a word is in flight |
| Per-frame garbage | No allocation in the hot path: integer grid keys, one reused result object, numeric leg fields |
| Hidden tab | rAF stops by itself; `dt` is clamped on return |

---

## 15. Packaging

### 15.1 Chrome extension (primary)

```
manifest.json   MV3 · permissions: activeTab, scripting · no host permissions
background.js   chrome.action.onClicked → chrome.scripting.executeScript({ files: ['crawler.js'] })
```

- `activeTab` grants access only to the tab the user clicked on, only at that moment. The extension can read nothing in the background and needs no scary install-time warning.
- Extension-injected scripts are not subject to the page's Content-Security-Policy, so it works on Wikipedia, GitHub, and news sites where a bookmarklet is blocked.
- The script runs in the extension's isolated world. `window.__webCrawler` lives there too and persists between clicks, so the toggle works.
- Keyboard shortcut: `Alt+Shift+S` (`_execute_action`).

### 15.2 Bookmarklet

Loads a hosted copy of `crawler.js` with a `<script>` tag. Fast to share, but blocked on sites with a strict CSP.

### 15.3 Demo page

`demo/index.html` is a dark, Wikipedia-style references section built from the citations visible in the clip. A button injects the script the same way the bookmarklet does. Works from `file://`.

---

## 16. Tuning guide

All constants are in the `CFG` object at the top of `crawler.js`.

| You want | Change |
|---|---|
| A bigger or smaller spider | `upperLen`, `lowerLen`, `restRadius`, `bodyLength`, `bodyWidth` together |
| A calmer page (less chaos) | lower `linkGrabChance` / `wordGrabChance` |
| Links only, like the clip | `words: false` |
| Feet that reach further for text | raise `snapRadius` (keep it below `REACH − restRadius`) |
| Quicker, more nervous steps | lower `stepDist` and `stepTime` |
| Long loping strides | raise `stepDist` and `lead` |
| A lazier follower | lower `followSpeed`, lower `steer` |
| Constant colours | set `themeEvery` to `Infinity` |

---

## 17. Known limitations

- **Inner scroll containers.** State is in window-document space. In apps where the content scrolls inside a `<div>`, rects are refreshed after each scroll, but feet already planted do not travel with the content.
- **Framework re-renders.** React/Vue may replace nodes that were wrapped or hidden. Stale targets are dropped at the next `measure()`; a re-rendered element simply reappears.
- **Transformed or positioned `<html>`.** The float layer assumes the root element is the origin.
- **Rich links are flattened.** The floating copy is plain text in the link's own font; inner formatting (a bold word inside a link) is lost.
- **Hidden links are not clickable** until reset.
- **Reduced motion.** With `prefers-reduced-motion: reduce` the spider moves at half speed, does not fidget, and never uses large rotations. It still only ever starts on a click.

---

## 18. Test checklist

Checked on the demo page in Chrome, with the frame loop driven by a stepped clock (60 simulated fps):

- [x] Spider enters from the top, walks, feet land on links, grip boxes appear.
- [x] Grabbed links leave a blank gap; surrounding text does not move; no scrollbar appears.
- [x] Pointer follow: the body settles within ~16 px of the cursor.
- [x] Standing still: ~1.4 steps per second in total (fidget only), body speed 0.
- [x] Scroll 900 px away: it scurries back into view; `|foot − hip|` never exceeds `REACH`.
- [x] Second injection turns it off; `[data-wc]` count is 0 and `body.innerHTML` is unchanged.
- [x] Esc turns it off.

Still to check by hand:

- [ ] Loaded as an unpacked extension: icon click on, icon click off, `Alt+Shift+S`.
- [ ] Wikipedia *Spider* article, dark mode, references section: smooth while scrolling.
- [ ] A light-themed page: displaced text is readable (light palette in use).
- [ ] Resize the window and change zoom: canvas stays sharp and aligned.

---

## 19. Roadmap

Carried over from the brief, in rough order of effort:

1. **Sound**: a soft tick on each `plant()`.
2. **Silk**: record the sequence of gripped targets and draw thin lines between their drop points.
3. **Drag the spider** with the mouse; click to spawn more (the leg and body code is already instance-shaped; it needs wrapping in a factory).
4. **Eating**: grabbed words shrink into the body, and the body scale grows.
5. **Other creatures**: crab (lateral rest spots, sideways steering), centipede (chain of bodies, follow-the-leader).
6. **Page-aware mood**: raise speed and grab chance when the page title matches `/spider|arachn/i`.
