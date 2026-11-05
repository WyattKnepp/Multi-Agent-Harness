-- nvim support for .testreport files (written by testing/testreport.js).
-- Install: link or copy this file into ~/.config/nvim/plugin/.
--
-- Colors come from the current theme's diagnostic groups, so they follow
-- theme switches. In a report:
--   ]f / [f   next / previous failing test
--   ]] / [[   next / previous suite
--   <CR>      on an entry under FAILURES: jump to that test
--   gF        on an "at file:line" detail: open the code (from the project root)
--   <Tab>     collapse / expand the suite under the cursor (also za)
--   zM / zR   collapse / expand every suite
--   /FAIL  /SKIP  /TODO  /▶      every line carries its status word, so plain search works

vim.filetype.add({ extension = { testreport = 'testreport' } })

-- The syntax rules are in syntax/testreport.lua next to this file (following
-- the symlink if this was linked into ~/.config/nvim/plugin/).
local here = vim.fn.fnamemodify(vim.fn.resolve(debug.getinfo(1, 'S').source:sub(2)), ':h')
if not vim.tbl_contains(vim.opt.runtimepath:get(), here) then vim.opt.runtimepath:append(here) end

local function hl(name)
  local ok, h = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false })
  return ok and h or {}
end

local function set_highlights()
  local set = function(group, spec) vim.api.nvim_set_hl(0, group, spec) end
  local bold = function(from) return { fg = hl(from).fg, bold = true } end
  set('testreportRule', { link = 'NonText' })
  set('testreportTitle', bold('Title'))
  set('testreportMeta', { link = 'Comment' })
  set('testreportResultPass', vim.tbl_extend('force', bold('DiagnosticOk'), { reverse = true }))
  set('testreportResultFail', vim.tbl_extend('force', bold('DiagnosticError'), { reverse = true }))
  set('testreportSection', bold('Statement'))
  set('testreportIndexFail', { link = 'DiagnosticError' })
  set('testreportSuite', bold('Function'))
  set('testreportPass', bold('DiagnosticOk'))
  set('testreportFail', bold('DiagnosticError'))
  set('testreportFailLine', { link = 'DiagnosticError' })
  set('testreportSkip', bold('DiagnosticWarn'))
  set('testreportSkipLine', { link = 'Comment' })
  set('testreportTodo', bold('DiagnosticHint'))
  set('testreportTodoLine', { link = 'DiagnosticHint' })
  set('testreportCountTodo', bold('DiagnosticHint'))
  set('testreportDuration', { link = 'Comment' })
  set('testreportBar', { link = 'NonText' })
  set('testreportExpected', { link = 'DiagnosticOk' })
  set('testreportActual', { link = 'DiagnosticError' })
  set('testreportAt', { link = 'Underlined' })
  set('testreportCountFail', bold('DiagnosticError'))
  set('testreportCountZero', { link = 'Comment' })
end


-- One fold per suite (and one for the FAILURES index); header and footer stay open.
function _G.testreport_fold(lnum)
  local line = vim.fn.getline(lnum)
  if line:match('^▶ ') or line:match('^FAILURES %(') then return '>1' end
  if line == '' or line:match('^═') or line:match('^  END · ') then return '0' end
  if line:match('^─') and vim.fn.getline(lnum + 1):match('^▶ ') then return '0' end
  if line:match('^  TEST REPORT · ') or line:match('^  RESULT: ') or line:match('^  commit ') or line:match('^  %d%d%d%d%-%d%d%-%d%d ') then return '0' end
  return '1'
end

-- A collapsed suite shows its header line (name and counts) and how many tests it hides.
function _G.testreport_foldtext()
  local first = vim.fn.getline(vim.v.foldstart)
  local tests = 0
  for l = vim.v.foldstart, vim.v.foldend do
    if vim.fn.getline(l):match('^  %S+ %u%u%u%u  ') then tests = tests + 1 end
  end
  return first .. (tests > 0 and ('  [' .. tests .. ' tests folded]') or '  [folded]')
end

-- <CR> on "  ✗ suite › test" under FAILURES: find the suite, then the test in it.
local function jump_to_failure()
  local line = vim.api.nvim_get_current_line()
  local entry = line:match('^  ✗ (.*)$')
  if not entry or line:match('^  ✗ FAIL  ') then return vim.cmd('normal! j') end
  local suite, name = entry:match('^(.*) › (.-)$')
  if not suite then return end
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local in_suite = false
  for i, l in ipairs(lines) do
    if l:sub(1, 4) == '▶ ' then
      local label = l:sub(5):gsub('%s%s+%d+ passed.*$', '')
      in_suite = label == suite
    elseif in_suite and l:sub(1, #('  ✗ FAIL  ' .. name)) == '  ✗ FAIL  ' .. name then
      vim.api.nvim_win_set_cursor(0, { i, 0 })
      vim.cmd('normal! zvzz')
      return
    end
  end
end

local group = vim.api.nvim_create_augroup('testreport', { clear = true })
vim.api.nvim_create_autocmd('ColorScheme', { group = group, callback = set_highlights })
vim.api.nvim_create_autocmd('FileType', {
  group = group,
  pattern = 'testreport',
  callback = function(ev)
    set_highlights()
    vim.opt_local.foldmethod = 'expr'
    vim.opt_local.foldexpr = 'v:lua.testreport_fold(v:lnum)'
    vim.opt_local.foldlevel = 99
    vim.opt_local.foldtext = 'v:lua.testreport_foldtext()'
    vim.opt_local.fillchars:append({ fold = ' ' })
    vim.opt_local.wrap = false
    vim.opt_local.spell = false
    vim.opt_local.list = false
    local map = function(lhs, rhs, desc) vim.keymap.set('n', lhs, rhs, { buffer = ev.buf, silent = true, desc = desc }) end
    map(']f', function() vim.fn.search('✗ FAIL', 'W') end, 'Next failing test')
    map('[f', function() vim.fn.search('✗ FAIL', 'bW') end, 'Previous failing test')
    map(']]', function() vim.fn.search('^▶ ', 'W') end, 'Next suite')
    map('[[', function() vim.fn.search('^▶ ', 'bW') end, 'Previous suite')
    map('<CR>', jump_to_failure, 'Jump to failing test')
    map('<Tab>', 'za', 'Collapse / expand suite')
  end,
})
