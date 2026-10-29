#!/usr/bin/env node
// Test wallet for the harness Chrome. Stays attached to Chrome over CDP for the whole run and injects an
// EIP-1193 provider into every page before the page's own scripts run. The provider forwards each request
// here over HTTP, and this process signs with a key generated for the run. It never sends a transaction.
// Started and stopped by verify-tape.mjs `up` and `down`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const require = createRequire(resolve(REPO, 'package.json'))
const { concat, hashStruct, keccak256, numberToHex } = require('viem')
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts')

const [cdpPort, walletPort, keyFile, logFile] = process.argv.slice(2)
if (!cdpPort || !walletPort || !keyFile || !logFile) {
  console.error('usage: test-wallet.mjs <cdp-port> <wallet-port> <key-file> <log-file>')
  process.exit(1)
}

const key = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')).privateKey : generatePrivateKey()
const account = privateKeyToAccount(key)
writeFileSync(keyFile, JSON.stringify({ privateKey: key, address: account.address }, null, 2))
let chainId = 1
// Like MetaMask, the wallet lists no account until a page asks to connect.
let connected = false

const log = (entry) => appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)

class RpcError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// MetaMask semantics (eth-sig-util): the domain is hashed with the EIP712Domain fields the request
// lists, so a request that leaves them out signs a different digest and the venue rejects it.
function typedDataDigest(data) {
  const types = { EIP712Domain: [], ...data.types }
  const domain = hashStruct({ data: data.domain, primaryType: 'EIP712Domain', types })
  return keccak256(concat(['0x1901', domain, hashStruct({ data: data.message, primaryType: data.primaryType, types })]))
}

async function handle(method, params) {
  switch (method) {
    case 'eth_requestAccounts':
      connected = true
      log({ method })
      return [account.address]
    case 'eth_accounts':
      return connected ? [account.address] : []
    case 'eth_chainId':
      return numberToHex(chainId)
    case 'net_version':
      return String(chainId)
    case 'wallet_switchEthereumChain':
      chainId = Number(params[0].chainId)
      return null
    case 'wallet_addEthereumChain':
    case 'wallet_requestPermissions':
      return null
    case 'wallet_getPermissions':
      return [{ parentCapability: 'eth_accounts' }]
    case 'eth_signTypedData_v4': {
      const [from, json] = params
      if (from.toLowerCase() !== account.address.toLowerCase()) throw new RpcError(4100, `unknown account ${from}`)
      const data = typeof json === 'string' ? JSON.parse(json) : json
      log({ method, primaryType: data.primaryType, domain: data.domain, message: data.message })
      return account.sign({ hash: typedDataDigest(data) })
    }
    case 'personal_sign': {
      const [message] = params
      log({ method, message })
      return account.signMessage({ message: { raw: message } })
    }
    case 'eth_sendTransaction':
      log({ method, refused: true })
      throw new RpcError(4001, 'The test wallet does not send transactions')
    default:
      throw new RpcError(4200, `The test wallet does not support ${method}`)
  }
}

const server = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-private-network', 'true')
  if (req.method === 'OPTIONS') return res.end()
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    const { method, params = [] } = JSON.parse(body || '{}')
    let reply
    try {
      reply = { result: await handle(method, params) }
    } catch (e) {
      reply = { error: { code: e.code ?? -32603, message: String(e.message ?? e) } }
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(reply))
  })
})
server.listen(Number(walletPort), '127.0.0.1')

const PROVIDER = `(() => {
  if (window.ethereum && window.ethereum.isTapeTestWallet) return
  const listeners = {}
  const emit = (event, value) => (listeners[event] || []).forEach((fn) => fn(value))
  async function rpc(method, params) {
    const response = await fetch('http://127.0.0.1:${walletPort}/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })
    const reply = await response.json()
    if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code })
    return reply.result
  }
  const provider = {
    isTapeTestWallet: true,
    async request({ method, params }) {
      const result = await rpc(method, params || [])
      if (method === 'wallet_switchEthereumChain') emit('chainChanged', await rpc('eth_chainId', []))
      return result
    },
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return provider },
    removeListener(event, fn) { listeners[event] = (listeners[event] || []).filter((f) => f !== fn); return provider },
  }
  window.ethereum = provider
  const info = { uuid: '6a3b0c3e-2f1d-4b7a-9c8e-7d5f4a3b2c1d', name: 'Tape test wallet', rdns: 'dev.kegler.tape.testwallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E' }
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
  window.addEventListener('eip6963:requestProvider', announce)
  announce()
})()`

// The guard: a harness run never reaches mainnet order endpoints and never creates an account or key at a
// venue. Matching requests are answered here with 451 and logged with their body, which is the evidence.
const GUARDED = [
  { urlPattern: 'https://api.hyperliquid.xyz/exchange*' },
  { urlPattern: '*orderly.org/v1/*' },
  { urlPattern: '*dydx*rpc*' },
]
function verdict(url, method, body) {
  // A CORS preflight sends nothing. Blocking it would hide the real request behind "Failed to fetch".
  if (method === 'OPTIONS') return null
  if (url.startsWith('https://api.hyperliquid.xyz/exchange')) return 'Hyperliquid mainnet orders are blocked in verification'
  if (/orderly\.org\/v1\/(register_account|orderly_key)/.test(url)) return 'Orderly account and key registration is blocked in verification'
  if (/\/\/api\.orderly\.org\/v1\/(order|batch-order|client)/.test(url) && method !== 'GET') return 'Orderly mainnet orders are blocked in verification'
  if (/dydx/.test(url) && !/testnet|test-dydx/.test(url) && /broadcast_tx/.test(body ?? '')) return 'dYdX mainnet broadcasts are blocked in verification'
  return null
}

const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()
const ws = new WebSocket(webSocketDebuggerUrl)
await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)))
let id = 0
const send = (method, params = {}, sessionId) => ws.send(JSON.stringify({ id: ++id, method, params, ...(sessionId ? { sessionId } : {}) }))
ws.onmessage = (event) => {
  const m = JSON.parse(event.data)
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params
    const reason = verdict(request.url, request.method, request.postData)
    if (!reason) return send('Fetch.continueRequest', { requestId }, m.sessionId)
    log({ blocked: request.url, method: request.method, reason, body: request.postData ?? null })
    const body = Buffer.from(JSON.stringify({ blockedByVerifyHarness: true, message: reason })).toString('base64')
    return send('Fetch.fulfillRequest', { requestId, responseCode: 451, responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }], body }, m.sessionId)
  }
  if (m.method !== 'Target.attachedToTarget') return
  const session = m.params.sessionId
  if (m.params.targetInfo.type === 'page') {
    send('Page.enable', {}, session)
    send('Page.addScriptToEvaluateOnNewDocument', { source: PROVIDER }, session)
    send('Fetch.enable', { patterns: GUARDED }, session)
  }
  send('Runtime.runIfWaitingForDebugger', {}, session)
}
ws.onclose = () => process.exit(0)
send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
log({ started: true, address: account.address, walletPort: Number(walletPort) })
console.log(`test wallet ${account.address} on 127.0.0.1:${walletPort}`)
