import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLogger } = require('./dist/logging/logger.js');

const KEY = 'PLANTEDKEYSECRET';
const BEARER = 'Bearer abcdef0123456789secrettoken';
const SECRET_KEYS = ['password', 'token', 'apiKey', 'secret', 'cookie', 'authorization', 'credential', 'privateKey'];

// Build a value of a given shape planting BOTH defined secret kinds:
//  (1) KEY-based: a secret-family property whose value is KEY
//  (2) PATTERN-based: a string value containing BEARER
function buildShapes() {
  const s = [];
  s.push(['plain-object', () => { const o = { ok: 'v', note: BEARER }; for (const k of SECRET_KEYS) o[k] = KEY; return o; }]);
  s.push(['array', () => [{ password: KEY }, BEARER, { token: KEY, apiKey: KEY }]]);
  s.push(['class-instance', () => { class C { constructor(){ this.u='u'; this.password=KEY; this.header=BEARER; this.token=KEY; } } return new C(); }]);
  s.push(['error-basic', () => { const e = new Error('boom ' + BEARER); e.password=KEY; e.token=KEY; e.detail=BEARER; return e; }, { msg: 'boom' }]);
  s.push(['error-symbol-keyed', () => { const e = new Error('symerr ' + BEARER); e[Symbol('password')]=KEY; e[Symbol.for('token')]=KEY; e.visible='v'; return e; }, { msg: 'symerr' }]);
  s.push(['error-nested-cause', () => { const inner = new Error('inner ' + BEARER); inner.password=KEY; const outer = new Error('outer-boom', { cause: inner }); outer.apiKey=KEY; return outer; }, { msg: 'outer-boom' }]);
  s.push(['map', () => { const m = new Map(); m.set('password', KEY); m.set('token', KEY); m.set('data', BEARER); m.set({ secret: KEY }, 'ok'); return m; }]);
  // Set: only the two DEFINED secret kinds (pattern bearer + key-based object)
  s.push(['set', () => new Set([BEARER, { password: KEY }, { token: KEY, authorization: KEY }])]);
  s.push(['date', () => new Date('2020-01-02T03:04:05.678Z'), { date: '2020-01-02' }]);
  s.push(['regexp', () => { const r = /foo.*bar/gi; r.password=KEY; r.bearer=BEARER; return r; }]);
  s.push(['deep-nesting', () => { let v = { password: KEY, leaf: BEARER }; for (let i=0;i<12;i++) v = { level:i, token:KEY, nested:v }; return v; }]);
  return s;
}

// Interpolation-path + plain-positional call shapes
const paths = [
  ['info %o', (lg, v) => lg.info('ctx %o', v)],
  ['info %j', (lg, v) => lg.info('ctx %j', v)],
  ['info %s', (lg, v) => lg.info('ctx %s', v)],
  ['error %o', (lg, v) => lg.error('fail %o', v)],
  ['two-arg x=%s y=%o', (lg, v) => lg.info('x=%s y=%o', 'str', v)],
  ['value alone', (lg, v) => lg.info(v)],
];

const findings = [];
let cells = 0;

function assess(label, callShape, line, opts) {
  if (line == null) { findings.push({ label, callShape, kind: 'crash', detail: 'no line emitted', line: null }); return; }
  if (line.includes(KEY)) findings.push({ label, callShape, kind: 'leak', detail: 'KEY secret present', line: line.trim() });
  if (line.includes('abcdef0123456789secrettoken')) findings.push({ label, callShape, kind: 'leak', detail: 'BEARER token present', line: line.trim() });
  if (opts.msg && !line.includes(opts.msg) && !line.includes('Error')) findings.push({ label, callShape, kind: 'diagnostic-loss', detail: `Error message "${opts.msg}" destroyed`, line: line.trim() });
  if (opts.date && !line.includes(opts.date)) findings.push({ label, callShape, kind: 'diagnostic-loss', detail: `Date value destroyed`, line: line.trim() });
}

for (const [pname, call] of paths) {
  for (const [sname, make, opts = {}] of buildShapes()) {
    cells++;
    const lines = [];
    const lg = createLogger('info', { write: (c) => lines.push(c) });
    let threw = null;
    try { call(lg, make()); } catch (e) { threw = e; }
    const line = lines.length ? lines[lines.length - 1] : null;
    if (threw) { findings.push({ label: sname, callShape: pname, kind: 'crash', detail: String(threw && threw.stack || threw), line: line && line.trim() }); continue; }
    assess(sname, pname, line, opts);
    if (process.env.VERBOSE) console.log(`[${pname}] ${sname}: ${line && line.trim()}`);
  }
}

// plain no-arg bearer positional
{
  cells++;
  const lines = [];
  const lg = createLogger('info', { write: (c) => lines.push(c) });
  lg.info('plain no-arg bearer ' + BEARER);
  const line = lines[lines.length - 1];
  if (line.includes('abcdef0123456789secrettoken')) findings.push({ label: 'string-literal', callShape: 'plain no-arg', kind: 'leak', detail: 'BEARER present', line: line.trim() });
}

console.log('CELLS=' + cells);
console.log('FINDINGS=' + findings.length);
for (const f of findings) console.log(JSON.stringify(f));
