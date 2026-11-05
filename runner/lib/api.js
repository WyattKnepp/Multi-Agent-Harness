// HTTP to the pipeline's internal API (jobs) and to Lawn (chat reports).
// Tokens go in headers only, never in argv or logs.
const fs = require('fs');

async function request(url, { method = 'GET', token, body, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || res.statusText;
    const err = new Error(`${method} ${new URL(url).pathname}: ${res.status} ${msg}`);
    err.status = res.status;
    throw err;
  }
  return { status: res.status, data };
}

function pipeline(cfg) {
  const call = (method, path, body) => request(cfg.pipelineUrl + path, { method, token: cfg.pipelineToken, body });
  return {
    hello: () => call('POST', '/api/runner/hello').then((r) => r.data),
    claim: () => call('POST', '/api/runner/claim').then((r) => (r.status === 204 ? null : r.data)),
    update: (id, patch) => call('PATCH', `/api/jobs/${id}`, patch).then((r) => r.data),
    list: (query) => call('GET', `/api/jobs?${new URLSearchParams(query)}`).then((r) => r.data),
  };
}

// Lawn: append an assistant message to the job's chat thread. Lawn looks the
// thread up from the job itself, so the runner can only post where the user
// asked for the change. Failures are logged, never fatal: the job record in the
// pipeline is the source of truth.
function lawn(cfg, log) {
  let token = null;
  const readToken = () => {
    if (token) return token;
    try { token = fs.readFileSync(cfg.lawnTokenFile, 'utf8').trim(); } catch { token = ''; }
    return token;
  };
  return {
    async report(job, text) {
      if (job.source !== 'lawn' || !job.thread_id) return false;
      if (!readToken()) { log(`job ${job.id}: no Lawn token at ${cfg.lawnTokenFile}; chat report skipped`); return false; }
      try {
        await request(`${cfg.lawnUrl}/api/change-requests/${job.id}/report`, { method: 'POST', token, body: { text } });
        return true;
      } catch (e) {
        log(`job ${job.id}: chat report failed: ${e.message}`);
        return false;
      }
    },
  };
}

module.exports = { request, pipeline, lawn };
