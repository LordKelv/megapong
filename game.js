(() => {
  'use strict';

  // ---------------------------------------------------------------- tuning
  // Board space is normalised: x and y both run 0..1.
  const PADDLE_X = 0.05, PADDLE_W = 0.035;
  const BASE_HALF = 0.17;          // half paddle height
  const BASE_PSPEED = 2.4;         // board heights per second
  const BALL_R = 0.028;
  const BALL_SPEED = 0.5;          // board widths per second at multiplier 1
  const START_ANGLE = 20 * Math.PI / 180;
  const MAX_ANGLE = 62 * Math.PI / 180;
  const COUNTDOWN = 2;
  const SUBSTEP = 1 / 240;
  const BASE_BOARDS = 100;
  const SLOWMO_SECONDS = 3, SLOWMO_SCALE = 0.35;
  const WIN_LEVEL = 12;

  const UPGRADES = [
    { id: 'wide',     name: 'Broad Stroke',       rar: 'common',   price: 5,  max: 6, desc: 'Paddles are 14% taller.' },
    { id: 'quick',    name: 'Quick Wrist',        rar: 'common',   price: 4,  max: 5, desc: 'Paddles move 20% faster.' },
    { id: 'slow',     name: 'Still Life',         rar: 'common',   price: 5,  max: 6, desc: 'Balls travel 8% slower.' },
    { id: 'net',      name: 'Underpainting',      rar: 'common',   price: 5,  max: 6, desc: 'The first 8 misses of each level bounce back.' },
    { id: 'calm',     name: 'Slow Drying',        rar: 'common',   price: 4,  max: 3, desc: 'Balls speed up 25% more slowly during a level.' },
    { id: 'spare',    name: 'Spare Canvases',     rar: 'uncommon', price: 7,  max: 5, desc: 'Start every level with 12 extra boards.' },
    { id: 'slowmo',   name: 'Long Exposure',      rar: 'uncommon', price: 7,  max: 4, desc: 'Space slows every ball for 3s. One charge per level.' },
    { id: 'luck',     name: 'Happy Accident',     rar: 'uncommon', price: 7,  max: 5, desc: 'Each miss has a 7% chance to bounce back anyway.' },
    { id: 'patron',   name: 'Patron',             rar: 'uncommon', price: 6,  max: 4, desc: 'Earn $3 more after every level.' },
    { id: 'dealer',   name: 'Art Dealer',         rar: 'uncommon', price: 7,  max: 3, desc: 'Earn $1 per 10 boards still alive at the end.' },
    { id: 'deadline', name: 'Short Sitting',      rar: 'uncommon', price: 8,  max: 4, desc: 'Survival timers are 8% shorter.' },
    { id: 'forgive',  name: 'Loose Brief',        rar: 'uncommon', price: 8,  max: 4, desc: 'Missions demand 12% less.' },
    { id: 'ghost',    name: 'Second Perspective', rar: 'rare',     price: 11, max: 3, desc: 'A ghost paddle mirrors yours on every board.' },
    { id: 'magnet',   name: 'Vanishing Point',    rar: 'rare',     price: 10, max: 3, desc: 'Incoming balls bend toward your paddle.' },
  ];
  const RARITY_WEIGHT = { common: 60, uncommon: 30, rare: 10 };

  const BOSSES = [
    { id: 'mirror',   name: 'The Mirror',    desc: 'Your controls are reversed.' },
    { id: 'shrink',   name: 'The Miniature', desc: 'Paddles are much shorter.' },
    { id: 'rush',     name: 'The Futurist',  desc: 'Balls are 22% faster.' },
    { id: 'blackout', name: 'The Eclipse',   desc: 'Half the boards go dark in turns.' },
    { id: 'wind',     name: 'The Draught',   desc: 'A shifting wind bends every ball.' },
  ];

  // ---------------------------------------------------------------- helpers
  const $ = (id) => document.getElementById(id);
  const canvas = $('game'), ctx = canvas.getContext('2d');
  const stage = $('stage'), overlay = $('overlay');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  function rng(seed) {
    let a = seed | 0;
    return () => {
      a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function store(key, val) {
    try {
      if (val === undefined) { const v = parseFloat(localStorage.getItem('megapong.' + key)); return isFinite(v) ? v : null; }
      localStorage.setItem('megapong.' + key, String(val));
    } catch { /* storage unavailable */ }
    return null;
  }

  // ---------------------------------------------------------------- state
  let state = 'menu';   // menu | brief | countdown | play | final | shop | over
  let run = null;       // { level, money, up: {id: n} }
  let M = null;         // current mission
  let L = null;         // current level simulation
  let shop = null;      // { offers, rerollCost, payout }
  let paddleY = 0.5, targetY = null, countdown = 0, clock = 0;
  const keys = { up: false, down: false };
  const own = (id) => (run && run.up[id]) || 0;

  // ---------------------------------------------------------------- sound
  let audio = null, muted = false, lastBlip = 0;
  function ensureAudio() {
    if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; } }
    if (audio && audio.state === 'suspended') audio.resume();
  }
  function blip(freq, dur, vol, type) {
    if (muted || !audio) return;
    const now = audio.currentTime;
    if (now - lastBlip < 0.03) return;
    lastBlip = now;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type || 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    o.connect(g).connect(audio.destination);
    o.start(now); o.stop(now + dur);
  }
  function setMuted(m) { muted = m; $('mute').textContent = m ? 'sound off' : 'sound on'; }

  // ---------------------------------------------------------------- missions
  function makeMission(lv) {
    const boss = lv % 3 === 0 ? pick(BOSSES) : null;
    const kind = boss || lv === 1 ? 'hold' : pick(['hold', 'rally', 'protect']);
    const tm = Math.pow(0.92, own('deadline')), fm = Math.pow(0.88, own('forgive'));
    const m = { lv, kind, boss };
    if (kind === 'hold') {
      m.T = Math.min(14 + 2 * lv, 40) * tm;
      m.K = Math.max(1, Math.round(Math.min(4 + 2 * lv, 60) * fm));
      m.title = `Keep ${m.K} boards alive for ${m.T.toFixed(0)} seconds`;
    } else if (kind === 'rally') {
      m.T = 30 + lv;
      m.R = Math.round((110 + 40 * lv) * fm);
      m.K = 1;
      m.title = `Make ${m.R} returns within ${m.T} seconds`;
    } else {
      m.T = Math.min(14 + 2 * lv, 36) * tm;
      m.G = 10;
      m.K = Math.max(1, Math.round(Math.min(2 + lv / 3, 7) * fm));
      m.title = `Keep ${m.K} of the ${m.G} gilded boards alive for ${m.T.toFixed(0)} seconds`;
    }
    return m;
  }

  function startLevel(m) {
    M = m;
    const classic = m.kind === 'classic';
    const count = classic ? BASE_BOARDS : BASE_BOARDS + 12 * own('spare');
    const cols = Math.ceil(Math.sqrt(count * 1.25));
    const boss = m.boss ? m.boss.id : null;
    L = {
      count, cols, rows: Math.ceil(count / cols), seed: (Math.random() * 1e9) | 0,
      bx: new Float32Array(count), by: new Float32Array(count),
      vx: new Float32Array(count), vy: new Float32Array(count),
      alive: new Uint8Array(count).fill(1), gold: new Uint8Array(count),
      deathAt: new Float32Array(count).fill(-10), saveAt: new Float32Array(count).fill(-10),
      aliveCount: count, goldAlive: 0, returns: 0, t: 0, bonus: 0, finalBase: 1,
      half: Math.min(0.42, BASE_HALF * (1 + 0.14 * own('wide')) * (boss === 'shrink' ? 0.62 : 1)),
      pspeed: BASE_PSPEED * (1 + 0.2 * own('quick')),
      ghostHalf: own('ghost') ? 0.05 + 0.04 * own('ghost') : 0,
      magnet: own('magnet'), luck: Math.min(0.45, 0.07 * own('luck')),
      nets: 8 * own('net'), charges: own('slowmo'), slowT: 0,
      // Past the exhibition the pace climbs much harder, so endless runs do end.
      speedBase: classic ? 1 : (1 + 0.07 * (m.lv - 1) + 0.12 * Math.max(0, m.lv - WIN_LEVEL)) * Math.pow(0.92, own('slow')) * (boss === 'rush' ? 1.22 : 1),
      rampSec: classic ? 45 : 50 / Math.pow(0.75, own('calm')),
      mirror: boss === 'mirror', blackout: boss === 'blackout', wind: boss === 'wind',
    };
    for (let i = 0; i < count; i++) {
      const a = (Math.random() * 2 - 1) * START_ANGLE, dir = Math.random() < 0.5 ? -1 : 1;
      L.vx[i] = dir * Math.cos(a) * BALL_SPEED;
      L.vy[i] = Math.sin(a) * BALL_SPEED;
      L.bx[i] = 0.4 + Math.random() * 0.55;
      L.by[i] = 0.5 + (Math.random() - 0.5) * 0.24;
    }
    if (m.kind === 'protect') {
      while (L.goldAlive < m.G) {
        const i = Math.floor(Math.random() * count);
        if (!L.gold[i]) { L.gold[i] = 1; L.goldAlive++; }
      }
    }
    paddleY = 0.5; targetY = null; countdown = COUNTDOWN;
    state = 'countdown';
    overlay.classList.add('hidden');
    ensureAudio();
    paintBoards();
  }

  function speedMul() {
    if (state === 'final') return L.finalBase * (1 + L.bonus / 10);
    return L.speedBase * (1 + L.t / L.rampSec);
  }

  // ---------------------------------------------------------------- simulation
  function movePaddle(dt) {
    let dir = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    if (L.mirror) dir = -dir;
    const maxStep = L.pspeed * dt;
    if (dir !== 0) { targetY = null; paddleY += dir * maxStep; }
    else if (targetY !== null) paddleY += clamp(targetY - paddleY, -maxStep, maxStep);
    paddleY = clamp(paddleY, L.half, 1 - L.half);
  }

  function kill(i) {
    L.alive[i] = 0; L.deathAt[i] = clock; L.aliveCount--;
    if (L.gold[i]) L.goldAlive--;
    paintBoard(i);
    blip(160 + 700 * (L.aliveCount / L.count), 0.07, 0.035);
  }

  function stepBalls(dt) {
    const mul = speedMul();
    const face = PADDLE_X + PADDLE_W;
    const reach = L.half + BALL_R, gReach = L.ghostHalf + BALL_R, ghostY = 1 - paddleY;
    const wind = L.wind ? 0.32 * Math.sign(Math.sin(L.t * Math.PI / 3)) : 0;
    const bend = L.magnet || L.wind;
    const { bx, by, vx, vy, alive } = L;
    for (let i = 0; i < L.count; i++) {
      if (!alive[i]) continue;
      if (bend) {
        if (wind) vy[i] += wind * dt;
        if (L.magnet && vx[i] < 0) vy[i] += (paddleY - by[i]) * 0.9 * L.magnet * dt * mul;
        const minVx = 0.3 * BALL_SPEED;
        if (Math.abs(vx[i]) < minVx) vx[i] = vx[i] < 0 ? -minVx : minVx;
        const s = BALL_SPEED / Math.hypot(vx[i], vy[i]);
        vx[i] *= s; vy[i] *= s;
      }
      let x = bx[i] + vx[i] * mul * dt;
      let y = by[i] + vy[i] * mul * dt;
      if (y < BALL_R) { y = BALL_R; vy[i] = Math.abs(vy[i]); }
      else if (y > 1 - BALL_R) { y = 1 - BALL_R; vy[i] = -Math.abs(vy[i]); }
      if (x > 1 - BALL_R) { x = 1 - BALL_R; vx[i] = -Math.abs(vx[i]); }
      if (vx[i] < 0 && x - BALL_R <= face) {
        if (x - BALL_R >= PADDLE_X - PADDLE_W) {
          let rel = null;
          if (Math.abs(y - paddleY) <= reach) rel = (y - paddleY) / reach;
          else if (L.ghostHalf && Math.abs(y - ghostY) <= gReach) rel = (y - ghostY) / gReach;
          if (rel !== null) {
            // Blend true reflection with where on the paddle it landed, so balls
            // neither converge onto one path nor ignore the player's aim.
            const incoming = Math.atan2(vy[i], -vx[i]);
            const out = clamp(0.5 * incoming + 0.5 * rel * MAX_ANGLE + (Math.random() - 0.5) * 0.06, -MAX_ANGLE, MAX_ANGLE);
            vx[i] = Math.cos(out) * BALL_SPEED;
            vy[i] = Math.sin(out) * BALL_SPEED;
            x = face + BALL_R;
            L.returns++;
            if (state === 'final') blip(520, 0.05, 0.03);
          }
        }
        if (x < -BALL_R) {
          const lucky = L.luck && Math.random() < L.luck;
          if (lucky || L.nets > 0) {
            if (!lucky) L.nets--;
            x = BALL_R; vx[i] = Math.abs(vx[i]); L.saveAt[i] = clock;
            blip(880, 0.05, 0.025, 'triangle');
          } else { kill(i); continue; }
        }
      }
      bx[i] = x; by[i] = y;
    }
  }

  function checkEnd() {
    if (M.kind === 'classic') {
      if (state === 'play' && L.aliveCount <= 1) {
        L.finalBase = speedMul();
        state = L.aliveCount === 1 ? 'final' : 'over';
      } else if (state === 'final' && L.aliveCount === 0) state = 'over';
      if (state === 'over') classicOver();
      return;
    }
    let won = false, lost = null;
    if (M.kind === 'hold') {
      if (L.aliveCount < M.K) lost = `Only ${L.aliveCount} boards were left with ${(M.T - L.t).toFixed(1)}s to go.`;
      else if (L.t >= M.T) won = true;
    } else if (M.kind === 'protect') {
      if (L.goldAlive < M.K) lost = `Only ${L.goldAlive} gilded boards were left with ${(M.T - L.t).toFixed(1)}s to go.`;
      else if (L.t >= M.T) won = true;
    } else {
      if (L.returns >= M.R) won = true;
      else if (L.aliveCount === 0) lost = `Every board went dark at ${L.returns} of ${M.R} returns.`;
      else if (L.t >= M.T) lost = `Time ran out at ${L.returns} of ${M.R} returns.`;
    }
    if (won) levelWon(); else if (lost) runOver(lost);
  }

  function update(dt) {
    clock += dt;
    if (state === 'countdown') {
      movePaddle(dt);
      countdown -= dt;
      if (countdown <= 0) state = 'play';
      return;
    }
    let left = dt;
    while (left > 1e-9 && (state === 'play' || state === 'final')) {
      const h = Math.min(SUBSTEP, left);
      left -= h;
      if (state === 'play') L.t += h; else L.bonus += h;
      if (L.slowT > 0) L.slowT -= h;
      movePaddle(h);
      stepBalls(L.slowT > 0 ? h * SLOWMO_SCALE : h);
      checkEnd();
    }
  }

  function useSlowmo() {
    if (state !== 'play' || !L || L.charges <= 0 || L.slowT > 0) return;
    L.charges--; L.slowT = SLOWMO_SECONDS;
    blip(220, 0.4, 0.04, 'sine');
  }

  // ---------------------------------------------------------------- run flow
  function newRun() {
    run = { level: 1, money: 4, up: {} };
    showBrief();
  }

  function showBrief() {
    state = 'brief';
    M = makeMission(run.level);
    const b = M.boss;
    show(`<div class="panel narrow">
      <p class="kicker">Level ${run.level}${run.level > WIN_LEVEL ? ' · endless' : ` of ${WIN_LEVEL}`}</p>
      ${b ? `<div class="boss">Boss · ${b.name}</div><p>${b.desc}</p>` : ''}
      <p class="mission">${M.title}</p>
      <p class="dim">${M.kind === 'rally' ? 'Every paddle hit on any board counts as a return.'
        : M.kind === 'protect' ? 'Only the gilded boards matter. The rest are decoration.'
        : 'Fall below the line before the clock runs out and the run ends.'}</p>
      ${ownedChips()}
      <div class="row"><button class="btn primary" data-act="begin" data-primary>Begin</button></div>
    </div>`);
  }

  function levelWon() {
    const lines = [];
    const add = (label, v) => { if (v > 0) lines.push([label, v]); };
    add(M.boss ? 'Boss defeated' : 'Mission complete', 4 + Math.floor(run.level / 3) + (M.boss ? 4 : 0));
    const spare = M.kind === 'protect' ? (L.goldAlive - M.K) * 1 : Math.floor((L.aliveCount - M.K) / 10);
    add(M.kind === 'protect' ? 'Extra gilded boards' : 'Boards to spare', Math.min(6, spare));
    add('Interest ($1 per $5 held)', Math.min(5, Math.floor(run.money / 5)));
    add('Patron', 3 * own('patron'));
    add('Art Dealer', own('dealer') * Math.floor(L.aliveCount / 10));
    const total = lines.reduce((s, l) => s + l[1], 0);
    run.money += total;
    if (run.level > (store('bestLevel') || 0)) store('bestLevel', run.level);
    shop = { rerollCost: 2, payout: lines, total, offers: rollOffers(), cleared: run.level };
    run.level++;
    state = 'shop';
    blip(660, 0.25, 0.04, 'triangle');
    showShop();
  }

  function rollOffers() {
    const pool = UPGRADES.filter((u) => own(u.id) < u.max);
    const offers = [];
    while (offers.length < 3 && pool.length) {
      let r = Math.random() * pool.reduce((s, u) => s + RARITY_WEIGHT[u.rar], 0);
      const idx = pool.findIndex((u) => (r -= RARITY_WEIGHT[u.rar]) < 0);
      offers.push(pool.splice(idx < 0 ? pool.length - 1 : idx, 1)[0]);
    }
    return offers;
  }
  const priceOf = (u) => u.price + 2 * own(u.id);

  function showShop() {
    const cards = shop.offers.map((u, i) => {
      if (!u) return `<div class="card sold">SOLD</div>`;
      const p = priceOf(u);
      return `<button class="card r-${u.rar}" data-act="buy" data-i="${i}" ${p > run.money ? 'disabled' : ''}>
        ${facetArt(u)}<span class="rar">${u.rar}</span>
        <span class="name">${u.name}</span><span class="desc">${u.desc}</span>
        <span class="price">$${p}</span><span class="own">owned ${own(u.id)} / ${u.max}</span></button>`;
    }).join('');
    const won = shop.cleared === WIN_LEVEL;
    show(`<div class="panel">
      <p class="kicker">Level ${shop.cleared} cleared</p>
      <h2>${won ? 'Masterpiece' : 'The Atelier'}</h2>
      ${won ? '<p>You finished the exhibition. Carry on into endless mode for as long as the canvases last.</p>' : ''}
      <ul class="payout">${shop.payout.map((l) => `<li><span>${l[0]}</span><span>+$${l[1]}</span></li>`).join('')}
        <li class="total"><span>Earned</span><span>+$${shop.total}</span></li></ul>
      <div class="purse">$${run.money}</div>
      <div class="cards">${cards}</div>
      ${ownedChips()}
      <div class="row">
        <button class="btn" data-act="reroll" ${shop.rerollCost > run.money ? 'disabled' : ''}>Reroll $${shop.rerollCost}</button>
        <button class="btn primary" data-act="next" data-primary>Next mission</button>
      </div>
    </div>`);
  }

  function ownedChips() {
    const chips = UPGRADES.filter((u) => own(u.id)).map((u) =>
      `<span class="chip" title="${u.desc}">${u.name}${own(u.id) > 1 ? ' ×' + own(u.id) : ''}</span>`).join('');
    return chips ? `<div class="owned">${chips}</div>` : '';
  }

  function runOver(reason) {
    state = 'over';
    const best = store('bestLevel') || 0;
    blip(110, 0.5, 0.05, 'sawtooth');
    show(`<div class="panel narrow">
      <p class="kicker">The canvas goes dark</p>
      <h2>Fell on level ${run.level}</h2>
      <p>${reason}</p>
      <p class="dim">Best level cleared: ${best || 'none yet'}</p>
      ${ownedChips()}
      <div class="row"><button class="btn primary" data-act="run" data-primary>New run</button>
        <button class="btn" data-act="menu">Menu</button></div>
    </div>`);
  }

  function classicOver() {
    const prev = store('classicBest');
    const record = prev === null || L.t > prev;
    if (record) store('classicBest', L.t);
    show(`<div class="panel narrow">
      <p class="kicker">Classic</p>
      <h2>${L.count} → 1 in ${L.t.toFixed(2)}s</h2>
      <p>The last board held for another ${L.bonus.toFixed(2)}s.</p>
      <p class="dim">${record ? 'New best.' : `Best: ${prev.toFixed(2)}s`}</p>
      <div class="row"><button class="btn primary" data-act="classic" data-primary>Again</button>
        <button class="btn" data-act="menu">Menu</button></div>
    </div>`);
  }

  function showMenu() {
    state = 'menu'; run = null;
    const best = store('bestLevel'), cb = store('classicBest');
    show(`<div class="panel narrow">
      <h1>${'MEGAPONG'.split('').map((c) => `<span>${c}</span>`).join('')}</h1>
      <p class="kicker" style="margin-top:10px">a hundred boards · one pair of hands</p>
      <p>One input moves every paddle on every board. Survive each mission, spend what you earn
        in the atelier, and see how deep into the exhibition you can get.</p>
      <div class="row"><button class="btn primary" data-act="run" data-primary>New run</button>
        <button class="btn" data-act="classic">Classic</button></div>
      <p class="dim" style="margin-top:14px">${best ? `Best level cleared: ${best}` : 'No runs yet'}${cb ? ` · Classic best: ${cb.toFixed(2)}s` : ''}</p>
      <p class="dim"><kbd>W</kbd>/<kbd>S</kbd> or <kbd>↑</kbd>/<kbd>↓</kbd>, or move the mouse / drag.
        <kbd>Space</kbd> confirms, and fires Long Exposure in play.</p>
    </div>`);
  }

  function show(html) { overlay.innerHTML = html; overlay.classList.remove('hidden'); overlay.scrollTop = 0; }

  overlay.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    ensureAudio();
    const act = b.dataset.act;
    if (act === 'run') newRun();
    else if (act === 'menu') showMenu();
    else if (act === 'begin') startLevel(M);
    else if (act === 'classic') startLevel({ kind: 'classic', lv: 1, boss: null });
    else if (act === 'next') showBrief();
    else if (act === 'reroll' && run.money >= shop.rerollCost) {
      run.money -= shop.rerollCost; shop.rerollCost++; shop.offers = rollOffers(); showShop();
    } else if (act === 'buy') {
      const i = +b.dataset.i, u = shop.offers[i];
      if (u && run.money >= priceOf(u)) {
        run.money -= priceOf(u); run.up[u.id] = own(u.id) + 1; shop.offers[i] = null;
        blip(740, 0.12, 0.04, 'triangle'); showShop();
      }
    }
  });

  // ---------------------------------------------------------------- cubist art
  const INK = '#1d1a17';
  const BOARD_TONES = [['#5b6f82', '#48596a'], ['#7a5c3e', '#906f4a'], ['#6f7150', '#5a5c41'],
    ['#8a7a5c', '#73654b'], ['#4f6068', '#667b84'], ['#94703f', '#7b5d35'], ['#66584c', '#7b6b5c']];
  const GOLD_TONES = ['#e0b03c', '#c58f24'];
  const DEAD_TONES = ['#2a2622', '#35302a'];
  const BG_TONES = ['#2b2621', '#332c25', '#27292b', '#2f2a22', '#24211d', '#2c3033', '#3a3027'];

  let W = 0, H = 0, dpr = 1;
  const bgLayer = document.createElement('canvas'), boardLayer = document.createElement('canvas');
  const bgCtx = bgLayer.getContext('2d'), boardCtx = boardLayer.getContext('2d');
  const cube = document.createElement('canvas');

  function poly(g, pts, fill) {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
  }
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  // The ball: a little cube seen from three sides at once.
  function paintCube() {
    cube.width = cube.height = 64;
    const g = cube.getContext('2d'), c = 32, r = 29;
    const v = [];
    for (let k = 0; k < 6; k++) { const a = (-90 + 60 * k) * Math.PI / 180; v.push([c + r * Math.cos(a), c + r * Math.sin(a)]); }
    const C = [c, c + 2];
    poly(g, [v[0], v[1], C, v[5]], '#f3e8d2');
    poly(g, [v[1], v[2], v[3], C], '#8f2d1c');
    poly(g, [v[5], C, v[3], v[4]], '#d9502f');
    g.lineWidth = 4; g.lineJoin = 'round'; g.strokeStyle = INK;
    poly(g, v); g.stroke();
  }

  function paintBackground() {
    const g = bgCtx, r = rng(1907);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const nx = Math.max(4, Math.round(W / 150)), ny = Math.max(3, Math.round(H / 150));
    const P = [];
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const edgeX = i === 0 || i === nx, edgeY = j === 0 || j === ny;
      P.push([(i + (edgeX ? 0 : (r() - 0.5) * 0.7)) * W / nx, (j + (edgeY ? 0 : (r() - 0.5) * 0.7)) * H / ny]);
    }
    g.lineWidth = 1; g.strokeStyle = '#151311';
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = P[j * (nx + 1) + i], b = P[j * (nx + 1) + i + 1], c = P[(j + 1) * (nx + 1) + i + 1], d = P[(j + 1) * (nx + 1) + i];
      const tris = r() < 0.5 ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]];
      for (const t of tris) { poly(g, t, BG_TONES[Math.floor(r() * BG_TONES.length)]); g.stroke(); }
    }
  }

  function cellRect(i) {
    const pad = 8, gap = L.count > 150 ? 3 : 5;
    const cw = (W - pad * 2 - gap * (L.cols - 1)) / L.cols;
    const ch = (H - pad * 2 - gap * (L.rows - 1)) / L.rows;
    return [pad + (i % L.cols) * (cw + gap), pad + Math.floor(i / L.cols) * (ch + gap), cw, ch];
  }

  // A board is a slightly skewed plane split into two facets.
  function boardFacets(g, i, x, y, w, h) {
    const r = rng(L.seed + i * 7919), j = () => r() * 0.07;
    const q = [[x + j() * w, y + j() * h], [x + w - j() * w, y + j() * h], [x + w - j() * w, y + h - j() * h], [x + j() * w, y + h - j() * h]];
    const tones = !L.alive[i] ? DEAD_TONES : L.gold[i] ? GOLD_TONES : BOARD_TONES[Math.floor(r() * BOARD_TONES.length)];
    const top = lerp(q[0], q[1], 0.25 + r() * 0.5), bot = lerp(q[3], q[2], 0.25 + r() * 0.5);
    poly(g, q, tones[0]);
    poly(g, r() < 0.5 ? [q[0], top, bot, q[3]] : [top, q[1], q[2], bot], tones[1]);
    if (!L.alive[i]) {
      g.strokeStyle = '#18150f'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(q[0][0], q[0][1]); g.lineTo(bot[0], bot[1]); g.lineTo(q[1][0], q[1][1]); g.stroke();
    }
    g.lineWidth = Math.max(1, Math.min(w, h) * 0.035); g.lineJoin = 'round';
    g.strokeStyle = L.gold[i] && L.alive[i] ? '#f6d778' : INK;
    poly(g, q); g.stroke();
  }

  function paintBoard(i) {
    const [x, y, w, h] = cellRect(i);
    boardCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    boardCtx.clearRect(x - 2, y - 2, w + 4, h + 4);
    boardFacets(boardCtx, i, x, y, w, h);
  }
  function paintBoards() {
    boardCtx.setTransform(1, 0, 0, 1, 0, 0);
    boardCtx.clearRect(0, 0, boardLayer.width, boardLayer.height);
    if (L) for (let i = 0; i < L.count; i++) paintBoard(i);
  }

  function paddleShape(g, x, y, w, h, py, half, light, dark) {
    const x0 = x + PADDLE_X * w, pw = Math.max(2, PADDLE_W * w), y0 = y + (py - half) * h, ph = half * 2 * h;
    poly(g, [[x0, y0 + ph * 0.05], [x0 + pw, y0], [x0 + pw, y0 + ph], [x0, y0 + ph * 0.95]], light);
    poly(g, [[x0, y0 + ph * 0.05], [x0 + pw * 0.45, y0 + ph * 0.03], [x0 + pw * 0.45, y0 + ph * 0.97], [x0, y0 + ph * 0.95]], dark);
  }

  function drawLive(i, x, y, w, h) {
    if (L.ghostHalf) paddleShape(ctx, x, y, w, h, 1 - paddleY, L.ghostHalf, 'rgba(120,205,200,.8)', 'rgba(47,127,134,.8)');
    paddleShape(ctx, x, y, w, h, paddleY, L.half, '#f3e8d2', '#34424f');
    const s = Math.max(5, BALL_R * 2.7 * Math.min(w, h));
    ctx.drawImage(cube, x + L.bx[i] * w - s / 2, y + L.by[i] * h - s / 2, s, s);
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = stage.clientWidth; H = stage.clientHeight;
    for (const c of [canvas, bgLayer, boardLayer]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    paintBackground();
    paintBoards();
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bgLayer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!L) return;

    if (M.kind === 'classic' && (state === 'final' || (state === 'over' && L.bonus > 0))) {
      // One board left: blow it up so it is actually playable.
      let w = W - 16, h = H - 16 - 28;
      if (w / h > 1.7) w = h * 1.7; else h = w / 1.7;
      const x = (W - w) / 2, y = (H - h) / 2 + 14;
      let last = 0;
      for (let i = 0; i < L.count; i++) if (L.alive[i]) { last = i; break; }
      boardFacets(ctx, last, x, y, w, h);
      if (L.aliveCount > 0) drawLive(last, x, y, w, h);
      ctx.fillStyle = '#d8c3a5'; ctx.textAlign = 'center';
      ctx.font = 'bold 14px Rockwell, Georgia, serif';
      ctx.fillText(`LAST BOARD  ·  SPEED ×${speedMul().toFixed(1)}`, W / 2, y - 10);
      return;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(boardLayer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const darkPhase = L.blackout ? Math.floor(L.t / 2.2) % 2 : -1;
    for (let i = 0; i < L.count; i++) {
      const [x, y, w, h] = cellRect(i);
      if (L.alive[i]) {
        drawLive(i, x, y, w, h);
        if (darkPhase >= 0 && state === 'play' && ((i % L.cols) + Math.floor(i / L.cols)) % 2 === darkPhase) {
          poly(ctx, [[x, y + h * 0.04], [x + w, y], [x + w, y + h * 0.96], [x, y + h]], 'rgba(20,18,16,.97)');
        }
        const sAge = clock - L.saveAt[i];
        if (sAge < 0.4) poly(ctx, [[x, y], [x + w * 0.35, y], [x, y + h]], `rgba(120,205,200,${(0.85 * (1 - sAge / 0.4)).toFixed(3)})`);
      } else {
        const age = clock - L.deathAt[i];
        if (age < 0.5) {
          const a = (0.8 * (1 - age / 0.5)).toFixed(3);
          poly(ctx, [[x, y], [x + w, y], [x, y + h]], `rgba(200,69,47,${a})`);
          poly(ctx, [[x + w, y], [x + w, y + h], [x, y + h]], `rgba(224,176,60,${a})`);
        }
      }
    }
    if (L.slowT > 0) { ctx.fillStyle = 'rgba(47,127,134,.14)'; ctx.fillRect(0, 0, W, H); }

    if (state === 'countdown') {
      ctx.fillStyle = 'rgba(20,18,16,.5)'; ctx.fillRect(0, 0, W, H);
      const s = Math.min(W, H) * 0.16, cx = W / 2, cy = H / 2;
      poly(ctx, [[cx - s, cy - s * 0.8], [cx + s * 0.9, cy - s], [cx + s, cy + s * 0.85], [cx - s * 0.85, cy + s]], '#c8452f');
      poly(ctx, [[cx - s, cy - s * 0.8], [cx + s * 0.1, cy - s * 0.9], [cx - s * 0.2, cy + s * 0.93], [cx - s * 0.85, cy + s]], '#e0b03c');
      ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.round(s * 1.3)}px Rockwell, Georgia, serif`;
      ctx.fillText(String(Math.ceil(countdown)), cx, cy);
      ctx.textBaseline = 'alphabetic';
    }
  }

  // Shop thumbnail: a seeded pile of facets, different for every upgrade.
  function facetArt(u) {
    const r = rng(u.id.split('').reduce((s, c) => s * 31 + c.charCodeAt(0), 7));
    const sets = { common: ['#5b6f82', '#c9a66b', '#7a5c3e', '#d8c3a5', '#34424f'],
      uncommon: ['#2f7f86', '#7d7f5a', '#d8c3a5', '#34424f', '#e0b03c'],
      rare: ['#c8452f', '#e0b03c', '#34424f', '#8f2d1c', '#ece2cf'] };
    const pal = sets[u.rar];
    let s = `<svg viewBox="0 0 200 92" preserveAspectRatio="none" aria-hidden="true"><rect width="200" height="92" fill="${pal[4]}"/>`;
    for (let k = 0; k < 9; k++) {
      const cx = r() * 200, cy = r() * 92, n = 3 + Math.floor(r() * 2), pts = [];
      for (let p = 0; p < n; p++) {
        const a = (p / n + r() * 0.2) * Math.PI * 2, d = 26 + r() * 50;
        pts.push(`${(cx + Math.cos(a) * d).toFixed(0)},${(cy + Math.sin(a) * d * 0.7).toFixed(0)}`);
      }
      s += `<polygon points="${pts.join(' ')}" fill="${pal[Math.floor(r() * 4)]}" stroke="#1d1a17" stroke-width="1.5" opacity=".92"/>`;
    }
    return s + '</svg>';
  }

  // ---------------------------------------------------------------- HUD
  function hud() {
    const playing = L && (state === 'countdown' || state === 'play' || state === 'final');
    let level = '', mission = '', extra = '';
    if (playing && M.kind === 'classic') {
      level = 'Classic';
      mission = `boards<b>${L.aliveCount}</b> &nbsp; time<b>${L.t.toFixed(2)}${state === 'final' ? ' +' + L.bonus.toFixed(2) : ''}</b>`;
    } else if (playing) {
      level = `Level<b>${M.lv}</b>${M.boss ? ` &nbsp;${M.boss.name}` : ''}`;
      const left = Math.max(0, M.T - L.t).toFixed(1);
      if (M.kind === 'hold') {
        const cls = L.aliveCount - M.K <= 5 ? 'bad' : 'good';
        mission = `boards<b class="${cls}">${L.aliveCount}</b> / need ${M.K} &nbsp; time<b>${left}</b>`;
      } else if (M.kind === 'protect') {
        const cls = L.goldAlive - M.K <= 1 ? 'bad' : 'good';
        mission = `gilded<b class="${cls}">${L.goldAlive}</b> / need ${M.K} &nbsp; time<b>${left}</b>`;
      } else {
        mission = `returns<b>${L.returns}</b> / ${M.R} &nbsp; boards<b>${L.aliveCount}</b> &nbsp; time<b>${left}</b>`;
      }
      if (L.nets) extra += `nets<b>${L.nets}</b> `;
      if (own('slowmo')) extra += `exposure<b>${L.slowT > 0 ? L.slowT.toFixed(1) + 's' : L.charges}</b>`;
    } else if (run) {
      level = `Level<b>${run.level}</b>`;
    }
    $('hLevel').innerHTML = level;
    $('hMission').innerHTML = mission;
    $('hExtra').innerHTML = extra;
    $('hMoney').innerHTML = run ? `purse<b>$${run.money}</b>` : '';
  }

  // ---------------------------------------------------------------- loop & input
  let lastTs = 0;
  function frame(ts) {
    const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0);
    lastTs = ts;
    update(dt);
    hud();
    draw();
    requestAnimationFrame(frame);
  }

  const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down' };
  window.addEventListener('keydown', (e) => {
    const k = KEYMAP[e.code];
    if (k) { keys[k] = true; e.preventDefault(); return; }
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      if (state === 'play') useSlowmo();
      else if (!overlay.classList.contains('hidden')) {
        const b = overlay.querySelector('[data-primary]');
        if (b) b.click();
      }
    } else if (e.code === 'KeyM') setMuted(!muted);
  });
  window.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keys[k] = false; });
  window.addEventListener('blur', () => { keys.up = keys.down = false; });

  function pointer(e) {
    const r = canvas.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    targetY = L && L.mirror ? 1 - y : y;
  }
  canvas.addEventListener('pointermove', pointer);
  canvas.addEventListener('pointerdown', pointer);
  $('mute').onclick = () => setMuted(!muted);
  window.addEventListener('resize', resize);

  // Read-only hook used by the headless balance test.
  window.__megapong = {
    get state() { return state; }, get L() { return L; }, get M() { return M; }, get run() { return run; },
    get paddleY() { return paddleY; }, aim(y) { targetY = y; },
  };

  paintCube();
  resize();
  showMenu();
  requestAnimationFrame(frame);
})();
