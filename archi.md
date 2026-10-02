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

- Reproduce the clip: an 8-legged spider with long, zigzag, 3-segment legs that walks over a page, shoots a thread from its head to one link at a time, and leaves a trail of restyled links behind it.
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
| 8 thin polylines from the body, about 22 dots around it (close to 8 × 3) | Jointed legs with 3 segments each; dots are knee, ankle, foot | [Legs](#9-module-legs) |
| The polylines fold back on themselves and cross each other; segments are long compared with the body | Long bones folded into a **zigzag** (knee and ankle bend opposite ways), not a smooth arch | [Legs §9.6](#96-inverse-kinematics) |
| In every blue-theme frame exactly **one** link has a cyan box around it, and one long straight line runs to it from the head dot (0:04: the DOI in ref. 146, ~250 px away). Feet have no boxes | A **thread** from the head holds one link at a time; that is what selects links, not the feet | [Thread §10.5](#105-the-thread) |
| One second later (0:05) that same DOI has a pink highlight and the box and line are on the DOI above it | After a short hold the held link is restyled and the thread moves on | [Thread §10.5](#105-the-thread) |
| In ref. 147 the plain text *"Wright, M. Rosemary."*, *"mythandreligion.upatras.gr"* and *"Retrieved 3 January 2023"* stay put while the two **links** in the same line are gone | The original moves `<a>` elements as whole units. Plain text is mostly left alone | [Text layer §7.1](#71-two-kinds-of-target) |
| Where a link was, there is a **blank gap** of the same width; surrounding text does not reflow | The original is hidden in place and a copy is animated | [Grab FX §10.1](#101-why-a-floating-copy-and-not-a-transform-on-the-original) |
| A link title that wraps over two lines in the article appears as one long single-line banner | The moved copy is laid out on one line | [Grab FX §10.2](#102-pick-up) |
| Changed links show monospace or serif fonts, solid highlight bars, recoloured text, thin outline boxes, and sizes from tiny (~0.35×) to ~2× | Random restyle per link, each property rolled separately | [Grab FX §10.3](#103-restyle) |
| Of about twelve changed links in the 0:04 frame, ten are still exactly where they were and upright; two are moved and rotated (one ~10°, one ~65°) | Most restyles happen **in place**. Displacement and tumbling are the exception | [Grab FX §10.3](#103-restyle) |
| Scaled text starts at the left edge of the gap it left | Unrotated copies scale from their left edge | [Grab FX §10.3](#103-restyle) |
| Blue-legged frames use only cyan, pink and red on the text; the orange-legged frame uses orange and green | The text colours belong to the spider's theme | [Renderer §11.2](#112-themes) |
| Legs are orange with green joints in one frame, light blue with pink joints in the others | The clip alternates two themes | [Renderer §11.2](#112-themes) |
| The page scrolls during the clip and the spider stays in view | The spider chases the viewport | [Body §8.2](#82-goals) |

Three points differ from the brief on purpose:

1. **Links are the targets.** The brief wraps every word. The frames show only links changing, so where a page has links, plain text is not touched at all. Words are used only where links are scarce ([§7.1](#71-two-kinds-of-target)).
2. **Changed text is a floating copy**, not the original `<span>` transformed as `inline-block`. See [§10.1](#101-why-a-floating-copy-and-not-a-transform-on-the-original).
3. **The thread, not the feet, picks most links.** The brief has feet grab the words they stand on. The frames show a single boxed link on a line from the head. Feet still kick a link now and then, which is where the few displaced, tumbled pieces come from.

---

## 3. System overview

Everything lives in one IIFE in `extension/crawler.js`. Internally it is six modules that share a small amount of state and are driven by one `requestAnimationFrame` loop.

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
                                              │  step tween, 3-bone IK    │
                                              └──────┬─────────────┬──────┘
                                        kick on lift │             │ leg joints
                                                     ▼             ▼
┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────┐
│ THREAD                   │  │ GRAB FX                  │  │ RENDERER         │
│  pick a link near head   │─▶│  hide original           │  │  fixed <canvas>  │
│  shoot, hold, restyle    │  │  floating copy + restyle │  │  box, thread,    │
│  pull back, pause        │  │  ease into the new look  │  │  legs, joints,   │
└────────────┬─────────────┘  └──────────────────────────┘  │  body            │
             │ line + boxed link                            └──────────────────┘
             └─────────────────────────────────────────────────────▲
                                 writes to the DOM             draws pixels only
```

The thread also reads the Text layer's grid to find its next link.

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
| **Document** | top-left of the page | body, hips, knees, ankles, feet, target rects, floating copies, wander goal |
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

**When words are used at all** is set by `CFG.words`:

| Value | Behaviour |
|---|---|
| `'auto'` (default) | Each scan counts the links in the scan region. With `minLinks` (12) or more, no text is wrapped and plain text is never touched, as in the clip. With fewer, words are wrapped so the spider has something to work on |
| `false` | Links only, everywhere |
| `true` | Words are always wrapped, alongside links |

On a link-rich page such as a Wikipedia references list, `'auto'` means the DOM is not modified at all until a link is actually restyled.

### 7.2 The target record

```js
{
  el,      // the <a> or the word <span>
  link,    // true for links
  x, y,    // top-left of its first line box, document space
  w, h,    // size of that box (w = 0 means "not visible right now")
  holder,  // who has reserved it: a leg standing on or stepping to it, or the thread; else null
  gone,    // true once it has been restyled; never targeted again
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
                 (count the links in the region; stop here if words are not needed)
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
- A target is rejected if it is `gone`, reserved by another leg or by the thread, equal to `skip` (the word the foot just left), further than `radius` from the query, or further than `reach` from `(hx, hy)` (the hip, so a leg is never asked to reach a spot it cannot touch).
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
| `upperLen` | 78 px | hip → knee |
| `midLen` | 86 px | knee → ankle |
| `lowerLen` | 78 px | ankle → foot |
| `REACH` | 242 px | their sum; the furthest a foot can be from its hip |
| `restRadius` | 118 px | distance of the rest spots from the body centre |

The bones are long and the rest spots are close: a resting foot is at roughly **half** of full reach. Each leg therefore carries about 120 px of slack, which it has to fold away. That folding is what produces the tangled, crossing, zigzag look of the clip, where single segments are longer than the body. A short-boned leg at the same rest distance would be nearly straight and look like a stick insect.

### 9.2 Per-leg state

```js
{
  side,               // −1 left, +1 right
  group,              // 0 or 1, the tetrapod group
  bend,               // ±1, which side of the hip→foot line the knee is on (the ankle is opposite)
  hipX, hipY,         // body-local
  restX, restY,       // body-local
  jitter,             // 0.85–1.15, de-synchronises step thresholds
  hx, hy,             // hip, document space, recomputed every frame
  kx, ky, ax, ay,     // knee and ankle, document space, recomputed every frame
  x, y,               // foot, document space; constant while planted
  stepping, t,        // step tween state, t in 0..1
  stepTime,           // duration of the current step
  fromX, fromY, toX, toY,
  lift,               // 0..1..0 over a step, used to draw the foot larger mid-air
  plantErr,           // how far the foot was from its rest spot when it landed
  target,             // target the planted foot is standing on
  next,               // target reserved for the step in progress
  carry,              // floating copy this step is kicking along, if any
}
```

### 9.3 State machine

```
                    stretched
                 or (behind and other group planted)
   ┌─────────┐ ─────────────────────────────────────▶ ┌──────────┐
   │ PLANTED │        startStep(): lift, maybe kick    │ STEPPING │
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

The lead makes the foot land ahead of its rest spot, so the body walks *over* it before it falls behind. If a target was hit it is reserved (`target.holder = leg`) for the whole flight, so two feet never choose the same link, and the thread never takes a link a foot is on.

Feet do **not** draw a box around what they stand on, and most of the time they leave it alone. On lifting, a foot kicks the link it was standing on with probability `linkKickChance` (0.2; `wordKickChance` 0.3 for words). See [§10.2](#102-pick-up).

### 9.5 Step tween

```
t    += dt / stepTime
e     = t²(3 − 2t)                 smoothstep
foot  = lerp(from, to, e)
lift  = sin(π · t)
```

### 9.6 Inverse kinematics

Each leg has **three bones and three visible joints**: hip → knee → ankle → foot.

The building block is the two-bone solve (`solveJoint`), by the law of cosines. For bones `a` and `b` between a start and an end point, with `d` = their distance clamped to `(|a − b|, a + b)`:

```
base  = atan2(end − start)
A     = acos((a² + d² − b²) / (2·a·d))       angle at the start
joint = start + a · (cos, sin)(base + bend · A)
```

Three bones have one more degree of freedom than a foot position pins down, so there are infinitely many valid poses. `solveLeg` picks one by solving two two-bone problems in sequence:

```
stretch = |foot − hip| / REACH                               0 = tucked in, 1 = straight
virtual = (midLen + lowerLen) · (0.55 + 0.45 · stretch²)

knee    = solveJoint(hip,  foot, upperLen, virtual,   bend)   lower two bones treated as one
ankle   = solveJoint(knee, foot, midLen,   lowerLen, −bend)   then split that one into two
```

- The knee is placed as if the two lower bones were a single bone of length `virtual`. After that solve the knee is exactly `virtual` away from the foot, so the second solve always has a valid triangle.
- `virtual` shrinks as the leg tucks in. A short `virtual` leaves slack in the lower two bones, and the ankle bends to take it up. At full stretch `virtual` equals `midLen + lowerLen` and the whole leg is a straight line.
- Why `0.55 + 0.45 · stretch²` is safe: the first triangle needs `upperLen + virtual ≥ d`. That expression equals `d` at `stretch = 1` and exceeds it everywhere below, so the foot is always reachable.
- The two solves use **opposite** `bend` signs. The knee goes to one side of the hip → foot line and the ankle to the other, so the leg is a zigzag (an "N" or "Z"). The same sign for both would give a smooth arch; that was the first version, and it does not match the clip.

Worked example at rest (`d` ≈ 118): `stretch` ≈ 0.49, `virtual` ≈ 108. The knee sits about 63° off the hip → foot line, and the ankle about 46° off the knee → foot line on the other side. Segments of neighbouring legs cross, as in the frames.

`bend` is fixed per leg, so a joint can never flip to the other side:

- front two pairs: `bend = −side` → knees point forward
- back two pairs:  `bend = +side` → knees point backward

**Hard clamp.** If the foot is further than `REACH` from the hip, the solver pulls the foot back onto the reach circle before solving. At scurry speed the body covers ~21 px per frame and can outrun a foot that is mid-step; without the clamp the last leg segment visibly stretches. With it, `|foot − hip| ≤ REACH` holds on every frame.

Measured over 1100 simulated frames: every bone stays at its configured length (error below 0.0001 px) and `|foot − hip|` peaks at 232.6 px, inside the 242 px reach.

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

`grab(target, dx, dy)` turns a target into a floating copy. It has two callers:

| Caller | When | `dx, dy` | Result |
|---|---|---|---|
| **Thread** ([§10.5](#105-the-thread)) | its hold on a link ends | `0, 0` | restyled **in place** |
| **Foot kick** (`startStep()`) | a foot lifts off a link, with probability `linkKickChance` 0.2 (`wordKickChance` 0.3) | step vector × random 0.3–0.9 | restyled and **dragged** part of the way along the step |

The thread is the main source (about one link per second). Kicks are the minority that end up out of place.

```
text  = el.innerText, whitespace collapsed
copy  = <span> with  all: initial; position: absolute; left: 0; top: 0;
                     white-space: nowrap; transform-origin: 50% 50%; will-change: transform
        + font-family/size/weight/style and colour copied from the original's computed style
        + line-height = original box height (so the glyphs start exactly where they were)
copy.transform = translate(target.x, target.y)
original       → visibility: hidden !important       (previous inline value saved)
target.gone    = true
returns          { el, x, y, dx, dy, rot, scale, age }      the copy's animation record
```

Because the copy starts as a pixel-accurate stand-in for the original, anything the restyle does not change stays as it was.

### 10.3 Restyle

Applied once, at pick-up. Each property is rolled **independently**, and the default for each is "leave it alone". That is what makes most links end up in place, upright, and recognisably themselves, with only one or two things different.

| Property | Rule |
|---|---|
| Font | 45 % monospace (Courier New), and 40 % of those get 0.1 em letter-spacing · 30 % serif (Georgia) · 25 % unchanged |
| Weight | 15 % bold |
| Scale | 22 % tiny (0.3–0.45×) · 22 % big (1.5–2×, or 1.05–1.15× for text over 24 chars) · 56 % unchanged |
| Look | 25 % solid **highlight bar** (theme fill, dark ink of the same hue, small padding) · 35 % text **recoloured** · 10 % recoloured inside a 1 px **outline box** · 30 % the link's own colour |
| Rotation | thread: 12 % · kick: 50 %. When it happens: half slight (±6–18°), half steep (±40–80°) |
| Scale origin | unrotated copies scale from their **left edge**, so a tiny copy sits at the start of the gap it left; rotated copies turn about their centre |

A link that drew "unchanged" for both font and scale is forced into one of the coloured looks, so no restyle is invisible. Italics are never added or removed: an italic book title stays italic.

Colours come from the active spider theme ([§11.2](#112-themes)), so the text always matches the spider:

| Theme | Highlight bars | Text recolour |
|---|---|---|
| Blue / pink | cyan `#43dcff`, pink `#ff3f7f` | cyan, pink, red `#ff3b4e` |
| Orange / green | orange `#ff7a45`, green `#3fd673` | orange, green, red |

Each colour has three forms: `fill` (the bar, and text on dark pages), `ink` (dark text on top of a bar), `deep` (text on light pages, where the bright fills would be unreadable). Page darkness is detected once at init: walk up from the element at the centre of the viewport to the first non-transparent `background-color` and test its luminance.

### 10.4 Easing into the new look

A copy is never snapped to its final pose. `drag(carry, e)` interpolates all three components with one eased value `e` in 0..1:

```
transform = translate(x + dx·e, y + dy·e) rotate(rot·e deg) scale(1 + (scale − 1)·e)
```

- **Kicked** copies use the foot's own step tween for `e`, so the link visibly travels with the foot.
- **Thread** copies go into a `settling` list and ease over `settleTime` (0.22 s).

When it finishes, the copy stays put permanently and `will-change` is removed (so hundreds of copies do not each hold a compositor layer). A finished copy is not a target; each element is changed once.

### 10.5 The thread

One line from the spider's head to one link at a time. This is the single most recognisable thing in the frames: the cyan box with a straight line running to it.

```
            pickPrey()               age ≥ threadOut + hold            ext reaches 0
  ┌──────┐ ───────────▶ ┌─────────────────────────┐ ───────────▶ ┌───────────┐ ─────────▶ idle
  │ IDLE │              │ OUT, then HOLD          │   grab(t,0,0) │ PULL BACK │   pause 150–600 ms
  └──────┘              │ line grows over 0.12 s, │   restyle     │ line      │
                        │ link is boxed           │   in place    │ shrinks   │
                        └─────────────────────────┘               └───────────┘
```

State: `{ target, age, hold, done, ext, hx, hy, x, y, nextAt }`. `ext` is how much of the line is drawn, 0..1. `(hx, hy)` is the head; `(x, y)` is where the line meets the link.

**Choosing a link (`pickPrey`).** Candidates are free targets that are

- between `threadMin` (60 px) and `threadRange` (280 px) from the head, measured to the nearest point of their box, and
- vertically inside the viewport, so the change is seen.

One is chosen uniformly at random by reservoir sampling over the grid cells in range, so no candidate list is allocated. Links beat words: the first link seen discards any word chosen so far, and a word never replaces a link. Random rather than nearest, because nearest would make the thread sweep predictably outward from the body; random gives the mix of short and very long lines seen in the clip.

**Holding.** The chosen link is reserved (`holder = thread`), so no foot lands on it. The line attaches to the point of the link's box nearest the head, recomputed every frame as the spider walks, so the line slides along the box edge. Hold time is random in `threadHold` (0.3–0.7 s). The spider keeps walking during the hold, so the line can stretch past `threadRange` (measured up to ~306 px).

**Release.** `grab(target, 0, 0)`, the copy goes to `settling`, and the line pulls back in 0.12 s. If the link disappears first (page re-render), the thread just pulls back.

Rate: `threadOut + hold + threadOut + pause` ≈ 1.1 s per link, close to the clip, where the boxed link is a different one in frames one second apart.

---

## 11. Module: Renderer

One canvas, sized `innerWidth × innerHeight` CSS pixels and backed by `× devicePixelRatio` device pixels.

### 11.1 Draw order (back to front)

1. **Box**: a 2 px rectangle in the head colour around the link the thread is holding, 3 px outside its rect.
2. **Thread**: a 2 px line from the head toward the link, drawn to `ext` of its length, in the leg colour.
3. **Legs**: polyline hip → knee → ankle → foot, 2 px, round caps and joins. Thread and legs are one path and one stroke call.
4. **Joints**: 3 px dots at the knee, ankle and foot. The foot dot grows by up to 1.5 px with `lift`, which reads as the foot coming off the page.
5. **Body**: rounded rect `bodyLength × bodyWidth` (52 × 18), rotated to the heading, translucent blue fill, 2.5 px stroke.
6. **Head**: 3.6 px dot near the front end. The thread starts here.

### 11.2 Themes

| Theme | Legs / thread | Joints | Body | Head / box | Text colours |
|---|---|---|---|---|---|
| A (default) | light blue `rgb(86,182,246)` | pink `rgb(255,62,110)` | blue `rgb(78,98,242)` | cyan `rgb(70,226,255)` | cyan, pink, red |
| B | orange | green | blue | magenta | orange, green, red |

Both come straight from the frames. A theme is one object that holds the spider's colours **and** the `fx` colours used on text, so the two can never drift apart.

`themeEvery` is `Infinity` by default: the spider stays on theme A, the look of the 0:04 reference frame. Set it to `6000` to alternate A and B every six seconds as the full clip does; the colours then blend over the last 10 % of each period, so the change is a quick fade and not a pop. Text restyled during theme B gets theme B's colours.

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
  updateLegs(dt, now);                       // hips, step logic, tween, kicked copy, IK, fidget
  updateThread(dt, now);                     // head position, settling copies, pick / hold / release
  draw(now);
}
```

Order matters: the body moves first, so the hips, rest spots and head position used by the legs and the thread are current, and the renderer sees a consistent pose.

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

After `destroy()` the DOM is identical to what it was before injection: on the demo page `document.body.innerHTML` compares equal, character for character, before and after a run that restyled ~40 links (and, in the earlier words-on configuration, wrapped ~670 words).

`window.__webCrawler` is `{ destroy, config, body, legs, thread }`. `body`, `legs` and `thread` are the live simulation objects, exposed for debugging and for tests.

---

## 14. Performance

Budget: 16.6 ms per frame. Measured on the demo page: about 0.2 ms per frame for simulation plus canvas drawing, averaged over 720 frames including the initial scan. (It was 0.7 ms when every word was wrapped; with `words: 'auto'` a link-rich page needs no wrapping.)

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
| A bigger or smaller spider | `upperLen`, `midLen`, `lowerLen`, `restRadius`, `bodyLength`, `bodyWidth` together |
| Legs that look more tangled | raise the three bone lengths, or lower `restRadius` (more slack to fold) |
| Straighter, tidier legs | lower the bone lengths toward `restRadius / 2` each |
| Links changing faster or slower | `threadHold` and `threadPause` |
| Longer or shorter thread lines | `threadRange` and `threadMin` |
| More text knocked out of place | raise `linkKickChance` |
| Nothing ever out of place | `linkKickChance: 0`, `wordKickChance: 0` |
| Plain words changed too, on every page | `words: true` |
| Never touch plain text | `words: false` |
| Quicker, more nervous steps | lower `stepDist` and `stepTime` |
| Long loping strides | raise `stepDist` and `lead` |
| A lazier follower | lower `followSpeed`, lower `steer` |
| The orange/green phase of the clip as well | set `themeEvery` to `6000` |

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

Checked on the demo page in Chrome, with the frame loop driven by a stepped clock (60 simulated fps).

With the current build (thread, zigzag legs):

- [x] Spider enters from the top and walks; legs are zigzags with three dots each.
- [x] One link at a time is boxed with a line from the head; about a second later it is restyled and another is boxed.
- [x] Screenshot compared side by side with the 0:04 reference frame.
- [x] Restyled links leave a blank gap; surrounding text does not move; no scrollbar appears.
- [x] On the link-rich demo page no words are wrapped (`[data-wc="w"]` count is 0).
- [x] Bones keep their lengths; `|foot − hip|` stays inside `REACH`.
- [x] Second injection turns it off; `[data-wc]` count is 0 and `body.innerHTML` is unchanged.

Checked on the earlier build only (the code involved has not changed since, but these were not re-run):

- [x] Pointer follow: the body settles within ~16 px of the cursor.
- [x] Standing still: ~1.4 steps per second in total (fidget only), body speed 0.
- [x] Scroll 900 px away: it scurries back into view.
- [x] Esc turns it off.
- [x] Word wrapping and its undo (now only reached on pages with few links).

Still to check by hand:

- [ ] Real-time motion in a foreground tab (the test tab was in the background, so nothing was watched live).
- [ ] A page with few links, where `words: 'auto'` switches word targets on.
- [ ] Loaded as an unpacked extension: icon click on, icon click off, `Alt+Shift+S`.
- [ ] Wikipedia *Spider* article, dark mode, references section: smooth while scrolling.
- [ ] A light-themed page: displaced text is readable (light palette in use).
- [ ] Resize the window and change zoom: canvas stays sharp and aligned.

---

## 19. Roadmap

Carried over from the brief, in rough order of effort:

1. **Sound**: a soft tick on each `plant()`.
2. **Silk**: record the sequence of links the thread has held and leave thin lines between them.
3. **Drag the spider** with the mouse; click to spawn more (the leg and body code is already instance-shaped; it needs wrapping in a factory).
4. **Eating**: grabbed words shrink into the body, and the body scale grows.
5. **Other creatures**: crab (lateral rest spots, sideways steering), centipede (chain of bodies, follow-the-leader).
6. **Page-aware mood**: raise speed and grab chance when the page title matches `/spider|arachn/i`.
