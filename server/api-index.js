// `GET /api` on the internal API: every endpoint, self-described in the same
// shape as Lawn's `GET /api` index (method, path, summary, plus optional tool,
// effect, agent, query, body). An agent tool layer (Lawn's agent/src/tools.ts
// reads exactly this shape) can turn each entry into one tool, so a later
// unified agent can sit on top of several apps' indexes without per-app code.
// Every entry is served behind the same bearer token as the rest of the API.

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const STATUS_LIST = 'Comma-separated statuses';

const ENDPOINTS = [
  { method: 'GET', path: '/api', summary: 'This index', agent: false },
  { method: 'GET', path: '/api/health', summary: 'Liveness: {ok: true}', agent: false },
  { method: 'GET', path: '/api/projects', summary: "Projects the ideas app knows (the laptop's plus API-made ones)", tool: 'list_projects', effect: 'read' },
  {
    method: 'POST', path: '/api/projects', summary: 'Register a project: {name, status?}', tool: 'create_project', effect: 'write',
    body: obj({ name: str('Folder name: letters, digits, . _ -'), status: str('active or finished', { enum: ['active', 'finished'] }) }, ['name']),
  },
  {
    method: 'GET', path: '/api/ideas', summary: 'Ideas; filters: status (open,in_progress,done,dropped), updated_since', tool: 'list_ideas', effect: 'read',
    query: obj({ status: str(STATUS_LIST), updated_since: str('ISO-8601 time') }),
  },
  { method: 'GET', path: '/api/ideas/{id}', summary: 'One idea', tool: 'get_idea', effect: 'read' },
  {
    method: 'PATCH', path: '/api/ideas/{id}', summary: "Change an idea's status and/or project: {status?, project_id?}", tool: 'update_idea', effect: 'write',
    body: obj({ status: str('open, in_progress, done or dropped', { enum: ['open', 'in_progress', 'done', 'dropped'] }), project_id: { type: ['string', 'null'], description: 'Project id, or null' } }),
  },
  {
    method: 'POST', path: '/api/jobs',
    summary: 'File an APPROVED droplet change job (the runner builds it with Claude Code): {project, title, brief, mode?, thread_id?, source?}',
    tool: 'create_change_job', effect: 'write',
    body: obj({
      project: str('Project folder name; must have a runner block in projects.deploy.json'),
      title: str('Short title'),
      brief: str('Complete brief for Claude Code; it cannot ask questions'),
      mode: str('preview (default) or live', { enum: ['preview', 'live'] }),
      thread_id: { type: 'integer', description: 'Lawn chat thread to report progress to' },
      source: str('lawn or api (default: lawn with a thread_id, else api)', { enum: ['lawn', 'api'] }),
    }, ['project', 'title', 'brief']),
  },
  {
    method: 'GET', path: '/api/jobs', summary: 'Change jobs, newest first; filters: thread_id, idea_id, source, project, status, limit', tool: 'list_change_jobs', effect: 'read',
    query: obj({ thread_id: { type: 'integer' }, idea_id: str('Idea id'), source: str('lawn, ideas or api'), project: str('Project'), status: str(STATUS_LIST), limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  },
  {
    method: 'GET', path: '/api/jobs/{id}', summary: 'One change job; full=1 adds the whole brief and the log tail', tool: 'get_change_job', effect: 'read',
    query: obj({ full: { type: 'boolean' } }),
  },
  {
    method: 'POST', path: '/api/jobs/{id}/actions', summary: 'Ask the runner to ship a preview live, discard a preview, or roll back a live change: {action}',
    tool: 'change_job_action', effect: 'write',
    body: obj({ action: str('ship, discard or rollback', { enum: ['ship', 'discard', 'rollback'] }) }, ['action']),
  },
  { method: 'POST', path: '/api/runner/hello', summary: 'Runner start: release claims left by a crash', agent: false },
  { method: 'POST', path: '/api/runner/claim', summary: 'Runner: take the next action or queued job (204 if none)', agent: false },
  { method: 'PATCH', path: '/api/jobs/{id}', summary: 'Runner: report progress on a job', agent: false },
];

function index() {
  return {
    name: 'idea-pipeline internal API',
    version: '1',
    conventions: {
      auth: 'Authorization: Bearer <INTERNAL_TOKEN> on every request; loopback only',
      errors: '{error: "<message>"} with a 4xx/5xx status',
    },
    path_params: { id: { type: 'string', description: 'Record id' } },
    endpoints: ENDPOINTS,
  };
}

module.exports = { index, ENDPOINTS };
