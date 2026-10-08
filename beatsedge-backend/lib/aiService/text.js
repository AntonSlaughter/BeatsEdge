'use strict';
// Untrusted-text handling for the AI backend layer. Every string that originates from a provider / browser (player names, market labels, factor details, the user's question) is DATA, never an
// instruction: it is reduced to a conservative character set, length-capped, scrubbed of instruction-shaped phrases and later wrapped in delimiters the system contract declares as data.
const INJECTION_RE = /(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+|these\s+)?(previous|prior|above|earlier|system|safety|rules?|instructions?)|system\s+prompt|you\s+are\s+(now\s+)?(a|an|the)\b|(^|\s)(assistant|system|developer)\s*:|\bas an ai\b|<\/?\s*(system|assistant|user|data|evidence|question)\s*>|\[\/?\s*(inst|system)\s*\]|#{2,}\s*(instruction|system)|jailbreak|developer mode|new instructions?|reveal (your|the) (prompt|key|secret)|<<<|>>>/i;
const cc = (...r) => r.map(x => Array.isArray(x) ? String.fromCharCode(x[0]) + '-' + String.fromCharCode(x[1]) : String.fromCharCode(x)).join('');
const CONTROL_RE = new RegExp('[' + cc([0, 31], [127, 159], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], 0xfeff) + ']', 'g');
const DISALLOWED_RE = /[^\p{L}\p{N} .,'’()+\-\/&:%#@!?]/gu;
// text(v, max, report?) -> sanitized string | null. report: { field, list } collects fields that were altered / blocked (never the content).
function text(v, max, report) {
  if (v == null) return null; if (typeof v !== 'string' && typeof v !== 'number') { if (report) report.list.push({ field: report.field, issue: 'not a string' }); return null; }
  const raw = String(v); let s = raw.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (INJECTION_RE.test(s)) { s = '[removed]'; if (report) report.list.push({ field: report.field, issue: 'instruction-shaped text removed' }); }
  const cleaned = s.replace(DISALLOWED_RE, '').replace(/\s+/g, ' ').trim(); if (cleaned !== s && report) report.list.push({ field: report.field, issue: 'unsupported characters removed' });
  const out = cleaned.slice(0, max || 80); if (cleaned.length > out.length && report) report.list.push({ field: report.field, issue: 'truncated to ' + (max || 80) + ' characters' });
  return out || null;
}
const finite = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
module.exports = { text, finite, INJECTION_RE };
