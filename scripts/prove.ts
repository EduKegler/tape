import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { z } from 'zod'

const execFileAsync = promisify(execFile)

const vitestReport = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      message: z.string().optional(),
      assertionResults: z.array(z.object({ fullName: z.string(), status: z.string() })),
    }),
  ),
})

type VitestReport = z.infer<typeof vitestReport>

export type RunOutcome = 'passed' | 'assertion-failed' | 'load-failed'

export type RunResult = {
  outcome: RunOutcome
  tests: number
  failedTests: string[]
  loadProblems: string[]
}

export type Verdict = 'proved' | 'not proved' | 'could not run'

const EXIT_CODES: Record<Verdict, number> = { proved: 0, 'not proved': 1, 'could not run': 2 }

export const exitCode = (verdict: Verdict): number => EXIT_CODES[verdict]

export const readRun = (report: VitestReport, tree: string): RunResult => {
  const short = (path: string) => relative(tree, path)
  const failedTests: string[] = []
  const loadProblems: string[] = []
  let tests = 0
  for (const file of report.testResults) {
    tests += file.assertionResults.length
    const failed = file.assertionResults.filter((test) => test.status === 'failed')
    failedTests.push(...failed.map((test) => `${short(file.name)} > ${test.fullName}`))
    if (file.assertionResults.length === 0 || (file.status === 'failed' && failed.length === 0)) {
      loadProblems.push(`${short(file.name)}: ${file.message?.trim() || 'no test ran'}`)
    }
  }
  if (report.testResults.length === 0) loadProblems.push('vitest found no test file')
  const outcome = loadProblems.length > 0 ? 'load-failed' : failedTests.length > 0 ? 'assertion-failed' : 'passed'
  return { outcome, tests, failedTests, loadProblems }
}

export const verdictOf = (base: RunOutcome, head: RunOutcome): Verdict => {
  if (head !== 'passed' || base === 'load-failed') return 'could not run'
  return base === 'assertion-failed' ? 'proved' : 'not proved'
}

export const refusal = (paths: readonly string[]): string | undefined => {
  if (paths.length === 0) return 'Name at least one Vitest test file, such as src/ui/Ticket.test.tsx.'
  const refused = paths.filter((path) => !/\.test\.tsx?$/.test(path) || /(?:^|\/)e2e\//.test(path))
  if (refused.length === 0) return undefined
  return `${refused.join(', ')}: pnpm prove covers Vitest files (*.test.ts, *.test.tsx) only, not Playwright specs under e2e/.`
}

type Git = (...args: string[]) => Promise<string>

const gitIn =
  (cwd: string): Git =>
  async (...args) =>
    (await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim()

const linkInstall = async (root: string, tree: string) => {
  const workspaceDirs = ['.', ...(await readdir(join(root, 'packages'))).map((name) => join('packages', name))]
  for (const dir of workspaceDirs) {
    const source = join(root, dir, 'node_modules')
    if (!existsSync(source)) continue
    const target = join(tree, dir, 'node_modules')
    await mkdir(target, { recursive: true })
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name.startsWith('@') && entry.isDirectory()) {
        await mkdir(join(target, entry.name), { recursive: true })
        for (const member of await readdir(join(source, entry.name))) {
          await linkEntry(root, tree, join(source, entry.name, member), join(target, entry.name, member))
        }
      } else {
        await linkEntry(root, tree, join(source, entry.name), join(target, entry.name))
      }
    }
  }
}

const linkEntry = async (root: string, tree: string, source: string, destination: string) => {
  const real = await realpath(source).catch(() => source)
  const own = relative(join(root, 'packages'), real)
  const isWorkspacePackage = !own.startsWith('..') && !own.includes(sep) && own !== ''
  await symlink(isWorkspacePackage ? join(tree, 'packages', own) : real, destination)
}

const lockfileDiffers = async (git: Git, root: string, base: string) => {
  const baseLock = await git('show', `${base}:pnpm-lock.yaml`).catch(() => undefined)
  const headLock = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')
  return baseLock?.trim() !== headLock.trim()
}

let running: ChildProcess | undefined
let interrupted = false

const stopIfInterrupted = () => {
  if (interrupted) throw new Error('Interrupted')
}

const spawnIn = (cwd: string, command: string, args: readonly string[]) =>
  new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    running = child
    const output: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk))
    child.on('error', (error) => done({ code: null, output: error.message }))
    child.on('close', (code) => done({ code, output: Buffer.concat(output).toString() }))
  })

const prove = async (cwd: string, files: readonly string[], reportDir: string, name: string): Promise<RunResult> => {
  const reportFile = join(reportDir, `${name}.json`)
  const { output } = await spawnIn(cwd, 'pnpm', [
    'exec',
    'vitest',
    'run',
    '--reporter=json',
    `--outputFile=${reportFile}`,
    ...files,
  ])
  stopIfInterrupted()
  const parsed = vitestReport.safeParse(JSON.parse(await readFile(reportFile, 'utf8').catch(() => 'null')))
  if (parsed.success) return readRun(parsed.data, cwd)
  return {
    outcome: 'load-failed',
    tests: 0,
    failedTests: [],
    loadProblems: [output.trim() || 'vitest wrote no report'],
  }
}

const describeRun = (result: RunResult) => {
  if (result.outcome === 'passed') return `${result.tests} passed`
  if (result.outcome === 'assertion-failed')
    return `${result.failedTests.length} of ${result.tests} failed on an assertion`
  return 'did not load'
}

const main = async () => {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { base: { type: 'string' } } })
  const refused = refusal(positionals)
  if (refused !== undefined) {
    console.error(refused)
    return exitCode('could not run')
  }

  const root = await gitIn(process.cwd())('rev-parse', '--show-toplevel')
  const git = gitIn(root)
  const files = positionals.map((path) => relative(root, resolve(path)).split(sep).join('/'))
  const missing = files.filter((file) => file.startsWith('..') || !existsSync(join(root, file)))
  if (missing.length > 0) {
    console.error(`${missing.join(', ')}: not a file inside ${root}`)
    return exitCode('could not run')
  }

  const baseSha = await git(
    'rev-parse',
    '--verify',
    `${values.base ?? (await git('merge-base', 'HEAD', 'origin/main'))}^{commit}`,
  )
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'tape-prove-'))
  const tree = join(scratch, 'base')
  let treeAdded = false
  const cleanUp = async () => {
    if (treeAdded) await git('worktree', 'remove', '--force', tree).catch(() => undefined)
    await rm(scratch, { recursive: true, force: true })
    await git('worktree', 'prune').catch(() => undefined)
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      interrupted = true
      running?.kill('SIGKILL')
    })
  }

  try {
    await git('worktree', 'add', '--detach', tree, baseSha)
    treeAdded = true
    stopIfInterrupted()
    for (const file of files) {
      await mkdir(dirname(join(tree, file)), { recursive: true })
      await copyFile(join(root, file), join(tree, file))
    }
    if (await lockfileDiffers(git, root, baseSha)) {
      console.log('The lockfile differs from the base, installing the base dependencies.')
      const install = await spawnIn(tree, 'pnpm', ['install', '--frozen-lockfile', '--offline', '--ignore-scripts'])
      stopIfInterrupted()
      if (install.code !== 0) throw new Error(`pnpm install in the base worktree failed:\n${install.output}`)
    } else {
      await linkInstall(root, tree)
    }

    stopIfInterrupted()
    console.log(`Running ${files.join(', ')} on ${baseSha.slice(0, 7)} and on the working tree.`)
    const base = await prove(tree, files, scratch, 'base')
    const head = await prove(root, files, scratch, 'head')
    const verdict = verdictOf(base.outcome, head.outcome)

    console.log(
      `\nside  code                     result\nbase  ${baseSha.slice(0, 7).padEnd(23)}  ${describeRun(base)}\nhead  ${'working tree'.padEnd(23)}  ${describeRun(head)}\n`,
    )
    if (base.outcome === 'assertion-failed')
      console.log(`Failing on base:\n${base.failedTests.map((test) => `  ${test}`).join('\n')}\n`)
    if (verdict === 'could not run') {
      for (const [side, result] of [
        ['base', base],
        ['head', head],
      ] as const) {
        if (result.outcome === 'load-failed')
          console.log(`The ${side} run did not load:\n${result.loadProblems.join('\n')}\n`)
      }
      if (head.outcome === 'assertion-failed')
        console.log(`The head run must pass, and fails:\n${head.failedTests.map((test) => `  ${test}`).join('\n')}\n`)
    }
    console.log(verdict)
    return exitCode(verdict)
  } finally {
    await cleanUp()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main().catch((error: unknown) => {
    if (interrupted) return 130
    console.error(error instanceof Error ? error.message : error)
    return exitCode('could not run')
  })
}
