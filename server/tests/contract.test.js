// Pure mapping from the pipeline's data model to the internal API contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../contract');

const idea = (over = {}) => ({
  id: 'abc123',
  text: 'Add a dark mode\nso it is easier at night',
  status: 'inbox',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  grillSession: null,
  messages: [],
  handoff: null,
  dispatch: null,
  deploy: null,
  ...over,
});

test('pipeline statuses map to contract statuses', () => {
  const cases = [
    ['inbox', null, 'open'],
    ['grilling', null, 'in_progress'],
    ['review', null, 'in_progress'],
    ['ready', null, 'in_progress'],
    ['dispatching', null, 'in_progress'],
    ['failed', null, 'in_progress'],
    ['dispatched', null, 'in_progress'],
    ['dispatched', { status: 'failed' }, 'in_progress'],
    ['dispatched', { status: 'ok' }, 'done'],
    ['archived', null, 'dropped'],
    ['archived', { status: 'ok' }, 'done'],
    ['something-new', null, 'in_progress'],
  ];
  for (const [status, deploy, want] of cases) {
    assert.equal(c.contractStatus(idea({ status, deploy })), want, `${status} ${JSON.stringify(deploy)}`);
  }
});

test('a status override holds only while the pipeline status is unchanged', () => {
  const i = idea({ status: 'grilling', statusOverride: { status: 'open', base: 'grilling' } });
  assert.equal(c.contractStatus(i), 'open');
  assert.equal(c.contractStatus({ ...i, status: 'review' }), 'in_progress');
  assert.equal(c.contractStatus({ ...i, statusOverride: { status: 'bogus', base: 'grilling' } }), 'in_progress');
});

test('project_id: explicit value wins, otherwise only a confirmed handoff counts', () => {
  const handoff = { title: 'Dark mode', project: 'Workout-Tracker', isNew: false, brief: 'b' };
  assert.equal(c.projectId(idea()), null);
  assert.equal(c.projectId(idea({ status: 'review', handoff })), null, 'a suggestion is not a link');
  assert.equal(c.projectId(idea({ status: 'dispatched', handoff })), 'Workout-Tracker');
  assert.equal(c.projectId(idea({ status: 'archived', handoff, dispatch: { at: 'x' } })), 'Workout-Tracker');
  assert.equal(c.projectId(idea({ status: 'archived', handoff })), null);
  assert.equal(c.projectId(idea({ status: 'dispatched', handoff, projectId: 'Lawn' })), 'Lawn');
  assert.equal(c.projectId(idea({ status: 'dispatched', handoff, projectId: null })), null);
});

test('title comes from the handoff, else the first non-empty line, capped', () => {
  assert.equal(c.title(idea()), 'Add a dark mode');
  assert.equal(c.title(idea({ text: '\n\n  spaced out  \nmore' })), 'spaced out');
  assert.equal(c.title(idea({ handoff: { title: 'From handoff' } })), 'From handoff');
  const long = c.title(idea({ text: 'x'.repeat(200) }));
  assert.equal(long.length, 80);
  assert.ok(long.endsWith('…'));
});

test('last_acted_at is the latest action, or null when untouched', () => {
  assert.equal(c.lastActedAt(idea()), null);
  const i = idea({
    actedAt: '2026-10-03T00:00:00.000Z',
    messages: [{ role: 'me', at: '2026-10-02T00:00:00.000Z' }, { role: 'claude', at: '2026-10-05T00:00:00.000Z' }],
    dispatch: { claimedAt: '2026-10-04T00:00:00.000Z' },
  });
  assert.equal(c.lastActedAt(i), '2026-10-05T00:00:00.000Z');
  assert.equal(c.lastActedAt({ ...i, deploy: { at: '2026-10-09T00:00:00.000Z' } }), '2026-10-09T00:00:00.000Z');
});

test('toIdea has every contract field and the pipeline stage', () => {
  const out = c.toIdea(idea());
  assert.deepEqual(Object.keys(out).sort(), ['body', 'created_at', 'id', 'last_acted_at', 'project_id', 'stage', 'status', 'title', 'updated_at']);
  assert.equal(out.body, 'Add a dark mode\nso it is easier at night');
  assert.equal(out.stage, 'inbox');
});

test('statusPatch reaches the requested status with the least change', () => {
  const apply = (i, want) => {
    const patch = c.statusPatch(i, want);
    const next = { ...i, ...patch };
    assert.equal(c.contractStatus(next), want, `${i.status} -> ${want}`);
    return patch;
  };
  // done / dropped archive the idea...
  assert.deepEqual(apply(idea(), 'done'), { status: 'archived', statusOverride: { status: 'done', base: 'archived' } });
  assert.deepEqual(apply(idea(), 'dropped'), { status: 'archived', statusOverride: null });
  // ...except a dispatched idea marked done stays in the Sent tab.
  assert.deepEqual(apply(idea({ status: 'dispatched' }), 'done'), { statusOverride: { status: 'done', base: 'dispatched' } });
  assert.deepEqual(apply(idea({ status: 'dispatched', deploy: { status: 'ok' } }), 'done'), { statusOverride: null });
  assert.deepEqual(apply(idea({ status: 'dispatched' }), 'dropped'), { status: 'archived', statusOverride: null });
  // open / in_progress unarchive by the web app's own rule.
  assert.deepEqual(apply(idea({ status: 'archived' }), 'open'), { status: 'inbox', statusOverride: null });
  assert.deepEqual(apply(idea({ status: 'archived', messages: [{ at: 'x' }] }), 'open'), { status: 'grilling', statusOverride: { status: 'open', base: 'grilling' } });
  assert.deepEqual(apply(idea({ status: 'archived', handoff: { project: 'p' } }), 'in_progress'), { status: 'review', statusOverride: null });
  assert.deepEqual(apply(idea(), 'in_progress'), { statusOverride: { status: 'in_progress', base: 'inbox' } });
  assert.deepEqual(apply(idea(), 'open'), { statusOverride: null });
});

test('idea query parsing and filtering', () => {
  assert.match(c.parseIdeaQuery({ status: 'open,nope' }).error, /nope/);
  assert.match(c.parseIdeaQuery({ updated_since: 'yesterday' }).error, /ISO-8601/);
  const q = c.parseIdeaQuery({ status: 'open, in_progress', updated_since: '2026-10-02T00:00:00Z' });
  assert.deepEqual([...q.statuses], ['open', 'in_progress']);
  const rows = [
    { id: 'a', status: 'open', updated_at: '2026-10-01T00:00:00.000Z' },
    { id: 'b', status: 'open', updated_at: '2026-10-02T00:00:00.000Z' },
    { id: 'c', status: 'done', updated_at: '2026-10-03T00:00:00.000Z' },
  ];
  assert.deepEqual(c.filterIdeas(rows, q).map((r) => r.id), ['b'], 'updated_since is inclusive');
  assert.equal(c.filterIdeas(rows, c.parseIdeaQuery({})).length, 3);
});
