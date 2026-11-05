#!/usr/bin/env node
// Turns JUnit XML (which node --test, pytest, vitest and playwright can all
// write) into a .testreport file: one plain-text format for every project,
// made to be read in nvim (see testing/nvim/testreport.lua) and still fine
// with cat or grep.
//
//   node testreport.js <junit.xml> [--out test-report.testreport]
//        [--project <name>] [--root <project dir>] [--cmd "<test command>"]
//
// Exit code: 0 if nothing failed, 1 if anything failed, 2 on bad input.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WIDTH = 78;

// ---------- args ----------

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const input = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!input) {
  console.error('usage: testreport.js <junit.xml> [--out file] [--project name] [--root dir] [--cmd "..."]');
  process.exit(2);
}
const root = path.resolve(opt('root', process.cwd()));
const out = opt('out', path.join(root, 'test-report.testreport'));
const project = opt('project', path.basename(root));
const cmd = opt('cmd', '');

// ---------- a small, forgiving XML reader ----------

const decode = (s) => s.replace(/&(#x?[0-9a-f]+|lt|gt|amp|quot|apos);/gi, (_, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
});

function parseXml(xml) {
  const rootNode = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [rootNode];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += decode(m[6]);
    else if (m[3]) {
      if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      for (const [, k, v1, v2] of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[k] = decode(v1 ?? v2);
      const node = { tag: m[3], attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    }
  }
  return rootNode;
}

// ---------- JUnit → suites of tests ----------

// Runner-level suite names that say nothing; their tests are grouped by
// classname instead (pytest puts everything in one "pytest" suite).
const GENERIC = new Set(['', 'pytest', 'root', 'tests', 'test', 'mocha tests', 'jest tests', 'vitest tests']);

function collect(doc) {
  const suites = new Map(); // label -> tests[]
  const add = (label, t) => { if (!suites.has(label)) suites.set(label, []); suites.get(label).push(t); };
  const walk = (node, trail) => {
    for (const c of node.children) {
      if (c.tag === 'testsuite' || c.tag === 'testsuites') {
        const name = c.tag === 'testsuite' ? (c.attrs.name || '').trim() : '';
        walk(c, name && !GENERIC.has(name.toLowerCase()) ? [...trail, name] : trail);
      } else if (c.tag === 'testcase') {
        const t = testFrom(c);
        let label = trail.join(' › ');
        if (!label) {
          const cls = (c.attrs.classname || '').trim();
          label = cls && !GENERIC.has(cls.toLowerCase()) ? cls : c.attrs.file ? path.relative(root, c.attrs.file) : 'tests';
        }
        add(label, t);
      }
    }
  };
  walk(doc, []);
  return suites;
}

function testFrom(c) {
  const t = { name: (c.attrs.name || '(unnamed)').replace(/\s+/g, ' ').trim(), ms: Math.round(Number(c.attrs.time || 0) * 1000), status: 'pass', detail: [] };
  const failure = c.children.find((x) => x.tag === 'failure' || x.tag === 'error');
  const skipped = c.children.find((x) => x.tag === 'skipped');
  // node:test `todo` tests (known bugs) carry both <skipped type="todo"> and
  // a <failure>; they're listed but don't fail the run.
  if (skipped && skipped.attrs.type === 'todo') {
    t.status = 'todo';
    t.reason = (skipped.attrs.message || 'todo').replace(/\s+/g, ' ').trim();
  } else if (failure) {
    t.status = 'fail';
    t.detail = failureDetail(failure.attrs.message || '', failure.text || '');
  } else if (skipped) {
    t.status = 'skip';
    t.reason = (skipped.attrs.message || skipped.text || '').replace(/\s+/g, ' ').trim();
  }
  return t;
}

// The useful part of a failure: the message, expected/actual if the runner
// gave them, and where in the project's own code it happened.
function failureDetail(message, body) {
  const lines = [];
  const grab = (key) => (body.match(new RegExp(`^\\s*${key}: (.+?),?$`, 'm')) || [])[1];
  const expected = grab('expected'), actual = grab('actual');
  // With expected/actual shown separately, the message's diff is noise.
  const msgLines = (message || body.split('\n').find((l) => l.trim()) || 'failed').split('\n').map((l) => l.trim()).filter(Boolean);
  const msg = (expected !== undefined || actual !== undefined ? msgLines.slice(0, 1) : msgLines.slice(0, 4)).join(' ');
  lines.push(['msg', msg.length > 300 ? msg.slice(0, 297) + '...' : msg]);
  if (expected !== undefined) lines.push(['expected', expected]);
  if (actual !== undefined) lines.push(['actual', actual]);
  for (const [, file, line] of body.matchAll(/(?:\(|\s|^)((?:\/|\.{0,2}\/?)[^\s():]+\.[a-z]+):(\d+)/gm)) {
    if (/node:|node_modules|site-packages|\/internal\//.test(file)) continue;
    const abs = path.resolve(root, file);
    if (!abs.startsWith(root + path.sep)) continue;
    lines.push(['at', `${path.relative(root, abs)}:${line}`]);
    break;
  }
  return lines;
}

// ---------- render ----------

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`);
const rule = (ch) => ch.repeat(WIDTH);
const spread = (left, right) => left + ' '.repeat(Math.max(2, WIDTH - left.length - right.length)) + right;
const plural = (n, word) => `${n} ${word}`;

function counts(tests) {
  const c = { pass: 0, fail: 0, skip: 0, todo: 0 };
  for (const t of tests) c[t.status]++;
  return c;
}
const countText = (c) => [plural(c.pass, 'passed'), plural(c.fail, 'failed'), plural(c.skip, 'skipped'), ...(c.todo ? [plural(c.todo, 'todo')] : [])].join(' · ');

function git(...a) {
  try { return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

function render(suites) {
  const all = [...suites.values()].flat();
  const c = counts(all);
  const totalMs = all.reduce((s, t) => s + t.ms, 0);
  const sha = git('rev-parse', '--short', 'HEAD');
  const branch = git('branch', '--show-current');
  const dirty = git('status', '--porcelain') ? ' +uncommitted changes' : '';
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const L = [];
  L.push(rule('═'));
  L.push(`  TEST REPORT · ${project}`);
  L.push(`  RESULT: ${c.fail ? 'FAIL' : 'PASS'} · ${countText(c)} · ${all.length} total · ${fmtMs(totalMs)}`);
  L.push(`  ${[sha && `commit ${sha}${branch ? ` on ${branch}` : ''}${dirty}`, when, cmd].filter(Boolean).join(' · ')}`);
  L.push(rule('═'));

  // Index of failures; <CR> on one in nvim jumps to it.
  const failed = [];
  for (const [label, tests] of suites) for (const t of tests) if (t.status === 'fail') failed.push(`${label} › ${t.name}`);
  L.push('');
  if (failed.length) {
    L.push(`FAILURES (${failed.length})`);
    for (const f of failed) L.push(`  ✗ ${f}`);
  } else {
    L.push('FAILURES (0)');
    L.push('  none');
  }

  for (const [label, tests] of suites) {
    const sc = counts(tests);
    L.push('');
    L.push(rule('─'));
    L.push(spread(`▶ ${label}`, `${countText(sc)} · ${fmtMs(tests.reduce((s, t) => s + t.ms, 0))}`));
    L.push(rule('─'));
    for (const t of tests) {
      if (t.status === 'skip' || t.status === 'todo') {
        L.push(`  ${t.status === 'skip' ? '○ SKIP' : '◆ TODO'}  ${t.name}${t.reason ? `  (${t.reason})` : ''}`);
        continue;
      }
      L.push(spread(`  ${t.status === 'pass' ? '✓ PASS' : '✗ FAIL'}  ${t.name}`, fmtMs(t.ms)));
      for (const [k, v] of t.detail) L.push(k === 'msg' ? `          │ ${v}` : `          │ ${k.padEnd(8)}  ${v}`);
    }
  }
  L.push('');
  L.push(rule('═'));
  L.push(`  END · ${c.fail ? 'FAIL' : 'PASS'} · ${countText(c)}`);
  L.push(rule('═'));
  return { text: L.join('\n') + '\n', c, total: all.length };
}

// ---------- main ----------

let xml;
try { xml = fs.readFileSync(input, 'utf8'); } catch (e) {
  console.error(`can't read ${input}: ${e.message}`);
  process.exit(2);
}
const suites = collect(parseXml(xml));
if (!suites.size) {
  console.error(`no test cases found in ${input}`);
  process.exit(2);
}
const { text, c, total } = render(suites);
fs.writeFileSync(out, text);
console.log(`${c.fail ? 'FAIL' : 'PASS'}: ${countText(c)} (${total} total) → ${path.relative(process.cwd(), out).startsWith('..') ? out : path.relative(process.cwd(), out)}`);
process.exit(c.fail ? 1 : 0);
