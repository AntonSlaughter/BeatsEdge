'use strict';
// Resource optimization (2026-11-05, docs/RESOURCE_OPTIMIZATION_2026-11-05.md). Covers every piece of the patch:
//   1  provider credit budget            4  startup-job gate                  7  real server: cache / 304 / compression / coalescing / stale / cooldown / metrics
//   2  response cache TTL + stale pool   5  archive latest-row cache          8  real server: credit budget (503, stale) and a rejected key is never masked
//   3  compression + encoding negotiation 6  Turso quota-block breaker         9  real server: Turso BLOCKED at startup -> degraded, not a crash loop; other failures still fatal
// Nothing here touches the network, a real Turso database, a real provider or production data: the provider is a local stub (scripts/lib/stubParlayFetch.js, which refuses every
// other host), Turso is the local Hrana double, the key is a made-up string, and all files live in one temp folder this script creates and removes itself.
// Run: node scripts/test-resource-optimization.js
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const { startHranaDouble } = require('./lib/hranaDouble');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-opt-'));
const KEY = 'TESTKEY-RESOURCE-OPT-9f3a';
let pass = 0, fail = 0; const ok = (c, m, d) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m, d === undefined ? '' : '-- ' + (typeof d === 'string' ? d : JSON.stringify(d))); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const children = new Set();

function worker(code, env = {}) {   // run a snippet in a fresh process, return the JSON it prints after '@@'
  const dataDir = path.join(TMP, 'w-' + Math.random().toString(36).slice(2)); fs.mkdirSync(dataDir, { recursive: true });
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', code], { cwd: ROOT, env: Object.assign({}, process.env, { BEATSEDGE_DATA_DIR: dataDir }, env), encoding: 'utf8', timeout: 60000 });
  const line = String(r.stdout || '').split('\n').reverse().find(l => l.startsWith('@@'));
  return line ? JSON.parse(line.slice(2)) : { fatal: String(r.stderr || r.stdout || 'no output').slice(-600) };
}

function request(port, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 20000 }, (res) => { const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); });
    req.on('error', (e) => resolve({ error: e.code || e.message })); req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    if (body) req.write(body); req.end();
  });
}
async function boot(name, env) {
  const dir = path.join(TMP, name); fs.mkdirSync(dir, { recursive: true });
  const port = 41000 + Math.floor(Math.random() * 2500);
  const ctl = path.join(dir, 'control.json'), log = path.join(dir, 'calls.log'); fs.writeFileSync(ctl, '{}'); fs.writeFileSync(log, '');
  const e = Object.assign({}, process.env, { PORT: String(port), SKIP_STARTUP_JOBS: '1', BEATSEDGE_DATA_DIR: path.join(dir, 'data'), NODE_ENV: 'production', STUB_CONTROL: ctl, STUB_LOG: log,
    NODE_OPTIONS: '--require=' + path.join(__dirname, 'lib', 'stubParlayFetch.js').replace(/\\/g, '/') }, env);
  fs.mkdirSync(e.BEATSEDGE_DATA_DIR, { recursive: true });
  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: ROOT, env: e }); children.add(child);
  const lines = []; const push = (d) => String(d).split('\n').forEach(l => { if (l.trim()) lines.push(l); });
  child.stdout.on('data', push); child.stderr.on('data', push);
  let listening = false;
  for (let i = 0; i < 160 && child.exitCode === null; i++) { if (lines.some(l => /listening on port/.test(l))) { listening = true; break; } await sleep(250); }
  return {
    child, port, lines, listening, ctl: (o) => fs.writeFileSync(ctl, JSON.stringify(o)),
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length,
    get: (p, headers) => request(port, p, { headers }),
    stop: async () => { if (child.exitCode === null) { child.kill(); for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(100); } children.delete(child); },
  };
}
const P = (k) => '/api/parlayapi/v1/sports/basketball_nba/props?apiKey=' + KEY + '&markets=' + k;
const json = (r) => JSON.parse(r.body.toString('utf8'));

(async () => {
  try {
    // ── 1. provider credit budget ─────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n=== 1. provider credit budget');
    {
      const r = worker(`
        process.env.PARLAY_HOURLY_CREDIT_BUDGET='10'; process.env.PARLAY_DAILY_CREDIT_BUDGET='25'; process.env.PARLAY_CREDIT_RESERVE='1000'; process.env.PARLAY_ASSUMED_CALL_COST='3';
        const b=require('./lib/providerBudget'); const out={}; const T=1_000_000_000_000;
        out.first=b.check('p',T);
        b.record('p',{status:200,headers:{'x-credits-cost':'4','x-credits-remaining':'90000'}},T);       // measured by header
        b.record('p',{status:200,headers:{}},T+1000);                                                       // assumed (3)
        b.record('p',{status:200,headers:{'x-credits-cost':'3'}},T+2000);                                   // 4+3+3 = 10 = hourly cap
        out.afterHour=b.check('p',T+3000);
        out.sPre=b.stats('p',T+3000);
        out.later=b.check('p',T+3_600_000+5000);                                                            // an hour later the spends have aged out
        for(let i=0;i<3;i++) b.record('p',{status:200,headers:{'x-credits-cost':'3'}},T+3_700_000+i*1000); // 9 credits in hour 2
        b.record('p',{status:200,headers:{'x-credits-cost':'3'}},T+7_200_000); b.record('p',{status:200,headers:{'x-credits-cost':'3'}},T+7_300_000);
        b.record('p',{status:200,headers:{'x-credits-cost':'3'}},T+10_900_000);
        out.dailyDenied=b.check('p',T+11_000_000);
        b.record('q',{status:200,headers:{'x-credits-cost':'1','x-credits-remaining':'500'}},T);
        out.reserve=b.check('q',T+60_000); out.reserveAfterHour=b.check('q',T+3_700_000);
        out.keyFree=JSON.stringify(b.stats('p',T)).toLowerCase().includes('key');
        console.log('@@'+JSON.stringify(out));`);
      ok(r.first && r.first.allowed === true, 'budget: an unspent provider is allowed');
      ok(r.afterHour && r.afterHour.allowed === false && r.afterHour.reason === 'hourly' && r.afterHour.retryAfterSeconds > 0, 'budget: 10 credits spent in the hour (4 by header + 3 assumed + 3 by header) stops further calls with reason hourly and a Retry-After', r.afterHour);
      ok(r.sPre && r.sPre.chargedByProviderHeader === 2 && r.sPre.chargedByAssumption === 1, 'budget: header-measured and assumed charges are counted separately', r.sPre);
      ok(r.later && r.later.allowed === true, 'budget: the hourly window rolls (an hour later the spend has aged out)', r.later);
      ok(r.dailyDenied && r.dailyDenied.allowed === false && r.dailyDenied.reason === 'daily', 'budget: the 24 h cap stops calls even when the hour is clear', r.dailyDenied);
      ok(r.reserve && r.reserve.allowed === false && r.reserve.reason === 'reserve', 'budget: a provider-reported balance below the reserve stops calls', r.reserve);
      ok(r.reserveAfterHour && r.reserveAfterHour.allowed === true, 'budget: after an hour ONE call is allowed through to re-read the real balance', r.reserveAfterHour);
      ok(r.keyFree === false, 'budget: stats() carries no key-shaped field');
    }

    // ── 2. response cache: TTL + stale pool ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n=== 2. response cache TTL and stale pool');
    {
      const d = worker(`const c=require('./lib/parlayCache'); console.log('@@'+JSON.stringify({ttl:c.DEFAULT_TTL_MS, off:c.OFF_PEAK_TTL_MS, s:c.stats()}));`, { PARLAY_CACHE_TTL_MS: '', PARLAY_OFF_PEAK_TTL_MS: '', PARLAY_STALE_MAX_MS: '' });
      ok(d.ttl === 600000 && d.off === 1800000, 'cache: default TTL is 10 minutes and off-peak 30 minutes', { ttl: d.ttl, off: d.off });
      ok(d.s && d.s.staleMaxAgeMs === 0 && d.s.staleEntries === 0, 'cache: stale-on-error is OFF by default (the page cannot yet show a data age, so a stale board would look current)', d.s);
      const off = worker(`const c=require('./lib/parlayCache'); const k=c.cacheKeyFor('v1/x',{}); c.set(k,{status:200,contentType:'application/json',body:'[1]',headers:{}}); c.peek(k).expiresAt=Date.now()-1; c.get(k); console.log('@@'+JSON.stringify({stale:c.getStale(k), s:c.stats()}));`, { PARLAY_STALE_MAX_MS: '' });
      ok(off.stale === null && off.s.staleEntries === 0 && off.s.staleBytes === 0, 'cache: with it off, an expired entry is released and never offered as stale (identical to the previous behaviour)', off);
      const r = worker(`
        process.env.PARLAY_CACHE_TTL_MS='1000'; process.env.PARLAY_OFF_PEAK_TTL_MS='1000'; process.env.PARLAY_STALE_MAX_MS='3000'; process.env.PARLAY_CACHE_MAX_MB='1';
        const zlib=require('zlib'); const c=require('./lib/parlayCache'); const out={}; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
        (async()=>{
          const body=JSON.stringify(Array.from({length:300},(_,i)=>({p:'Player '+i,line:10.5})));
          const k=c.cacheKeyFor('v1/x',{apiKey:'k',a:'1'});
          c.set(k,{status:200,contentType:'application/json',body,headers:{'x-result-has-more':'false'}});
          out.fresh=!!c.get(k); out.staleBeforeExpiry=c.getStale(k);
          out.etag=c.etagFor(c.peek(k)); out.etag2=c.etagFor(c.peek(k));
          const e=c.peek(k); const before=c.stats().cacheBytes;
          const br=await c.encodedBody(k,e,'br'); const gz=await c.encodedBody(k,e,'gzip');
          out.brOk=zlib.brotliDecompressSync(br).toString()===body; out.gzOk=zlib.gunzipSync(gz).toString()===body;
          out.encodedCounted=c.stats().cacheBytes>before; out.sameBuffer=(await c.encodedBody(k,e,'br'))===br;
          await sleep(1200);
          out.getAfterExpiry=c.get(k); const st=c.getStale(k);
          out.stale=!!st && st.entry.body===body && st.ageSeconds>=1; out.staleHeaders=st&&st.entry.headers;
          out.sAfter=c.stats();
          c.set(k,{status:200,contentType:'application/json',body:'[1]',headers:{}});   // a fresh body replaces the stale copy
          out.staleGoneAfterSet=c.stats().staleEntries===0 && c.getStale(k)===null && c.get(k).body==='[1]';
          // expiry of a non-2xx is never kept as a stale answer
          const k2=c.cacheKeyFor('v1/err',{}); c.set(k2,{status:503,contentType:'application/json',body:'{}',headers:{}}); await sleep(1200); c.get(k2); out.errNotStale=c.getStale(k2)===null;
          // window end
          const k3=c.cacheKeyFor('v1/w',{}); c.set(k3,{status:200,contentType:'application/json',body:'[3]',headers:{}}); await sleep(1200); c.get(k3); await sleep(2200); out.windowEnded=c.getStale(k3)===null;
          // shared budget: fresh + stale together stay inside MAX_CACHE_BYTES (1 MB here)
          const big=(n)=>'['+'"'+'x'.repeat(n)+'"]';
          for(let i=0;i<4;i++){ c.set('s'+i,{status:200,contentType:'application/json',body:big(300000),headers:{}}); }
          await sleep(1200); for(let i=0;i<4;i++) c.get('s'+i);   // all four expire into the stale pool
          c.set('fresh',{status:200,contentType:'application/json',body:big(400000),headers:{}});
          const s=c.stats(); out.joint=s.cacheBytes+s.staleBytes<=s.maxCacheBytes; out.jointDetail={cache:s.cacheBytes,stale:s.staleBytes,max:s.maxCacheBytes};
          console.log('@@'+JSON.stringify(out)); process.exit(0);
        })();`, { PARLAY_CACHE_TTL_MS: '', PARLAY_OFF_PEAK_TTL_MS: '', PARLAY_STALE_MAX_MS: '' });
      ok(r.fresh === true && r.staleBeforeExpiry === null, 'cache: a fresh entry is served by get() and is NOT offered as stale', r);
      ok(r.etag && r.etag === r.etag2 && r.etag.length >= 16, 'cache: the validator is computed once and is stable', r.etag);
      ok(r.brOk && r.gzOk, 'cache: brotli and gzip bodies decompress to exactly the cached body');
      ok(r.encodedCounted === true && r.sameBuffer === true, 'cache: the encoded body is memoized per entry (same Buffer on the second request) and counted against the byte budget');
      ok(r.getAfterExpiry === null, 'cache: get() never returns an expired entry (unchanged contract)');
      ok(r.stale === true && r.staleHeaders && r.staleHeaders['x-result-has-more'] === 'false', 'cache: the expired body is still available to getStale() with its age and its pagination headers', r);
      ok(r.staleGoneAfterSet === true, 'cache: a fresh body for the key replaces the stale copy');
      ok(r.errNotStale === true, 'cache: an expired non-2xx response is never kept as a stale answer');
      ok(r.windowEnded === true, 'cache: a stale body is dropped once the stale window has passed');
      ok(r.joint === true, 'cache: fresh + stale bytes together stay inside the byte budget', r.jointDetail);
    }

    // ── 3. compression and encoding negotiation ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n=== 3. compression');
    {
      const r = worker(`
        const express=require('express'), http=require('http'), zlib=require('zlib'); const enc=require('./lib/httpEncoding');
        const out={}; const req=(h)=>({headers:h});
        out.neg={ none:enc.acceptedEncoding(req({})), br:enc.acceptedEncoding(req({'accept-encoding':'gzip, deflate, br'})), gz:enc.acceptedEncoding(req({'accept-encoding':'gzip, deflate'})),
          brZero:enc.acceptedEncoding(req({'accept-encoding':'br;q=0, gzip'})), star:enc.acceptedEncoding(req({'accept-encoding':'*'})), identityOnly:enc.acceptedEncoding(req({'accept-encoding':'identity'})), gzZero:enc.acceptedEncoding(req({'accept-encoding':'gzip;q=0'})) };
        const big=JSON.stringify(Array.from({length:500},(_,i)=>({player:'Player '+i,line:10.5,book:'fanduel'})));
        const app=express(); app.use(enc.middleware()); app.get('/big',(q,s)=>s.json(JSON.parse(big))); app.get('/small',(q,s)=>s.json({a:1})); app.get('/text',(q,s)=>s.type('text/plain').send('x'.repeat(5000)));
        app.get('/bin',(q,s)=>s.type('application/octet-stream').send(Buffer.alloc(5000))); app.get('/pre',(q,s)=>{ s.set('Content-Encoding','gzip'); s.type('application/json').send(zlib.gzipSync(big)); });
        const srv=app.listen(0,async()=>{ const port=srv.address().port;
          const get=(p,h)=>new Promise(res=>http.get({host:'127.0.0.1',port,path:p,headers:h},r=>{const c=[];r.on('data',d=>c.push(d));r.on('end',()=>res({status:r.statusCode,headers:r.headers,body:Buffer.concat(c)}));}));
          const a=await get('/big',{'accept-encoding':'br'}); out.br={ce:a.headers['content-encoding'],vary:a.headers.vary,ok:zlib.brotliDecompressSync(a.body).toString()===JSON.stringify(JSON.parse(big)),smaller:a.body.length<Buffer.byteLength(big)/3};
          const g=await get('/big',{'accept-encoding':'gzip'}); out.gz={ce:g.headers['content-encoding'],ok:zlib.gunzipSync(g.body).toString()===JSON.stringify(JSON.parse(big)),cl:g.headers['content-length']==String(g.body.length)};
          const i=await get('/big',{}); out.identity={ce:i.headers['content-encoding']||null,vary:i.headers.vary,len:i.body.length};
          const s=await get('/small',{'accept-encoding':'gzip'}); out.small={ce:s.headers['content-encoding']||null};
          const t=await get('/text',{'accept-encoding':'gzip'}); out.text={ce:t.headers['content-encoding']};
          const b=await get('/bin',{'accept-encoding':'gzip'}); out.bin={ce:b.headers['content-encoding']||null};
          const p=await get('/pre',{'accept-encoding':'br'}); out.pre={ce:p.headers['content-encoding'],ok:zlib.gunzipSync(p.body).toString()===big};
          const e1=a.headers.etag; out.etags={e1:!!e1, differsByEncoding:e1!==g.headers.etag};
          out.stats=enc.stats(); srv.close(); console.log('@@'+JSON.stringify(out)); process.exit(0); });`);
      ok(r.neg && r.neg.none === null && r.neg.br === 'br' && r.neg.gz === 'gzip' && r.neg.brZero === 'gzip' && r.neg.star === 'br' && r.neg.identityOnly === null && r.neg.gzZero === null, 'encoding: Accept-Encoding parsing (br preferred, q=0 refuses, * accepts, identity only = none)', r.neg);
      ok(r.br && r.br.ce === 'br' && r.br.ok && r.br.smaller && /accept-encoding/i.test(r.br.vary || ''), 'compression: a large JSON response is sent as brotli, decompresses to the same JSON, is far smaller, and carries Vary: Accept-Encoding', r.br);
      ok(r.gz && r.gz.ce === 'gzip' && r.gz.ok && r.gz.cl, 'compression: gzip works and Content-Length matches the compressed body', r.gz);
      ok(r.identity && r.identity.ce === null && /accept-encoding/i.test(r.identity.vary || '') && r.identity.len > 1000, 'compression: a client that accepts no encoding gets the plain body', r.identity);
      ok(r.small && r.small.ce === null, 'compression: a response under 1 KB is not compressed');
      ok(r.text && r.text.ce === 'gzip' && r.bin && r.bin.ce === null, 'compression: text types are compressed, binary types are not', { text: r.text, bin: r.bin });
      ok(r.pre && r.pre.ce === 'gzip' && r.pre.ok, 'compression: a response that already carries a Content-Encoding is left exactly as it is', r.pre);
      ok(r.etags && r.etags.differsByEncoding, 'compression: the validator differs per encoding (a br copy is never confused with a gzip copy)', r.etags);
    }

    // ── 4. startup job gate ───────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n=== 4. startup job gate');
    {
      const r = worker(`
        const g=require('./lib/startupJobs'); const NOW=Date.parse('2026-11-05T12:00:00Z'); const out={};
        const q=(ranAt)=>async(sql,p)=>{ out.lastSql=sql; out.lastParam=p; return ranAt===undefined?undefined:{last:ranAt}; };
        (async()=>{
          out.never=await g.decide('nba',{now:NOW,queryOne:q(null)});
          out.recent=await g.decide('mlb',{now:NOW,queryOne:q('2026-11-05 06:05:11')});
          out.old=await g.decide('nhl',{now:NOW,queryOne:q('2026-11-04 06:05:11')});
          out.broken=await g.decide('nfl',{now:NOW,queryOne:async()=>{throw new Error('BLOCKED: SQL read operations are forbidden');}});
          out.like={nba:g.LIKE.nba,mlb:g.LIKE.mlb,nhl:g.LIKE.nhl,nfl:g.LIKE.nfl};
          process.env.STARTUP_JOB_MIN_AGE_HOURS='0'; out.alwaysRun=await g.decide('mlb',{now:NOW,queryOne:q('2026-11-05 11:59:00')});
          process.env.STARTUP_JOB_MIN_AGE_HOURS='1'; out.custom=await g.decide('mlb',{now:NOW,queryOne:q('2026-11-05 11:30:00')});   // 0.5 h ago, threshold 1 h
          out.customOld=await g.decide('mlb',{now:NOW,queryOne:q('2026-11-05 10:30:00')});   // 1.5 h ago, threshold 1 h
          out.parse=[g.parseRanAt('2026-11-05 06:05:11'),g.parseRanAt('2026-11-05T06:05:11Z'),g.parseRanAt(null),g.parseRanAt('garbage')];
          out.decisions=g.decisions().length;
          console.log('@@'+JSON.stringify(out));
        })();`);
      ok(r.never && r.never.run === true, 'gate: a job with no recorded run is run (a fresh deploy / empty database still catches up)', r.never);
      ok(r.recent && r.recent.run === false && /cron/.test(r.recent.reason), 'gate: a job that completed 6 h ago is skipped at boot', r.recent);
      ok(r.old && r.old.run === true, 'gate: a job last completed 30 h ago is run', r.old);
      ok(r.broken && r.broken.run === false && r.broken.error === true, 'gate: if the run history cannot be read (BLOCKED, unreachable) the job is skipped, not run blind', r.broken);
      ok(r.alwaysRun && r.alwaysRun.run === true, 'gate: STARTUP_JOB_MIN_AGE_HOURS=0 restores the previous always-run behaviour', r.alwaysRun);
      ok(r.custom && r.custom.run === false && /1 h/.test(r.custom.reason) && r.customOld && r.customOld.run === true, 'gate: the age threshold is configurable (0.5 h ago skipped, 1.5 h ago run, at a 1 h threshold)', { custom: r.custom, customOld: r.customOld });
      ok(r.like && r.like.nba === 'Date:%' && r.like.mlb === 'MLB:%' && r.like.nhl === 'NHL:%' && r.like.nfl === 'NFL:%', 'gate: it keys on the notes prefixes the nightly jobs really write', r.like);
      ok(Array.isArray(r.parse) && r.parse[0] === Date.parse('2026-11-05T06:05:11Z') && r.parse[1] === r.parse[0] && r.parse[2] === null && r.parse[3] === null, 'gate: ran_at (SQLite datetime, UTC) parses correctly', r.parse);
      const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
      ok(['nba', 'mlb', 'nhl', 'nfl'].every(j => new RegExp("gate\\('" + j + "'").test(src)) && /SKIP_STARTUP_JOBS/.test(src), 'gate: server.js gates all four boot jobs and still honours SKIP_STARTUP_JOBS');
      ok(/recordCompleted\('nfl'/.test(src), 'gate: the NFL pipeline records its own completion (it writes no ingest_log row itself)');
    }

    // ── 5. archive latest-row cache ───────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n=== 5. archive latest-row cache');
    {
      const code = (envJs, body) => `
        ${envJs}
        const path=require('path'); const store=require('./lib/snapshotStore'); const f=require('./lib/marketArchive/providerLineArchiveFactory');
        const mk=(n,o)=>Array.from({length:n},(_,i)=>Object.assign({event_id:'evt'+(i%3),player:'P'+i,player_id:String(i),market_key:'player_points',market:'Points',period:'game',bookmaker:'fanduel',projection_type:null,odds_type:'standard',side:'over',line:10.5,over_price:-110,under_price:-110,last_update:'2026-11-05T12:00:00Z',home_team:'A',away_team:'B',commence_time:'x',game_status:'scheduled'},o||{}));
        const arch=f.createProviderLineArchive({sport:'nba',propsPathRegex:/basketball_nba\\/props/}); const PATH='v1/sports/basketball_nba/props';
        let selects=0; const q0=store.query; store.query=async(sql,p)=>{ if(/ROW_NUMBER/.test(sql)) selects++; return q0(sql,p); };
        const rows=async()=> (await q0('SELECT COUNT(*) c FROM nba_provider_line_archive'))[0].c; const out={};
        const run=async(b)=>{ const r=await arch.archiveFromRawParlayResponse(PATH,JSON.stringify(b)); return {archived:r.archived,unchanged:r.unchanged}; };
        (async()=>{ ${body}; console.log('@@'+JSON.stringify(out)); process.exit(0); })().catch(e=>{console.log('@@'+JSON.stringify({fatal:String(e&&e.stack||e)})); process.exit(0);});`;
      const base = `const b1=mk(30); out.p1=await run(b1); out.sel1=selects; out.p2=await run(b1); out.sel2=selects; out.p3=await run(b1); out.sel3=selects; out.rows=await rows();
        const b2=mk(30); b2[4].over_price=-125; b2[7].line=11.5; out.p4=await run(b2); out.sel4=selects; out.rows4=await rows();
        const b3=mk(30,{last_update:'2026-11-05T12:05:00Z'}); b3[4].over_price=-125; b3[7].line=11.5; out.p5=await run(b3); out.rows5=await rows(); out.stats=f.latestCacheStats()[0];`;
      const on = worker(code('', base), {});
      ok(!on.fatal, 'archive: worker ran', on.fatal);
      ok(on.p1 && on.p1.archived === 30 && on.sel1 === 1, 'archive: first pass writes every new row and reads the database ONCE for all 3 events', { p1: on.p1, sel1: on.sel1 });
      ok(on.p2 && on.p2.archived === 0 && on.p2.unchanged === 30 && on.sel2 === 1 && on.p3.archived === 0 && on.sel3 === 1, 'archive: identical passes write nothing and issue NO further database lookups (previously one scan per pass)', { p2: on.p2, p3: on.p3, sel: [on.sel2, on.sel3] });
      ok(on.p4 && on.p4.archived === 2 && on.sel4 === 1 && on.rows4 === 32, 'archive: a real change (price, line) is written exactly once, still without a lookup', { p4: on.p4, rows4: on.rows4 });
      ok(on.p5 && on.p5.archived === 30 && on.rows5 === 62, 'archive: a changed provider last_update is still a change (default unchanged: the stored rows keep the provider timestamp)', { p5: on.p5, rows5: on.rows5 });
      ok(on.stats && on.stats.enabled === true && on.stats.dbLookups === 1 && on.stats.eventsFromMemory >= 8, 'archive: cache statistics report the lookup avoided', on.stats);

      const off = worker(code('process.env.ARCHIVE_LATEST_CACHE_MAX="0";', base), {});
      ok(off.p1 && off.p1.archived === 30 && off.p2.archived === 0 && off.sel2 === 2 && off.sel3 === 3, 'archive: ARCHIVE_LATEST_CACHE_MAX=0 restores one lookup per pass with identical results', { off: [off.p1, off.p2, off.sel2, off.sel3] });
      ok(off.rows === on.rows && off.rows4 === on.rows4 && off.rows5 === on.rows5 && JSON.stringify(off.p4) === JSON.stringify(on.p4) && JSON.stringify(off.p5) === JSON.stringify(on.p5), 'archive: cache on and cache off store the same number of rows and report the same written / unchanged counts on every pass', { on: [on.rows, on.rows4, on.rows5], off: [off.rows, off.rows4, off.rows5] });

      const lu = worker(code('process.env.ARCHIVE_LAST_UPDATE_IS_CHANGE="0";', base), {});
      ok(lu.p4 && lu.p4.archived === 2 && lu.p5 && lu.p5.archived === 0 && lu.rows5 === 32, 'archive: ARCHIVE_LAST_UPDATE_IS_CHANGE=0 skips rows whose ONLY difference is the provider timestamp, while real price / line changes are still written (opt-in; default keeps the timestamp rows)', { p4: lu.p4, p5: lu.p5, rows5: lu.rows5 });

      const fail = worker(code('', `const b1=mk(12); const w0=store.batchWrite; let boom=true; store.batchWrite=async(s,o)=>{ if(boom){ boom=false; const e=new Error('write refused'); e.rowsCommitted=0; throw e; } return w0(s,o); };
        try { await run(b1); out.threw=false; } catch(e){ out.threw=true; }
        out.afterFailRows=await rows(); const s0=selects; out.retry=await run(b1); out.reread=selects-s0; out.finalRows=await rows(); out.again=await run(b1); out.noMore=selects-s0;`), {});
      ok(fail.threw === true && fail.afterFailRows === 0 && fail.retry && fail.retry.archived === 12 && fail.reread === 1 && fail.finalRows === 12 && fail.again.archived === 0 && fail.noMore === 1, 'archive: a failed write drops the cached events; the next pass re-reads the database, writes the rows once, and then runs from memory', fail);

      const small = worker(code('process.env.ARCHIVE_LATEST_CACHE_MAX="20";', `const A=mk(30); const B=mk(10,{event_id:'evtB'}); B.forEach((r,i)=>{r.player='B'+i;});
        out.pA=await run(A); out.afterA=f.latestCacheStats()[0]; out.pB=await run(B); out.afterB=f.latestCacheStats()[0];
        const s0=selects; out.pA2=await run(A); out.reloads=selects-s0; out.rows=await rows(); out.final=f.latestCacheStats()[0];`), {});
      ok(!small.fatal && small.afterA.cachedIdentities === 30, 'archive: a single pass may exceed the bound (its own events are never evicted mid-pass)', small.fatal || small.afterA);
      ok(small.afterB.cachedIdentities <= 20 && small.afterB.evictedEvents >= 2 && small.afterB.cachedEvents === 2, 'archive: the cache is bounded - whole events are evicted, oldest first, when another board arrives', small.afterB);
      ok(small.pA2.archived === 0 && small.reloads === 1 && small.rows === 40, 'archive: an evicted event costs one re-read and NEVER a duplicate row', { pA2: small.pA2, reloads: small.reloads, rows: small.rows });

      const ttl = worker(code('process.env.ARCHIVE_LATEST_CACHE_TTL_MS="1500";', `const b=mk(9); await run(b); const s0=selects; await run(b); out.within=selects-s0; await new Promise(r=>setTimeout(r,1800)); const r=await run(b); out.afterExpiry=selects-s0; out.archived=r.archived; out.rows=await rows(); out.expired=f.latestCacheStats()[0].expiredEvents;`), {});
      ok(ttl.within === 0 && ttl.afterExpiry === 1 && ttl.archived === 0 && ttl.rows === 9 && ttl.expired === 3, 'archive: within the cache lifetime a pass needs no lookup; after it the events are re-read once (and nothing is duplicated)', ttl);

      const ro = worker(code('', `const b=mk(6); await run(b); const s0=selects; await arch.recordObservation({eventId:'evt0',playerRaw:'P0',marketKeyRaw:'player_points',source:'fanduel',sport:'nba',period:'game',side:'over',line:12.5,overPrice:-110,underPrice:-110,providerLastUpdate:'2026-11-05T12:00:00Z',capturedAt:Date.now()+5});
        const r=await run(b); out.reread=selects-s0; out.archived=r.archived; out.rows=await rows();`), {});
      ok(ro.reread >= 1 && ro.rows >= 7, 'archive: a row written outside a pass (recordObservation) drops that event from the cache so it is re-read, never compared against stale memory', ro);
    }

    // ── 6. Turso quota-block breaker ──────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n=== 6. Turso quota-block breaker');
    {
      const dbl = await startHranaDouble({ file: path.join(TMP, 'breaker.db') });
      try {
        const code = `
          const store=require('./lib/snapshotStore'); const out={}; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
          (async()=>{
            await store.verifyReady(); out.ready=true; await store.run("INSERT INTO prop_snapshots (snap_date,sport,player,stat) VALUES ('2026-11-05','nba','A','pts')");
            console.log('@@ready'); await new Promise(r=>process.stdin.once('data',r));   // test flips the double to "everything refused"
            const errs=[]; const t=async(fn)=>{ try{ await fn(); return null; }catch(e){ return { blocked:store.isQuotaBlocked(e), code:e.code||null, msg:String(e.message).slice(0,90) }; } };
            out.first=await t(()=>store.query('SELECT COUNT(*) c FROM prop_snapshots'));
            out.state1=store.blockedState();
            console.log('@@mid'); await new Promise(r=>process.stdin.once('data',r));
            out.shorts=[]; for(let i=0;i<5;i++) out.shorts.push(await t(()=>store.query('SELECT 1')));
            out.write=await t(()=>store.run("INSERT INTO prop_snapshots (snap_date,sport,player,stat) VALUES ('2026-11-05','nba','B','pts')"));
            out.batch=await t(()=>store.batchWrite([{sql:"INSERT INTO prop_snapshots (snap_date,sport,player,stat) VALUES (?,?,?,?)",args:['2026-11-05','nba','C','pts']}]));
            out.state2=store.blockedState();
            console.log('@@mid2'); await new Promise(r=>process.stdin.once('data',r));   // test lifts the block and waits out the backoff
            out.recovered=await t(()=>store.query('SELECT COUNT(*) c FROM prop_snapshots')); out.state3=store.blockedState();
            out.stats=store.stats(); out.net=store.isQuotaBlocked(Object.assign(new Error('fetch failed'),{cause:Object.assign(new Error('connect ECONNREFUSED'),{code:'ECONNREFUSED'})}));
            out.plain=store.isQuotaBlocked(new Error('SQLITE_ERROR: no such table'));
            console.log('@@'+JSON.stringify(out)); process.exit(0);
          })().catch(e=>{console.log('@@'+JSON.stringify({fatal:String(e&&e.stack||e)}));process.exit(0);});`;
        const child = spawn(process.execPath, ['--no-warnings', '-e', code], { cwd: ROOT, env: Object.assign({}, process.env, { BEATSEDGE_DATA_DIR: path.join(TMP, 'br-data'), TURSO_DATABASE_URL: dbl.url, TURSO_AUTH_TOKEN: 'test', TURSO_BLOCKED_BACKOFF_MS: '4000' }) }); children.add(child);
        let buf = ''; child.stdout.on('data', d => { buf += d; }); child.stderr.on('data', d => { buf += d; });
        const waitFor = async (re) => { for (let i = 0; i < 200; i++) { if (re.test(buf)) return true; await sleep(100); } return false; };
        ok(await waitFor(/@@ready/), 'breaker: storage becomes ready against the (unblocked) double');
        dbl.setBlockAll(true); child.stdin.write('go\n');
        ok(await waitFor(/@@mid\b/), 'breaker: the first refused statement is reported');
        const refusedAtFirst = dbl.refusedWhileBlockedAll();
        child.stdin.write('go\n');
        ok(await waitFor(/@@mid2/), 'breaker: later requests complete');
        const refusedAfterShorts = dbl.refusedWhileBlockedAll();
        ok(refusedAfterShorts === refusedAtFirst, 'breaker: while blocked, queries / writes / batch writes are answered locally and send NOTHING to Turso (refused count unchanged)', { atFirst: refusedAtFirst, after: refusedAfterShorts });
        dbl.setBlockAll(false); await sleep(4300); child.stdin.write('go\n');
        ok(await waitFor(/@@\{/), 'breaker: worker finished');
        const o = JSON.parse(buf.split('\n').reverse().find(l => l.startsWith('@@{')).slice(2));
        ok(!o.fatal, 'breaker: no crash', o.fatal);
        ok(o.first && o.first.blocked === true && o.state1.blocked === true && o.state1.retryAt, 'breaker: a refused read is classified as a quota block and opens the breaker', { first: o.first, s: o.state1 });
        ok(o.shorts.every(s => s && s.blocked === true && s.code === 'STORAGE_BLOCKED') && o.write.code === 'STORAGE_BLOCKED' && o.batch.code === 'STORAGE_BLOCKED', 'breaker: short-circuited calls fail fast with a recognisable STORAGE_BLOCKED error (still classified as a quota block)', { shorts: o.shorts[0], write: o.write });
        ok(o.state2.shortCircuited >= 7, 'breaker: short-circuits are counted', o.state2);
        ok(o.recovered === null && o.state3.blocked === false && o.state3.recoveries === 1, 'breaker: after the backoff the next call is the probe; it succeeds, the breaker closes, no restart needed', { recovered: o.recovered, s: o.state3 });
        ok(o.net === false && o.plain === false, 'breaker: a network failure and an ordinary SQL error are NOT classified as a quota block (they keep their old handling)', { net: o.net, plain: o.plain });
      } finally { await dbl.close(); }
    }

    // ── 7. real server: cache, 304, compression, coalescing, stale, cooldown, metrics ──────────────────────────────────────────────
    console.log('\n=== 7. real server: provider passthrough');
    {
      const s = await boot('srvA', { PARLAY_CACHE_TTL_MS: '4000', PARLAY_OFF_PEAK_TTL_MS: '4000', PARLAY_STALE_MAX_MS: '30000', PARLAY_HOURLY_CREDIT_BUDGET: '100000', PARLAY_DAILY_CREDIT_BUDGET: '100000' });
      try {
        ok(s.listening, 'server A boots against the local stub');
        const a1 = await s.get(P('k1'));
        ok(a1.status === 200 && a1.headers['x-cache'] === 'MISS' && s.calls() === 1 && json(a1).length === 400, 'passthrough: first request is a MISS and makes exactly one upstream call', { st: a1.status, xc: a1.headers['x-cache'], calls: s.calls() });
        ok(a1.headers['x-result-has-more'] === 'false' && a1.headers.etag && /private/.test(a1.headers['cache-control'] || '') && /no-cache/.test(a1.headers['cache-control'] || ''), 'passthrough: pagination headers survive; ETag present; Cache-Control is private, no-cache (the URL carries a key)', a1.headers);
        const a2 = await s.get(P('k1'));
        ok(a2.status === 200 && a2.headers['x-cache'] === 'HIT' && s.calls() === 1 && a2.body.equals(a1.body), 'passthrough: second request is a HIT with an identical body and NO upstream call', { xc: a2.headers['x-cache'], calls: s.calls() });
        const nm = await s.get(P('k1'), { 'if-none-match': a1.headers.etag });
        ok(nm.status === 304 && nm.body.length === 0 && nm.headers['x-result-has-more'] === 'false' && nm.headers['x-cache'] === 'HIT' && s.calls() === 1, 'passthrough: If-None-Match gets 304 with no body, the pagination headers still present, no upstream call', { st: nm.status, len: nm.body.length, h: nm.headers['x-result-has-more'] });
        const nmw = await s.get(P('k1'), { 'if-none-match': '"something-else"' });
        ok(nmw.status === 200 && nmw.body.equals(a1.body), 'passthrough: a validator that does not match gets the full body');
        const br = await s.get(P('k1'), { 'accept-encoding': 'br, gzip' }); const gz = await s.get(P('k1'), { 'accept-encoding': 'gzip' });
        ok(br.headers['content-encoding'] === 'br' && zlib.brotliDecompressSync(br.body).equals(a1.body) && br.body.length < a1.body.length / 4, 'passthrough: brotli body decompresses to the identical JSON and is at least 4x smaller', { len: br.body.length, plain: a1.body.length });
        ok(gz.headers['content-encoding'] === 'gzip' && zlib.gunzipSync(gz.body).equals(a1.body), 'passthrough: gzip body decompresses to the identical JSON');
        ok(br.headers.etag !== gz.headers.etag && br.headers.etag !== a1.headers.etag && /accept-encoding/i.test(br.headers.vary || ''), 'passthrough: validators differ per encoding; Vary: Accept-Encoding', { br: br.headers.etag, gz: gz.headers.etag });
        const brNm = await s.get(P('k1'), { 'accept-encoding': 'br', 'if-none-match': br.headers.etag });
        ok(brNm.status === 304 && s.calls() === 1, 'passthrough: a compressed representation also revalidates with 304');
        const byp = await s.get(P('k1'), { 'cache-control': 'no-cache' });
        ok(byp.status === 200 && byp.headers['x-cache'] === 'MISS' && s.calls() === 2, 'passthrough: a no-cache request still bypasses the cache and is never answered 304 (the page\'s direct book check)', { xc: byp.headers['x-cache'], calls: s.calls() });
        s.ctl({ delayMs: 400 });
        const before = s.calls(); const conc = await Promise.all([1, 2, 3, 4, 5].map(() => s.get(P('k2'))));
        const tags = conc.map(r => r.headers['x-cache']);
        ok(s.calls() - before === 1 && tags.filter(t => t === 'MISS').length === 1 && tags.filter(t => t === 'COALESCED').length === 4 && conc.every(r => r.status === 200), 'passthrough: 5 simultaneous identical requests make ONE upstream call (1 MISS + 4 COALESCED)', { delta: s.calls() - before, tags });
        s.ctl({});
        await sleep(800);
        const wrote = s.lines.filter(l => /\[nba-archive\] captured=/.test(l)); const w = wrote.map(l => Number((/written=(\d+)/.exec(l) || [])[1]));
        ok(wrote.length >= 2 && w[0] === 400 && w.slice(1).every(x => x === 0), 'archive through the real route: the first pass writes 400 rows, every later pass over the same board writes 0', w);

        await sleep(4300);   // k1 and k2 are now past their 4 s TTL, inside the 30 s stale window
        const callsBefore = s.calls();
        s.ctl({ status: 503 });
        const st1 = await s.get(P('k1'));
        ok(st1.status === 200 && st1.headers['x-cache'] === 'STALE' && /upstream-503/.test(st1.headers['x-stale-reason'] || '') && Number(st1.headers['x-data-age-seconds']) >= 4 && s.calls() === callsBefore + 1, 'stale: provider answers 503 -> the last good board is served, labelled STALE with its age and the reason', { xc: st1.headers['x-cache'], reason: st1.headers['x-stale-reason'], age: st1.headers['x-data-age-seconds'] });
        ok(json(st1).length === 400 && st1.headers['x-result-has-more'] === 'false', 'stale: it is a complete valid board with its own pagination headers (not an error body)');
        const st2 = await s.get(P('k2'));
        ok(st2.status === 200 && st2.headers['x-cache'] === 'STALE' && /cooldown/.test(st2.headers['x-stale-reason'] || '') && st2.headers['x-cooldown-until'] && s.calls() === callsBefore + 1, 'stale: while the provider is cooling down, a stale board is served WITHOUT calling the provider', { reason: st2.headers['x-stale-reason'], calls: s.calls() - callsBefore });
        const unseen = await s.get(P('never-seen'));
        ok(unseen.status === 503 && json(unseen).status === 'unavailable' && s.calls() === callsBefore + 1, 'stale: a request with no stale copy gets the honest 503 unavailable, never an invented board', { st: unseen.status, calls: s.calls() - callsBefore });
        const stBr = await s.get(P('k1'), { 'accept-encoding': 'br' });
        ok(stBr.headers['x-cache'] === 'STALE' && stBr.headers['content-encoding'] === 'br' && zlib.brotliDecompressSync(stBr.body).equals(a1.body), 'stale: a stale board is compressed like any other');

        const m = json(await s.get('/api/resource-metrics'));
        const text = JSON.stringify(m);
        ok(!text.includes(KEY) && !/apikey/i.test(text), 'metrics: no key or key-shaped field anywhere in the output');
        ok(m.counters['parlay.upstreamCalls'] === s.calls() && m.counters['parlay.staleServed'] >= 3 && m.counters['parlay.cacheHit'] >= 2 && m.counters['http.notModified'] >= 2, 'metrics: the process\'s own counters agree with the stub\'s call log (upstream calls, stale answers, hits, 304s)', { counters: m.counters, stubCalls: s.calls() });
        ok(m.provider.budget.upstreamCalls === s.calls() && m.provider.budget.chargedByProviderHeader >= 1 && m.provider.budget.providerReportedRemaining === 50000, 'metrics: credit use is attributed by the provider\'s own cost header, and the provider-reported balance is shown', m.provider.budget);
        ok(m.http.bytesAfter > 0 && m.http.bytesAfter < m.http.bytesBefore / 3 && m.http.notModified >= 2 && m.http.encodedFromCache >= 2, 'metrics: compression and 304 savings are reported', m.http);
        const nbaCache = (m.archive.latestCache || []).find(c => c.table === 'nba_provider_line_archive');
        ok(nbaCache && nbaCache.dbLookups === 1 && nbaCache.eventsFromMemory >= 1 && nbaCache.dbRowsRead === 0, 'metrics: the archive read the database once for the event and then ran from memory', nbaCache);
        ok(m.storage.backend === 'sqlite' && m.startupJobs.length === 0 && typeof m.uptimeSeconds === 'number' && m.provider.health.status, 'metrics: storage, startup-job and health sections present');
        const sh = await s.get('/api/data-sources/health');
        ok(sh.status === 200 && json(sh).parlayApiCache.ttlMs === 4000 && json(sh).parlayApiCache.staleServed >= 3, '/api/data-sources/health now shows the cache TTL and stale answers served');
        ok(s.child.exitCode === null, 'server A is still running after all of the above');
      } finally { await s.stop(); }
    }

    // ── 8. real server: credit budget, and a rejected key is never masked ─────────────────────────────────────────────────────────────
    console.log('\n=== 8. real server: credit budget');
    {
      const s = await boot('srvB', { PARLAY_CACHE_TTL_MS: '2500', PARLAY_OFF_PEAK_TTL_MS: '2500', PARLAY_STALE_MAX_MS: '30000', PARLAY_HOURLY_CREDIT_BUDGET: '6', PARLAY_DAILY_CREDIT_BUDGET: '1000', PARLAY_BUDGET_MODE: 'call' });   // these checks pin the PER-CALL rule (board mode is covered in section 10)
      try {
        ok(s.listening, 'server B boots (hourly budget 6 credits, 3 per call)');
        const b1 = await s.get(P('b1')); const b2 = await s.get(P('b2'));
        ok(b1.headers['x-cache'] === 'MISS' && b2.headers['x-cache'] === 'MISS' && s.calls() === 2, 'budget: two calls (6 credits by the provider\'s header) are made', s.calls());
        const b3 = await s.get(P('b3'));
        ok(b3.status === 503 && json(b3).status === 'unavailable' && /budget/.test(json(b3).reason) && Number(b3.headers['retry-after']) > 0 && s.calls() === 2, 'budget: the third call is refused locally with a 503 and Retry-After; the provider is NOT called', { st: b3.status, ra: b3.headers['retry-after'], calls: s.calls() });
        const b1again = await s.get(P('b1'));
        ok(b1again.headers['x-cache'] === 'HIT' && s.calls() === 2, 'budget: a request answered from the cache costs nothing and is unaffected by the budget');
        await sleep(2700);
        const stale = await s.get(P('b1'));
        ok(stale.status === 200 && stale.headers['x-cache'] === 'STALE' && /budget-hourly/.test(stale.headers['x-stale-reason'] || '') && s.calls() === 2, 'budget: with the budget spent and the cache expired, the labelled stale board is served and the provider is still not called', { xc: stale.headers['x-cache'], r: stale.headers['x-stale-reason'], calls: s.calls() });
        const m = json(await s.get('/api/resource-metrics'));
        ok(m.provider.budget.spentLastHour === 6 && m.provider.budget.denied.hourly >= 2 && m.counters['parlay.budgetDenied.hourly'] >= 2, 'budget: spend and denials are reported', m.provider.budget);
      } finally { await s.stop(); }
      const r = await boot('srvB2', { PARLAY_CACHE_TTL_MS: '2500', PARLAY_OFF_PEAK_TTL_MS: '2500', PARLAY_STALE_MAX_MS: '30000', PARLAY_HOURLY_CREDIT_BUDGET: '100000', PARLAY_DAILY_CREDIT_BUDGET: '100000', PARLAY_CREDIT_RESERVE: '1000' });
      try {
        r.ctl({ remaining: 400 });
        await r.get(P('r1'));
        const denied = await r.get(P('r2'));
        ok(denied.status === 503 && /budget/.test(json(denied).reason) && /reserve/.test(json(denied).detail) && r.calls() === 1, 'budget: when the provider reports fewer credits than the reserve, calls stop (reason reserve)', { st: denied.status, d: json(denied).detail, calls: r.calls() });
      } finally { await r.stop(); }
      const c = await boot('srvC', { PARLAY_CACHE_TTL_MS: '1500', PARLAY_OFF_PEAK_TTL_MS: '1500', PARLAY_STALE_MAX_MS: '30000', PARLAY_HOURLY_CREDIT_BUDGET: '100000', PARLAY_DAILY_CREDIT_BUDGET: '100000' });
      try {
        await c.get(P('c1')); await sleep(1700);
        c.ctl({ status: 403 });
        const r403 = await c.get(P('c1'));
        ok(r403.status === 403 && r403.headers['x-cache'] !== 'STALE', 'stale: a rejected key (403) is passed through, never hidden behind an old board', { st: r403.status, xc: r403.headers['x-cache'] });
      } finally { await c.stop(); }
    }

    // ── 9. real server: Turso BLOCKED at startup ────────────────────────────────────────────────────────────────────────────────────
    console.log('\n=== 9. real server: Turso quota block at startup');
    {
      const dbl = await startHranaDouble({ file: path.join(TMP, 'srvD.db') });
      dbl.setBlockAll(true);
      const d = await boot('srvD', { TURSO_DATABASE_URL: dbl.url, TURSO_AUTH_TOKEN: 'test', TURSO_BLOCKED_BACKOFF_MS: '60000' });
      try {
        ok(d.listening && d.child.exitCode === null, 'blocked start: the server LISTENS instead of exiting with code 1 (the 2026-11-05 crash loop)', d.listening ? '' : { exit: d.child.exitCode, log: d.lines.slice(-12) });
        ok(d.lines.some(l => /DEGRADED mode/.test(l)) && !d.lines.some(l => /FATAL/.test(l)), 'blocked start: it says clearly that it is running degraded');
        const h = await d.get('/api/health');
        ok(h.status === 200 && json(h).ok === true && json(h).snapshotStorage === 'blocked', '/api/health stays 200 and reports snapshotStorage: blocked', h.body.toString().slice(0, 200));
        const refused0 = dbl.refusedWhileBlockedAll();
        const results = []; for (let i = 0; i < 10; i++) results.push((await d.get('/api/snapshots/summary')).status);
        ok(results.every(x => x === 500) && dbl.refusedWhileBlockedAll() - refused0 <= 1, 'blocked start: 10 requests that need the snapshot database fail fast (500) and send at most 1 refused statement to Turso (was: one per request)', { results, refused: dbl.refusedWhileBlockedAll() - refused0 });
        const p = await d.get(P('d1'));
        ok(p.status === 200 && p.headers['x-cache'] === 'MISS' && json(p).length === 400, 'blocked start: the provider passthrough works (it does not depend on snapshot storage)');
        await sleep(500);
        const m = json(await d.get('/api/resource-metrics'));
        ok(m.storage.blocked === true && m.storage.shortCircuited >= 5, 'blocked start: /api/resource-metrics shows the open breaker and the short-circuits', m.storage);
        ok(d.child.exitCode === null, 'blocked start: still running after all of the above');
      } finally { await d.stop(); await dbl.close(); }
      const f = await boot('srvE', { TURSO_DATABASE_URL: 'http://127.0.0.1:1', TURSO_AUTH_TOKEN: 'test' });
      try {
        for (let i = 0; i < 80 && f.child.exitCode === null; i++) await sleep(250);
        ok(f.child.exitCode === 1 && f.lines.some(l => /FATAL: snapshot storage is not reachable/.test(l)), 'unchanged: an unreachable Turso (not a quota block) is still fatal at startup, exit code 1', { exit: f.child.exitCode });
      } finally { await f.stop(); }
    }

    // ── 10. board-mode credit budget: no partial board can be produced by a budget limit ─────────────────────────────────────────────────────────────
    console.log('\n=== 10. board-mode credit budget');
    {
      const r = worker(`
        process.env.PARLAY_HOURLY_CREDIT_BUDGET='450'; process.env.PARLAY_DAILY_CREDIT_BUDGET='1500'; delete process.env.PARLAY_BUDGET_MODE;
        const b=require('./lib/providerBudget'); const T=1_000_000_000_000; const out={}; const board=(t0,sc)=>{ for(let i=0;i<51;i++){ const a=b.admit('p',sc,t0+i*1000); if(!a.allowed) return {stoppedAt:i,a}; b.record('p',{status:200,headers:{}},t0+i*1000,sc);} return {ok:true}; };
        out.defaults=b.limits();
        out.board1=board(T,'basketball_nba'); out.afterBoard1=b.stats('p',T+60_000);
        out.gateDuringLease=b.blockedFor('p','basketball_nba',T+60_000);
        out.board2=board(T+400_000,'basketball_nba'); out.afterBoard2=b.stats('p',T+460_000);
        out.third=b.admit('p','basketball_nba',T+700_000); out.blockedNba=b.blockedFor('p','basketball_nba',T+700_000); out.blockedNhl=b.blockedFor('p','icehockey_nhl',T+700_000);
        out.unscoped=b.admit('p',null,T+700_000);
        out.retryOk = out.third && out.third.retryAfterSeconds>0 && out.third.retryAfterSeconds<=3600;
        // after the first spends age out of the hour, a board may start again
        out.later=b.admit('p','basketball_nba',T+3_700_000);
        // daily: 1500 cap, the board must fit in what is left of the day
        b._reset(); process.env.PARLAY_HOURLY_CREDIT_BUDGET='100000';
        for(let k=0;k<9;k++){ const t=T+k*4_000_000; const r=board(t,'basketball_nba'); if(!r.ok) out.dailyStop={k,r}; }
        out.afterNineBoards=b.stats('p',T+9*4_000_000); out.tenth=b.admit('p','basketball_nba',T+9*4_000_000+1000);
        // call mode = the first patch's per-call cap, unchanged
        b._reset(); process.env.PARLAY_BUDGET_MODE='call'; process.env.PARLAY_HOURLY_CREDIT_BUDGET='6';
        out.callMode={ gate:b.blockedFor('p','basketball_nba',T), first:b.admit('p','basketball_nba',T).allowed };
        b.record('p',{status:200,headers:{}},T); b.record('p',{status:200,headers:{}},T+1); out.callModeDenied=b.admit('p','basketball_nba',T+2);
        console.log('@@'+JSON.stringify(out));`);
      ok(r.defaults && r.defaults.hourly === 450 && r.defaults.daily === 1500 && r.defaults.boardMode === true && r.defaults.boardReserveMin === 160, 'board budget: canary defaults are 450 credits/hour, 1,500 credits/day, board mode on, board reserve 160', r.defaults);
      ok(r.board1 && r.board1.ok && r.afterBoard1.spentLastHour === 153 && r.afterBoard1.boards.started === 1, 'board budget: a full 51-request board (153 credits) is admitted whole', r.afterBoard1);
      ok(r.gateDuringLease === null, 'board budget: while a board is in progress nothing is gated');
      ok(r.board2 && r.board2.ok && r.afterBoard2.spentLastHour === 306 && r.afterBoard2.boards.completed === 1 && r.afterBoard2.limits.boardReserveCredits === 192, 'board budget: a second whole board fits (306 of 450); the reserve follows the measured board cost (153 x 1.25 = 192)', r.afterBoard2);
      ok(r.third && r.third.allowed === false && r.third.reason === 'board-hourly' && r.retryOk && r.blockedNba && r.blockedNhl, 'board budget: with 144 credits left (< one board) a third board is NOT started and every sport is blocked (not one request is half-served)', { third: r.third, nba: !!r.blockedNba, nhl: !!r.blockedNhl });
      ok(r.unscoped && r.unscoped.allowed === true, 'board budget: a request that is not a sport board (for example the sports list) still uses the plain per-call rule');
      ok(r.later && r.later.allowed === true && r.later.board === 'start', 'board budget: once the old spend leaves the hour a board may start again', r.later);
      ok(r.afterNineBoards && r.afterNineBoards.spentLast24h <= 1500 && r.tenth && r.tenth.allowed === false && r.tenth.reason === 'board-daily' && !r.dailyStop, 'board budget: the 1,500 daily cap admits nine whole boards (1,377 credits) and refuses the tenth up front, never part-way', { spent: r.afterNineBoards && r.afterNineBoards.spentLast24h, tenth: r.tenth, dailyStop: r.dailyStop });
      ok(r.callMode && r.callMode.gate === null && r.callMode.first === true && r.callModeDenied && r.callModeDenied.allowed === false && r.callModeDenied.reason === 'hourly', 'board budget: PARLAY_BUDGET_MODE=call restores the per-call cap exactly', r.callModeDenied);

      const common = { PARLAY_CACHE_TTL_MS: '600000', PARLAY_OFF_PEAK_TTL_MS: '600000', PARLAY_BOARD_LEASE_SECONDS: '10', PARLAY_DAILY_CREDIT_BUDGET: '100000' };
      const NHL = (k) => '/api/parlayapi/v1/sports/icehockey_nhl/props?apiKey=' + KEY + '&markets=' + k;
      // a board that STARTS affordable finishes even though it crosses the hourly cap; the next board is refused as a whole, cache hits included
      const e = await boot('srvBoardE', Object.assign({}, common, { PARLAY_HOURLY_CREDIT_BUDGET: '200' }));
      try {
        const st = []; for (let i = 0; i < 80; i++) st.push((await e.get(P('e' + i))).status);
        ok(st.every(x => x === 200) && e.calls() === 80, 'board budget (server): a board started with a whole board affordable FINISHES although it crosses the 200 cap (80 requests = 240 credits): no partial board', { bad: st.filter(x => x !== 200).length, calls: e.calls() });
        const hitIn = await e.get(P('e3'));
        ok(hitIn.status === 200 && hitIn.headers['x-cache'] === 'HIT', 'board budget (server): while the board is in progress its cached parts are served');
        await sleep(10600);
        const hit = await e.get(P('e3')); const fresh = await e.get(P('brand-new')); const nhl = await e.get(NHL('x')); const list = await e.get('/api/parlayapi/v1/sports?apiKey=' + KEY);
        ok(hit.status === 503 && hit.headers['x-credit-budget'] === 'board-denied' && Number(hit.headers['retry-after']) > 0 && /no complete/.test(json(hit).reason) && !hit.headers['x-cache'], 'board budget (server): afterwards even a CACHED part of the board is refused (503, x-credit-budget: board-denied, Retry-After): the browser keeps its old board and shows its error state, never a half board', { st: hit.status, h: hit.headers['x-credit-budget'], ra: hit.headers['retry-after'] });
        ok(fresh.status === 503 && fresh.headers['x-credit-budget'] === 'board-denied' && nhl.status === 503 && nhl.headers['x-credit-budget'] === 'board-denied', 'board budget (server): an uncached NBA request and an NHL request are refused the same way (one shared budget)');
        ok(list.status === 503 && list.headers['x-credit-budget'] === 'denied' && e.calls() === 80, 'board budget (server): the per-call rule still stops non-board requests, and not one extra upstream call was made');
        const m = json(await e.get('/api/resource-metrics')); const bs = m.provider.budget;
        ok(bs.mode === 'board' && bs.boards.started === 1 && bs.boards.blockedRequests >= 3 && bs.spentLastHour === 240 && m.counters['parlay.boardBlocked'] >= 3, 'board budget (server): metrics report the board started, the blocked requests and the true spend', bs.boards);
      } finally { await e.stop(); }
      // hard stop: a board that would run far past the cap is aborted, visibly, and the refusal is labelled
      const d = await boot('srvBoardD', Object.assign({}, common, { PARLAY_HOURLY_CREDIT_BUDGET: '300' }));
      try {
        const st = []; for (let i = 0; i < 140; i++) { const r = await d.get(P('d' + i)); st.push({ s: r.status, h: r.headers['x-credit-budget'] || null }); }
        const okN = st.filter(x => x.s === 200).length, aborted = st.filter(x => x.h === 'board-aborted').length;
        ok(okN === 134 && aborted === 6 && st.slice(134).every(x => x.s === 503 && x.h === 'board-aborted') && d.calls() === 134, 'board budget (server): the hard stop (cap + 100) aborts a runaway board after 134 requests; every refused request is labelled x-credit-budget: board-aborted', { okN, aborted, calls: d.calls() });
        await sleep(10600); const after = await d.get(P('d5'));
        ok(after.status === 503 && after.headers['x-credit-budget'] === 'board-denied', 'board budget (server): after the board is over, the sport is refused as a whole (even cached requests)');
      } finally { await d.stop(); }
      // a board that is not affordable is never started at all
      const f1 = await boot('srvBoardF', Object.assign({}, common, { PARLAY_HOURLY_CREDIT_BUDGET: '150' }));
      try {
        const x = await f1.get(P('f1'));
        ok(x.status === 503 && x.headers['x-credit-budget'] === 'board-denied' && f1.calls() === 0, 'board budget (server): with an hourly cap below one board (150) not a single upstream call is made', { st: x.status, calls: f1.calls() });
      } finally { await f1.stop(); }
    }

    // ── 11. production-like blocked start: BOTH Turso databases refuse everything, boot jobs enabled ─────────────────────────────────────────────────
    console.log('\n=== 11. real server: both Turso databases blocked, boot jobs enabled (as Render boots)');
    {
      const snap = await startHranaDouble({ file: path.join(TMP, 'prod-snap.db') }); const hist = await startHranaDouble({ file: path.join(TMP, 'prod-hist.db') });
      snap.setBlockAll(true); hist.setBlockAll(true);
      const s = await boot('srvProd', { SKIP_STARTUP_JOBS: '', NODE_ENV: 'production', TURSO_DATABASE_URL: snap.url, TURSO_AUTH_TOKEN: 'test', TURSO_HISTORICAL_DATABASE_URL: hist.url, TURSO_HISTORICAL_AUTH_TOKEN: 'test', TURSO_BLOCKED_BACKOFF_MS: '60000' });
      try {
        ok(s.listening && s.child.exitCode === null, 'prod-like blocked start: the server LISTENS (it used to exit 1 and crash-loop)', s.listening ? '' : { exit: s.child.exitCode, log: s.lines.slice(-12) });
        await sleep(16000);   // the boot jobs fire at +10 s
        ok(s.child.exitCode === null, 'prod-like blocked start: still alive after the boot jobs fired (+10 s) and the NFL / NBA history checks ran', { exit: s.child.exitCode });
        const skipped = s.lines.filter(l => /\[startup\] (NBA|MLB|NHL) initial update pass: skipped|\[startup\] NFL ingest \+ DvP recompute: skipped/.test(l));
        ok(skipped.length === 4 && skipped.every(l => /could not be read/.test(l)), 'prod-like blocked start: all four boot jobs are SKIPPED because the run history cannot be read (none runs blind against a refusing database)', skipped.map(l => l.slice(0, 120)));
        ok(!s.lines.some(l => /Running initial|NFL ingest\.\.\.|FATAL/.test(l)), 'prod-like blocked start: no job ran, no child process was spawned, no fatal line');
        const h = await s.get('/api/health');
        ok(h.status === 200 && json(h).ok === true && json(h).historical === 'unavailable' && json(h).snapshotStorage === 'blocked', '/api/health: 200, ok, historical "unavailable", snapshotStorage "blocked" (the dependency problem is reported, not hidden)', h.body.toString().slice(0, 220));
        const p = await s.get(P('prod1'));
        ok(p.status === 200 && p.headers['x-cache'] === 'MISS' && json(p).length === 400, 'prod-like blocked start: the provider passthrough still serves boards');
        const before = snap.refusedWhileBlockedAll() + hist.refusedWhileBlockedAll(); await sleep(8000); const after = snap.refusedWhileBlockedAll() + hist.refusedWhileBlockedAll();
        ok(after - before <= 2, 'prod-like blocked start: while idle the server sends (almost) nothing to the refusing databases (8 s idle: ' + (after - before) + ' refused statements)', { before, after });
        const m = json(await s.get('/api/resource-metrics'));
        ok(m.startupJobs.length === 4 && m.startupJobs.every(j => j.run === false && j.error === true) && m.storage.blocked === true && m.provider.cache.staleMaxAgeMs === 0, 'prod-like blocked start: metrics show 4 skipped boot jobs, the open breaker, and stale-on-error OFF (staleMaxAgeMs 0)', { jobs: m.startupJobs.map(j => j.job + ':' + j.run), stale: m.provider.cache.staleMaxAgeMs });
      } finally { await s.stop(); await snap.close(); await hist.close(); }
    }
  } catch (e) {
    fail++; console.log('FAIL harness error:', e && e.stack || e);
  } finally {
    for (const c of children) { try { c.kill(); } catch (e) { /* gone */ } }
    await sleep(500);
    // Remove ONLY the folder this script created (guarded: inside the OS temp dir and carrying this script's own prefix).
    try { if (TMP.startsWith(os.tmpdir()) && path.basename(TMP).startsWith('resource-opt-')) fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { console.log('(temp folder not fully removed:', e.message + ')'); }
  }
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();
