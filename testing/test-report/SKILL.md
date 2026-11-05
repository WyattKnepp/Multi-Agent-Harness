---
name: test-report
description: How tests work in this project. One uniform setup across all of the user's projects (node:test files in tests/, run with make test, results in test-report.testreport, which the user reads in nvim). Use whenever writing, changing, running or reading tests, after changing behavior, and before deploying.
---

# Tests in this project

Every one of the user's projects tests the same way, so they get one report
format everywhere. Follow this exactly; don't bring in another test setup.

## Run them

```
make -C {{PIPELINE_DIR}} test PROJECT={{PROJECT}}
```

This runs every `tests/**/*.test.{js,mjs,cjs,ts,mts}` file with Node's
built-in test runner, prints progress, and writes **`test-report.testreport`**
at the project root. It exits non-zero if anything failed. Read the report to
see what failed and why: it lists failures first, then every test with
expected/actual values and the file:line where each failure happened.

- Never write or edit the `.testreport` file by hand. It is generated, as is
  `.test-results.xml`; both are gitignored.
- If this project is deployed, `make deploy` runs the same tests first and
  refuses to deploy if any test fails.

## Write them

**Runner.** Use Node's built-in `node:test` and `node:assert/strict` only. No
jest, vitest, mocha or other test dependencies. Node 22+ has everything you
need: `fetch`, `child_process`, `fs`, `os.tmpdir()`. TypeScript test files
work through Node's type stripping (erasable syntax only).

```js
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
```

**Any language.** Python, C/C++, shell and other non-Node projects are tested
from the outside. Start the server, or run the script or binary, with
`child_process`, then check its output, exit code, files or HTTP responses.
Build first in a `before` hook if needed (e.g. `make`).

**What to cover.** Test what the user would notice breaking, from the outside
in:
1. The app starts (or builds) cleanly.
2. Every main user flow (each API route, command or page): the happy path
   plus the obvious bad input.
3. If the app stores data, that the data survives a restart.
4. Logic that's easy to get wrong: dates, units, scoring, parsing.

A few meaningful tests beat many trivial ones. 10-40 tests is typical.

**Servers.**
- Start the real server as a child process on a free port: listen on port 0,
  read the port and close it, then pass it in as `PORT`. Pass
  `HOST=127.0.0.1` too.
- Wait for the server by polling until it answers; don't use fixed sleeps.
- Kill it in `after`.
- Several agents may run tests on this laptop at once, so never hardcode a
  port.

**Never touch real data or the outside world.**
- Point the app at a fresh temp dir:
  `fs.mkdtempSync(path.join(os.tmpdir(), '<project>-'))`.
- If the app hardcodes its data path, add an environment override (e.g.
  `DATA_DIR`) that defaults to the current path. Make the smallest possible
  change and mention it in your final message.
- No real external APIs, emails, payments or hardware. Skip those tests with
  a reason.

**Names are the coverage list the user reads.**
- `describe` is the area, named `"<kind>: <area>"`, e.g. `api: workouts`,
  `cli: import`, `ui: main page`, `logic: scoring`, `data: persistence`,
  `build: firmware`.
- `test` is one plain-English sentence describing the behavior, e.g.
  `rejects a workout with no exercises`.

**Skips.** When something can't run on the laptop, skip it with a real reason:
`test('…', { skip: 'needs the Arduino attached' }, …)`. For hardware or GUI
projects, test what can run (pure logic, the build succeeding) and skip the
rest with the reason.

**Known bugs.** If a test exposes a real bug that's outside your task, keep
the test and mark it `{ todo: 'BUG: <what is wrong>' }`. It shows as TODO in
the report without blocking deploys. Tell the user about it in your final
message.

**Fast and deterministic.**
- The whole suite should finish in under about a minute.
- Poll instead of sleeping.
- No dependence on test order, and no randomness without a fixed seed.

**Green means honest.** A failing test is a bug in the code or in the test.
Fix whichever one is wrong. Never weaken an assertion, delete a test or skip
it just to get a pass.

## Files

| Path | What |
| --- | --- |
| `tests/*.test.js` (subfolders fine) | the tests |
| `tests/helpers/` | shared helpers (not named `*.test.*`) |
| `test-report.testreport`, `.test-results.xml` | generated, gitignored |
| `.claude/skills/test-report/SKILL.md` | this file (installed by the idea pipeline; don't edit, it gets overwritten) |

When you commit, stage only the files you created or changed (`git add
tests/ <files>`), never `git add -A`. This project may contain unrelated work
in progress.
