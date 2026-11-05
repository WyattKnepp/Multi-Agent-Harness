#!/usr/bin/env node
// Stand-in for `claude -p` in the runner's tests. It makes a deterministic
// edit in the worktree (its cwd) from the brief, records how it was called
// (argv and env names only, never values) in $HOME/calls.jsonl, and prints the
// same JSON shape as `claude -p --output-format json`.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const brief = fs.readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8');
fs.appendFileSync(path.join(process.env.HOME, 'calls.jsonl'), JSON.stringify({
  args, env: Object.keys(process.env).sort(), cwd: process.cwd(),
  token: process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'set' : 'missing',
}) + '\n');

let result;
if (brief.includes('NOOP')) {
  result = 'Nothing to do.';
} else if (brief.includes('SECRET')) {
  fs.writeFileSync('.env', 'TOKEN=oops\n');
  result = 'Wrote an env file.';
} else {
  const msg = brief.includes('BREAK') ? 'BROKEN greeting' : (/Greeting: (.+)/.exec(brief)?.[1] || 'Hello from a change');
  fs.writeFileSync('message.txt', msg + '\n');
  result = `Set message.txt to "${msg}".`;
}
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result }) + '\n');
