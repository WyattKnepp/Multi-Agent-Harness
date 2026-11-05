// The internal API contract (Lawn spec, "Ideas app API contract") mapped onto
// the pipeline's own data model. Pure functions only; storage is in store.js.
//
// Idea:    { id, project_id, title, body, status, created_at, updated_at, last_acted_at, stage }
// Project: { id, name, description, status, created_at }
//
// Contract status from the pipeline status (`stage`):
//   inbox                                        -> open
//   grilling, review, ready, dispatching, failed -> in_progress
//   dispatched                                   -> done if its deploy succeeded, else in_progress
//   archived                                     -> done if its deploy succeeded, else dropped
// An explicit status set through PATCH (idea.statusOverride = {status, base})
// wins for as long as the pipeline status is still `base`; once the web app
// moves the idea on, the mapping above takes over again.

const STATUSES = ['open', 'in_progress', 'done', 'dropped'];
const PROJECT_STATUSES = ['active', 'finished'];
// Pipeline statuses where the handoff's project has been confirmed by the user.
const SENT = ['ready', 'dispatching', 'dispatched', 'failed'];
const TITLE_MAX = 80;

function mappedStatus(idea) {
  const shipped = idea.deploy?.status === 'ok';
  switch (idea.status) {
    case 'inbox': return 'open';
    case 'dispatched': return shipped ? 'done' : 'in_progress';
    case 'archived': return shipped ? 'done' : 'dropped';
    default: return 'in_progress';
  }
}

function contractStatus(idea) {
  const o = idea.statusOverride;
  if (o && STATUSES.includes(o.status) && o.base === idea.status) return o.status;
  return mappedStatus(idea);
}

// An explicit projectId (set by PATCH or by sending the idea) wins, including
// an explicit null. Otherwise, ideas sent before projectId existed take the
// project from their confirmed handoff. An unconfirmed handoff is only
// Claude's suggestion, so it doesn't count.
function projectId(idea) {
  if (Object.prototype.hasOwnProperty.call(idea, 'projectId')) return idea.projectId ?? null;
  const confirmed = SENT.includes(idea.status) || !!idea.dispatch;
  return (confirmed && idea.handoff?.project) || null;
}

function title(idea) {
  const fromHandoff = String(idea.handoff?.title || '').trim();
  if (fromHandoff) return fromHandoff;
  const line = String(idea.text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > TITLE_MAX ? line.slice(0, TITLE_MAX - 1).trimEnd() + '…' : line;
}

const latest = (times) => times.filter(Boolean).sort().pop() || null;

// The last time someone did something with the idea: a grilling message, a
// status change or edit (actedAt, kept by store.update), or a dispatch/deploy
// event. null if nothing happened after it was captured.
function lastActedAt(idea) {
  return latest([
    idea.actedAt,
    ...(idea.messages || []).map((m) => m.at),
    idea.dispatch?.claimedAt,
    idea.dispatch?.at,
    idea.deploy?.at,
  ].map((t) => (typeof t === 'string' ? t : null)));
}

function toIdea(idea) {
  return {
    id: idea.id,
    project_id: projectId(idea),
    title: title(idea),
    body: String(idea.text || ''),
    status: contractStatus(idea),
    created_at: idea.createdAt,
    updated_at: idea.updatedAt,
    last_acted_at: lastActedAt(idea),
    stage: idea.status,
  };
}

// The web app's own unarchive rule (server.js, PATCH /api/ideas/:id).
const unarchived = (idea) => (idea.handoff ? 'review' : idea.messages?.length ? 'grilling' : 'inbox');

// The store patch that gives `idea` the contract status `want`:
//   done/dropped:      archive it (out of the inbox), unless the pipeline
//                      status already maps there. A dispatched idea marked done
//                      stays dispatched, so it keeps its place in the Sent tab.
//   open/in_progress:  unarchive it if it's archived.
// Then, if the pipeline status alone still maps elsewhere, pin `want` with an
// override tied to that pipeline status.
function statusPatch(idea, want) {
  let stage = idea.status;
  const probe = (s) => mappedStatus({ ...idea, status: s });
  if (want === 'done' || want === 'dropped') {
    const keep = probe(stage) === want || stage === 'archived' || (want === 'done' && stage === 'dispatched');
    if (!keep) stage = 'archived';
  } else if (stage === 'archived') {
    stage = unarchived(idea);
  }
  const patch = {};
  if (stage !== idea.status) patch.status = stage;
  patch.statusOverride = probe(stage) === want ? null : { status: want, base: stage };
  return patch;
}

// Ideas filter for GET /api/ideas. Returns {error} on bad input.
function parseIdeaQuery(query) {
  const out = { statuses: null, since: null };
  if (query.status !== undefined && query.status !== '') {
    const list = String(query.status).split(',').map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((s) => !STATUSES.includes(s));
    if (bad.length) return { error: `Unknown status ${bad.join(', ')}; use ${STATUSES.join(', ')}` };
    out.statuses = new Set(list);
  }
  if (query.updated_since !== undefined && query.updated_since !== '') {
    const t = Date.parse(String(query.updated_since));
    if (Number.isNaN(t)) return { error: 'updated_since must be an ISO-8601 timestamp' };
    out.since = t;
  }
  return out;
}

function filterIdeas(ideas, { statuses, since }) {
  return ideas
    .filter((i) => since === null || Date.parse(i.updated_at) >= since)
    .filter((i) => !statuses || statuses.has(i.status));
}

module.exports = {
  STATUSES, PROJECT_STATUSES,
  mappedStatus, contractStatus, projectId, title, lastActedAt, toIdea, statusPatch,
  parseIdeaQuery, filterIdeas,
};
