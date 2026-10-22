// JSON-file storage. Everything lives in data/ (gitignored, created on start).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const IDEAS_FILE = path.join(DATA_DIR, 'ideas.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const CONTEXT_DIR = path.join(DATA_DIR, 'context');
fs.mkdirSync(DATA_DIR, { recursive: true });

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Write to a temp file then rename, so a crash mid-write never truncates data.
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

let ideas = readJson(IDEAS_FILE, []);
const save = () => writeJson(IDEAS_FILE, ideas);
const now = () => new Date().toISOString();

module.exports = {
  DATA_DIR,
  CONTEXT_DIR,
  now,
  list: () => ideas,
  get: (id) => ideas.find((i) => i.id === id),

  create(text) {
    const idea = {
      id: crypto.randomBytes(6).toString('hex'),
      text,
      status: 'inbox', // inbox → grilling → review → ready → dispatching → dispatched | failed; archived
      createdAt: now(),
      updatedAt: now(),
      grillSession: null,
      messages: [],
      handoff: null,
      dispatch: null,
    };
    ideas.unshift(idea);
    save();
    return idea;
  },

  update(id, patch) {
    const idea = ideas.find((i) => i.id === id);
    if (!idea) return null;
    Object.assign(idea, patch, { updatedAt: now() });
    save();
    return idea;
  },

  remove(id) {
    const before = ideas.length;
    ideas = ideas.filter((i) => i.id !== id);
    save();
    return ideas.length !== before;
  },

  projects: () => readJson(PROJECTS_FILE, { syncedAt: null, projects: [] }),

  // projects: [{name, description, context: {file, text} | null}]. The
  // context text goes to CONTEXT_DIR/<name>.md for the griller to read;
  // files for projects that no longer exist are removed.
  setProjects(projects) {
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    const keep = new Set();
    for (const p of projects) {
      if (!p.context) continue;
      const file = path.join(CONTEXT_DIR, `${p.name}.md`);
      const body = `<!-- ${p.name}/${p.context.file} -->\n${p.context.text}`;
      keep.add(`${p.name}.md`);
      if (readText(file) !== body) fs.writeFileSync(file, body);
    }
    for (const f of fs.readdirSync(CONTEXT_DIR)) if (!keep.has(f)) fs.rmSync(path.join(CONTEXT_DIR, f));
    writeJson(PROJECTS_FILE, {
      syncedAt: now(),
      projects: projects.map((p) => ({ name: p.name, description: p.description, contextFile: p.context ? p.context.file : null })),
    });
  },
};
