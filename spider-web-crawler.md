# 🕷️ The "Web Crawler": a spider that crawls a webpage

> A breakdown of the viral X clip (Wikipedia's *Spider* article being crawled by an animated spider), and a full plan to build your own.
>
> **Note:** This is reconstructed from 4 frames of a 17-second video. The original creator's exact code isn't public here, so the "how it works" section describes the most likely approach, one that reproduces everything visible in the clip.

---

## 1. What it is

A **literal web crawler**: a pun on the search-engine term. A procedurally animated **spider** walks across a real webpage (the Wikipedia article on *Spiders*, in its references section) and **messes with the text it steps on**.

It's an **art / creative-coding piece**, not a data crawler. Nothing is scraped; the page itself becomes the spider's playground.

### What you can see in the frames

| Visual | What it means |
|---|---|
| Blue rectangle in the middle | The spider's **body** |
| 8 lines with red/green dots | **Legs** (2 segments each). The dots are the **joints** (hip, knee, foot) |
| Feet landing on ISBNs, DOIs, titles | Feet **plant on real words/links** on the page |
| Text pulled out, rotated, recoloured | Words the spider touched get **grabbed and dragged** |
| Same text in new fonts (monospace, serif, italic) | Each grabbed word gets a **random style swap** |
| Highlight boxes (cyan, pink, green, orange) | Random **background/outline** applied to grabbed words |
| Words left scattered behind it | A **trail of chaos** as it moves down the page |
| "From 🕷️ ..." label | Probably the creator's handle or a playful "signature" |

Why the context is perfect: the page is about spiders, the references are about **arachnophobia** and **spider silk**, and a spider is crawling over them. The joke lands without any explanation.

---

## 2. How it works (technical breakdown)

The system has 4 parts:

```
┌──────────────────────────────────────────────────────────┐
│ 1. TEXT LAYER   page words wrapped in <span>s → targets  │
│ 2. BODY         position + heading, wanders or follows   │
│ 3. LEGS         8 × 2-segment inverse kinematics + gait  │
│ 4. GRAB FX      lifted feet drag words, restyle them     │
└──────────────────────────────────────────────────────────┘
          drawn on a transparent <canvas> over the page
```

### 2.1 Text layer: turn the page into targets

The spider needs to know **where every word is**. Walk the DOM's text nodes and wrap each word in its own `<span>`, then read positions with `getBoundingClientRect()`.

```js
function wrapWords(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (node.parentElement.closest('script,style,noscript,textarea,.crawler-word'))
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    for (const part of node.nodeValue.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        frag.appendChild(document.createTextNode(part));
        continue;
      }
      const span = document.createElement('span');
      span.className = 'crawler-word';
      span.textContent = part;
      frag.appendChild(span);
    }
    node.replaceWith(frag);
  }
}
```

**Tips**
- In the clip, whole **links, ISBNs and DOIs** move as one unit. Treat `<a>` elements as single targets instead of splitting them into words.
- Only wrap the **visible region** (plus a margin) to keep big pages fast; wrap more as the user scrolls.
- Store positions in **document coordinates** (`rect.left + scrollX`, `rect.top + scrollY`) so they stay valid when scrolling.
- Use a **spatial grid** (e.g. 100px cells → list of words) so "nearest word to this foot" is fast.

### 2.2 The body

A point with position, velocity and heading. Two behaviours:
- **Wander:** steer toward a slowly drifting random target (smooth noise).
- **Follow:** steer toward the mouse cursor.

```js
const body = { x: 300, y: 300, vx: 0, vy: 0, angle: 0 };

function updateBody(target, dt) {
  const dx = target.x - body.x, dy = target.y - body.y;
  const dist = Math.hypot(dx, dy) || 1;
  const speed = Math.min(dist, 120);          // px per second
  body.vx += ((dx / dist) * speed - body.vx) * 4 * dt;  // smooth steering
  body.vy += ((dy / dist) * speed - body.vy) * 4 * dt;
  body.x += body.vx * dt;
  body.y += body.vy * dt;
  if (Math.hypot(body.vx, body.vy) > 5) body.angle = Math.atan2(body.vy, body.vx);
}
```

### 2.3 Legs: inverse kinematics (the core trick)

Each leg has:
- a **hip**: fixed point on the body (rotates with it)
- a **foot**: planted at a world position (it does **not** move with the body)
- a **knee**: computed so the two segments connect hip → foot

**2-segment IK (law of cosines):**

```js
// a = upper leg length, b = lower leg length
// bendDir = +1 or -1 so knees bend outward on each side
function solveKnee(hip, foot, a, b, bendDir) {
  const dx = foot.x - hip.x, dy = foot.y - hip.y;
  const d = Math.max(Math.abs(a - b) + 0.001, Math.min(Math.hypot(dx, dy), a + b - 0.001));
  const base = Math.atan2(dy, dx);
  const cosA = (a * a + d * d - b * b) / (2 * a * d);
  const angle = base + bendDir * Math.acos(Math.max(-1, Math.min(1, cosA)));
  return { x: hip.x + a * Math.cos(angle), y: hip.y + a * Math.sin(angle) };
}
```

**Stepping (what makes it look alive):**
1. Each leg has an **ideal foot spot**: a point out to the side of the body, slightly forward.
2. When the planted foot gets too far from its ideal spot (body moved on), the leg **steps**.
3. The new foot target is the ideal spot **plus a bit of velocity lead**, then **snapped to the nearest word**. This is what makes feet land on ISBNs and titles.
4. The step animates over ~100–150 ms, easing from the old spot to the new one.

**Gait:** real spiders walk with an **alternating tetrapod gait**. Split the 8 legs into 2 groups:
- Group A: Left 1, Right 2, Left 3, Right 4
- Group B: Right 1, Left 2, Right 3, Left 4

A group may only step while **every leg in the other group is planted**. Without this rule the legs move randomly and it looks like a broken toy.

```js
function updateLeg(leg, dt) {
  const hip = toWorld(leg.hipOffset);       // rotate offset by body.angle, add body position
  const ideal = toWorld(leg.restOffset);

  if (leg.stepping) {
    leg.t = Math.min(1, leg.t + dt / STEP_TIME);
    const e = leg.t * leg.t * (3 - 2 * leg.t);   // smoothstep easing
    leg.foot.x = leg.from.x + (leg.to.x - leg.from.x) * e;
    leg.foot.y = leg.from.y + (leg.to.y - leg.from.y) * e;
    if (leg.t === 1) { leg.stepping = false; onFootPlant(leg); }
  } else if (dist(leg.foot, ideal) > STEP_DIST && otherGroupPlanted(leg.group)) {
    const lead = { x: ideal.x + body.vx * 0.15, y: ideal.y + body.vy * 0.15 };
    leg.from = { ...leg.foot };
    leg.to = nearestWordCenter(lead, SNAP_RADIUS) ?? lead;
    leg.t = 0;
    leg.stepping = true;
    onFootLift(leg);
  }

  leg.knee = solveKnee(hip, leg.foot, UPPER_LEN, LOWER_LEN, leg.side);
}
```

### 2.4 Grabbing words (the chaos)

- **On plant:** remember which word span the foot landed on (`leg.word = span`).
- **On lift:** that word is "picked up". While the foot moves, move the word with it.
- **On release:** drop it where it is, and leave it there permanently. This builds the trail.

```js
const FONTS = ['monospace', 'Georgia, serif', 'Courier New', 'Times New Roman', 'Impact'];
const COLORS = ['#4fd1ff', '#ff4f8b', '#5be37d', '#ff8a3d', '#b48cff'];

function restyle(span) {
  span.style.display = 'inline-block';           // transforms need inline-block
  span.style.fontFamily = pick(FONTS);
  span.style.color = pick(COLORS);
  if (Math.random() < 0.4) span.style.background = pick(COLORS) + '55';
  if (Math.random() < 0.3) span.style.outline = `1.5px solid ${pick(COLORS)}`;
  if (Math.random() < 0.2) span.style.fontSize = (1 + Math.random()) + 'em';
}

function dragWord(span, dx, dy, rot) {
  span.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
}
```

Use **only `transform`** to move words. Changing `left`/`top`/`margin` forces the browser to recalculate the whole layout every frame, which is very slow on Wikipedia-sized pages.

### 2.5 Drawing

- One `<canvas>`: `position: fixed; inset: 0; pointer-events: none; z-index: 999999`
- Scale for `devicePixelRatio` so lines stay sharp.
- Each frame: clear, then draw legs (lines hip → knee → foot), joints (small dots), then the body (rotated rectangle or ellipse).
- Convert document coordinates → screen coordinates by subtracting `scrollX` / `scrollY`.
- Run everything in one `requestAnimationFrame` loop.

---

## 3. Build plan (step by step)

| Step | Goal | Done when |
|---|---|---|
| **1. Canvas + body** | A dot that follows the mouse on any page | Smooth movement, no jitter |
| **2. One leg with IK** | A 2-segment leg whose foot follows the mouse | Knee bends correctly, never "snaps" |
| **3. 8 legs + stepping** | Feet plant and step as the body moves | Looks like walking, no sliding feet |
| **4. Gait** | Alternating tetrapod groups | Legs move in a rhythmic pattern |
| **5. Text layer** | Words wrapped, positions cached, spatial grid | Finding the nearest word takes <1 ms |
| **6. Snap to words** | Feet land on real words/links | Feet visibly "grip" text |
| **7. Grab + restyle** | Lifted feet drag words; words get new fonts and colors | The chaos trail appears |
| **8. Polish** | Body wobble, leg thickness, shadows, speed tuning | Feels alive, not robotic |
| **9. Package** | Bookmarklet + Chrome extension | Works on any site with one click |
| **10. Launch** | 15s video on Wikipedia's Spider page | Posted |

**Time estimate:** steps 1–7 take about a weekend with AI help; polish is as long as you want.

---

## 4. Packaging

### Option A: Bookmarklet (fastest to share)
Host `crawler.js` (e.g. on your portfolio), and the bookmark is:
```js
javascript:(()=>{const s=document.createElement('script');s.src='https://sriman.online/crawler.js';document.body.appendChild(s);})()
```
⚠️ Some sites (including Wikipedia) may block external scripts via **Content Security Policy**. If so, use the extension.

### Option B: Chrome extension (Manifest V3, most reliable)
```
crawler-extension/
├── manifest.json
├── background.js    // on icon click → inject crawler.js into the tab
└── crawler.js       // the whole spider
```

```json
{
  "manifest_version": 3,
  "name": "Web Crawler 🕷️",
  "version": "1.0",
  "permissions": ["activeTab", "scripting"],
  "action": { "default_title": "Release the spider" },
  "background": { "service_worker": "background.js" }
}
```

```js
// background.js
chrome.action.onClicked.addListener((tab) => {
  chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['crawler.js'] });
});
```

Extension-injected scripts aren't blocked by the page's CSP, so it works on Wikipedia, GitHub, news sites, etc.

---

## 5. Hard parts (and how to handle them)

| Problem | Fix |
|---|---|
| **Legs look robotic** | Smoothstep easing, a slight "lift" (scale the foot dot up mid-step), alternating gait, small random timing offsets |
| **Feet slide** | Feet must stay locked in world space while planted; only move during a step |
| **Laggy on huge pages** | Wrap only visible text, spatial grid lookups, only `transform` changes, batch DOM writes |
| **Knees flip sides** | Fixed `bendDir` per side of the body |
| **Breaks page layout** | Never change element size/position directly; use transforms on `inline-block` spans |
| **Scrolling** | Store everything in document coordinates, convert to screen coordinates only when drawing |
| **Undo** | Keep a list of modified spans + original styles; a "Reset" key (Esc) restores them |
| **Accessibility** | Respect `prefers-reduced-motion`; never start automatically, only when the user clicks |

---

## 6. Stretch ideas

- **More creatures:** crab (walks sideways), centipede (many legs, follow-the-leader body), snake.
- **Eating:** the spider "eats" words and grows bigger.
- **Webs:** it spins silk lines between words it has visited, connecting them like a graph.
- **Sound:** tiny tap sounds per footstep (your portfolio already has audio).
- **Interaction:** drag the spider with your mouse, or spawn more with a click.
- **Page-aware:** on a spider-related page it gets excited; on others it's calm.
- **Portfolio Easter egg:** a small spider that occasionally crawls across sriman.online.

---

## 7. Launch plan

1. **Record a 15–20s clip** on Wikipedia's *Spider* article (the joke only works there). Dark mode, cursor visible, no UI clutter.
2. **Post on X** with a short caption ("made a web crawler 🕷️") plus the video. Don't explain the pun.
3. **Reply with the link** (extension / GitHub) in the first comment.
4. **Publish** on the Chrome Web Store and open-source it on GitHub.
5. **Add it to your portfolio** with the clip and a short "how it works" (IK + gait), which is the part that impresses engineers.

---

## 8. Why this is a good project for you

- **Fast to vibe-code:** AI can write most of the canvas and DOM code.
- **One real hard part to learn:** inverse kinematics and gait. It's actual math you can explain in interviews.
- **Very shareable:** a 15-second clip people understand instantly.
- **Matches your style:** your portfolio already uses animated canvas and grid visuals.
- **Small scope:** a weekend to v1, unlike the inference server, so it won't derail your Karpathy plan.
