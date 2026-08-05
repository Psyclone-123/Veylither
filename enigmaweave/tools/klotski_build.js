// Offline level-table builder for SLIDE mode.
// Generates levels procedurally here (full component analysis + exact par),
// then emits a compact table to embed in the game. Doing the heavy analysis
// at build time keeps the browser from freezing and — more importantly —
// guarantees every player gets an identical level N, which the global
// leaderboard depends on.
const SR = 5, SC = 4;
const sizeOf = t => t === 'goal' ? { w: 2, h: 2 } : t === 'v' ? { w: 1, h: 2 } : t === 'h' ? { w: 2, h: 1 } : { w: 1, h: 1 };
const CH = { goal: 'G', s: 'S', v: 'V', h: 'H' };
const FROM_CH = { G: 'goal', S: 's', V: 'v', H: 'h' };

function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function structural(pieces) {
    const g = Array.from({ length: SR }, () => Array(SC).fill(-1));
    for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i], { w, h } = sizeOf(p.type);
        if (p.r < 0 || p.c < 0 || p.r + h > SR || p.c + w > SC) return 'oob';
        for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) {
            if (g[p.r + dr][p.c + dc] !== -1) return 'overlap';
            g[p.r + dr][p.c + dc] = i;
        }
    }
    let e = 0; for (let r = 0; r < SR; r++) for (let c = 0; c < SC; c++) if (g[r][c] === -1) e++;
    if (e !== 2) return 'empties=' + e;
    if (pieces.filter(p => p.type === 'goal').length !== 1) return 'goal count';
    return null;
}

function key(pieces) {
    const g = new Array(SR * SC).fill('.');
    for (const p of pieces) {
        const { w, h } = sizeOf(p.type);
        for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) g[(p.r + dr) * SC + p.c + dc] = CH[p.type];
    }
    return g.join('');
}

function legalMoves(pieces) {
    const g = new Int8Array(SR * SC).fill(-1);
    for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i], { w, h } = sizeOf(p.type);
        for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) g[(p.r + dr) * SC + p.c + dc] = i;
    }
    const out = [], dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i], { w, h } = sizeOf(p.type);
        for (const [dr, dc] of dirs) {
            const nr = p.r + dr, nc = p.c + dc;
            if (nr < 0 || nc < 0 || nr + h > SR || nc + w > SC) continue;
            let ok = true;
            for (let a = 0; a < h && ok; a++) for (let b = 0; b < w && ok; b++) {
                const cell = g[(nr + a) * SC + nc + b];
                if (cell !== -1 && cell !== i) ok = false;
            }
            if (ok) out.push({ i, dr, dc });
        }
    }
    return out;
}
const applyMove = (ps, mv) => { const n = ps.map(p => ({ ...p })); n[mv.i].r += mv.dr; n[mv.i].c += mv.dc; return n; };
const isWin = ps => { const g = ps.find(p => p.type === 'goal'); return g.r === 3 && g.c === 1; };

function analyse(tpl, cap = 400000) {
    const states = new Map([[key(tpl), tpl]]);
    let frontier = [tpl];
    while (frontier.length) {
        const next = [];
        for (const st of frontier) for (const mv of legalMoves(st)) {
            const ns = applyMove(st, mv), k = key(ns);
            if (states.has(k)) continue;
            states.set(k, ns); next.push(ns);
            if (states.size > cap) return null;
        }
        frontier = next;
    }
    const dist = new Map();
    let layer = [];
    for (const [k, st] of states) if (isWin(st)) { dist.set(k, 0); layer.push(st); }
    let d = 0;
    while (layer.length) {
        const next = []; d++;
        for (const st of layer) for (const mv of legalMoves(st)) {
            const ns = applyMove(st, mv), k = key(ns);
            if (dist.has(k)) continue;
            dist.set(k, d); next.push(ns);
        }
        layer = next;
    }
    const byDist = new Map();
    let maxDist = 0;
    // NB: spreading 100k+ values into Math.max overflows the stack — accumulate.
    for (const [k, dv] of dist) {
        if (!byDist.has(dv)) byDist.set(dv, []);
        byDist.get(dv).push(k);
        if (dv > maxDist) maxDist = dv;
    }
    for (const a of byDist.values()) a.sort();
    return { states, byDist, maxDist };
}

// ---- candidate templates (all must be a SOLVED board: goal at 3,1) ----
const CANDIDATES = {
    A: [ {type:'goal',r:3,c:1}, {type:'v',r:3,c:0}, {type:'v',r:3,c:3}, {type:'v',r:1,c:0}, {type:'v',r:1,c:3},
         {type:'h',r:2,c:1}, {type:'s',r:0,c:0}, {type:'s',r:0,c:1}, {type:'s',r:0,c:2}, {type:'s',r:0,c:3} ],
    B: [ {type:'goal',r:3,c:1}, {type:'h',r:0,c:0}, {type:'h',r:0,c:2}, {type:'h',r:1,c:0}, {type:'h',r:1,c:2},
         {type:'s',r:2,c:0}, {type:'s',r:2,c:3}, {type:'s',r:3,c:0}, {type:'s',r:4,c:0}, {type:'s',r:3,c:3}, {type:'s',r:4,c:3} ],
    D: [ {type:'goal',r:3,c:1}, {type:'s',r:0,c:0}, {type:'s',r:0,c:1}, {type:'s',r:0,c:2}, {type:'s',r:0,c:3},
         {type:'v',r:1,c:0}, {type:'v',r:1,c:3}, {type:'h',r:1,c:1}, {type:'s',r:3,c:0}, {type:'s',r:4,c:0},
         {type:'s',r:3,c:3}, {type:'s',r:4,c:3} ],
    // E — vertical bars down both flanks, empties in the middle band
    E: [ {type:'goal',r:3,c:1}, {type:'v',r:0,c:0}, {type:'v',r:0,c:3}, {type:'v',r:2,c:0}, {type:'v',r:2,c:3},
         {type:'h',r:0,c:1}, {type:'h',r:1,c:1}, {type:'s',r:4,c:0}, {type:'s',r:4,c:3} ],
    // F — bar lid, vertical shoulders, singles in the corners
    F: [ {type:'goal',r:3,c:1}, {type:'h',r:0,c:0}, {type:'h',r:0,c:2}, {type:'v',r:1,c:0}, {type:'v',r:1,c:3},
         {type:'h',r:2,c:1}, {type:'s',r:3,c:0}, {type:'s',r:3,c:3}, {type:'s',r:4,c:0}, {type:'s',r:4,c:3} ],
    // (a "G" variant was dropped: same piece multiset as D, so it explores the
    //  identical reachable component and would just duplicate D's levels)
    // H — stacked bars in the middle column
    H: [ {type:'goal',r:3,c:1}, {type:'s',r:0,c:0}, {type:'s',r:0,c:3}, {type:'h',r:0,c:1}, {type:'v',r:1,c:0},
         {type:'v',r:1,c:3}, {type:'h',r:1,c:1}, {type:'s',r:3,c:0}, {type:'s',r:3,c:3},
         {type:'s',r:4,c:0}, {type:'s',r:4,c:3} ],
};

console.log('=== candidate template survey ===');
const good = [];
for (const [name, tpl] of Object.entries(CANDIDATES)) {
    const err = structural(tpl);
    if (err) { console.log(`  ${name}: STRUCTURAL FAIL (${err})`); continue; }
    const g = tpl.find(p => p.type === 'goal');
    if (g.r !== 3 || g.c !== 1) { console.log(`  ${name}: not solved-position`); continue; }
    const t0 = Date.now();
    const a = analyse(tpl);
    const ms = Date.now() - t0;
    if (!a) { console.log(`  ${name}: component too large (>cap)`); continue; }
    const usable = a.maxDist >= 25 && a.states.size >= 2000;
    console.log(`  ${name}: states=${String(a.states.size).padStart(6)} maxPar=${String(a.maxDist).padStart(3)} pieces=${tpl.length} ${ms}ms ${usable ? 'USE' : 'reject (too shallow)'}`);
    if (usable) good.push({ name, tpl, a });
}

// ---- build the level table ----
// Par ramps smoothly; templates rotate so consecutive levels feel different.
const LEVEL_COUNT = 160;
const out = [];
for (let lv = 0; lv < LEVEL_COUNT; lv++) {
    const pick = good[lv % good.length];
    const rnd = mulberry32((lv + 1) * 2654435761 >>> 0);
    const frac = lv / (LEVEL_COUNT - 1);
    // ease-in ramp: gentle early, steep later
    let target = Math.round(4 + (pick.a.maxDist - 4) * Math.pow(frac, 1.25));
    target = Math.max(3, Math.min(pick.a.maxDist, target));
    let d = target, bucket = pick.a.byDist.get(d) || [];
    let step = 0;
    while (!bucket.length && step < 200) {           // nearest populated bucket
        step++;
        bucket = pick.a.byDist.get(d - step) || pick.a.byDist.get(d + step) || [];
        if (bucket.length) d = (pick.a.byDist.get(d - step) || []).length ? d - step : d + step;
    }
    if (!bucket.length) continue;
    const k = bucket[Math.floor(rnd() * bucket.length) % bucket.length];
    const pieces = pick.a.states.get(k);
    out.push({ lv, tpl: pick.name, par: d, pieces });
}

// ---- encode compactly: 3 chars per piece (type,row,col) + '|' + par ----
const encode = pieces => pieces.map(p => CH[p.type] + p.r + p.c).join('');
const decode = s => {
    const ps = [];
    for (let i = 0; i < s.length; i += 3) ps.push({ type: FROM_CH[s[i]], r: +s[i + 1], c: +s[i + 2] });
    return ps;
};

console.log('\n=== verifying encode/decode round-trip + level validity ===');
let bad = 0;
const encoded = out.map(o => {
    const enc = encode(o.pieces);
    const dec = decode(enc);
    const problems = [];
    if (key(dec) !== key(o.pieces)) problems.push('ROUND-TRIP MISMATCH');
    const st = structural(dec);
    if (st) problems.push('INVALID:' + st);
    if (isWin(dec)) problems.push('STARTS SOLVED');
    if (o.par < 1) problems.push('PAR<1');
    if (problems.length) { bad++; console.log(`  L${o.lv}: ${problems.join(', ')}`); }
    return enc + '|' + o.par;
});

const pars = out.map(o => o.par);
console.log(`levels=${out.length} bad=${bad}`);
console.log(`par ramp: ${pars.slice(0, 8).join(',')} ... ${pars.slice(-6).join(',')}`);
console.log(`par range ${Math.min(...pars)}..${Math.max(...pars)}`);
for (let i = 0; i < 8; i++) {
    const seg = pars.slice(i * 20, (i + 1) * 20);
    console.log(`  levels ${String(i*20).padStart(3)}-${String(i*20+19).padStart(3)}: avg par ${(seg.reduce((a,b)=>a+b,0)/seg.length).toFixed(1)}`);
}

const totalBytes = encoded.join(',').length;
console.log(`\nembedded table size: ${(totalBytes/1024).toFixed(1)} KB`);
require('fs').writeFileSync('/tmp/slide_levels.json', JSON.stringify(encoded));
console.log(bad ? 'FAILURES PRESENT' : 'ALL LEVELS VALID — written to /tmp/slide_levels.json');
