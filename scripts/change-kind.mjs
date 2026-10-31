import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const isDoc = (path) => path.endsWith('.md')
const isTest = (path) => /\.test\.tsx?$/.test(path) && !/(?:^|\/)(?:e2e|__fixtures__)\//.test(path)

export const changeKind = (paths) => {
  if (paths.length === 0) return 'code'
  if (paths.every(isDoc)) return 'docs'
  if (paths.every((path) => isDoc(path) || isTest(path))) return 'tests'
  return 'code'
}

export const changedFiles = (range, env = process.env) => {
  try {
    return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', range], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
      .split('\0')
      .filter(Boolean)
  } catch {
    console.error(`git cannot diff ${range}, so it counts as code`)
    return []
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [range] = process.argv.slice(2)
  const files = range === undefined ? [] : changedFiles(range)
  const kind = changeKind(files)
  console.log(`${files.length} files changed in ${range}`)
  console.log(`kind=${kind}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `kind=${kind}\n`)
}
