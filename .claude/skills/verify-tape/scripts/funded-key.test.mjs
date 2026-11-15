import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { envFiles, readFundedKey } from './funded-key.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const dir = mkdtempSync(join(tmpdir(), 'verify-tape-key-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const hex = 'ab12'.repeat(16)
const expected = `0x${hex}`
let files = 0

function fromFile(contents, env = {}) {
  const file = join(dir, `${files++}.env`)
  writeFileSync(file, contents)
  return readFundedKey({ network: 'testnet', env, files: [file] })
}

test('reads a bare key, with or without 0x, in either case', () => {
  assert.equal(fromFile(`VERIFY_TAPE_KEY=${hex}\n`), expected)
  assert.equal(fromFile(`VERIFY_TAPE_KEY=0x${hex.toUpperCase()}\n`), expected)
})

test('reads the dotenv forms a person writes', () => {
  assert.equal(fromFile(`export VERIFY_TAPE_KEY=${hex}\n`), expected)
  assert.equal(fromFile(`VERIFY_TAPE_KEY="${expected}"\n`), expected)
  assert.equal(fromFile(`VERIFY_TAPE_KEY='${expected}'\n`), expected)
  assert.equal(fromFile(`VERIFY_TAPE_KEY = ${expected}\n`), expected)
  assert.equal(fromFile(`OTHER=1\r\nVERIFY_TAPE_KEY=${expected}\r\nMORE=2\r\n`), expected)
  assert.equal(fromFile(`VERIFY_TAPE_KEY=${expected} # funded testnet account\n`), expected)
  assert.equal(fromFile(`VERIFY_TAPE_KEY="${expected}" # funded testnet account\n`), expected)
  assert.equal(fromFile(`VERIFY_TAPE_KEY=${expected}`), expected)
})

test('ignores a commented line, a longer name and a key that only mentions the name', () => {
  const tail = `VERIFY_TAPE_KEY=${expected}\n`
  assert.equal(fromFile(`# VERIFY_TAPE_KEY=${'0'.repeat(64)}\n${tail}`), expected)
  assert.equal(fromFile(`VERIFY_TAPE_KEY_OLD=${'0'.repeat(64)}\n${tail}`), expected)
  assert.equal(fromFile(`MY_VERIFY_TAPE_KEY=${'0'.repeat(64)}\n${tail}`), expected)
})

test('takes the last VERIFY_TAPE_KEY in the file, as dotenv does', () => {
  assert.equal(fromFile(`VERIFY_TAPE_KEY=${'0'.repeat(64)}\nVERIFY_TAPE_KEY=${expected}\n`), expected)
})

test('takes the environment over the .env', () => {
  assert.equal(fromFile(`VERIFY_TAPE_KEY=${'0'.repeat(64)}\n`, { VERIFY_TAPE_KEY: ` ${hex} ` }), expected)
})

test('an empty value counts as no key', () => {
  for (const contents of ['VERIFY_TAPE_KEY=\n', 'VERIFY_TAPE_KEY=""\n', 'VERIFY_TAPE_KEY= # later\n', ''])
    assert.throws(() => fromFile(contents), /there is no VERIFY_TAPE_KEY in the environment or in /)
  assert.throws(() => fromFile('', { VERIFY_TAPE_KEY: '' }), /there is no VERIFY_TAPE_KEY/)
})

test('a missing .env counts as no key', () => {
  const missing = join(dir, 'missing.env')
  assert.throws(
    () => readFundedKey({ network: 'testnet', env: {}, files: [missing] }),
    (error) => error.message.includes(`no VERIFY_TAPE_KEY in the environment or in ${missing}.`),
  )
})

test('refuses a malformed key without echoing any of it', () => {
  const malformed = [hex.slice(0, 40), `${hex}ff`, `0x${hex.slice(0, 63)}z`, `"${hex}`, `${hex} extra`]
  for (const value of malformed)
    for (const read of [() => fromFile(`VERIFY_TAPE_KEY=${value}\n`), () => fromFile('', { VERIFY_TAPE_KEY: value })])
      assert.throws(read, (error) => {
        assert.match(error.message, /VERIFY_TAPE_KEY holds no private key/)
        assert.ok(!error.message.toLowerCase().includes(hex.slice(0, 8)), 'the refusal never prints the value')
        return true
      })
})

test('checks the network and VERIFY_TAPE_WATCH before it reads any key', () => {
  const untouched = [join(dir, 'never-read.env')]
  assert.throws(() => readFundedKey({ network: 'mainnet', env: {}, files: untouched }), /only on a testnet build/)
  assert.throws(
    () => readFundedKey({ network: 'testnet', watch: '0x1', env: {}, files: untouched }),
    /do not go together/,
  )
})

test('looks in this checkout and then the main checkout, unless VERIFY_TAPE_ENV_FILE names one file', () => {
  const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: REPO, encoding: 'utf8' })
  const main = /^worktree (.+)$/m.exec(worktrees)[1]
  assert.deepEqual(envFiles({}), [...new Set([join(REPO, '.env'), join(main, '.env')])])
  assert.deepEqual(envFiles({ VERIFY_TAPE_ENV_FILE: join(dir, 'chosen.env') }), [join(dir, 'chosen.env')])
})
