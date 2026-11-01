// Breakable glasses of milk, and the puddle they leave at the bottom of the screen.
//
// Everything is drawn on one fixed, full-screen canvas in viewport coordinates.
// The puddle's surface is a row of springs (a classic 1D wave simulation), so
// falling drops, shards, the straw, the pointer and scrolling all make it ripple.
//
// "Bottoms up" drops a straw into the puddle, which slowly drinks it all up.

interface Spring {
  h: number;
  v: number;
}

interface Drop {
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  r: number;
  /** Share of all the page's milk this drop carries. Spray carries none. */
  volume: number;
}

interface Shard {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  points: number[];
  alpha: number;
  sunk: boolean;
}

interface Straw {
  /** The bottom tip. It comes to rest on the floor, just below the screen. */
  x: number;
  y: number;
  vy: number;
  /** Lean from upright, in radians. Positive leans right. */
  angle: number;
  spin: number;
  lean: number;
  length: number;
  width: number;
  state: 'falling' | 'sinking' | 'drinking' | 'leaving';
  /** Share of the page's milk drunk per second. */
  rate: number;
  clock: number;
}

const MILK = '#fbfdff';
const MILK_DEEP = '#d8e1f3';
const MILK_EDGE = '#c3d0ed';
const STRAW_RED = '#e8384f';
const STRAW_LINE = 'rgb(16 40 122 / 0.3)';
const STRAW_HOLE = 'rgb(16 40 122 / 0.45)';

// With every glass on the page broken, milk fills this share of the screen.
const MAX_FILL = 0.4;
const GRAVITY = 2000; // px/s²
const COLUMN_GAP = 6; // px between springs along the surface
const TENSION = 0.025;
const DAMPENING = 0.022;
const SPREAD = 0.24;
const MAX_WAVE = 36;
const MAX_DROPS = 1600;
const STEP = 1 / 60; // the wave simulation runs at a fixed rate
const SINK_SPEED = 140; // px/s, how fast the straw settles through the milk
const FLOOR_OFFSET = 8; // the straw rests this far below the bottom of the screen

const root = document.documentElement;
const main = document.querySelector<HTMLElement>('main');
const canvas = document.querySelector<HTMLCanvasElement>('[data-pool-canvas]')!;
const ctx = canvas.getContext('2d')!;
const control = document.querySelector<HTMLElement>('[data-pool-control]')!;
const count = document.querySelector<HTMLElement>('[data-pool-count]')!;
const announcer = document.querySelector<HTMLElement>('[data-pool-status]')!;
const drinkButton = document.querySelector<HTMLButtonElement>('[data-pool-drink]')!;
const glasses = [...document.querySelectorAll<HTMLButtonElement>('[data-glass]')];
const totalVolume = glasses.reduce((sum, glass) => sum + Number(glass.dataset.volume), 0);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let width = 0;
let height = 0;
let springs: Spring[] = [];
let leftDeltas = new Float32Array(0);
let rightDeltas = new Float32Array(0);
let drops: Drop[] = [];
let shards: Shard[] = [];
let straw: Straw | null = null;

let landed = 0; // share of the page's milk on the floor, 0–1
let level = 0; // `landed`, eased, so the puddle rises and falls smoothly
let depth = 0; // puddle height in px
let waveScale = 0; // shallow puddles get gentler waves
let brokenCount = 0;
let paddedHeight = 0;
let clean = true;
let accumulator = 0;
let lastTime = performance.now();
let controlWidth = 0;
let controlHeight = 0;
let controlRight = 16;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const columnAt = (x: number) => clamp(Math.round(x / COLUMN_GAP), 0, springs.length - 1);
const surfaceAt = (x: number) => height - depth - springs[columnAt(x)].h * waveScale;
const milkInFlight = () => drops.reduce((sum, drop) => sum + drop.volume, 0);

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const nextWidth = canvas.clientWidth;
  height = canvas.clientHeight;
  // Mobile browsers resize the height as the toolbar slides; only a width
  // change needs a new surface.
  if (nextWidth !== width) {
    width = nextWidth;
    const columns = Math.ceil(width / COLUMN_GAP) + 1;
    springs = Array.from({ length: columns }, () => ({ h: 0, v: 0 }));
    leftDeltas = new Float32Array(columns);
    rightDeltas = new Float32Array(columns);
  }
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clean = true;
  measureControl();
}

function splash(x: number, force: number) {
  const i = columnAt(x);
  springs[i].v -= force;
  if (i > 0) springs[i - 1].v -= force * 0.5;
  if (i < springs.length - 1) springs[i + 1].v -= force * 0.5;
}

function spillMilk(box: DOMRect, share: number) {
  const scale = Math.sqrt(box.width / 120);
  const total = Math.round(clamp(box.width * 1.1, 50, 220));
  const centerX = box.left + box.width / 2;
  const fresh: Drop[] = [];
  let area = 0;

  for (let i = 0; i < total; i++) {
    // Start somewhere inside the milk, which narrows towards the base of the glass.
    const down = 0.28 + Math.random() * 0.6;
    const halfWidth = (0.355 - down * 0.087) * box.width;
    const x = centerX + (Math.random() * 2 - 1) * halfWidth;
    const y = box.top + down * box.height;
    const r = (2.5 + Math.random() * 5.5) * scale;
    const outward = (x - centerX) / (box.width / 2);
    area += r * r;
    fresh.push({
      x,
      y,
      px: x,
      py: y,
      vx: outward * (40 + Math.random() * 160) + (Math.random() - 0.5) * 50,
      vy: -Math.random() * 160,
      r,
      volume: r * r,
    });
  }

  // Bigger drops carry more of the glass.
  for (const drop of fresh) drop.volume = (drop.volume / area) * share;
  drops.push(...fresh);
}

function shatter(box: DOMRect) {
  const scale = box.width / 120;
  const total = Math.round(10 + scale * 6);
  const centerX = box.left + box.width / 2;

  for (let i = 0; i < total; i++) {
    const x = box.left + box.width * (0.12 + Math.random() * 0.76);
    const y = box.top + box.height * (0.05 + Math.random() * 0.75);
    const size = (5 + Math.random() * 12) * scale;
    const corners = Math.random() < 0.5 ? 3 : 4;
    const points: number[] = [];
    for (let k = 0; k < corners; k++) {
      const angle = (k / corners) * Math.PI * 2 + Math.random() * 0.9;
      const reach = size * (0.5 + Math.random() * 0.6);
      points.push(Math.cos(angle) * reach, Math.sin(angle) * reach);
    }
    shards.push({
      x,
      y,
      vx: ((x - centerX) / (box.width / 2)) * (120 + Math.random() * 260),
      vy: -(120 + Math.random() * 380),
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 14,
      points,
      alpha: 1,
      sunk: false,
    });
  }
}

function breakGlass(glass: HTMLButtonElement) {
  if (glass.classList.contains('is-broken')) return;

  // Measure before hiding the glass, while it still has a size.
  const box = glass.querySelector('.glass__whole')!.getBoundingClientRect();
  const share = Number(glass.dataset.volume) / totalVolume;

  glass.classList.remove('is-filling');
  glass.classList.add('is-broken');
  glass.setAttribute('aria-disabled', 'true');
  glass.setAttribute('aria-label', 'Broken glass');
  brokenCount++;
  if (!straw) showCount();
  announcer.textContent = `Glass broken. ${brokenCount} of ${glasses.length} glasses broken.`;
  navigator.vibrate?.(20);

  if (reducedMotion.matches) {
    landed = Math.min(1, landed + share);
    return;
  }
  shatter(box);
  spillMilk(box, share);
}

function refillGlasses() {
  brokenCount = 0;
  for (const glass of glasses) {
    if (!glass.classList.contains('is-broken')) continue;
    glass.classList.remove('is-broken', 'is-filling');
    glass.removeAttribute('aria-disabled');
    glass.setAttribute('aria-label', glass.dataset.label ?? 'Break the glass of milk');
    void glass.offsetWidth; // restart the fill animation
    glass.classList.add('is-filling');
  }
}

function startDrinking() {
  if (straw) return;

  if (document.activeElement === drinkButton) main?.focus({ preventScroll: true });
  drinkButton.hidden = true;
  control.classList.add('is-busy');
  count.textContent = 'Glug, glug, glug…';
  announcer.textContent = 'Bottoms up. A straw is drinking the spilled milk.';
  measureControl();

  const length = clamp(height * 0.42, 200, 360);
  // Land it left of the (now narrower) float, so the two never overlap.
  const crossX = Math.max(24, clamp(width * 0.45, 40, width - controlRight - controlWidth - 48));
  const side = crossX < width * 0.3 || Math.random() < 0.5 ? 1 : -1;
  const lean = side * (0.2 + Math.random() * 0.1);
  straw = {
    x: clamp(crossX - Math.tan(lean) * (depth + FLOOR_OFFSET), 16, width - 16),
    y: -24,
    vy: 0,
    angle: lean * 0.3,
    spin: 0,
    lean,
    length,
    width: clamp(width * 0.011, 10, 14),
    state: 'falling',
    rate: 0,
    clock: 0,
  };
  if (reducedMotion.matches) {
    straw.angle = lean;
    beginDrinking(straw);
  }
}

function beginDrinking(s: Straw) {
  s.y = height + FLOOR_OFFSET;
  s.vy = 0;
  s.state = 'drinking';
  s.clock = 0;
  // Slow on purpose: about six seconds for one glass, twelve for a flood.
  const total = landed + milkInFlight();
  s.rate = Math.max(total, 0.01) / clamp(6 + 6 * total, 6, 12);
}

function drink(s: Straw, dt: number) {
  s.clock += dt;
  // Sip in gulps rather than at a steady rate. The gulps average out to `rate`.
  const sip = 0.5 + 0.5 * Math.sin(s.clock * Math.PI * 2 * 1.3);
  const gulp = reducedMotion.matches ? 1 : (0.35 + 0.65 * sip) / 0.675;
  landed = Math.max(0, landed - s.rate * gulp * dt);

  // Each sip pulls a little dimple into the surface around the straw.
  if (!reducedMotion.matches && depth > 2) {
    const crossX = s.x + Math.tan(s.angle) * (s.y - (height - depth));
    springs[columnAt(crossX)].v -= 18 * sip * dt;
  }

  if (landed === 0 && milkInFlight() === 0) finishDrinking(s);
}

function finishDrinking(s: Straw) {
  refillGlasses();
  count.textContent = 'All gone';
  announcer.textContent = 'All gone. Every glass is full again.';
  measureControl();
  if (reducedMotion.matches) {
    removeStraw();
    return;
  }
  // Toss the empty straw away.
  s.state = 'leaving';
  s.vy = -480;
  s.spin = Math.sign(s.lean) * (2 + Math.random() * 2);
}

function removeStraw() {
  straw = null;
  drinkButton.hidden = false;
  control.classList.remove('is-busy');
  if (brokenCount > 0) showCount();
  measureControl();
}

function plunge(x: number, speed: number) {
  splash(x, Math.min(9, speed * STEP * 0.35));
  if (reducedMotion.matches) return;
  const surface = height - depth;
  for (let k = 0; k < 16 && drops.length < MAX_DROPS; k++) {
    const r = 2 + Math.random() * 4;
    const sprayX = x + (Math.random() - 0.5) * 20;
    drops.push({
      x: sprayX,
      y: surface - r - 1,
      px: sprayX,
      py: surface - r - 1,
      vx: (Math.random() - 0.5) * 360,
      vy: -(250 + Math.random() * 450),
      r,
      volume: 0,
    });
  }
}

function showCount() {
  const total = glasses.length;
  count.textContent =
    brokenCount === total ? `All ${total} glasses broken` : `${brokenCount} of ${total} glasses broken`;
  measureControl();
}

function measureControl() {
  if (control.hidden) return;
  controlWidth = control.offsetWidth;
  controlHeight = control.offsetHeight;
  controlRight = parseFloat(getComputedStyle(control).right) || 16;
}

function stepWaves() {
  const n = springs.length;
  for (const spring of springs) {
    spring.v += -TENSION * spring.h - DAMPENING * spring.v;
    spring.h += spring.v;
  }
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        leftDeltas[i] = SPREAD * (springs[i].h - springs[i - 1].h);
        springs[i - 1].v += leftDeltas[i];
      }
      if (i < n - 1) {
        rightDeltas[i] = SPREAD * (springs[i].h - springs[i + 1].h);
        springs[i + 1].v += rightDeltas[i];
      }
    }
    for (let i = 0; i < n; i++) {
      if (i > 0) springs[i - 1].h += leftDeltas[i];
      if (i < n - 1) springs[i + 1].h += rightDeltas[i];
    }
  }
  for (const spring of springs) spring.h = clamp(spring.h, -MAX_WAVE, MAX_WAVE);
}

function updateDrops(dt: number) {
  for (let i = drops.length - 1; i >= 0; i--) {
    const drop = drops[i];
    drop.px = drop.x;
    drop.py = drop.y;
    drop.vy += GRAVITY * dt;
    drop.vx -= drop.vx * 0.8 * dt;
    drop.x += drop.vx * dt;
    drop.y += drop.vy * dt;

    // Bounce off the sides of the screen so no milk is lost.
    if (drop.x < drop.r || drop.x > width - drop.r) {
      drop.x = clamp(drop.x, drop.r, width - drop.r);
      drop.vx *= -0.3;
    }

    const surface = surfaceAt(drop.x);
    if (drop.y < surface) continue;

    splash(drop.x, Math.min(3, drop.vy * STEP * drop.r * 0.012));
    if (drop.volume > 0) {
      landed = Math.min(1, landed + drop.volume);
      if (drop.r > 3.5 && drops.length < MAX_DROPS && Math.random() < 0.3) spray(drop, surface);
    }
    drops[i] = drops[drops.length - 1];
    drops.pop();
  }
}

function spray(from: Drop, surface: number) {
  for (let k = 0; k < 2; k++) {
    const r = from.r * (0.25 + Math.random() * 0.2);
    const y = surface - r - 1;
    drops.push({
      x: from.x,
      y,
      px: from.x,
      py: y,
      vx: (Math.random() - 0.5) * 240,
      vy: -(160 + Math.random() * 260),
      r,
      volume: 0,
    });
  }
}

function updateShards(dt: number) {
  for (let i = shards.length - 1; i >= 0; i--) {
    const shard = shards[i];
    if (shard.sunk) {
      // Sinking slowly through the milk.
      shard.vx -= shard.vx * 3 * dt;
      shard.spin -= shard.spin * 3 * dt;
      shard.vy = 60;
      shard.alpha -= dt * 1.5;
    } else {
      shard.vy += GRAVITY * dt;
    }
    shard.x += shard.vx * dt;
    shard.y += shard.vy * dt;
    shard.angle += shard.spin * dt;

    if (!shard.sunk && shard.y >= surfaceAt(shard.x)) {
      shard.sunk = true;
      splash(shard.x, 1.2);
    }
    if (shard.alpha <= 0 || shard.y > height + 60) {
      shards[i] = shards[shards.length - 1];
      shards.pop();
    }
  }
}

function updateStraw(dt: number) {
  if (!straw) return;
  const s = straw;

  if (s.state === 'leaving') {
    s.vy += GRAVITY * dt;
    s.y += s.vy * dt;
    s.angle += s.spin * dt;
    if (s.y - s.length > height + 40) removeStraw();
    return;
  }

  // A damped spring holds the lean, so it wobbles when it lands.
  s.spin += (-(s.angle - s.lean) * 40 - s.spin * 5) * dt;
  s.angle += s.spin * dt;

  if (s.state === 'falling') {
    s.vy += GRAVITY * dt;
    s.y += s.vy * dt;
    if (s.y >= surfaceAt(s.x)) {
      s.state = 'sinking';
      s.spin += Math.sign(s.lean) * 2.5;
      plunge(s.x, s.vy);
    }
  } else if (s.state === 'sinking') {
    // Milk is thick: the straw slows right down and settles slowly to the floor.
    s.vy += (SINK_SPEED - s.vy) * Math.min(1, dt * 14);
    s.y += s.vy * dt;
    if (s.y >= height + FLOOR_OFFSET) beginDrinking(s);
  } else {
    s.x = Math.min(s.x, width - 16);
    s.y = height + FLOOR_OFFSET;
    drink(s, dt);
  }
}

function traceSurface(path: Path2D, top: number) {
  const n = springs.length;
  for (let i = 1; i < n; i++) {
    const x0 = (i - 1) * COLUMN_GAP;
    const y0 = top - springs[i - 1].h * waveScale;
    const x1 = i * COLUMN_GAP;
    const y1 = top - springs[i].h * waveScale;
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.lineTo((n - 1) * COLUMN_GAP, top - springs[n - 1].h * waveScale);
}

function drawPool() {
  const top = height - depth;
  const startY = top - springs[0].h * waveScale;

  const body = new Path2D();
  body.moveTo(0, height);
  body.lineTo(0, startY);
  traceSurface(body, top);
  body.lineTo(width, height);
  body.closePath();

  // Crests catch the light; the deep end is a little shaded.
  const sheen = MAX_WAVE * waveScale;
  const gradient = ctx.createLinearGradient(0, top - sheen, 0, height);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(Math.min(0.98, (sheen + 14) / (depth + sheen)), MILK);
  gradient.addColorStop(1, MILK_DEEP);
  ctx.fillStyle = gradient;
  ctx.fill(body);

  // A soft edge so the puddle still reads over white parts of the page.
  const edge = new Path2D();
  edge.moveTo(0, startY);
  traceSurface(edge, top);
  ctx.lineWidth = 2;
  ctx.strokeStyle = MILK_EDGE;
  ctx.stroke(edge);
}

function drawDrops() {
  // Each drop is a streak from where it was last frame. There can be well over
  // a thousand, so drops of a similar size share one path.
  const bySize = new Map<number, Path2D>();
  for (const drop of drops) {
    const size = Math.max(1, Math.round(drop.r * 2));
    let path = bySize.get(size);
    if (!path) {
      path = new Path2D();
      bySize.set(size, path);
    }
    path.moveTo(drop.px, drop.py);
    path.lineTo(drop.x + 0.01, drop.y);
  }
  ctx.lineCap = 'round';
  ctx.strokeStyle = MILK;
  for (const [size, path] of bySize) {
    ctx.lineWidth = size;
    ctx.stroke(path);
  }
}

function drawShards() {
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  for (const shard of shards) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, shard.alpha);
    ctx.translate(shard.x, shard.y);
    ctx.rotate(shard.angle);
    ctx.beginPath();
    ctx.moveTo(shard.points[0], shard.points[1]);
    for (let k = 2; k < shard.points.length; k += 2) ctx.lineTo(shard.points[k], shard.points[k + 1]);
    ctx.closePath();
    ctx.fillStyle = 'rgb(255 255 255 / 0.3)';
    ctx.fill();
    ctx.strokeStyle = 'rgb(214 228 255 / 0.95)';
    ctx.stroke();
    ctx.restore();
  }
}

// A striped bendy straw: a long shaft, a ribbed neck, and a short top bent over.
function drawStraw(s: Straw) {
  const w = s.width;
  const shaft = s.length * 0.74;
  const neck = s.length * 0.08;
  const top = s.length - shaft - neck;

  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.angle);
  stripedTube(shaft, w);
  ctx.translate(0, -shaft);
  ribbedNeck(neck, w);
  ctx.translate(0, -neck);
  ctx.rotate(Math.sign(s.lean) * 0.6);
  ctx.fillStyle = MILK;
  ctx.beginPath();
  ctx.arc(0, 0, w / 2, 0, Math.PI * 2);
  ctx.fill();
  stripedTube(top, w);
  ctx.fillStyle = STRAW_HOLE;
  ctx.beginPath();
  ctx.ellipse(0, -top, w / 2 - 1, w * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function stripedTube(length: number, w: number) {
  const half = w / 2;
  const period = w * 1.5;
  const slant = w * 0.6;

  ctx.fillStyle = MILK;
  ctx.fillRect(-half, -length, w, length);

  ctx.save();
  ctx.beginPath();
  ctx.rect(-half, -length, w, length);
  ctx.clip();
  ctx.beginPath();
  for (let y = slant; y > -length - period; y -= period) {
    ctx.moveTo(-half, y);
    ctx.lineTo(half, y - slant);
    ctx.lineTo(half, y - slant - period / 2);
    ctx.lineTo(-half, y - period / 2);
    ctx.closePath();
  }
  ctx.fillStyle = STRAW_RED;
  ctx.fill();
  ctx.restore();

  ctx.lineWidth = 1;
  ctx.strokeStyle = STRAW_LINE;
  ctx.strokeRect(-half, -length, w, length);
}

function ribbedNeck(length: number, w: number) {
  const half = w / 2 + 1;
  ctx.fillStyle = MILK;
  ctx.fillRect(-half, -length, half * 2, length);
  ctx.beginPath();
  for (let k = 1; k < 5; k++) {
    const y = (-length * k) / 5;
    ctx.moveTo(-half, y);
    ctx.lineTo(half, y);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = STRAW_LINE;
  ctx.stroke();
  ctx.strokeRect(-half, -length, half * 2, length);
}

function updateControl() {
  const visible = brokenCount > 0 || level > 0.002 || straw !== null;
  if (visible && control.hidden) {
    control.hidden = false;
    measureControl();
  } else if (!visible && !control.hidden) {
    if (control.contains(document.activeElement)) main?.focus({ preventScroll: true });
    control.hidden = true;
  }
  if (control.hidden) return;

  // Bob along on the surface, tilting with the waves underneath.
  const i = columnAt(width - controlRight - controlWidth / 2);
  const reach = 4;
  const h = springs[i].h * waveScale;
  const rise =
    (springs[Math.min(springs.length - 1, i + reach)].h - springs[Math.max(0, i - reach)].h) * waveScale;
  const tilt = clamp((Math.atan2(-rise, reach * 2 * COLUMN_GAP) * 180) / Math.PI, -8, 8);
  const lift = Math.max(16, depth + h - controlHeight * 0.3);
  control.style.transform = `translate3d(0, ${-lift}px, 0) rotate(${tilt}deg)`;
}

function syncPadding() {
  const next = Math.ceil(depth / 8) * 8;
  if (next === paddedHeight) return;
  paddedHeight = next;
  root.style.setProperty('--pool-height', `${next}px`);
}

function frame(now: number) {
  const dt = Math.min((now - lastTime) / 1000, 1 / 30);
  lastTime = now;

  accumulator += dt;
  while (accumulator >= STEP) {
    stepWaves();
    accumulator -= STEP;
  }

  level += (landed - level) * Math.min(1, dt * 7);
  if (landed === 0 && level < 0.0005) level = 0;
  depth = level * MAX_FILL * height;
  waveScale = Math.min(1, depth / 48);

  updateDrops(dt);
  updateShards(dt);
  updateStraw(dt);

  if (depth > 0.25 || drops.length > 0 || shards.length > 0 || straw) {
    ctx.clearRect(0, 0, width, height);
    // The straw goes behind the milk, so whatever is under the surface is hidden.
    if (straw) drawStraw(straw);
    if (depth > 0.25) drawPool();
    drawDrops();
    drawShards();
    clean = false;
  } else if (!clean) {
    ctx.clearRect(0, 0, width, height);
    clean = true;
  }

  updateControl();
  syncPadding();
  requestAnimationFrame(frame);
}

for (const glass of glasses) {
  glass.addEventListener('click', () => breakGlass(glass));
  glass.addEventListener('animationend', () => glass.classList.remove('is-filling'));
}
drinkButton.addEventListener('click', startDrinking);

// Run a finger or cursor through the milk to make ripples.
let pointerX = 0;
let pointerY = 0;
window.addEventListener(
  'pointermove',
  (event) => {
    const moved = Math.hypot(event.clientX - pointerX, event.clientY - pointerY);
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (depth < 4 || reducedMotion.matches) return;
    if (event.clientY < surfaceAt(event.clientX) - 4) return;
    splash(event.clientX, Math.min(2.5, moved * 0.05));
  },
  { passive: true },
);

// Scrolling tips the puddle a little, like nudging a tray.
let lastScroll = window.scrollY;
window.addEventListener(
  'scroll',
  () => {
    const delta = window.scrollY - lastScroll;
    lastScroll = window.scrollY;
    if (depth < 4 || reducedMotion.matches) return;
    const tip = clamp(delta * 0.015, -1, 1);
    const last = springs.length - 1;
    springs.forEach((spring, i) => {
      spring.v += tip * (i / last - 0.5) * 2;
    });
  },
  { passive: true },
);

// The canvas changes size with the window, and on phones with the toolbar too.
new ResizeObserver(resize).observe(canvas);
window.addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);
