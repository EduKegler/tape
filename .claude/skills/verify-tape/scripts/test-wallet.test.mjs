import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const require = createRequire(resolve(SCRIPTS, '../../../../package.json'))
const { recoverMessageAddress, recoverTypedDataAddress } = require('viem')
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const dir = mkdtempSync(join(tmpdir(), 'verify-tape-wallet-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const key = generatePrivateKey()
const envFile = join(dir, 'funded.env')
writeFileSync(envFile, `# test\nVERIFY_TAPE_KEY=${key}\n`)
const funded = { VERIFY_TAPE_FUNDED: '1', VERIFY_TAPE_ENV_FILE: envFile }

const {
  VERIFY_TAPE_WATCH: _watch,
  VERIFY_TAPE_FUNDED: _funded,
  VERIFY_TAPE_KEY: _key,
  VERIFY_TAPE_ENV_FILE: _envFile,
  ...withoutWalletEnv
} = process.env

const freePort = () =>
  new Promise((ok) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => ok(port))
    })
  })

function startWallet(network, env, run = join(dir, `run-${Date.now()}`)) {
  mkdirSync(run, { recursive: true })
  const child = spawn(
    process.execPath,
    [
      join(SCRIPTS, 'test-wallet.mjs'),
      String(env.cdpPort ?? 1),
      String(env.walletPort ?? 1),
      join(run, 'wallet-key.json'),
      join(run, 'wallet.jsonl'),
      network,
    ],
    { env: { ...withoutWalletEnv, ...env.vars }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  child.stdout.on('data', (c) => (out += c))
  child.stderr.on('data', (c) => (out += c))
  const exited = new Promise((ok) => child.on('exit', (code) => ok(code)))
  return { child, exited, output: () => out, run }
}

async function refusal(network, vars) {
  const wallet = startWallet(network, { vars })
  const code = await wallet.exited
  return { code, output: wallet.output() }
}

const bare = key.slice(2).toLowerCase()

test('refuses a funded key on a mainnet build', async () => {
  const { code, output } = await refusal('mainnet', funded)
  assert.equal(code, 1)
  assert.match(output, /VERIFY_TAPE_FUNDED signs only on a testnet build, and this build is mainnet/)
  assert.ok(!output.toLowerCase().includes(bare), 'the refusal never prints the key')
})

test('refuses a funded run with no key in the environment or the .env, naming the .env', async () => {
  const missing = join(dir, 'missing.env')
  const { code, output } = await refusal('testnet', { ...funded, VERIFY_TAPE_ENV_FILE: missing })
  assert.equal(code, 1)
  assert.match(output, new RegExp(`no VERIFY_TAPE_KEY in the environment or in ${missing}`))
})

test('refuses a funded key together with a watched address', async () => {
  const { code, output } = await refusal('testnet', {
    ...funded,
    VERIFY_TAPE_WATCH: privateKeyToAccount(generatePrivateKey()).address,
  })
  assert.equal(code, 1)
  assert.match(output, /VERIFY_TAPE_FUNDED and VERIFY_TAPE_WATCH do not go together/)
})

test('keeps the throwaway wallet when the run does not ask for the key it finds', async () => {
  // No Chrome on port 1, so the wallet stops after it picks its key and writes it down.
  const wallet = startWallet('testnet', { vars: { VERIFY_TAPE_ENV_FILE: envFile, VERIFY_TAPE_KEY: key } })
  await wallet.exited
  assert.doesNotMatch(wallet.output(), /VERIFY_TAPE_FUNDED/)
  const written = JSON.parse(readFileSync(join(wallet.run, 'wallet-key.json'), 'utf8'))
  assert.notEqual(written.address, privateKeyToAccount(key).address)
  assert.equal(written.funded, false)
})

test('refuses a VERIFY_TAPE_KEY that holds no key without printing what it holds', async () => {
  const junk = join(dir, 'junk.env')
  writeFileSync(junk, `VERIFY_TAPE_KEY=${bare.slice(0, 40)}\n`)
  const { code, output } = await refusal('testnet', { ...funded, VERIFY_TAPE_ENV_FILE: junk })
  assert.equal(code, 1)
  assert.match(output, /holds no private key/)
  assert.ok(!output.toLowerCase().includes(bare.slice(0, 40)), 'the refusal never prints the value')
})

test(
  'signs as the funded address on testnet and writes the key to no file',
  { skip: !existsSync(CHROME) && `no Chrome at ${CHROME}` },
  async (t) => {
    const [cdpPort, walletPort] = [await freePort(), await freePort()]
    const profile = join(dir, 'chrome')
    const chrome = spawn(
      CHROME,
      ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, 'about:blank'],
      { stdio: 'ignore' },
    )
    t.after(() => chrome.kill('SIGKILL'))
    for (let i = 0; i < 60; i++) {
      const up = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(
        (r) => r.ok,
        () => false,
      )
      if (up) break
      await new Promise((ok) => setTimeout(ok, 250))
    }
    const run = join(dir, 'funded-run')
    const wallet = startWallet('testnet', { cdpPort, walletPort, vars: funded }, run)
    t.after(() => wallet.child.kill('SIGKILL'))
    const rpc = async (method, params = []) => {
      for (let i = 0; ; i++) {
        try {
          const reply = await (
            await fetch(`http://127.0.0.1:${walletPort}`, { method: 'POST', body: JSON.stringify({ method, params }) })
          ).json()
          return reply
        } catch (e) {
          if (i > 40) throw e
          await new Promise((ok) => setTimeout(ok, 250))
        }
      }
    }
    const fundedAddress = privateKeyToAccount(key).address
    assert.deepEqual((await rpc('eth_requestAccounts')).result, [fundedAddress])
    const typedData = {
      domain: {
        name: 'Exchange',
        version: '1',
        chainId: 1337,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        Agent: [
          { name: 'source', type: 'string' },
          { name: 'connectionId', type: 'bytes32' },
        ],
      },
      primaryType: 'Agent',
      message: { source: 'b', connectionId: `0x${'ab'.repeat(32)}` },
    }
    const typed = await rpc('eth_signTypedData_v4', [fundedAddress, JSON.stringify(typedData)])
    assert.equal(await recoverTypedDataAddress({ ...typedData, signature: typed.result }), fundedAddress)
    const personal = await rpc('personal_sign', ['0x68656c6c6f', fundedAddress])
    assert.equal(
      await recoverMessageAddress({ message: { raw: '0x68656c6c6f' }, signature: personal.result }),
      fundedAddress,
    )
    assert.match(wallet.output(), new RegExp(`test wallet ${fundedAddress} \\(funded\\)`))

    const files = readdirSync(run).map((f) => join(run, f))
    assert.deepEqual(files.map((f) => f.slice(run.length + 1)).sort(), ['wallet-key.json', 'wallet.jsonl'])
    for (const text of [...files.map((f) => readFileSync(f, 'utf8')), wallet.output()])
      assert.ok(!text.toLowerCase().includes(bare), 'no file and no console line holds the key')
    assert.deepEqual(JSON.parse(readFileSync(join(run, 'wallet-key.json'), 'utf8')), {
      address: fundedAddress,
      watchOnly: false,
      funded: true,
    })
  },
)
