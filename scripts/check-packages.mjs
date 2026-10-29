import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const packagesDir = join(root, 'packages')
const manifests = readdirSync(packagesDir)
  .map((dir) => join(packagesDir, dir))
  .filter((dir) => statSync(join(dir, 'package.json'), { throwIfNoEntry: false }))
  .map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }))

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  )
const specifiers = (source) => [...source.matchAll(/(?:from|import)\s*(?:\(\s*)?'([^']+)'/g)].map((m) => m[1])
const packageOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])

const problems = []
for (const { dir, pkg } of manifests) {
  const runtime = new Set([
    pkg.name,
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ])
  const dev = new Set([...runtime, ...Object.keys(pkg.devDependencies ?? {})])
  for (const file of files(join(dir, 'src'))) {
    const allowed = /\.test\.tsx?$|fixtures/.test(file) ? dev : runtime
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.') || spec.startsWith('node:')) continue
      const where = relative(root, file)
      if (spec.startsWith('#/')) problems.push(`${where}: '${spec}' reaches into the app`)
      else if (!allowed.has(packageOf(spec))) problems.push(`${where}: '${spec}' is not declared in ${pkg.name}`)
    }
  }
}

const graph = new Map(
  manifests.map(({ pkg }) => [
    pkg.name,
    Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).filter((d) => d.startsWith('@tape/')),
  ]),
)
const visit = (name, path) => {
  if (path.includes(name)) return problems.push(`cycle: ${[...path.slice(path.indexOf(name)), name].join(' -> ')}`)
  for (const next of graph.get(name) ?? []) visit(next, [...path, name])
}
for (const name of graph.keys()) visit(name, [])

if (problems.length > 0) {
  console.error([...new Set(problems)].join('\n'))
  process.exit(1)
}
console.log(`packages ok: ${manifests.map((m) => m.pkg.name).join(', ')}`)
