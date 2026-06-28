// Port JS fidèle du moteur Swift (FootstepFCApp/MatchSim) — pour CALIBRATION.
// Instrumenté pour mesurer : possession, tirs, tirs cadrés, buts, passes (tentées/réussies), fautes.
// Les constantes ici DOIVENT rester synchrones avec SimEngine.swift.

'use strict';

// ── Constantes terrain ───────────────────────────────────────────────────────
const PW = 105, PH = 68, GOAL_Y = 34, GOAL_HW = 3.66;
const HALF = PW / 2;

// ── Réglages calibrables (= les "boutons") ───────────────────────────────────
// On les regroupe ici pour que la calibration ne touche qu'à cet objet.
const K = {
  controlTau: 1.4,
  decideEvery: 0.7,           // s de possession avant décision
  shootMaxDist: 26,
  goalValue: 20,              // attractivité du tir dans l'EV (→ volume de tirs)
  shootBase: { near: 0.165, mid: 0.095, far: 0.04 }, // <12 / <20 / sinon (conversion)
  shootTechMod: 0.11,
  shootGkMod: 0.08,
  outcomeSaved: 0.23,         // part après but
  outcomeBlocked: 0.16,
  tackleBase: 0.12,
  tackleRange: 1.4,
  foulShare: 0.56,            // part des tacles qui sont des fautes
  passMinProb: 0.22,
  passTechSlope: 0.85,        // pente technique→réussite passe (centrée sur 55)
  passLaneDiv: 6.2,           // + grand = couloir plus exigeant
  speedSlope: 10,             // pente speed→vitesse (centrée sur 55)
  // ── Coups de pied arrêtés ──
  yellowProb: 0.19,          // part des fautes → carton jaune
  redGivenYellow: 0.04,
  penConv: 0.76,             // conversion penalty
  penFromBoxFoul: 0.15,      // part des fautes dans la surface qui sont sifflées penalty
  cornerFromBlock: 0.80,     // tir contré → corner
  cornerFromSave: 0.50,      // arrêt → corner (ballon relâché)
  cornerFromMiss: 0.33,      // tir manqué → corner (dévié)
  cornerShotProb: 0.38,      // un corner débouche sur un tir/tête
};

// ── RNG déterministe (mulberry32) ────────────────────────────────────────────
function makeRng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + next() * (hi - lo),
    bool: (p = 0.5) => next() < p,
    int: (n) => (n <= 0 ? 0 : Math.floor(next() * n) % n),
    pick: (a) => a[Math.floor(next() * a.length) % a.length],
  };
}

// ── Vec helpers (sur {x,y}) ──────────────────────────────────────────────────
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clampPitch = (x, y) => ({ x: Math.min(Math.max(x, 0), PW), y: Math.min(Math.max(y, 0), PH) });
function norm(dx, dy) { const l = Math.hypot(dx, dy); return l > 1e-9 ? { x: dx / l, y: dy / l } : { x: 0, y: 0 }; }
function clampLen(dx, dy, max) { const l = Math.hypot(dx, dy); return l > max ? { x: dx * max / l, y: dy * max / l } : { x: dx, y: dy }; }
function distSeg(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const denom = Math.max(abx * abx + aby * aby, 1e-6);
  const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / denom;
  const tc = Math.max(0, Math.min(1, t));
  const px = a.x + abx * tc, py = a.y + aby * tc;
  return { d: Math.hypot(p.x - px, p.y - py), t };
}

const attackDir = (s) => (s === 'home' ? 1 : -1);
const oppGoal = (s) => ({ x: s === 'home' ? PW : 0, y: GOAL_Y });
const ownGoal = (s) => ({ x: s === 'home' ? 0 : PW, y: GOAL_Y });
const otherSide = (s) => (s === 'home' ? 'away' : 'home');
const sideSign = (s) => (s === 'home' ? 1 : -1);
function capOwnHalf(x, s) { return s === 'home' ? Math.min(x, HALF + 3) : Math.max(x, HALF - 3); }

const HOME_ANCHORS = [
  ['gk', 0, 6, 34],
  ['def', 1, 21, 11], ['def', 2, 15, 27], ['def', 3, 15, 41], ['def', 4, 21, 57],
  ['mid', 5, 43, 13], ['mid', 6, 38, 28], ['mid', 7, 40, 41], ['mid', 8, 43, 56],
  ['att', 9, 64, 28], ['att', 10, 69, 42],
];

function buildSquad(team, side) {
  // team.players: [{position:'GK'|'DEF'|'MID'|'ATT', speed,stamina,technique,strength,name}]
  const byRole = { gk: [], def: [], mid: [], att: [] };
  for (const p of team.players) byRole[p.position.toLowerCase()].push(p);
  const out = [];
  for (const [role, slot, ax, ay] of HOME_ANCHORS) {
    const anchorX = side === 'home' ? ax : PW - ax;
    const src = byRole[role].shift();
    const sp = src || { speed: 47, stamina: 47, technique: 47, strength: 47, name: role + slot };
    out.push({
      id: side + slot, name: sp.name || (role + slot), role, slot, side,
      speed: sp.speed, stamina: sp.stamina, technique: sp.technique, strength: sp.strength,
      x: anchorX, y: ay, vx: 0, vy: 0, speedMul: 1, anchorX, anchorY: ay,
    });
  }
  return out;
}
const maxSpeed = (p) => 6.51 + (p.speed - 55) / 100 * K.speedSlope;
const effSpeed = (p) => maxSpeed(p) * p.speedMul;

// ── Simulation d'un match → renvoie les stats mesurées ───────────────────────
function simulate(homeTeam, awayTeam, seed, displaySeconds = 360, opts = {}) {
  const REC = !!opts.record;          // enregistrer positions + événements (visualiseur)
  const keyframeEvery = 4;
  const frames = [];
  const events = [];
  const rng = makeRng(seed);
  const home = buildSquad(homeTeam, 'home');
  const away = buildSquad(awayTeam, 'away');
  const all = home.concat(away);
  const byId = {}; for (const p of all) byId[p.id] = p;
  const team = (s) => (s === 'home' ? home : away);
  const opp = (s) => (s === 'home' ? away : home);

  // Identité d'équipe (toute la durée du match) : offensive = ligne haute/pressing/risque,
  // défensive = bloc bas/contre. S'ajoute à la mentalité dynamique liée au score.
  const styleOff = (t) => ({ attacking: 0.45, defensive: -0.45 }[t] || 0);
  const homeStyleOff = styleOff(homeTeam.style), awayStyleOff = styleOff(awayTeam.style);

  const dt = 1 / 20;
  const totalTicks = Math.floor(displaySeconds * 20);
  const GX = 12, GY = 8, cellW = PW / GX, cellH = PH / GY;
  const control = new Float64Array(GX * GY);
  const cellCenter = (i, j) => ({ x: (i + 0.5) * cellW, y: (j + 0.5) * cellH });

  let ball = { x: PW / 2, y: GOAL_Y, vx: 0, vy: 0, ownerId: null };
  let scoreH = 0, scoreA = 0;
  let inFlight = false, flightReceiverId = null, flightIsShot = false, flightOutcome = '', flightSide = 'home';
  let possessionTime = 0, lastOwnerSide = 'home';
  const center = { x: PW / 2, y: GOAL_Y };
  let phase = 'kickoff', phaseUntil = 1.2, kickoffSide = 'home', celebX = PW / 2, celebY = GOAL_Y;
  let spTaker = null, spSide = 'home', spType = '', spX = PW / 2, spY = GOAL_Y;   // balle arrêtée
  let ctxAtt = 'home', ctxPresser = null, ctxMark = {}, ctxInterceptor = null, ctxOffside = PW / 2;
  let ctxMent = { home: 0, away: 0 };   // mentalité selon score/temps (-1 défensif … +1 offensif)
  let subsDone = false;
  const extraTicks = Math.floor(rng.range(2, 5) / 90 * displaySeconds * 20);   // temps additionnel

  // STATS instrumentées
  const st = {
    poss: { home: 0, away: 0 },
    shots: { home: 0, away: 0 }, sot: { home: 0, away: 0 },
    passAtt: { home: 0, away: 0 }, passComp: { home: 0, away: 0 },
    fouls: { home: 0, away: 0 }, offside: { home: 0, away: 0 },
    corners: { home: 0, away: 0 }, throwins: { home: 0, away: 0 },
    yellow: { home: 0, away: 0 }, red: { home: 0, away: 0 }, pens: { home: 0, away: 0 },
    lateGoals: 0, totalGoals: 0,
  };

  // Ligne de hors-jeu = x du 2e défenseur le plus profond de l'équipe qui défend.
  function offsideLineX(defSide) {
    const xs = team(defSide).map((p) => p.x);
    if (defSide === 'away') { xs.sort((a, b) => b - a); return xs[1] != null ? xs[1] : PW; }
    xs.sort((a, b) => a - b); return xs[1] != null ? xs[1] : 0;
  }

  const nearestOpp = (px, py, side) => {
    let best = null, bd = 1e9;
    for (const o of opp(side)) { const d = dist({ x: px, y: py }, o); if (d < bd) { bd = d; best = o; } }
    return best;
  };
  const pressureOn = (pl) => { const o = nearestOpp(pl.x, pl.y, pl.side); return Math.max(0, 1 - dist(pl, o) / 8); };

  function computeControl() {
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
      const c = cellCenter(i, j); let h = 0, a = 0;
      for (const p of all) {
        const tti = dist(c, p) / Math.max(effSpeed(p), 0.1);
        const inf = Math.exp(-tti / K.controlTau);
        if (p.side === 'home') h += inf; else a += inf;
      }
      control[j * GX + i] = h - a;
    }
  }
  const controlAt = (px, py) => {
    const i = Math.min(Math.max(Math.floor(px / cellW), 0), GX - 1);
    const j = Math.min(Math.max(Math.floor(py / cellH), 0), GY - 1);
    return control[j * GX + i];
  };
  function cellValue(c, side) {
    const danger = 1 / (1 + dist(c, oppGoal(side)) / 22);
    const rel = 1 / (1 + dist(c, ball) / 26);
    return danger * (0.45 + 0.55 * rel);
  }
  function passSuccess(a, b, tech, foeSide) {
    let minClear = 99;
    for (const o of team(foeSide)) {
      if (o.role === 'gk') continue;
      const r = distSeg(o, a, b);
      if (r.t > 0.05 && r.t < 0.98) minClear = Math.min(minClear, r.d);
    }
    const lane = Math.min(1, minClear / K.passLaneDiv);
    const distF = Math.max(0.3, 1 - dist(a, b) / 80);
    const techF = 0.578 + (tech - 55) / 100 * K.passTechSlope;
    return Math.max(0.02, techF * lane * distF);
  }
  function giveBallToMidfield(side) {
    inFlight = false; flightIsShot = false;
    const mid = team(side).find((p) => p.role === 'mid');
    ball.ownerId = mid ? mid.id : null;
    if (mid) { ball.x = mid.x; ball.y = mid.y; } else { ball.x = PW / 2; ball.y = GOAL_Y; }
    ball.vx = 0; ball.vy = 0; lastOwnerSide = side; possessionTime = 0;
  }

  // ── Coups de pied arrêtés ───────────────────────────────────────────────────
  function scoreGoal(side) {
    if (side === 'home') scoreH++; else scoreA++;
    st.totalGoals++;
    if (curT / displaySeconds * 90 >= 76) st.lateGoals++;
    const netX = side === 'home' ? PW - 1.2 : 1.2;
    celebX = netX; celebY = GOAL_Y; ball.x = netX; ball.y = GOAL_Y; ball.ownerId = null;
    inFlight = false; flightIsShot = false;
    phase = 'celebrate'; phaseUntil = curT + 1.6; kickoffSide = otherSide(side);
  }
  // Balle arrêtée : on pose le ballon au point, on désigne le tireur (le plus proche),
  // et on passe en phase 'setpiece' (le tireur s'y rend, courte pause, puis il joue).
  function deadBall(side, x, y, type) {
    inFlight = false; flightIsShot = false;
    spX = x; spY = y; ball.x = x; ball.y = y; ball.vx = 0; ball.vy = 0; ball.ownerId = null;
    let taker = null, td = 1e9;
    for (const p of team(side)) {
      if (p.role === 'gk' && type !== 'goalkick') continue;
      const d = Math.hypot(p.x - x, p.y - y); if (d < td) { td = d; taker = p; }
    }
    spTaker = taker ? taker.id : null; spSide = side; spType = type;
    lastOwnerSide = side; possessionTime = 0;
    phase = 'setpiece'; phaseUntil = curT + 0.8;
  }
  function awardThrowIn(side, x, y) { st.throwins[side]++; deadBall(side, Math.min(Math.max(x, 1), PW - 1), y < HALF ? 0.4 : PH - 0.4, 'throwin'); }
  function awardGoalKick(side) {   // 6 mètres = restart RAPIDE (peu d'enjeu visuel)
    inFlight = false; flightIsShot = false;
    const x = side === 'home' ? 14 : PW - 14, y = GOAL_Y + rng.range(-12, 12);
    ball.x = x; ball.y = y; ball.vx = 0; ball.vy = 0;
    let taker = null, td = 1e9;
    for (const p of team(side)) { if (p.role !== 'def' && p.role !== 'gk') continue; const d = Math.hypot(p.x - x, p.y - y); if (d < td) { td = d; taker = p; } }
    ball.ownerId = taker ? taker.id : null; lastOwnerSide = side; possessionTime = 0;
  }
  function takePenalty(side) {
    st.pens[side]++; st.shots[side]++; st.sot[side]++;
    if (rng.bool(K.penConv)) scoreGoal(side);
    else giveBallToMidfield(otherSide(side));
  }
  function awardCorner(side) {
    st.corners[side]++;
    const g = oppGoal(side);
    deadBall(side, g.x, rng.bool() ? 1 : PH - 1, 'corner');   // ballon au drapeau de corner
  }

  function computeContext() {
    const owner = ball.ownerId ? byId[ball.ownerId] : null;
    ctxAtt = owner ? owner.side : lastOwnerSide;
    const defSide = otherSide(ctxAtt);
    let pr = null, prd = 1e9;
    for (const p of team(defSide)) { if (p.role === 'gk') continue; const d = dist(p, ball); if (d < prd) { prd = d; pr = p; } }
    ctxPresser = pr ? pr.id : null;
    ctxMark = {};
    const defGoal = ownGoal(defSide);
    const threats = team(ctxAtt).filter((p) => p.role === 'att' || p.role === 'mid')
      .sort((x, y) => dist(x, defGoal) - dist(y, defGoal));
    const freeDefs = team(defSide).filter((p) => p.role === 'def' || p.role === 'mid');
    const used = new Set();
    for (const th of threats) {
      let cand = null, cd = 1e9;
      for (const d of freeDefs) { if (used.has(d.id)) continue; const dd = dist(d, th); if (dd < cd) { cd = dd; cand = d; } }
      if (cand) { ctxMark[cand.id] = th.id; used.add(cand.id); }
    }
    if (inFlight && !flightIsShot) {
      const predict = { x: ball.x + ball.vx * 0.25, y: ball.y + ball.vy * 0.25 };
      let cand = null, cd = 1e9;
      for (const p of team(defSide)) { if (p.role === 'gk') continue; const d = dist(p, predict); if (d < cd) { cd = d; cand = p; } }
      ctxInterceptor = cand && cd < 9 ? cand.id : null;
    } else ctxInterceptor = null;
    ctxOffside = offsideLineX(defSide);
  }

  function targetFor(p) {
    const dir = attackDir(p.side);
    const owner = ball.ownerId ? byId[ball.ownerId] : null;
    const isAtt = p.side === ctxAtt;
    const jit = { x: Math.sin(p.slot * 12.9898) * 1.3, y: Math.cos(p.slot * 4.1414) * 1.3 };

    if (owner && owner.id === p.id) {
      const g = oppGoal(p.side); const tg = norm(g.x - p.x, g.y - p.y);
      const foe = nearestOpp(p.x, p.y, p.side); const fd = dist(foe, p);
      const av = norm(p.x - foe.x, p.y - foe.y); const am = fd < 9 ? 6 : 0;
      return clampPitch(p.x + tg.x * 10 + av.x * am, p.y + tg.y * 10 + av.y * am);
    }
    if (p.role === 'gk') {
      const g = ownGoal(p.side);
      const ballInOwn = p.side === 'home' ? ball.x < HALF : ball.x > HALF;
      const y = ballInOwn ? GOAL_Y + (ball.y - GOAL_Y) * 0.5 : GOAL_Y;
      const comeOut = dist(ball, g) < 18 ? 6 : 2;
      return { x: g.x + dir * comeOut, y: Math.min(Math.max(y, 28), 40) };
    }
    if (inFlight && !flightIsShot && (p.id === flightReceiverId || p.id === ctxInterceptor)) {
      return clampPitch(ball.x + ball.vx * 0.25, ball.y + ball.vy * 0.25);
    }
    if (!isAtt) {
      if (p.id === ctxPresser) {
        // Un défenseur ne presse pas au-delà de son camp (sinon il traverse le terrain).
        const px = p.role === 'def' ? capOwnHalf(ball.x, p.side) : ball.x;
        return clampPitch(px + jit.x * 0.3, ball.y + jit.y * 0.3);
      }
      const fid = ctxMark[p.id];
      if (fid) {
        const foe = byId[fid]; const gs = norm(ownGoal(p.side).x - foe.x, ownGoal(p.side).y - foe.y);
        let tx = foe.x + gs.x * 2.5, ty = foe.y + gs.y * 2.5;
        if (p.role === 'def') tx = capOwnHalf(tx, p.side);
        return clampPitch(tx + jit.x, ty + jit.y);
      }
    }
    if (p.role === 'def') {
      const isCB = p.slot === 2 || p.slot === 3;
      const capX = isCB ? HALF - 3 : HALF + 3;   // centraux jamais au-delà du milieu, latéraux +3 m max
      const cap = (x) => (p.side === 'home' ? Math.min(x, capX) : Math.max(x, PW - capX));
      const lineDrop = 13 - ctxMent[p.side] * 9;   // mentalité : bétonne = recule, pousse = ligne haute
      let x = cap(isAtt ? HALF - 8 : ball.x - dir * lineDrop);
      let y = p.anchorY;
      let th = null, td = 1e9;
      for (const o of opp(p.side)) { if (o.role !== 'att' && o.role !== 'mid') continue; const d = dist(o, p); if (d < td) { td = d; th = o; } }
      if (th && td < 24) { y = p.anchorY * 0.45 + th.y * 0.55; x = cap((x + th.x - dir * 2) / 2); }
      return clampPitch(x + jit.x, y + jit.y);
    }
    // ── JEU SANS BALLON (équipe en possession) : course en profondeur vs appel court ──
    if (isAtt && (p.role === 'att' || p.role === 'mid')) {
      const carrier = owner && owner.side === p.side ? owner : null;
      const carrierPress = carrier ? pressureOn(carrier) : 0.5;
      const mk = nearestOpp(p.x, p.y, p.side);
      const marked = dist(mk, p) < 4;
      const openAt = (xx, yy) => 1 - Math.max(0, Math.min(1, -controlAt(xx, yy) * sideSign(p.side)));
      const pickY = (xx, center, spread) => {
        let bestY = center, bs = -1e9;
        for (const d of [-spread, -spread / 2, 0, spread / 2, spread]) {
          const yy = Math.min(Math.max(center + d, 6), PH - 6);
          const s = openAt(xx, yy) - Math.abs(yy - p.anchorY) * 0.012;
          if (s > bs) { bs = s; bestY = yy; }
        }
        return bestY;
      };
      // Un milieu central fait la course de 3e homme quand le ballon est dans le dernier tiers.
      const mids = team(p.side).filter((q) => q.role === 'mid');
      const runner = mids.length ? mids.reduce((b, q) => Math.abs(q.anchorY - GOAL_Y) < Math.abs(b.anchorY - GOAL_Y) ? q : b) : null;
      const advanced = (ball.x - HALF) * dir > 12;

      // Les attaquants rapides poussent la ligne (course plus tôt, risque de hors-jeu).
      const aggro = p.speed > 60 ? 3 : 1.5;
      const ment = ctxMent[p.side];   // mené tard → seuil de course relevé (on tente plus)
      if (p.role === 'att') {
        if (carrierPress < 0.6 + ment * 0.25 && !marked) {
          // COURSE EN PROFONDEUR : à la limite (parfois au-delà → hors-jeu), espace le moins tenu.
          const runX = dir > 0 ? Math.min(ctxOffside + aggro, ball.x + 24) : Math.max(ctxOffside - aggro, ball.x - 24);
          return clampPitch(runX + jit.x, pickY(runX, p.anchorY, 11) + jit.y);
        }
        // APPEL DANS LES PIEDS : poche d'espace vers le ballon.
        const showX = ball.x - dir * 5;
        return clampPitch(showX + jit.x, pickY(showX, ball.y, 12) + jit.y);
      }
      if (p.role === 'mid' && runner && p.id === runner.id && advanced && carrierPress < 0.65) {
        // 3e HOMME : course dans la surface.
        const runX = dir > 0 ? Math.min(ctxOffside, ball.x + 14) : Math.max(ctxOffside, ball.x - 14);
        return clampPitch(runX + jit.x, GOAL_Y + (p.anchorY - GOAL_Y) * 0.4 + jit.y);
      }
      // autres milieux : soutien (bloc ci-dessous)
    }

    const bx = ball.x;
    let homeX;
    if (p.role === 'att') {
      const base = bx + dir * (isAtt ? 15 : 8);
      const floor = isAtt ? HALF + 4 : HALF - 8;
      homeX = p.side === 'home' ? Math.max(base, floor) : Math.min(base, PW - floor);
      if (isAtt) homeX = p.side === 'home' ? Math.min(homeX, ctxOffside + 1) : Math.max(homeX, ctxOffside - 1);
    } else if (p.role === 'mid') {
      homeX = bx + dir * (isAtt ? 3 : -3);
    } else homeX = bx;
    const homeY = p.anchorY * 0.78 + ball.y * 0.22;
    const rh = clampPitch(homeX, homeY);
    let bestCell = rh, bestScore = -1e18;
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
      const c = cellCenter(i, j);
      if (Math.abs(c.x - rh.x) > 16 || Math.abs(c.y - rh.y) > 11) continue;
      const reach = Math.exp(-(dist(c, p) / Math.max(effSpeed(p), 0.1)) / 1.2);
      const ctrlOwn = control[j * GX + i] * sideSign(p.side);
      let s;
      if (isAtt) { const openness = 1 - Math.max(0, Math.min(1, ctrlOwn / 3)); s = cellValue(c, p.side) * (0.5 + 0.5 * openness) * reach * 100; }
      else { const theirCtrl = Math.max(0, Math.min(1, -ctrlOwn / 3)); s = cellValue(c, otherSide(p.side)) * (0.4 + 0.6 * theirCtrl) * reach * 100; }
      if (s > bestScore) { bestScore = s; bestCell = c; }
    }
    return clampPitch(rh.x * 0.6 + bestCell.x * 0.4 + jit.x, rh.y * 0.6 + bestCell.y * 0.4 + jit.y);
  }

  function bestPassOption(o) {
    const goal = oppGoal(o.side); let best = null, bestScore = -1e18, bestThrough = false;
    for (const m of team(o.side)) {
      if (m.id === o.id || m.role === 'gk') continue;
      const d = dist(o, m); if (d < 4 || d > 60) continue;
      const prob = passSuccess(o, m, o.technique, otherSide(o.side));
      if (prob < K.passMinProb) continue;
      const progress = dist(goal, o) - dist(goal, m);
      const space = cellValue(m, o.side);
      const own = Math.max(0, controlAt(m.x, m.y) * sideSign(o.side));
      const openness = dist(nearestOpp(m.x, m.y, o.side), m);
      const lateral = Math.abs(m.y - o.y);
      let score = (progress * 0.8 + space * 22 + own * 6 + openness * 1.6 + lateral * 0.25) * prob;
      if (m.role === 'att' && progress > 0) score += 8;
      if (score > bestScore) { bestScore = score; best = m; bestThrough = progress > 12 && openness > 6; }
    }
    return best ? { mate: best, through: bestThrough } : null;
  }

  function doPass(o, mate, through, safe, noOff) {
    const lead = through ? { x: attackDir(o.side) * 6, y: 0 } : { x: 0, y: 0 };
    const ft = clampPitch(mate.x + lead.x, mate.y + lead.y);
    // HORS-JEU : passe vers l'avant à un receveur au-delà de la ligne (sauf corner → noOff).
    const odir = attackDir(o.side);
    const inOppHalf = o.side === 'home' ? mate.x > HALF : mate.x < HALF;
    const ahead = (mate.x - ball.x) * odir > 1;
    const beyond = o.side === 'home' ? mate.x > ctxOffside + 0.5 : mate.x < ctxOffside - 0.5;
    if (!noOff && inOppHalf && ahead && beyond) {
      st.offside[o.side]++;
      giveBallToMidfield(otherSide(o.side));   // coup franc pour l'équipe qui défend
      return;
    }
    st.passAtt[o.side]++;
    const prob = passSuccess(o, ft, o.technique, otherSide(o.side));
    const success = rng.next() < prob;
    flightReceiverId = success ? mate.id : null;   // ratée = pas de receveur désigné (physique décide)
    flightIsShot = false; flightSide = o.side;
    // PHYSIQUE DU BALLON : erreur de DIRECTION + de POIDS — faible si réussie, forte si ratée,
    // aggravée par la pression et la faible technique. Une passe ratée part à la dérive
    // (interception, ballon qui traîne, ou sortie — décidé par la géométrie/les sorties).
    const press = pressureOn(o);
    const errMag = (success ? 0.05 : 0.22) + (1 - o.technique / 100) * 0.12 + press * 0.05;
    const ang = Math.atan2(ft.y - o.y, ft.x - o.x) + (rng.next() - 0.5) * 2 * errMag;
    const weight = success ? rng.range(0.96, 1.06) : rng.range(0.70, 1.35);
    const d = dist(o, ft) * weight;
    const sp = Math.min(30, 9 + d * 0.8);
    ball.vx = Math.cos(ang) * sp; ball.vy = Math.sin(ang) * sp;
    ball.ownerId = null; inFlight = true; lastOwnerSide = o.side;
  }

  function shoot(shooter) {
    const goal = oppGoal(shooter.side);
    const gk = team(otherSide(shooter.side)).find((p) => p.role === 'gk');
    const d = dist(shooter, goal);
    const base = d < 12 ? K.shootBase.near : d < 20 ? K.shootBase.mid : K.shootBase.far;
    const techMod = (shooter.technique - 55) / 100 * K.shootTechMod;
    const gkMod = ((gk ? gk.technique : 55) - 55) / 100 * K.shootGkMod;
    const pGoal = Math.min(0.45, Math.max(0.02, base + techMod - gkMod));
    const r = rng.next();
    let outcome;
    if (r < pGoal) outcome = 'goal';
    else if (r < pGoal + K.outcomeSaved) outcome = 'save';
    else if (r < pGoal + K.outcomeSaved + K.outcomeBlocked) outcome = 'block';
    else outcome = 'miss';
    let aim = { x: goal.x, y: goal.y };
    if (outcome === 'miss') aim.y += rng.bool() ? GOAL_HW + 3 : -(GOAL_HW + 3);
    else aim.y = GOAL_Y + rng.range(-GOAL_HW, GOAL_HW);
    if (outcome === 'save' && gk) aim = { x: gk.x, y: gk.y };
    flightIsShot = true; flightOutcome = outcome; flightSide = shooter.side; flightReceiverId = shooter.id;
    const dir = norm(aim.x - shooter.x, aim.y - shooter.y);
    ball.vx = dir.x * 32; ball.vy = dir.y * 32; ball.ownerId = null; inFlight = true; lastOwnerSide = shooter.side;
    st.shots[shooter.side]++;
    if (outcome === 'goal' || outcome === 'save') st.sot[shooter.side]++;
  }

  function resolveShot() {
    inFlight = false; ball.vx = 0; ball.vy = 0;
    const side = flightSide;
    if (flightOutcome === 'goal') {
      scoreGoal(side);
    } else if (flightOutcome === 'save') {
      if (rng.bool(K.cornerFromSave)) { awardCorner(side); }   // relâché → corner
      else { const gk = team(otherSide(side)).find((p) => p.role === 'gk'); ball.ownerId = gk ? gk.id : null; lastOwnerSide = otherSide(side); possessionTime = 0; }
    } else if (flightOutcome === 'block') {
      if (rng.bool(K.cornerFromBlock)) awardCorner(side);      // contré → corner
      else giveBallToMidfield(otherSide(side));
    } else { // miss : dévié en corner, sinon 6 mètres
      if (rng.bool(K.cornerFromMiss)) awardCorner(side);
      else awardGoalKick(otherSide(side));
    }
    flightIsShot = false;
  }

  function makeDecision(o, press) {
    const goal = oppGoal(o.side); const tg = norm(goal.x - o.x, goal.y - o.y); const gd = dist(o, goal);
    let bestOpt = 'dribble', bestEV = -1e9, passMate = null, passThrough = false, passSafe = false;
    if (gd < K.shootMaxDist) {
      const base = gd < 12 ? K.shootBase.near : gd < 20 ? K.shootBase.mid : K.shootBase.far;
      const pg = Math.max(0.02, base + (o.technique - 55) / 100 * K.shootTechMod);
      const ev = pg * K.goalValue * (1 - press * 0.3) * (1 + ctxMent[o.side] * 0.5);
      if (ev > bestEV) { bestEV = ev; bestOpt = 'shoot'; }
    }
    const bp = bestPassOption(o);
    if (bp) {
      const prob = passSuccess(o, bp.mate, o.technique, otherSide(o.side));
      const adv = gd - dist(bp.mate, goal);
      const ev = prob * (1.5 + Math.max(0, adv) * 0.18 + cellValue(bp.mate, o.side) * 5);
      if (ev > bestEV) { bestEV = ev; bestOpt = 'pass'; passMate = bp.mate; passThrough = bp.through; }
    }
    const aheadPt = clampPitch(o.x + tg.x * 9, o.y + tg.y * 9);
    const dribbleEV = cellValue(aheadPt, o.side) * 3 * (1 - press);
    if (dribbleEV > bestEV) { bestEV = dribbleEV; bestOpt = 'dribble'; }
    if (press > 0.55 && bestEV < 1.5) {
      let outlet = null, od = 1e9;
      for (const m of team(o.side)) {
        if (m.id === o.id || m.role === 'gk') continue;
        if (passSuccess(o, m, o.technique, otherSide(o.side)) <= 0.5) continue;
        const dd = dist(m, o); if (dd < od) { od = dd; outlet = m; }
      }
      if (outlet) { bestOpt = 'pass'; passMate = outlet; passThrough = false; passSafe = true; }
    }
    if (bestOpt === 'shoot') shoot(o);
    else if (bestOpt === 'pass' && passMate) doPass(o, passMate, passThrough, passSafe);
    // dribble = on garde la balle (rien à émettre)
  }

  function attemptTackle(d, c) {
    // Duel : force du défenseur vs (technique+force) du porteur (protection de balle). Centré sur 55.
    const carrierHold = c.technique * 0.6 + c.strength * 0.4;
    const pT = Math.min(0.5, K.tackleBase + (d.strength - carrierHold) / 130 + 0.1);
    if (!rng.bool(pT)) return;
    if (rng.bool(K.foulShare)) {
      // FAUTE → l'équipe attaquée (c) obtient le coup franc (PAS le fauteur).
      st.fouls[d.side]++;
      if (rng.bool(K.yellowProb)) { if (rng.bool(K.redGivenYellow)) st.red[d.side]++; else st.yellow[d.side]++; }
      // Penalty si la faute est dans la surface du défenseur (près de SON but).
      const ownG = ownGoal(d.side);
      const inBox = Math.abs(c.x - ownG.x) < 16.5 && Math.abs(c.y - GOAL_Y) < 20.16;
      if (inBox && rng.bool(K.penFromBoxFoul)) takePenalty(c.side);
      else deadBall(c.side, c.x, c.y, 'freekick');   // coup franc joué
    } else {
      // Tacle propre → le défenseur récupère.
      ball.ownerId = d.id; lastOwnerSide = d.side; possessionTime = 0;
    }
  }

  function kickoffTarget(p) {
    if (p.side === kickoffSide && p.role === 'mid' && (p.slot === 6 || p.slot === 7)) {
      const d = attackDir(kickoffSide);
      return { x: HALF - d * (p.slot === 6 ? 2 : 5), y: GOAL_Y + (p.slot === 6 ? 0 : 3) };
    }
    const x = p.side === 'home' ? Math.min(p.anchorX, HALF - 3) : Math.max(p.anchorX, HALF + 3);
    return { x, y: p.anchorY };
  }
  function allInOwnHalf() {
    for (const p of all) {
      if (p.side === 'home' && p.x > HALF + 1.5) return false;
      if (p.side === 'away' && p.x < HALF - 1.5) return false;
    }
    return true;
  }

  // ── Coup d'envoi initial ───────────────────────────────────────────────────
  ball = { x: center.x, y: center.y, vx: 0, vy: 0, ownerId: null };
  phase = 'kickoff'; kickoffSide = 'home'; phaseUntil = 1.2; lastOwnerSide = 'home';
  let halftimeDone = false;
  let curT = 0;

  for (let tick = 0; tick <= totalTicks + extraTicks; tick++) {
    const t = tick * dt; curT = t;
    const prog = t / displaySeconds;   // 0..1 (peut dépasser 1 = temps additionnel)

    if (!halftimeDone && phase === 'play' && t >= displaySeconds / 2) {
      halftimeDone = true;
      phase = 'kickoff'; kickoffSide = 'away'; phaseUntil = t + 2;
      ball.x = center.x; ball.y = center.y; ball.ownerId = null; inFlight = false;
    }

    // ── FLUX DE MATCH (1×/s) : fatigue progressive, mentalité, remplacements ──
    if (tick % 20 === 0) {
      for (const p of all) {
        const eff = Math.max(0, prog - (p.subProg || 0));          // temps joué depuis frais
        const fatigue = eff * (0.12 + (1 - p.stamina / 100) * 0.22); // l'endurance limite la baisse
        p.speedMul = Math.max(0.72, 1 - fatigue);
      }
      // Remplacements (~78') : on rafraîchit les 2 joueurs de champ les plus fatigués de chaque équipe.
      if (!subsDone && prog > 0.78) {
        subsDone = true;
        for (const side of ['home', 'away']) {
          team(side).filter((p) => p.role !== 'gk').sort((a, b) => a.speedMul - b.speedMul).slice(0, 2)
            .forEach((p) => { p.subProg = prog; });
        }
      }
      // Mentalité = identité de base (style) + ajustement selon le score/temps.
      for (const side of ['home', 'away']) {
        let m = side === 'home' ? homeStyleOff : awayStyleOff;     // identité (toute la durée)
        const diff = side === 'home' ? scoreH - scoreA : scoreA - scoreH;
        if (prog >= 0.6) {
          if (diff >= 2) m -= 1;                                   // mène nettement → bétonne
          else if (diff <= -1) m += Math.min(1, 0.4 + (prog - 0.6) * 1.6); // mené → pousse
          else if (diff === 1 && prog > 0.85) m -= 0.5;            // mène d'1 en fin → gère
        }
        ctxMent[side] = Math.max(-1.2, Math.min(1.2, m));
      }
    }

    if (phase === 'play' || phase === 'setpiece') { computeContext(); if (tick % 2 === 0) computeControl(); }

    for (const p of all) {
      let tgt;
      if (phase === 'play') tgt = targetFor(p);
      else if (phase === 'setpiece') tgt = (p.id === spTaker) ? { x: spX, y: spY } : targetFor(p);
      else tgt = kickoffTarget(p);
      const des = clampLen(tgt.x - p.x, tgt.y - p.y, effSpeed(p));
      let sx = 0, sy = 0;
      for (const q of team(p.side)) { if (q.id === p.id) continue; const ox = p.x - q.x, oy = p.y - q.y; const d = Math.hypot(ox, oy); if (d < 6 && d > 1e-3) { const n = (6 - d) / d; sx += ox * n; sy += oy * n; } }
      const steer = clampLen(des.x + sx * 0.9, des.y + sy * 0.9, effSpeed(p));
      p.vx = p.vx * 0.6 + steer.x * 0.4; p.vy = p.vy * 0.6 + steer.y * 0.4;
      const np = clampPitch(p.x + p.vx * dt, p.y + p.vy * dt); p.x = np.x; p.y = np.y;
    }

    if (phase === 'celebrate') {
      ball.x = celebX; ball.y = celebY; ball.ownerId = null;
      if (t >= phaseUntil) { phase = 'kickoff'; phaseUntil = t + 2; ball.x = center.x; ball.y = center.y; }
    } else if (phase === 'kickoff') {
      ball.x = center.x; ball.y = center.y; ball.ownerId = null;
      if (t >= phaseUntil && (allInOwnHalf() || t >= phaseUntil + 5)) {
        const kicker = team(kickoffSide).find((p) => p.role === 'mid' && p.slot === 6) || team(kickoffSide).find((p) => p.role === 'mid');
        const receiver = team(kickoffSide).find((p) => p.role === 'mid' && p.slot === 7) || team(kickoffSide).find((p) => p.id !== (kicker && kicker.id) && p.role !== 'gk');
        ball.ownerId = kicker ? kicker.id : null; if (kicker) { ball.x = kicker.x; ball.y = kicker.y; }
        possessionTime = 0; lastOwnerSide = kickoffSide; phase = 'play';
        if (kicker && receiver) doPass(kicker, receiver, false, true);
      }
    } else if (phase === 'setpiece') {
      ball.x = spX; ball.y = spY; ball.ownerId = null;   // ballon posé, le tireur s'approche
      const taker = spTaker ? byId[spTaker] : null;
      const ready = taker && Math.hypot(taker.x - spX, taker.y - spY) < 1.6;
      if ((t >= phaseUntil && ready) || t >= phaseUntil + 3) {
        if (taker) {
          ball.ownerId = taker.id; ball.x = taker.x; ball.y = taker.y;
          possessionTime = 0; lastOwnerSide = spSide; phase = 'play';
          if (spType === 'corner') {
            // Pré-positionne 2 attaquants dans la surface et CENTRE direct vers le 1er
            // (pas de hors-jeu sur corner) → reprise/tir réaliste, pas un tir du drapeau.
            const g = oppGoal(spSide);
            const atts = team(spSide).filter((p) => (p.role === 'att' || p.role === 'mid') && p.id !== taker.id)
              .sort((a, b) => dist(a, g) - dist(b, g)).slice(0, 2);
            atts.forEach((p, k) => { p.x = g.x - attackDir(spSide) * 6; p.y = GOAL_Y + (k === 0 ? -5 : 5); });
            if (atts[0]) doPass(taker, atts[0], false, false, true);   // centre, no offside
          }
        } else phase = 'play';
      }
    } else { // play
      const owner = ball.ownerId ? byId[ball.ownerId] : null;
      if (inFlight) {
        ball.x += ball.vx * dt; ball.y += ball.vy * dt; ball.vx *= 0.985; ball.vy *= 0.985;
        let rcv = null, rd = 1e9; for (const p of all) { const d = dist(p, ball); if (d < rd) { rd = d; rcv = p; } }
        if (rcv && rd < 1.6) {
          if (flightIsShot) resolveShot();
          else {
            inFlight = false; ball.ownerId = rcv.id; ball.vx = 0; ball.vy = 0; possessionTime = 0;
            if (rcv.side === flightSide) st.passComp[flightSide]++;  // passe réussie (reçue par un coéquipier)
            lastOwnerSide = rcv.side;
          }
        } else if (flightIsShot && (flightSide === 'home' ? ball.x >= PW - 0.5 : ball.x <= 0.5)) resolveShot();
        if (phase === 'play' && (ball.y < 0 || ball.y > PH)) {
          awardThrowIn(otherSide(lastOwnerSide), ball.x, ball.y);   // touche
        } else if (phase === 'play' && (ball.x < 0 || ball.x > PW)) {
          const defGoalSide = ball.x < 0 ? 'home' : 'away';        // de quel but on sort
          if (lastOwnerSide === defGoalSide) awardCorner(otherSide(defGoalSide)); // défenseur l'a sortie → corner
          else awardGoalKick(defGoalSide);                          // attaquant l'a sortie → 6 mètres
        }
      } else if (owner) {
        ball.x = owner.x + attackDir(owner.side) * 1; ball.y = owner.y;
        possessionTime += dt;
        const press = pressureOn(owner);
        if (possessionTime > K.decideEvery || (press > 0.6 && possessionTime > 0.25)) { makeDecision(owner, press); possessionTime = 0; }
        const defender = nearestOpp(owner.x, owner.y, owner.side);
        if (dist(defender, owner) < K.tackleRange) attemptTackle(defender, owner);
      } else {
        let g = null, gd = 1e9; for (const p of all) { const d = dist(p, ball); if (d < gd) { gd = d; g = p; } }
        if (g && gd < 1.6) { ball.ownerId = g.id; lastOwnerSide = g.side; possessionTime = 0; }
      }
      // possession (par tick de jeu)
      const posSide = owner ? owner.side : lastOwnerSide;
      st.poss[posSide]++;
    }

    if (REC && tick % keyframeEvery === 0) {
      frames.push({
        t,
        ball: { x: ball.x, y: ball.y },
        players: all.map((p) => ({ slot: p.slot, side: p.side, x: p.x, y: p.y, hasBall: ball.ownerId === p.id })),
        sh: scoreH, sa: scoreA,
      });
    }
  }

  return {
    scoreH, scoreA,
    shots: st.shots, sot: st.sot, goals: { home: scoreH, away: scoreA },
    passAtt: st.passAtt, passComp: st.passComp, fouls: st.fouls, offside: st.offside,
    corners: st.corners, throwins: st.throwins, yellow: st.yellow, red: st.red, pens: st.pens,
    lateGoals: st.lateGoals, totalGoalsTracked: st.totalGoals,
    poss: st.poss,
    frames, events,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { simulate, K };
if (typeof window !== 'undefined') window.SimEngine = { simulate, K };
