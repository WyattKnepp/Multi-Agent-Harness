-- Syntax rules for .testreport files. Colors: see ../testreport.lua.
if vim.b.current_syntax then return end
vim.cmd([[

syntax match testreportRule        /^[═─]\+$/
syntax match testreportTitle       /^  TEST REPORT · .*$/
syntax match testreportMeta        /^  \(commit \|\d\{4}-\d\d-\d\d \).*$/
syntax match testreportResultPass  /\(RESULT: \|END · \)PASS/
syntax match testreportResultFail  /\(RESULT: \|END · \)FAIL/
syntax match testreportSection     /^FAILURES (\d\+)$/
syntax match testreportIndexFail   /^  ✗ .*$/
syntax match testreportSuite       /^▶ .*$/ contains=testreportCountFail,testreportCountZero,testreportCountTodo
syntax match testreportPass        /✓ PASS/
syntax match testreportFailLine    /^  ✗ FAIL  .*$/ contains=testreportFail,testreportDuration
syntax match testreportFail        /✗ FAIL/ contained
syntax match testreportSkipLine    /^  ○ SKIP  .*$/ contains=testreportSkip
syntax match testreportSkip        /○ SKIP/ contained
syntax match testreportTodoLine    /^  ◆ TODO  .*$/ contains=testreportTodo
syntax match testreportTodo        /◆ TODO/ contained
syntax match testreportCountTodo   /[1-9]\d* todo/
syntax match testreportDuration    /\s\zs\d\+\(\.\d\+\)\?m\?s$/
syntax match testreportDetail      /^\s\+│.*$/ contains=testreportBar,testreportExpected,testreportActual,testreportAt
syntax match testreportBar         /│/ contained
syntax match testreportExpected    /\(│ \)\@<=expected .*$/ contained
syntax match testreportActual      /\(│ \)\@<=actual .*$/ contained
syntax match testreportAt          /\(│ \)\@<=at\s\+\S\+$/ contained
syntax match testreportCountFail   /[1-9]\d* failed/
syntax match testreportCountZero   /\<0 \(failed\|skipped\)/
]])
vim.b.current_syntax = 'testreport'
