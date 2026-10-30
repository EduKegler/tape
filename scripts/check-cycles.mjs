import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const root = new URL('..', import.meta.url).pathname
const projects = [
  'tsconfig.json',
  'packages/core/tsconfig.json',
  'packages/venues/tsconfig.json',
  'packages/trade/tsconfig.json',
]

const sources = new Map()
for (const project of projects) {
  const path = join(root, project)
  const { config } = ts.readConfigFile(path, ts.sys.readFile)
  const { fileNames, options } = ts.parseJsonConfigFileContent(config, ts.sys, join(path, '..'))
  for (const file of fileNames) if (!sources.has(file)) sources.set(file, options)
}

const allTypeOnly = (elements) => elements.length > 0 && elements.every((e) => e.isTypeOnly)
// TypeScript erases type-only imports and exports, so they cannot order module initialization.
const isTypeOnly = (node) => {
  if (ts.isExportDeclaration(node)) {
    return (
      node.isTypeOnly
      || (!!node.exportClause && ts.isNamedExports(node.exportClause) && allTypeOnly(node.exportClause.elements))
    )
  }
  const clause = node.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  return (
    !clause.name
    && !!clause.namedBindings
    && ts.isNamedImports(clause.namedBindings)
    && allTypeOnly(clause.namedBindings.elements)
  )
}

const runtimeImports = (file, options) => {
  const found = []
  const visit = (node) => {
    let specifier
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && !isTypeOnly(node)) {
      specifier = node.moduleSpecifier
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0]
    }
    if (specifier && ts.isStringLiteral(specifier)) {
      const target = ts.resolveModuleName(specifier.text, file, options, ts.sys).resolvedModule?.resolvedFileName
      if (target && sources.has(target)) found.push(target)
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true))
  return found
}

const graph = new Map([...sources].map(([file, options]) => [file, runtimeImports(file, options)]))

const stronglyConnected = () => {
  let next = 0
  const index = new Map()
  const low = new Map()
  const stack = []
  const groups = []
  const connect = (file) => {
    index.set(file, next)
    low.set(file, next++)
    stack.push(file)
    for (const target of graph.get(file)) {
      if (!index.has(target)) {
        connect(target)
        low.set(file, Math.min(low.get(file), low.get(target)))
      } else if (stack.includes(target)) low.set(file, Math.min(low.get(file), index.get(target)))
    }
    if (low.get(file) !== index.get(file)) return
    const group = stack.splice(stack.indexOf(file))
    if (group.length > 1 || graph.get(file).includes(file)) groups.push(group)
  }
  for (const file of graph.keys()) if (!index.has(file)) connect(file)
  return groups
}

const loopThrough = (group) => {
  const start = group[0]
  const reachedFrom = new Map([[start, null]])
  const queue = [start]
  while (queue.length > 0) {
    const file = queue.shift()
    for (const target of graph.get(file)) {
      if (target === start) {
        const path = [start]
        for (let step = file; step !== null; step = reachedFrom.get(step)) path.unshift(step)
        return path
      }
      if (group.includes(target) && !reachedFrom.has(target)) {
        reachedFrom.set(target, file)
        queue.push(target)
      }
    }
  }
}

const cycles = stronglyConnected().map((group) =>
  loopThrough(group)
    .map((file) => relative(root, file))
    .join(' -> '),
)
if (cycles.length > 0) {
  console.error(cycles.map((cycle) => `cycle: ${cycle}`).join('\n'))
  process.exit(1)
}
console.log(`no import cycles in ${graph.size} files`)
