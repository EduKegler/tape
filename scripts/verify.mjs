import { spawn } from 'node:child_process'

const docChecks = ['node scripts/check-public.mjs', 'prettier --check .']
const checks = process.argv.includes('--docs')
  ? docChecks
  : [
      'pnpm typecheck',
      ...docChecks,
      'node scripts/check-cycles.mjs',
      'node scripts/check-contrast.mjs',
      'eslint --max-warnings 0',
      'knip',
      'vitest run',
    ]

const run = (check) =>
  new Promise((resolve) => {
    const [command, ...args] = check.split(' ')
    const started = performance.now()
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const output = []
    child.stdout.on('data', (chunk) => output.push(chunk))
    child.stderr.on('data', (chunk) => output.push(chunk))
    child.on('error', (error) => output.push(Buffer.from(`${error.message}\n`)))
    child.on('close', (code) => {
      resolve({ check, ok: code === 0, output: Buffer.concat(output), seconds: (performance.now() - started) / 1000 })
    })
  })

const results = await Promise.all(checks.map(run))
const failed = results.filter((result) => !result.ok)
for (const { check, ok, seconds } of results) if (ok) console.log(`ok    ${check} (${seconds.toFixed(1)}s)`)
for (const { check, output } of failed) {
  process.stdout.write(output)
  console.log(`FAIL  ${check}`)
}
if (failed.length > 0) process.exitCode = 1
