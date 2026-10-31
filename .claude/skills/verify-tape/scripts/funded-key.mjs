import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const HEX_KEY = /^(?:0x)?([0-9a-fA-F]{64})$/

function workTreeOf(path) {
  try {
    return execFileSync('git', ['-C', dirname(path), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

export function readFundedKey(file, { network, watch }) {
  const path = resolve(file)
  if (watch)
    throw new Error(
      'VERIFY_TAPE_KEY_FILE and VERIFY_TAPE_WATCH do not go together. A watch-only run never signs. Unset one of them.',
    )
  if (network !== 'testnet')
    throw new Error(
      `VERIFY_TAPE_KEY_FILE signs only on a testnet build, and this build is ${network}. Run \`up --network testnet\`.`,
    )
  if (!existsSync(path)) throw new Error(`VERIFY_TAPE_KEY_FILE points at ${path}, which does not exist.`)
  const tree = workTreeOf(path)
  if (tree)
    throw new Error(
      `VERIFY_TAPE_KEY_FILE points at ${path}, inside the git work tree ${tree}. Keep the key outside every repository.`,
    )
  const text = readFileSync(path, 'utf8').trim()
  let raw = text
  if (text.startsWith('{'))
    try {
      raw = String(JSON.parse(text).privateKey ?? '')
    } catch {
      raw = ''
    }
  const hex = HEX_KEY.exec(raw)?.[1]
  if (!hex)
    throw new Error(
      `VERIFY_TAPE_KEY_FILE points at ${path}, which holds no private key. Write it as 64 hex digits, or as JSON with privateKey.`,
    )
  return `0x${hex.toLowerCase()}`
}
