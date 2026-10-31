import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { changedFiles, changeKind } from './change-kind.mjs'

const [base = 'origin/main', head = 'HEAD'] = process.argv.slice(2)
// Git sets GIT_DIR for hooks, and it wins over `git -C`, so a pre-push run would check out commits in the caller's worktree.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE)$/.test(key)),
)
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim()

const commits = git('rev-list', '--reverse', `${base}..${head}`).split('\n').filter(Boolean)
const passedFile = join(git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'tape-verified-trees')
const passed = new Set(readFileSync(passedFile, { encoding: 'utf8', flag: 'a+' }).split('\n'))
const treeOf = (sha) => git('rev-parse', `${sha}^{tree}`)
const pending = commits.filter((sha) => !passed.has(treeOf(sha)))

if (pending.length === 0) {
  console.log(`verify ok: ${commits.length} commits since ${base}, each verified before`)
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'tape-verify-'))
const logs = mkdtempSync(join(tmpdir(), 'tape-verify-logs-'))
// --ignore-scripts keeps an older commit's `prepare` from reinstalling its own lefthook hooks over the current ones.
const install = (log, ...flags) =>
  spawnSync('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', ...flags], {
    cwd: dir,
    env,
    stdio: ['ignore', log, log],
  }).status === 0

const failed = []
let lockfile
git('worktree', 'add', '--detach', dir, pending[0])
try {
  for (const sha of pending) {
    const subject = git('log', '-1', '--format=%h %s', sha)
    const logPath = join(logs, `${sha.slice(0, 7)}.log`)
    const log = openSync(logPath, 'w')
    git('-C', dir, 'checkout', '--quiet', '--detach', sha)
    const lock = git('rev-parse', `${sha}:pnpm-lock.yaml`)
    const installed = lock === lockfile || install(log, '--offline') || install(log)
    lockfile = installed ? lock : undefined
    const docsOnly = changeKind(changedFiles(`${sha}^..${sha}`, env)) === 'docs'
    const verify = docsOnly ? ['verify', '--docs'] : ['verify']
    const ok = installed && spawnSync('pnpm', verify, { cwd: dir, env, stdio: ['ignore', log, log] }).status === 0
    closeSync(log)
    if (ok && docsOnly) {
      console.log(`ok    ${subject} (markdown only)`)
    } else if (ok) {
      appendFileSync(passedFile, `${treeOf(sha)}\n`)
      console.log(`ok    ${subject}`)
    } else {
      failed.push(subject)
      // The dYdX client ships source maps that point outside its package, and Vite warns once per file.
      const tail = readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith('Sourcemap for '))
        .slice(-15)
      console.log(`FAIL  ${subject}\n${tail.map((line) => `      ${line}`).join('\n')}\n      full log: ${logPath}`)
    }
  }
} finally {
  git('worktree', 'remove', '--force', dir)
}

if (failed.length > 0) {
  console.error(`\n${failed.length} of ${commits.length} commits since ${base} fail pnpm verify on their own.`)
  console.error(`Fix each in the commit that broke it: git commit --fixup=<sha>, then`)
  console.error(`GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash ${base}. See Commits in CLAUDE.md.`)
  process.exit(1)
}
console.log(`verify ok: ${commits.length} commits since ${base}`)
