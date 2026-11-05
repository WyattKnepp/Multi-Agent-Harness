#!/usr/bin/env node
// Stand-in for the `claude` CLI (set CLAUDE_BIN to this file). Appends each
// message it receives on stdin to $FAKE_CLAUDE_LOG (one JSON line) and replies
// like `claude -p --output-format json`.
const fs = require('fs');

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(input) + '\n');
  const out = input.includes('Grilling is over')
    ? { result: JSON.stringify({ title: 'T', project: 'Proj', isNew: false, visibility: 'private', brief: 'B' }) }
    : { result: '', structured_output: { comment: 'ok', questions: [], done: false } };
  process.stdout.write(JSON.stringify(out));
});
