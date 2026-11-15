import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HEX_KEY = /^(?:0x)?([0-9a-fA-F]{64})$/
const KEY_LINE = /^\s*(?:export\s+)?VERIFY_TAPE_KEY\s*=(.*)$/
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

export const fundedRequested = (env = process.env) => env.VERIFY_TAPE_FUNDED === '1'

function mainCheckout() {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return dirname(commonDir)
  } catch {
    return REPO
  }
}

export function envFiles(env = process.env) {
  if (env.VERIFY_TAPE_ENV_FILE) return [resolve(env.VERIFY_TAPE_ENV_FILE)]
  return [...new Set([resolve(REPO, '.env'), resolve(mainCheckout(), '.env')])]
}

function unquote(assigned) {
  const text = assigned.trim()
  const quote = text[0]
  const end = quote === '"' || quote === "'" ? text.indexOf(quote, 1) : -1
  return end > 0 ? text.slice(1, end) : text.split('#')[0].trim()
}

function fromEnvFile(file) {
  if (!existsSync(file)) return null
  let value = null
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = KEY_LINE.exec(line)
    if (match) value = unquote(match[1])
  }
  return value
}

export function readFundedKey({ network, watch, env = process.env, files = envFiles(env) }) {
  if (watch)
    throw new Error(
      'VERIFY_TAPE_FUNDED and VERIFY_TAPE_WATCH do not go together. A watch-only run never signs. Unset one of them.',
    )
  if (network !== 'testnet')
    throw new Error(
      `VERIFY_TAPE_FUNDED signs only on a testnet build, and this build is ${network}. Run \`up --network testnet\`.`,
    )
  let raw = env.VERIFY_TAPE_KEY?.trim()
  for (const file of files) raw ||= fromEnvFile(file)
  if (!raw)
    throw new Error(
      `VERIFY_TAPE_FUNDED is set, but there is no VERIFY_TAPE_KEY in the environment or in ${files.join(' or ')}.`,
    )
  const hex = HEX_KEY.exec(raw)?.[1]
  if (!hex) throw new Error('VERIFY_TAPE_KEY holds no private key. Write it as 64 hex digits, with or without 0x.')
  return `0x${hex.toLowerCase()}`
}
