/*
 * Web Crawler: a spider that crawls the page it is injected into.
 *
 * One self-contained file, no dependencies, no build step. Injecting it a
 * second time (or pressing Esc) removes the spider and restores the page.
 * The design is documented in ../archi.md; section numbers below refer to it.
 */
(() => {
  'use strict';

  // Second injection = toggle off (archi §5).
  if (window.__webCrawler) {
    window.__webCrawler.destroy();
    return;
  }
  if (!document.body) return;

  // ───────────────────────────── Config (archi §16) ─────────────────────────────

  const CFG = {
    // Body
    bodyLength: 52,
    bodyWidth: 18,
    wanderSpeed: 150, // px/s
    followSpeed: 300,
    scurrySpeed: 1300, // catching up after the page scrolled away
    steer: 4, // how fast velocity follows the desired velocity
    turnRate: 7,
    mouseIdle: 2500, // ms without pointer movement before it wanders off

    // Legs
    upperLen: 62,
    lowerLen: 84,
    restRadius: 98,
    restAngles: [0.55, 1.15, 1.9, 2.6], // rad from the heading, front pair to back pair
    stepDist: 46,
    stepTime: 0.15, // s
    minStepTime: 0.06,
    lead: 0.16, // s of body travel a foot lands ahead of its rest spot
    snapRadius: 64,

    // Text layer
    words: true, // false = links only
    scanMargin: 500,
    cell: 96,
    maxLinkChars: 90,
    remeasureEvery: 2500, // ms

    // Grab FX
    linkGrabChance: 0.75,
    wordGrabChance: 0.3,
    fonts: [
      'ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace',
      '"Courier New", Courier, monospace',
      'Georgia, "Times New Roman", serif',
      '"Times New Roman", Times, serif',
      'Impact, "Arial Narrow", sans-serif',
    ],
    darkPalette: ['#4fd1ff', '#ff4f8b', '#5be37d', '#ff8a3d', '#b48cff'],
    lightPalette: ['#0b7fc2', '#d81b60', '#1a8f3c', '#d9480f', '#6f42c1'],

    // Renderer
    themeEvery: 6000, // ms
  };

  const THEMES = [
    { leg: [79, 195, 255], joint: [255, 79, 123], body: [91, 124, 250], head: [94, 240, 255] },
    { leg: [255, 122, 89], joint: [74, 222, 128], body: [91, 124, 250], head: [255, 79, 216] },
  ];

  const REACH = CFG.upperLen + CFG.lowerLen;
  const SKIP =
    'script,style,noscript,textarea,input,select,option,button,svg,canvas,video,audio,' +
    'iframe,object,embed,pre,code,[contenteditable]:not([contenteditable="false"]),[data-wc]';
  const RICH = 'img,svg,picture,video,canvas,div,p,table,ul,ol,h1,h2,h3,h4';
  const HAS_WORD = /[\p{L}\p{N}]/u;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[(Math.random() * list.length) | 0];
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const smooth = (t) => t * t * (3 - 2 * t);

  // ───────────────────────────── Shared state ─────────────────────────────

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const palette = pageIsDark() ? CFG.darkPalette : CFG.lightPalette;
  const bannerText = palette === CFG.darkPalette ? 'rgba(0,0,0,.74)' : '#fff';

  let vw = innerWidth;
  let vh = innerHeight;
  let sx = scrollX;
  let sy = scrollY;
  let dpr = 1;
  let raf = 0;
  let last = performance.now();
  const born = last;
  let scanAt = 0;
  let measureAt = Infinity;
  let fidgetAt = 0;

  const mouse = { x: 0, y: 0, t: -Infinity }; // client space
  const wander = { x: 0, y: 0, until: 0, arrived: false };
  const goal = { x: 0, y: 0, stop: 0, max: 0 };

  // Undo log (archi §13).
  const wrapped = []; // word spans we created
  const hidden = []; // [element, previous inline visibility, previous priority]

  const canvas = document.createElement('canvas');
  canvas.setAttribute('data-wc', 'canvas');
  canvas.style.cssText =
    'all:initial;position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147483647';
  const ctx = canvas.getContext('2d');

  const layer = document.createElement('div');
  layer.setAttribute('data-wc', 'layer');
  layer.style.cssText =
    'all:initial;position:absolute;left:0;top:0;overflow:hidden;pointer-events:none;z-index:2147483646';

  function pageIsDark() {
    let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2) || document.body;
    for (; el; el = el.parentElement) {
      const c = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (c && (c.length < 4 || +c[3] > 0.5)) {
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] < 128;
      }
    }
    return false;
  }

  // ───────────────────────────── Text layer (archi §7) ─────────────────────────────

  let targets = [];
  const grid = new Map();
  const knownLinks = new WeakSet();
  const hit = { target: null, x: 0, y: 0 }; // reused result of nearest()
  let queryId = 0;

  function isUnitLink(a, r) {
    if (r.width < 4 || r.height < 4 || r.height > 80) return false;
    const n = a.textContent.trim().length;
    return n > 0 && n <= CFG.maxLinkChars && !a.querySelector(RICH);
  }

  function addTarget(el, link) {
    targets.push({ el, link, x: 0, y: 0, w: 0, h: 0, leg: null, gone: false, q: 0 });
  }

  function scan() {
    const m = CFG.scanMargin;
    const texts = [];

    // Phase 1 (read): collect unit links and candidate text nodes near the viewport.
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === 3) {
            return CFG.words && HAS_WORD.test(node.nodeValue)
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          }
          if (knownLinks.has(node) || node.matches(SKIP)) return NodeFilter.FILTER_REJECT;
          const r = node.getBoundingClientRect();
          // Zero-height boxes are not pruned: they may hold only floated children.
          if (r.height > 0 && (r.bottom < -m || r.top > vh + m)) return NodeFilter.FILTER_REJECT;
          if (node.tagName === 'A' && isUnitLink(node, r)) {
            knownLinks.add(node);
            addTarget(node, true);
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP;
        },
      }
    );
    while (walker.nextNode()) texts.push(walker.currentNode);

    // Phase 2 (read): keep text that is really in the region and safe to split.
    const range = document.createRange();
    const unsafe = new Map();
    const keep = texts.filter((node) => {
      const parent = node.parentElement;
      if (!parent) return false;
      let bad = unsafe.get(parent);
      if (bad === undefined) {
        // Splitting a text run inside a flex/grid container turns each word into its own item.
        bad = /flex|grid/.test(getComputedStyle(parent).display);
        unsafe.set(parent, bad);
      }
      if (bad) return false;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      return r.height > 0 && r.bottom > -m && r.top < vh + m;
    });

    // Phase 3 (write): wrap each word in a span, leaving whitespace and punctuation as text.
    for (const node of keep) {
      const frag = document.createDocumentFragment();
      for (const part of node.nodeValue.split(/(\s+)/)) {
        if (!part) continue;
        if (!HAS_WORD.test(part)) {
          frag.appendChild(document.createTextNode(part));
          continue;
        }
        const span = document.createElement('span');
        span.setAttribute('data-wc', 'w');
        span.textContent = part;
        frag.appendChild(span);
        wrapped.push(span);
        addTarget(span, false);
      }
      node.replaceWith(frag);
    }

    // Phase 4 (read).
    measure();
  }

  function measure() {
    targets = targets.filter((t) => !t.gone && t.el.isConnected);
    for (const t of targets) {
      const r = t.el.getClientRects()[0];
      if (!r || r.width < 2 || r.height < 2) {
        t.w = 0;
        continue;
      }
      t.x = r.left + sx;
      t.y = r.top + sy;
      t.w = r.width;
      t.h = r.height;
    }

    // The layer clips the floating copies to the document so they cannot add scrollbars.
    // scrollWidth/Height are rounded up; 1px short keeps the layer itself from overflowing
    // at fractional zoom levels.
    const wide = document.body.scrollWidth;
    layer.style.width = wide > vw + 1 ? wide - 1 + 'px' : '100%';
    layer.style.height = Math.max(document.body.scrollHeight, vh) - 1 + 'px';

    grid.clear();
    const c = CFG.cell;
    for (const t of targets) {
      if (!t.w) continue;
      const x0 = Math.max(0, Math.floor(t.x / c));
      const x1 = Math.max(0, Math.floor((t.x + t.w) / c));
      const y0 = Math.max(0, Math.floor(t.y / c));
      const y1 = Math.max(0, Math.floor((t.y + t.h) / c));
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const key = gy * 4096 + gx;
          const cellList = grid.get(key);
          if (cellList) cellList.push(t);
          else grid.set(key, [t]);
        }
      }
    }
  }

  // Closest free target to (x, y) within `radius`, and no further than `reach` from (hx, hy).
  // Returns the shared `hit` object, or null.
  function nearest(x, y, radius, hx, hy, reach, skip) {
    const c = CFG.cell;
    const x0 = Math.max(0, Math.floor((x - radius) / c));
    const x1 = Math.max(0, Math.floor((x + radius) / c));
    const y0 = Math.max(0, Math.floor((y - radius) / c));
    const y1 = Math.max(0, Math.floor((y + radius) / c));
    let best = Infinity;
    hit.target = null;
    queryId++;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const cellList = grid.get(gy * 4096 + gx);
        if (!cellList) continue;
        for (const t of cellList) {
          if (t.q === queryId) continue;
          t.q = queryId;
          if (t.gone || t.leg || t === skip) continue;
          const px = t.w > 6 ? clamp(x, t.x + 3, t.x + t.w - 3) : t.x + t.w / 2;
          const py = t.y + t.h / 2;
          let d = Math.hypot(px - x, py - y);
          if (d > radius || Math.hypot(px - hx, py - hy) > reach) continue;
          if (!t.link) d = d * 1.6 + 6; // links win over plain words
          if (d < best) {
            best = d;
            hit.target = t;
            hit.x = px;
            hit.y = py;
          }
        }
      }
    }
    return hit.target ? hit : null;
  }

  // ───────────────────────────── Body (archi §8) ─────────────────────────────

  const body = {
    x: sx + vw / 2,
    y: sy - 70,
    vx: 0,
    vy: 0,
    angle: Math.PI / 2,
    speed: 0,
    cos: 0,
    sin: 1,
  };

  function pickWander(now) {
    const x = sx + rand(0.12, 0.88) * vw;
    const y = sy + rand(0.15, 0.85) * vh;
    const near = nearest(x, y, 220, x, y, Infinity, null);
    wander.x = near ? near.x : x;
    wander.y = near ? near.y : y;
    wander.arrived = false;
    wander.until = now + 7000;
  }

  function currentGoal(now) {
    if (now - mouse.t < CFG.mouseIdle) {
      goal.x = mouse.x + sx;
      goal.y = mouse.y + sy;
      goal.stop = 40;
      goal.max = CFG.followSpeed;
    } else {
      const out = wander.x < sx || wander.x > sx + vw || wander.y < sy || wander.y > sy + vh;
      if (!wander.arrived && Math.hypot(wander.x - body.x, wander.y - body.y) < 45) {
        wander.arrived = true;
        wander.until = now + rand(300, 1400);
      }
      if (out || now > wander.until) pickWander(now);
      goal.x = wander.x;
      goal.y = wander.y;
      goal.stop = 0;
      goal.max = CFG.wanderSpeed;
    }
    const lost =
      body.x < sx - 250 || body.x > sx + vw + 250 || body.y < sy - 250 || body.y > sy + vh + 250;
    if (lost) goal.max = CFG.scurrySpeed;
    if (calm) goal.max *= 0.5;
    return goal;
  }

  function updateBody(dt, now) {
    const g = currentGoal(now);
    const dx = g.x - body.x;
    const dy = g.y - body.y;
    const dist = Math.hypot(dx, dy) || 1;
    const want = Math.min(Math.max(0, dist - g.stop) * 2.5, g.max);
    const k = 1 - Math.exp(-CFG.steer * dt);
    body.vx += ((dx / dist) * want - body.vx) * k;
    body.vy += ((dy / dist) * want - body.vy) * k;
    body.x += body.vx * dt;
    body.y += body.vy * dt;
    body.speed = Math.hypot(body.vx, body.vy);
    if (body.speed > 6) {
      const da = Math.atan2(body.vy, body.vx) - body.angle;
      body.angle += Math.atan2(Math.sin(da), Math.cos(da)) * (1 - Math.exp(-CFG.turnRate * dt));
    }
    body.cos = Math.cos(body.angle);
    body.sin = Math.sin(body.angle);
  }

  // ───────────────────────────── Legs (archi §9) ─────────────────────────────

  const legs = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const a = CFG.restAngles[i] * side;
      const r = CFG.restRadius * (i === 0 || i === 3 ? 1.1 : 0.95);
      const leg = {
        side,
        group: (i + (side > 0 ? 1 : 0)) % 2, // alternating tetrapod: L1 R2 L3 R4 | R1 L2 R3 L4
        bend: i < 2 ? -side : side, // front knees point forward, back knees backward
        hipX: CFG.bodyLength * (0.3 - i * 0.18),
        hipY: side * CFG.bodyWidth * 0.5,
        restX: Math.cos(a) * r,
        restY: Math.sin(a) * r,
        jitter: rand(0.85, 1.15),
        hx: 0,
        hy: 0,
        kx: 0,
        ky: 0,
        x: 0,
        y: 0,
        stepping: false,
        t: 0,
        stepTime: CFG.stepTime,
        fromX: 0,
        fromY: 0,
        toX: 0,
        toY: 0,
        lift: 0,
        plantErr: 0,
        target: null,
        next: null,
        carry: null,
      };
      leg.x = body.x + leg.restX * body.cos - leg.restY * body.sin;
      leg.y = body.y + leg.restX * body.sin + leg.restY * body.cos;
      legs.push(leg);
    }
  }

  const otherGroupPlanted = (group) => legs.every((l) => l.group === group || !l.stepping);

  function startStep(leg, restX, restY) {
    leg.stepTime = clamp(CFG.stepDist / (body.speed * 1.6 + 1), CFG.minStepTime, CFG.stepTime);

    // Aim where the rest spot will be on landing, plus a lead, but within reach of the hip.
    const ahead = CFG.lead + leg.stepTime;
    let tx = restX + body.vx * ahead;
    let ty = restY + body.vy * ahead;
    const hipX = leg.hx + body.vx * leg.stepTime;
    const hipY = leg.hy + body.vy * leg.stepTime;
    const max = REACH * 0.9;
    const d = Math.hypot(tx - hipX, ty - hipY);
    if (d > max) {
      tx = hipX + ((tx - hipX) / d) * max;
      ty = hipY + ((ty - hipY) / d) * max;
    }

    const held = leg.target;
    leg.target = null;
    if (held) held.leg = null;

    const near = nearest(tx, ty, CFG.snapRadius, hipX, hipY, max, held);
    if (near) {
      tx = near.x;
      ty = near.y;
      leg.next = near.target;
      near.target.leg = leg;
    } else {
      leg.next = null;
    }

    leg.fromX = leg.x;
    leg.fromY = leg.y;
    leg.toX = tx;
    leg.toY = ty;
    leg.t = 0;
    leg.stepping = true;

    if (held && !held.gone && held.w && held.el.isConnected) {
      if (Math.random() < (held.link ? CFG.linkGrabChance : CFG.wordGrabChance)) grab(held, leg);
    }
  }

  function plant(leg, restX, restY) {
    leg.stepping = false;
    leg.lift = 0;
    leg.target = leg.next;
    leg.next = null;
    leg.plantErr = Math.hypot(leg.x - restX, leg.y - restY);
    if (leg.carry) {
      leg.carry.el.style.willChange = 'auto';
      leg.carry = null;
    }
  }

  // Two-bone IK by the law of cosines.
  function solveKnee(leg) {
    const a = CFG.upperLen;
    const b = CFG.lowerLen;
    let dx = leg.x - leg.hx;
    let dy = leg.y - leg.hy;
    const raw = Math.hypot(dx, dy);
    if (raw > REACH) {
      // A scurrying body can outrun a foot mid-step; keep the foot attached to the leg.
      dx *= REACH / raw;
      dy *= REACH / raw;
      leg.x = leg.hx + dx;
      leg.y = leg.hy + dy;
    }
    const d = clamp(raw, Math.abs(a - b) + 0.001, a + b - 0.001);
    const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const angle = Math.atan2(dy, dx) + leg.bend * Math.acos(cosA);
    leg.kx = leg.hx + a * Math.cos(angle);
    leg.ky = leg.hy + a * Math.sin(angle);
  }

  function updateLegs(dt, now) {
    const { cos, sin } = body;
    for (const leg of legs) {
      leg.hx = body.x + leg.hipX * cos - leg.hipY * sin;
      leg.hy = body.y + leg.hipX * sin + leg.hipY * cos;
      const restX = body.x + leg.restX * cos - leg.restY * sin;
      const restY = body.y + leg.restX * sin + leg.restY * cos;

      if (leg.stepping) {
        leg.t = Math.min(1, leg.t + dt / leg.stepTime);
        const e = smooth(leg.t);
        leg.x = leg.fromX + (leg.toX - leg.fromX) * e;
        leg.y = leg.fromY + (leg.toY - leg.fromY) * e;
        leg.lift = Math.sin(Math.PI * leg.t);
        if (leg.carry) drag(leg.carry, e);
        if (leg.t === 1) plant(leg, restX, restY);
      } else {
        const err = Math.hypot(leg.x - restX, leg.y - restY);
        const stretched = Math.hypot(leg.x - leg.hx, leg.y - leg.hy) > REACH * 0.96;
        // plantErr: a foot that snapped to a word away from its rest spot is not "behind" yet.
        const behind =
          err > Math.max(CFG.stepDist * leg.jitter, leg.plantErr + CFG.stepDist * 0.6);
        if (stretched || (behind && otherGroupPlanted(leg.group))) startStep(leg, restX, restY);
      }

      solveKnee(leg);
    }

    // Idle fidget: a standing spider keeps pawing at the text.
    if (!calm && body.speed < 12 && now > fidgetAt) {
      fidgetAt = now + rand(350, 1100);
      const leg = pick(legs);
      if (!leg.stepping && otherGroupPlanted(leg.group)) {
        startStep(
          leg,
          body.x + leg.restX * cos - leg.restY * sin + rand(-30, 30),
          body.y + leg.restX * sin + leg.restY * cos + rand(-30, 30)
        );
      }
    }
  }

  // ───────────────────────────── Grab FX (archi §10) ─────────────────────────────

  function grab(t, leg) {
    const el = t.el;
    const text = (el.innerText || el.textContent).replace(/\s+/g, ' ').trim();
    if (!text) return;

    const cs = getComputedStyle(el);
    const copy = document.createElement('span');
    copy.textContent = text;
    const s = copy.style;
    s.cssText =
      'all:initial;position:absolute;left:0;top:0;white-space:nowrap;pointer-events:none;' +
      'transform-origin:50% 50%;will-change:transform';
    s.fontFamily = cs.fontFamily;
    s.fontSize = cs.fontSize;
    s.fontWeight = cs.fontWeight;
    s.fontStyle = cs.fontStyle;
    s.color = cs.color;
    s.lineHeight = t.h + 'px';

    const carry = {
      el: copy,
      x: t.x,
      y: t.y,
      dx: (leg.toX - leg.fromX) * rand(0.3, 0.9),
      dy: (leg.toY - leg.fromY) * rand(0.3, 0.9),
      rot: 0,
      scale: 1,
    };
    restyle(carry, text.length);
    drag(carry, 0);
    layer.appendChild(copy);

    // Hiding (not removing) the original keeps its box, so the page does not reflow.
    hidden.push([
      el,
      el.style.getPropertyValue('visibility'),
      el.style.getPropertyPriority('visibility'),
      el.hasAttribute('style'),
    ]);
    el.style.setProperty('visibility', 'hidden', 'important');

    t.gone = true;
    leg.carry = carry;
  }

  function restyle(carry, length) {
    const s = carry.el.style;
    const color = pick(palette);
    s.fontFamily = pick(CFG.fonts);
    if (Math.random() < 0.3) s.fontStyle = 'italic';
    if (Math.random() < 0.2) s.letterSpacing = '.08em';

    const look = Math.random();
    if (look < 0.35) {
      s.background = color;
      s.color = bannerText;
      s.padding = '0 .3em';
    } else {
      s.color = color;
      if (look < 0.6) {
        s.outline = `1.5px solid ${pick(palette)}`;
        s.outlineOffset = '2px';
      } else if (look < 0.75) {
        s.background = color + '33';
      }
    }

    const size = Math.random();
    if (size < 0.3) carry.scale = length <= 24 ? rand(1.4, 2.3) : rand(1, 1.2);
    else if (size < 0.5) carry.scale = rand(0.4, 0.65);
    else carry.scale = rand(0.9, 1.15);

    carry.rot = !calm && Math.random() < 0.3 ? rand(-80, 80) : rand(-9, 9);
  }

  function drag(carry, e) {
    carry.el.style.transform =
      `translate(${carry.x + carry.dx * e}px,${carry.y + carry.dy * e}px) ` +
      `rotate(${carry.rot * e}deg) scale(${1 + (carry.scale - 1) * e})`;
  }

  // ───────────────────────────── Renderer (archi §11) ─────────────────────────────

  const tint = { leg: '', joint: '', body: '', head: '' };

  function updateTint(now) {
    const phase = Math.max(0, now - born) / CFG.themeEvery;
    const i = Math.floor(phase);
    const a = THEMES[i % THEMES.length];
    const b = THEMES[(i + 1) % THEMES.length];
    const m = smooth(clamp((phase - i - 0.9) / 0.1, 0, 1)); // blend over the last 10% of each period
    for (const key in tint) {
      const ca = a[key];
      const cb = b[key];
      tint[key] =
        `rgb(${Math.round(ca[0] + (cb[0] - ca[0]) * m)},` +
        `${Math.round(ca[1] + (cb[1] - ca[1]) * m)},` +
        `${Math.round(ca[2] + (cb[2] - ca[2]) * m)})`;
    }
  }

  function resize() {
    // The canvas fills the viewport without its scrollbars, which innerWidth/Height include.
    vw = canvas.clientWidth || innerWidth;
    vh = canvas.clientHeight || innerHeight;
    dpr = devicePixelRatio || 1;
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
  }

  function dot(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw(now) {
    updateTint(now);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.translate(-sx, -sy); // everything below is in document space

    // Grips: the element under each planted foot.
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = tint.head;
    for (const leg of legs) {
      const t = leg.target;
      if (t && !leg.stepping && !t.gone && t.w) ctx.strokeRect(t.x - 2, t.y - 1, t.w + 4, t.h + 2);
    }

    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = tint.leg;
    ctx.beginPath();
    for (const leg of legs) {
      ctx.moveTo(leg.hx, leg.hy);
      ctx.lineTo(leg.kx, leg.ky);
      ctx.lineTo(leg.x, leg.y);
    }
    ctx.stroke();

    ctx.fillStyle = tint.joint;
    for (const leg of legs) {
      dot(leg.kx, leg.ky, 3.2);
      dot(leg.x, leg.y, 3.2 + leg.lift * 2.2);
    }

    const l = CFG.bodyLength;
    const w = CFG.bodyWidth;
    ctx.save();
    ctx.translate(body.x, body.y);
    ctx.rotate(body.angle);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-l / 2, -w / 2, l, w, 5);
    else ctx.rect(-l / 2, -w / 2, l, w);
    ctx.fillStyle = 'rgba(18,22,58,.78)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = tint.body;
    ctx.stroke();
    ctx.fillStyle = tint.head;
    dot(l / 2 - 9, 0, 3.6);
    ctx.restore();
  }

  // ───────────────────────────── Loop and lifecycle (archi §5, §12, §13) ─────────────────────────────

  function frame(now) {
    raf = requestAnimationFrame(frame);
    // Clamped both ways: a frame timestamp can precede script start, and a background tab
    // must not teleport the spider when it resumes.
    const dt = clamp((now - last) / 1000, 0, 0.05);
    last = now;
    sx = scrollX;
    sy = scrollY;

    if (now >= scanAt) {
      scanAt = Infinity;
      measureAt = now + CFG.remeasureEvery;
      scan();
    } else if (now >= measureAt) {
      measureAt = now + CFG.remeasureEvery;
      measure();
    }

    updateBody(dt, now);
    updateLegs(dt, now);
    draw(now);
  }

  const onPointer = (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.t = performance.now();
  };
  const onScroll = () => {
    scanAt = Math.min(scanAt, performance.now() + 120);
  };
  const onResize = () => {
    resize();
    onScroll();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') destroy();
  };

  function destroy() {
    cancelAnimationFrame(raf);
    removeEventListener('pointermove', onPointer);
    removeEventListener('scroll', onScroll, true);
    removeEventListener('resize', onResize);
    removeEventListener('keydown', onKey, true);
    canvas.remove();
    layer.remove();

    for (const [el, value, priority, hadStyle] of hidden) {
      if (value) el.style.setProperty('visibility', value, priority);
      else el.style.removeProperty('visibility');
      if (!hadStyle) el.removeAttribute('style'); // do not leave an empty style="" behind
    }

    const parents = new Set();
    for (const span of wrapped) {
      if (!span.parentNode) continue;
      parents.add(span.parentNode);
      span.replaceWith(span.textContent);
    }
    for (const parent of parents) parent.normalize();

    delete window.__webCrawler;
  }

  document.documentElement.append(layer, canvas);
  resize();
  addEventListener('pointermove', onPointer, { passive: true });
  addEventListener('scroll', onScroll, { capture: true, passive: true });
  addEventListener('resize', onResize);
  addEventListener('keydown', onKey, true);
  window.__webCrawler = { destroy, config: CFG, body, legs };
  raf = requestAnimationFrame(frame);
})();
