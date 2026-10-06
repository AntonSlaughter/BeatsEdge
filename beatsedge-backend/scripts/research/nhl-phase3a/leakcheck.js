// LEAKAGE CHECK (seasons 2024-2025 only). Two independent tests:
//  A) INDEPENDENT RE-DERIVATION: for a seeded random sample of target games, recompute every feature from scratch using ONLY rows dated
//     strictly before the target game's date (plain filters, no shared ctx code) and require equality with the harness values.
//  B) POISON TEST: overwrite every outcome / team total dated >= D with 999, rebuild everything, and require that the harness's
//     baseline lambda, features and priors for games ON date D are byte-identical to the unpoisoned run.
const R = require('./run'); const L = require('./lib'); const { mean } = L;
let seed = 20261005; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const eq = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-9);
const FAMS = { sog: 'shots_on_goal', saves: 'saves', goal: 'goals', assist: 'assists', point: 'points' };
(async () => {
  const raw = await R.loadRaw(); const F = R.prepare(raw);
  const rawKey = { sog: 'sog', saves: 'gl', goal: 'g', assist: 'a', point: 'p' };
  // game-level lookup for the independent derivation
  const byGid = new Map(); for (const r of raw.tg) { if (!byGid.has(r.gid)) byGid.set(r.gid, []); byGid.get(r.gid).push(r); }
  const usable = raw.tg.filter(r => (byGid.get(r.gid) || []).length === 2 && r.sf != null);
  const saOf = (r) => byGid.get(r.gid).find(x => x.team !== r.team).sf;
  let checked = 0, bad = 0; const detail = {};
  // ---------- A ----------
  for (const fk of Object.keys(FAMS)) {
    const fm = F.fam[fk]; const rows = R.collect(F, fk, [2024, 2025]); const sample = []; for (let i = 0; i < 700 && rows.length; i++) sample.push(rows[Math.floor(rnd() * rows.length)]);
    const all = raw[rawKey[fk]]; let nbad = 0;
    for (const r of sample) {
      const row = r.e.row, D = row.d;
      const hist = all.filter(x => x.pid === row.pid && x.d < D).sort((a, b) => a.d < b.d ? -1 : 1).map(x => x.v);
      let ok = hist.length === r.n && eq(L.shrinkageFive(hist), r.base);
      // league prior (strictly earlier dates)
      const pr = all.filter(x => x.d < D && (fm.side === 'goalie' || (x.pos === 'D') === (row.pos === 'D')));
      const mu = pr.length >= (fm.side === 'goalie' ? 200 : 2000) ? mean(pr.map(x => x.v)) : null; ok = ok && eq(mu, r.mu);
      // team context
      const lg = usable.filter(x => process.env.LEAK_NEG ? x.d <= D : x.d < D); /* LEAK_NEG=1 = negative control: lets same-day data in */ const league = lg.length >= 200 ? mean(lg.map(x => x.sf)) : null;
      const tgOf = (team) => usable.filter(x => x.team === team && x.d < D).sort((a, b) => a.d < b.d ? -1 : 1);
      const og = tgOf(row.opp); const allowed = (og.length >= 10 && league) ? mean(og.slice(-15).map(saOf)) / league : null; const offense = (og.length >= 10 && league) ? mean(og.slice(-15).map(x => x.sf)) / league : null;
      ok = ok && eq(allowed, r.f.allowed) && eq(offense, r.f.offense);
      if (fk === 'saves') { const mg = tgOf(row.team); const tsv = mg.length >= 10 ? mean(mg.slice(-10).filter(x => x.sv != null).map(x => x.sv)) : null; ok = ok && eq(tsv, r.f.teamSv); }
      checked++; if (!ok) { bad++; nbad++; if (nbad <= 3) console.log('MISMATCH', fk, row.pid, D); }
    }
    detail[fk] = { sampled: sample.length, mismatches: nbad };
  }
  console.log('A) independent re-derivation:', JSON.stringify(detail), 'total checked', checked, 'mismatches', bad);
  // ---------- B ----------
  const dates = [...new Set(raw.tg.filter(r => r.d >= '2024-12-01').map(r => r.d))].sort(); const picks = []; for (let i = 0; i < 8; i++) picks.push(dates[Math.floor(rnd() * dates.length)]);
  let pBad = 0, pChecked = 0;
  for (const D of picks) {
    const poison = (rows, keys) => rows.map(r => r.d >= D ? { ...r, ...Object.fromEntries(keys.map(k => [k, 999])) } : r);
    const raw2 = { sog: poison(raw.sog, ['v']), g: poison(raw.g, ['v']), a: poison(raw.a, ['v']), p: poison(raw.p, ['v']), gl: poison(raw.gl, ['v']), tg: poison(raw.tg, ['sf', 'sv']) };
    const F2 = R.prepare(raw2);
    for (const fk of Object.keys(FAMS)) {
      const a = R.collect(F, fk, [2024, 2025]).filter(r => r.d === D), b = R.collect(F2, fk, [2024, 2025]).filter(r => r.d === D);
      const mb = new Map(b.map(r => [r.e.row.pid, r]));
      for (const r of a) { const s = mb.get(r.e.row.pid); pChecked++; if (!s || !eq(r.base, s.base) || !eq(r.mu, s.mu) || !eq(r.f.allowed, s.f.allowed) || !eq(r.f.offense, s.f.offense) || !eq(r.f.teamSv, s.f.teamSv)) { pBad++; if (pBad <= 3) console.log('POISON MISMATCH', fk, D, r.e.row.pid); } }
    }
  }
  console.log('B) poison test on dates', picks.join(','), 'rows compared', pChecked, 'mismatches', pBad);
  const ok = bad === 0 && pBad === 0 && checked > 0 && pChecked > 0;
  require('fs').writeFileSync(require('path').join(__dirname, '..', '..', '..', 'tmp', 'nhl-phase3a', 'leakcheck.json'), JSON.stringify({ A_independent_rederivation: { detail, checked, mismatches: bad }, B_poison: { dates: picks, compared: pChecked, mismatches: pBad }, PASS: ok, guard: require('./guard').stats() }, null, 2));
  console.log(ok ? 'LEAKAGE CHECK: PASS' : 'LEAKAGE CHECK: FAIL'); process.exit(ok ? 0 : 2);
})().catch(e => { console.error('FATAL', e.message, e.stack && e.stack.split('\n').slice(0, 3).join(' | ')); process.exit(1); });
