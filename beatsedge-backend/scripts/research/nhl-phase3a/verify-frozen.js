// Phase 3B / Phase 4 parity test run this first. Fails if the frozen config, tuned parameters, research code or evidence changed since the freeze.
//   node scripts/research/nhl-phase3a/verify-frozen.js
// The immutable evidence files named in frozen-manifest.json live in ./evidence/ (permanent, committed); nothing here reads tmp/.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const D = __dirname, sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const recorded = Object.fromEntries(fs.readFileSync(path.join(D, 'frozen-hash.txt'), 'utf8').trim().split('\n').map(l => { const m = l.match(/^(\S+) sha256 (\S+)$/); return [m[1], m[2]]; }));
const EVIDENCE = path.join(D, 'evidence');
let ok = true; const chk = (name, got, want) => { const g = got === want; ok = ok && g; console.log((g ? 'OK   ' : 'FAIL ') + name + ' ' + got.slice(0, 16) + (g ? '' : ' != ' + want.slice(0, 16))); };
chk('frozen-config.json', sha(fs.readFileSync(path.join(D, 'frozen-config.json'))), recorded['frozen-config.json']);
chk('frozen-manifest.json', sha(fs.readFileSync(path.join(D, 'frozen-manifest.json'))), recorded['frozen-manifest.json']);
for (const m of JSON.parse(fs.readFileSync(path.join(D, 'frozen-manifest.json'), 'utf8'))) {
  const p = ['tuned.json', 'validation.json', 'leakcheck.json', 'prodcheck.json'].includes(m.file) ? path.join(EVIDENCE, m.file) : path.join(D, m.file);
  chk(m.file, sha(fs.readFileSync(p)), m.sha256);
}
console.log(ok ? 'FROZEN SPEC INTACT' : 'FROZEN SPEC CHANGED -- DO NOT OPEN THE HOLDOUT'); process.exit(ok ? 0 : 3);
