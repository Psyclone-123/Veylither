// Offline level-table builder for SLIDE mode.
// Generates levels procedurally here (full component analysis + exact par),
// then emits a compact table to embed in the game. Doing the heavy analysis
// at build time keeps the browser from freezing and — more importantly —
// guarantees every player gets an identical level N, which the global
// leaderboard depends on.
//
// TIERS: the board grows as the player progresses. A bigger board has far more
// piece arrangements, and past ~4x5 the reachable state graph stops fitting in
// memory — so the larger tiers also carry immovable WALL cells. Walls cut
// mobility back down, which keeps the whole component enumerable (and so keeps
// par exact), and they give the later boards their own character.
//
// Run:  node tools/klotski_build.js            (writes tools/slide_levels.json)
const fs = require('fs');
const path = require('path');

const SIZES = { goal: { w: 2, h: 2 }, s: { w: 1, h: 1 }, v: { w: 1, h: 2 }, h: { w: 2, h: 1 }, w: { w: 1, h: 1 } };
const CH = { goal: 'G', s: 'S', v: 'V', h: 'H', w: 'W' };
const FROM_CH = { G: 'goal', S: 's', V: 'v', H: 'h', W: 'w' };
const sizeOf = t => SIZES[t] || SIZES.s;

// Level tiers: [rows, cols, walls, empty cells, level count, minPar, minStates]
// Wall/empty counts come from a sweep over each board size — these are the
// combinations that stay enumerable while still producing deep puzzles.
// parFrom/parTo is the difficulty curve the tier ramps along (clamped to what
// each template can actually reach). These are set so par climbs across the
// whole 160 rather than per tier — a fresh tier is already harder for being a
// bigger board, so it restarts a bit gentler than the previous tier ended, but
// never back down to beginner pars.
const TIERS = [
    { rows: 5, cols: 4, walls: 0, empties: 2, count: 50, minPar: 60, minStates: 20000, attempts: 120, parFrom: 4, parTo: 55 },
    { rows: 6, cols: 5, walls: 4, empties: 3, count: 55, minPar: 55, minStates: 20000, attempts: 160, parFrom: 20, parTo: 90 },
    { rows: 7, cols: 6, walls: 10, empties: 3, count: 55, minPar: 45, minStates: 20000, attempts: 260, parFrom: 32, parTo: 120 }
];
const TEMPLATES_PER_TIER = 5;
const STATE_CAP = 1600000;

function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------------------
// Board engine for one (rows, cols) shape. States are encoded as a string of
// char codes, one per movable piece (type/row/col packed), sorted — so two
// arrangements that differ only in which same-type piece sits where collapse
// to one state, which is what keeps the graph small enough to enumerate.
// ---------------------------------------------------------------------------
function engine(rows, cols) {
    const goalR = rows - 2, goalC = Math.floor((cols - 2) / 2);
    const TCODE = { goal: 0, v: 1, h: 2, s: 3 };
    const TNAME = ['goal', 'v', 'h', 's'];
    const SZ = [[2, 2], [1, 2], [2, 1], [1, 1]];   // [w,h] per TCODE

    const enc = ps => String.fromCharCode.apply(null,
        ps.map(p => TCODE[p.type] * 100 + p.r * 10 + p.c).sort((a, b) => a - b));
    const dec = k => {
        const ps = [];
        for (let i = 0; i < k.length; i++) {
            const v = k.charCodeAt(i);
            ps.push({ type: TNAME[(v / 100) | 0], r: ((v / 10) | 0) % 10, c: v % 10 });
        }
        return ps;
    };
    const isWin = k => {
        for (let i = 0; i < k.length; i++) {
            const v = k.charCodeAt(i);
            if (((v / 100) | 0) === 0) return (((v / 10) | 0) % 10) === goalR && v % 10 === goalC;
        }
        return false;
    };

    function make(walls) {
        const base = new Int8Array(rows * cols).fill(-1);
        for (const cell of walls) base[cell] = -2;          // -2 = immovable
        const occ = new Int8Array(rows * cols);

        function neighbours(k) {
            const ps = dec(k), out = [];
            occ.set(base);
            for (let i = 0; i < ps.length; i++) {
                const p = ps[i], s = SZ[TCODE[p.type]];
                for (let a = 0; a < s[1]; a++) for (let b = 0; b < s[0]; b++) occ[(p.r + a) * cols + p.c + b] = i;
            }
            for (let i = 0; i < ps.length; i++) {
                const p = ps[i], s = SZ[TCODE[p.type]];
                for (const d of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                    const nr = p.r + d[0], nc = p.c + d[1];
                    if (nr < 0 || nc < 0 || nr + s[1] > rows || nc + s[0] > cols) continue;
                    let ok = true;
                    for (let a = 0; a < s[1] && ok; a++) for (let b = 0; b < s[0] && ok; b++) {
                        const x = occ[(nr + a) * cols + nc + b];
                        if (x !== -1 && x !== i) ok = false;
                    }
                    if (!ok) continue;
                    const q = ps.slice();
                    q[i] = { type: p.type, r: nr, c: nc };
                    out.push(enc(q));
                }
            }
            return out;
        }

        // Full reachable component from a solved board, then exact distance to
        // the nearest winning state for every member (multi-source BFS).
        function analyse(tpl, cap) {
            const start = enc(tpl);
            const seen = new Set([start]);
            let frontier = [start];
            while (frontier.length) {
                const next = [];
                for (const k of frontier) for (const n of neighbours(k)) {
                    if (seen.has(n)) continue;
                    seen.add(n);
                    next.push(n);
                    if (seen.size > cap) return null;
                }
                frontier = next;
            }
            const dist = new Map();
            let layer = [];
            for (const k of seen) if (isWin(k)) { dist.set(k, 0); layer.push(k); }
            let d = 0;
            while (layer.length) {
                const next = [];
                d++;
                for (const k of layer) for (const n of neighbours(k)) {
                    if (dist.has(n)) continue;
                    dist.set(n, d);
                    next.push(n);
                }
                layer = next;
            }
            // NB: spreading 100k+ values into Math.max overflows the stack.
            const byDist = new Map();
            let maxDist = 0;
            for (const [k, dv] of dist) {
                if (!byDist.has(dv)) byDist.set(dv, []);
                byDist.get(dv).push(k);
                if (dv > maxDist) maxDist = dv;
            }
            for (const a of byDist.values()) a.sort();
            return { states: seen, dist, byDist, maxDist };
        }

        // Random SOLVED board: goal parked in the exit, the rest of the space
        // packed with bars/singles, then `empties` singles removed to open it up.
        function randomTemplate(rnd, empties) {
            const g = base.slice();
            const mark = (p, i) => {
                const s = sizeOf(p.type);
                for (let a = 0; a < s.h; a++) for (let b = 0; b < s.w; b++) g[(p.r + a) * cols + p.c + b] = i;
            };
            for (const cell of [goalR * cols + goalC, goalR * cols + goalC + 1,
                                (goalR + 1) * cols + goalC, (goalR + 1) * cols + goalC + 1]) {
                if (g[cell] === -2) return null;                  // exit blocked by a wall
            }
            const ps = [{ type: 'goal', r: goalR, c: goalC }];
            mark(ps[0], 0);
            const cells = [];
            for (let i = 0; i < rows * cols; i++) cells.push(i);
            for (let i = cells.length - 1; i > 0; i--) {
                const j = Math.floor(rnd() * (i + 1));
                const t = cells[i]; cells[i] = cells[j]; cells[j] = t;
            }
            for (const cell of cells) {
                if (g[cell] !== -1) continue;
                const r = (cell / cols) | 0, c = cell % cols, opts = [];
                if (r + 1 < rows && g[cell + cols] === -1) opts.push('v', 'v');
                if (c + 1 < cols && g[cell + 1] === -1) opts.push('h', 'h');
                opts.push('s');
                const p = { type: opts[Math.floor(rnd() * opts.length)], r: r, c: c };
                ps.push(p);
                mark(p, ps.length - 1);
            }
            const singles = ps.map((p, i) => i).filter(i => ps[i].type === 's');
            if (singles.length < empties) return null;
            for (let i = singles.length - 1; i > 0; i--) {
                const j = Math.floor(rnd() * (i + 1));
                const t = singles[i]; singles[i] = singles[j]; singles[j] = t;
            }
            const drop = new Set(singles.slice(0, empties));
            return ps.filter((p, i) => !drop.has(i));
        }

        // Structural audit of a decoded level, independent of how it was built.
        function structural(pieces, empties) {
            const g = base.slice();
            const movable = pieces.filter(p => p.type !== 'w');
            const wallCells = pieces.filter(p => p.type === 'w').map(p => p.r * cols + p.c);
            for (const cell of walls) if (!wallCells.includes(cell)) return 'wall missing';
            if (wallCells.length !== walls.length) return 'wall count';
            for (let i = 0; i < movable.length; i++) {
                const p = movable[i], s = sizeOf(p.type);
                if (p.r < 0 || p.c < 0 || p.r + s.h > rows || p.c + s.w > cols) return 'oob';
                for (let a = 0; a < s.h; a++) for (let b = 0; b < s.w; b++) {
                    const cell = (p.r + a) * cols + p.c + b;
                    if (g[cell] !== -1) return g[cell] === -2 ? 'overlaps wall' : 'overlap';
                    g[cell] = i;
                }
            }
            let free = 0;
            for (let i = 0; i < rows * cols; i++) if (g[i] === -1) free++;
            if (free !== empties) return 'empties=' + free;
            if (movable.filter(p => p.type === 'goal').length !== 1) return 'goal count';
            return null;
        }

        return { analyse, randomTemplate, structural, neighbours, enc, dec, isWin, goalR, goalC };
    }
    return { make, goalR, goalC };
}

// ---------------------------------------------------------------------------
// Template search: random wall layouts + random solved boards, keeping the
// ones whose component is both enumerable and deep.
// ---------------------------------------------------------------------------
function findTemplates(tier) {
    const { rows, cols, walls: nWalls, empties, minPar, minStates } = tier;
    const eng = engine(rows, cols);
    const found = [];
    let attempts = 0, overCap = 0, tooShallow = 0;

    for (let seed = 1; seed <= tier.attempts && found.length < TEMPLATES_PER_TIER; seed++) {
        const rnd = mulberry32(seed * 2654435761 + rows * 977 + cols * 61 + nWalls * 7 + empties);
        // Walls go anywhere above the exit rows, so the exit bay stays reachable.
        const pool = [];
        for (let r = 0; r < rows - 2; r++) for (let c = 0; c < cols; c++) pool.push(r * cols + c);
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }
        const walls = pool.slice(0, nWalls).sort((a, b) => a - b);
        const board = eng.make(walls);
        const tpl = board.randomTemplate(rnd, empties);
        if (!tpl) continue;
        attempts++;
        const t0 = Date.now();
        const a = board.analyse(tpl, STATE_CAP);
        const ms = Date.now() - t0;
        if (!a) { overCap++; continue; }
        if (a.states.size < minStates || a.maxDist < minPar) { tooShallow++; continue; }
        found.push({ seed, walls, board, tpl, a });
        console.log(`    seed ${String(seed).padStart(3)}: states=${String(a.states.size).padStart(7)} ` +
                    `maxPar=${String(a.maxDist).padStart(3)} pieces=${tpl.length} walls=${nWalls} ${ms}ms  USE`);
    }
    console.log(`    (${attempts} boards analysed, ${overCap} over cap, ${tooShallow} too shallow)`);
    return found;
}

console.log('=== template search ===');
const tiers = [];
for (const tier of TIERS) {
    console.log(`  ${tier.cols}x${tier.rows}, ${tier.walls} walls, ${tier.empties} empty:`);
    const templates = findTemplates(tier);
    if (!templates.length) {
        console.log('    NO USABLE TEMPLATES — aborting');
        process.exit(1);
    }
    tiers.push({ tier, templates });
}

// ---------------------------------------------------------------------------
// Level table: par ramps within each tier; templates rotate so consecutive
// levels feel different. Each new tier restarts a little easier than the last
// one ended — the bigger board is difficulty enough on its own.
// ---------------------------------------------------------------------------
const encode = (pieces, rows, cols) =>
    rows + 'x' + cols + ':' + pieces.map(p => CH[p.type] + p.r + p.c).join('');
const decode = s => {
    const bar = s.indexOf('|');
    let body = s.slice(0, bar);
    const par = parseInt(s.slice(bar + 1), 10);
    let rows = 5, cols = 4;
    const colon = body.indexOf(':');
    if (colon > 0) {
        const dims = body.slice(0, colon).split('x');
        rows = +dims[0]; cols = +dims[1];
        body = body.slice(colon + 1);
    }
    const pieces = [];
    for (let i = 0; i + 2 < body.length + 1; i += 3) {
        pieces.push({ type: FROM_CH[body[i]], r: +body[i + 1], c: +body[i + 2] });
    }
    return { pieces, par, rows, cols };
};

const levels = [];
for (let ti = 0; ti < tiers.length; ti++) {
    const { tier, templates } = tiers[ti];
    const used = new Set();
    for (let i = 0; i < tier.count; i++) {
        const pick = templates[i % templates.length];
        const rnd = mulberry32((levels.length + 1) * 2654435761 >>> 0);
        const frac = tier.count > 1 ? i / (tier.count - 1) : 1;
        // ease-in ramp along the tier's own par curve, then clamped to the
        // deepest par this particular template can offer.
        let target = Math.round(tier.parFrom + (tier.parTo - tier.parFrom) * Math.pow(frac, 1.15));
        target = Math.max(3, Math.min(pick.a.maxDist, target));
        // nearest populated distance bucket with a state we haven't used yet
        let chosen = null, chosenPar = 0;
        for (let step = 0; step < 240 && !chosen; step++) {
            for (const d of (step === 0 ? [target] : [target - step, target + step])) {
                const bucket = pick.a.byDist.get(d);
                if (!bucket || !bucket.length || d < 1) continue;
                for (let tries = 0; tries < 12; tries++) {
                    const k = bucket[Math.floor(rnd() * bucket.length) % bucket.length];
                    if (used.has(k)) continue;
                    chosen = k; chosenPar = d; break;
                }
                if (chosen) break;
            }
        }
        if (!chosen) continue;
        used.add(chosen);
        const pieces = pick.board.dec(chosen)
            .concat(pick.walls.map(cell => ({ type: 'w', r: (cell / tier.cols) | 0, c: cell % tier.cols })));
        levels.push({
            lv: levels.length, tier: ti, rows: tier.rows, cols: tier.cols,
            par: chosenPar, pieces, key: chosen, pick
        });
    }
}

// ---------------------------------------------------------------------------
// Verify every emitted level, from its encoded string only.
// ---------------------------------------------------------------------------
console.log('\n=== verifying encode/decode round-trip + level validity ===');
let bad = 0;
const encoded = levels.map(o => {
    const enc = encode(o.pieces, o.rows, o.cols) + '|' + o.par;
    const dec = decode(enc);
    const problems = [];
    if (dec.rows !== o.rows || dec.cols !== o.cols) problems.push('DIMS MISMATCH');
    const board = o.pick.board;
    const movable = dec.pieces.filter(p => p.type !== 'w');
    if (board.enc(movable) !== o.key) problems.push('ROUND-TRIP MISMATCH');
    const st = board.structural(dec.pieces, o.pick.board === board ? TIERS[o.tier].empties : 0);
    if (st) problems.push('INVALID:' + st);
    if (board.isWin(board.enc(movable))) problems.push('STARTS SOLVED');
    if (o.par < 1) problems.push('PAR<1');
    // Par audit against the graph: a shortest move must drop the distance by
    // exactly one, and nothing may drop it by more.
    const nd = board.neighbours(o.key).map(k => o.pick.a.dist.get(k));
    const best = Math.min.apply(null, nd.filter(v => v !== undefined));
    if (best !== o.par - 1) problems.push('PAR NOT OPTIMAL (neighbour=' + best + ', par=' + o.par + ')');
    if (problems.length) { bad++; console.log(`  L${o.lv}: ${problems.join(', ')}`); }
    return enc;
});

const pars = levels.map(o => o.par);
console.log(`levels=${levels.length} bad=${bad}`);
for (let ti = 0; ti < tiers.length; ti++) {
    const seg = levels.filter(l => l.tier === ti);
    const p = seg.map(l => l.par);
    console.log(`  tier ${ti} (${seg[0].cols}x${seg[0].rows}, ${TIERS[ti].walls} walls): ` +
                `levels ${seg[0].lv + 1}-${seg[seg.length - 1].lv + 1}, ` +
                `par ${Math.min.apply(null, p)}..${Math.max.apply(null, p)}, ` +
                `avg ${(p.reduce((a, b) => a + b, 0) / p.length).toFixed(1)}`);
}
console.log(`par ramp: ${pars.slice(0, 8).join(',')} ... ${pars.slice(-6).join(',')}`);

const out = path.join(__dirname, 'slide_levels.json');
const totalBytes = encoded.join(',').length;
console.log(`\nembedded table size: ${(totalBytes / 1024).toFixed(1)} KB`);
fs.writeFileSync(out, JSON.stringify(encoded, null, 0));
console.log(bad ? 'FAILURES PRESENT' : 'ALL LEVELS VALID — written to ' + out);
