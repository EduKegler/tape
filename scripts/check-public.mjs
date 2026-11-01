import { execFileSync } from 'node:child_process'

const root = new URL('..', import.meta.url).pathname
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)

const prose = /\.(?:md|mdx|markdown|txt|rst|adoc|org|pdf|docx?)$/i
const proseAllowed = [
  /^(?:README|CLAUDE|AGENTS|PRODUCT|DESIGN)\.md$/,
  /^packages\/[^/]+\/README\.md$/,
  /^\.claude\/skills\//,
  /^\.impeccable\/.+\.md$/,
]
const docsAllowed = /\.(?:png|jpe?g|webp|gif|svg)$/i

const problems = files.filter(
  (file) =>
    (prose.test(file) && !proseAllowed.some((allowed) => allowed.test(file)))
    || (file.startsWith('docs/') && !docsAllowed.test(file)),
)

if (problems.length > 0) {
  console.error(problems.map((file) => `${file}: this repo is public`).join('\n'))
  console.error(
    'Research, competitor notes and decision logs go to the private tape-notes repo. What the public reads goes in README.md.',
  )
  process.exit(1)
}
console.log(`public files ok: ${files.length}`)
