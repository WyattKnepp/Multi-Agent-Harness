// JSON-file storage. Everything lives in data/ (gitignored, created on start).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const IDEAS_FILE = path.join(DATA_DIR, 'ideas.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
// Per-project metadata the laptop sync doesn't carry: {projects: {<name>:
// {createdAt, status, origin}}}. A separate file so projects.json keeps its
// shape and an older server.js can still run against the same data/.
const REGISTRY_FILE = path.join(DATA_DIR, 'project-registry.json');
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
      contextNotes: [], // plain-text notes [{id, text, at, delivered}]; delivered = already sent to the claude session
      dispatch: null,
      deploy: null, // latest `make deploy` result: {status: ok|failed, commit, message, log, at}
    };
    ideas.unshift(idea);
    save();
    return idea;
  },

  // A status change or a text edit counts as acting on the idea (actedAt,
  // read by the internal API's last_acted_at). Pass actedAt to force it.
  update(id, patch) {
    const idea = ideas.find((i) => i.id === id);
    if (!idea) return null;
    const acted = ('status' in patch && patch.status !== idea.status) || ('text' in patch && patch.text !== idea.text);
    Object.assign(idea, patch, { updatedAt: now() });
    if (acted && !('actedAt' in patch)) idea.actedAt = idea.updatedAt;
    // A status pinned through the internal API lasts until the web app or the
    // dispatcher moves the idea on; it must not come back if the idea returns
    // to the old status later.
    const moved = 'status' in patch && !('statusOverride' in patch);
    if (idea.statusOverride === null || moved) delete idea.statusOverride;
    save();
    return idea;
  },

  // Context notes. Older ideas have no contextNotes field. These only touch
  // the notes, so they're safe to call while a grilling turn is running.
  // Each returns the idea, or null if the idea (or note) doesn't exist.
  addNote(id, text) {
    const idea = ideas.find((i) => i.id === id);
    if (!idea) return null;
    return module.exports.update(id, {
      contextNotes: [...(idea.contextNotes || []), { id: crypto.randomBytes(4).toString('hex'), text, at: now(), delivered: false }],
    });
  },

  editNote(id, noteId, text) {
    const idea = ideas.find((i) => i.id === id);
    if (!idea || !(idea.contextNotes || []).some((n) => n.id === noteId)) return null;
    return module.exports.update(id, { contextNotes: idea.contextNotes.map((n) => (n.id === noteId ? { ...n, text } : n)) });
  },

  removeNote(id, noteId) {
    const idea = ideas.find((i) => i.id === id);
    if (!idea || !(idea.contextNotes || []).some((n) => n.id === noteId)) return null;
    return module.exports.update(id, { contextNotes: idea.contextNotes.filter((n) => n.id !== noteId) });
  },

  // Mark notes as sent to the session (ids), or with no ids mark all of them
  // undelivered again, for a fresh session.
  setDelivered(id, ids) {
    const idea = ideas.find((i) => i.id === id);
    if (!idea) return null;
    const notes = (idea.contextNotes || []).map((n) => ({ ...n, delivered: ids ? n.delivered || ids.includes(n.id) : false }));
    return module.exports.update(id, { contextNotes: notes });
  },

  remove(id) {
    const before = ideas.length;
    ideas = ideas.filter((i) => i.id !== id);
    save();
    return ideas.length !== before;
  },

  projects: () => readJson(PROJECTS_FILE, { syncedAt: null, projects: [] }),

  // Every project the internal API knows: the laptop's projects plus ones
  // created through the API that the laptop doesn't have yet.
  // [{name, description, status, createdAt, origin}]
  allProjects() {
    const reg = syncRegistry();
    const laptop = module.exports.projects().projects;
    const names = new Set(laptop.map((p) => p.name));
    return [
      ...laptop.map((p) => ({ name: p.name, description: p.description || '', ...reg[p.name] })),
      ...Object.entries(reg)
        .filter(([name, m]) => m.origin === 'api' && !names.has(name))
        .map(([name, m]) => ({ name, description: '', ...m })),
    ];
  },

  // Register a project the laptop doesn't have yet. Returns null if the name
  // is taken.
  createProject(name, status = 'active') {
    const reg = syncRegistry();
    if (reg[name] || module.exports.projects().projects.some((p) => p.name === name)) return null;
    reg[name] = { createdAt: now(), status, origin: 'api' };
    writeRegistry(reg);
    return module.exports.allProjects().find((p) => p.name === name);
  },

  syncRegistry: () => syncRegistry(),

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
    syncRegistry();
  },
};

function writeRegistry(reg) {
  writeJson(REGISTRY_FILE, { version: 1, projects: reg });
}

// Make sure every laptop project has a registry entry. Runs on start (which is
// the whole data migration: additive, and it never touches ideas.json or
// projects.json) and after every laptop sync. A project seen for the first
// time is dated by the earliest idea that names it, else now. A project made
// through the API becomes a laptop project once the laptop syncs one with that
// name, keeping its createdAt and status. Laptop projects that disappear keep
// their entry, so their dates survive if they come back.
function syncRegistry() {
  const reg = readJson(REGISTRY_FILE, { projects: {} }).projects || {};
  let changed = false;
  for (const p of module.exports.projects().projects) {
    const m = reg[p.name];
    if (!m) {
      const named = ideas
        .filter((i) => i.projectId === p.name || i.handoff?.project === p.name)
        .map((i) => i.createdAt)
        .filter(Boolean)
        .sort();
      reg[p.name] = { createdAt: named[0] || now(), status: 'active', origin: 'laptop' };
      changed = true;
    } else if (m.origin !== 'laptop') {
      m.origin = 'laptop';
      changed = true;
    }
  }
  if (changed) writeRegistry(reg);
  return reg;
}
