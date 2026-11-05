// Response compression with Node's own zlib (no new dependency). Prop boards are 1-10 MB of repetitive JSON, so gzip / brotli remove most of the outbound
// bytes Render bills and the browser downloads.
//
//   acceptedEncoding(req)        -> 'br' | 'gzip' | null, from the request's Accept-Encoding (q=0 means "not accepted")
//   encode(body, encoding)       -> Promise<Buffer>   (zlib's threadpool: the event loop is not blocked)
//   middleware()                 -> Express middleware: compresses res.send()/res.json() bodies of 1 KB or more for compressible types. A response that already
//                                   carries a Content-Encoding (the cached ParlayAPI passthrough pre-encodes its own) is left alone.
//
// Brotli quality 4 / gzip level 6: close to the best ratio those formats give on this kind of JSON at a fraction of the CPU of the top settings (this
// service runs on a fraction of a vCPU). Counters feed GET /api/resource-metrics.

const zlib = require('zlib');
const MIN_BYTES = Math.max(256, Number(process.env.COMPRESS_MIN_BYTES) || 1024);
const COMPRESSIBLE = /^(application\/(json|javascript|xml)|text\/)/i;
const counters = { responses: 0, bytesBefore: 0, bytesAfter: 0, skippedSmall: 0, errors: 0, notModified: 0, encodedFromCache: 0, encodedFresh: 0 };

function acceptedEncoding(req) {
  const header = String((req && req.headers && req.headers['accept-encoding']) || '');
  if (!header) return null;
  const q = {};
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const qp = params.map(p => p.trim()).find(p => p.startsWith('q='));
    q[name] = qp ? Number(qp.slice(2)) : 1;
  }
  const ok = (n) => (n in q ? q[n] > 0 : (('*' in q) ? q['*'] > 0 : false));
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

function encode(body, encoding) {
  const input = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  return new Promise((resolve, reject) => {
    const done = (err, out) => (err ? reject(err) : resolve(out));
    if (encoding === 'br') zlib.brotliCompress(input, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length } }, done);
    else if (encoding === 'gzip') zlib.gzip(input, { level: 6 }, done);
    else reject(new Error('unsupported encoding ' + encoding));
  });
}

function middleware() {
  return function compressionMiddleware(req, res, next) {
    const orig = res.send.bind(res);
    res.send = function (body) {
      try {
        if (res.headersSent || res.getHeader('Content-Encoding') || (typeof body !== 'string' && !Buffer.isBuffer(body))) return orig(body);
        if (res.statusCode === 204 || res.statusCode === 304 || req.method === 'HEAD') return orig(body);
        const type = String(res.getHeader('Content-Type') || '');
        if (!COMPRESSIBLE.test(type)) return orig(body);
        const len = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
        res.vary('Accept-Encoding');
        if (len < MIN_BYTES) { counters.skippedSmall++; return orig(body); }
        const enc = acceptedEncoding(req);
        if (!enc) return orig(body);
        encode(body, enc).then((buf) => {
          if (res.headersSent) return;
          counters.responses++; counters.bytesBefore += len; counters.bytesAfter += buf.length; counters.encodedFresh++;
          res.set('Content-Encoding', enc); res.removeHeader('Content-Length');
          orig(buf);
        }).catch(() => { counters.errors++; if (!res.headersSent) orig(body); });
        return res;
      } catch (e) { counters.errors++; return orig(body); }
    };
    next();
  };
}

function note({ before, after, fromCache, notModified } = {}) {
  if (notModified) { counters.notModified++; return; }
  counters.responses++; counters.bytesBefore += before || 0; counters.bytesAfter += after || 0; if (fromCache) counters.encodedFromCache++;
}
function stats() { return { ...counters, ratio: counters.bytesBefore ? Math.round((counters.bytesAfter / counters.bytesBefore) * 1000) / 1000 : null, minBytes: MIN_BYTES }; }

module.exports = { acceptedEncoding, encode, middleware, note, stats, MIN_BYTES };
