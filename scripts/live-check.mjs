// Calls every cheap HTTPS method in openrpc.json once and checks the live answer against that method's result schema,
// so a wrong type in the spec is caught here and not by a user. Each REST route in served.json is called once too.
// Usage: CARBIUM_KEY=<your c_serv_ key> node scripts/live-check.mjs
// One call a second. Exits 0 when every call matched, 1 on a mismatch or a method the services do not serve, 2 without
// a key, 3 when any call is still unread after its one retry.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'

const json = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))
export const spec = json('openrpc.json')
const served = json('served.json')
const examples = json('examples.json')

// Never called, each for its reason.
export const SKIPS = {
  sendTransaction: 'it sends a transaction',
  simulateTransaction: 'it needs a transaction',
  getFeeForMessage: 'it needs a transaction message',
  getProgramAccounts: 'a heavy scan',
  getLargestAccounts: 'a heavy scan',
}

// Called in this order: each method that gives a fresh value comes before the methods that use it.
export const CALLS = [
  'getSlot', 'getBlocks', 'getBlock', 'getBlockCommitment', 'getBlockTime', 'getBlocksWithLimit', 'getSlotLeaders',
  'getSignaturesForAddress', 'getSignatureStatuses', 'getTransaction', 'getLatestBlockhash', 'isBlockhashValid',
  'getVoteAccounts', 'getInflationReward', 'quote', 'swap', 'GET /cq1/quote',
  'getAccountInfo', 'getAgGenesisCert', 'getAsset', 'getAssetBatch', 'getAssets', 'getAssetsByAuthority',
  'getAssetsByCreator', 'getAssetsByGroup', 'getAssetsByOwner', 'getBalance', 'getBlockHeight', 'getBlockProduction',
  'getClusterNodes', 'getEpochInfo', 'getEpochSchedule', 'getFirstAvailableBlock', 'getGenesisHash', 'getHealth',
  'getHighestSnapshotSlot', 'getIdentity', 'getInflationGovernor', 'getInflationRate', 'getLeaderSchedule',
  'getMaxRetransmitSlot', 'getMaxShredInsertSlot', 'getMinimumBalanceForRentExemption', 'getMultipleAccounts',
  'getNftEditions', 'getPriorityFeeEstimate', 'getRecentPerformanceSamples', 'getRecentPrioritizationFees',
  'getSlotLeader', 'getStakeMinimumDelegation', 'getSupply', 'getTokenAccountBalance', 'getTokenAccounts', 'getTokenAccountsByDelegate',
  'getTokenAccountsByOwner', 'getTokenSupply', 'getTransactionCount', 'getTransactionsForAddress', 'getVersion',
  'health', 'minimumLedgerSlot', 'prices', 'qn_estimatePriorityFees', 'searchAssets',
]

// Public addresses the spec's own examples use.
const WALLET = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
const TOKEN_ACCOUNT = 'EUuUbDcafPrmVTD5M6qoJAoyyNbihBhugADAxRMn5he9'
const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// The fresh values a result gives later calls.
const READS = {
  getSlot: (r) => ({ slot: r }),
  getBlocks: (r) => ({ block: r.at(-1) }),
  getSignaturesForAddress: (r) => ({ signature: r[0].signature }),
  getLatestBlockhash: (r) => ({ blockhash: r.value.blockhash }),
  getVoteAccounts: (r) => ({ vote: r.current[0].votePubkey }),
  quote: (r) => ({ quoteId: r.quoteId }),
}

// Params other than the method's example. A fill gives nothing while a fresh value it needs is unread.
// swap builds an unsigned transaction for a public address; it is never signed or sent.
const FILLS = {
  getSlot: () => [{ commitment: 'finalized' }],
  getBlocks: ({ slot }) => slot && [slot - 208, slot - 200],
  getBlock: ({ block }) => block && [block, { encoding: 'json', maxSupportedTransactionVersion: 1, transactionDetails: 'signatures', rewards: false }],
  getBlockCommitment: ({ block }) => block && [block],
  getBlockTime: ({ block }) => block && [block],
  getBlocksWithLimit: ({ block }) => block && [block, 8],
  getSlotLeaders: ({ slot }) => slot && [slot, 3],
  getSignatureStatuses: ({ signature }) => signature && [[signature], { searchTransactionHistory: true }],
  getTransaction: ({ signature }) => signature && [signature, { encoding: 'json', maxSupportedTransactionVersion: 1 }],
  isBlockhashValid: ({ blockhash }) => blockhash && [blockhash, { commitment: 'finalized' }],
  getInflationReward: ({ vote }) => vote && [[vote], { commitment: 'finalized' }],
  quote: () => ({ src_mint: SOL, dst_mint: USDC, amount_in: '10000000', slippage_bps: 50 }),
  swap: ({ quoteId }) => quoteId && { quote_id: quoteId, user_pubkey: WALLET, compute_unit_price_micro_lamports: 10000 },
  getTokenAccountsByDelegate: () => [WALLET, { mint: USDC }, { encoding: 'base64' }],
  getTokenAccountsByOwner: () => [WALLET, { mint: USDC }, { encoding: 'base64' }],
  getTransactionsForAddress: () => [TOKEN_ACCOUNT, { limit: 5 }],
}

// Every HTTPS method in the spec and every REST route is either called or skipped, never both, and both lists name only
// such methods and routes.
export function accounting(doc = spec, calls = CALLS, skips = SKIPS, routes = served.rest) {
  const https = [...doc.methods.filter((m) => !m.servers).map((m) => m.name), ...routes]
  const skipped = Object.keys(skips)
  return [
    ...https.filter((n) => !calls.includes(n) && !skipped.includes(n)).map((n) => `${n} is in neither list`),
    ...calls.filter((n) => skipped.includes(n)).map((n) => `${n} is in both lists`),
    ...calls.filter((n, i) => calls.indexOf(n) !== i).map((n) => `${n} is called twice`),
    ...[...calls, ...skipped].filter((n) => !https.includes(n)).map((n) => `${n} is listed but is neither an HTTPS method in openrpc.json nor a REST route in served.json`),
  ]
}

const scrub = (text) => String(text).replace(/c_(?:serv|acct)_[A-Za-z0-9_-]+|whsec_[A-Za-z0-9+/=_-]+/g, '[key]').replace(/\s+/g, ' ')

function exampleParams(m) {
  const values = m.examples[0].params
  if (m.paramStructure === 'by-name') return values.length ? Object.fromEntries(values.map((p) => [p.name, p.value])) : undefined
  return values.map((p) => p.value)
}

// A type by name only: no value is ever printed.
const typeOf = (v) => (v === undefined ? 'nothing' : v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)

function says(e) {
  if (e.keyword === 'type') return [e.params.type].flat().join(' or ')
  if (e.keyword === 'const') return JSON.stringify(e.params.allowedValue)
  if (e.keyword === 'enum') return `one of ${e.params.allowedValues.map((v) => JSON.stringify(v)).join(', ')}`
  if (e.keyword === 'required') return 'a required field'
  if (e.keyword === 'additionalProperties') return 'no such field'
  return e.message
}

// The schema's complaints as "path: schema says X, got Y". An error at a parent of another error's path comes from
// another branch of a union, so the deepest ones are the precise ones.
function mismatches(errors, result) {
  const errs = errors.filter((e) => !['anyOf', 'oneOf', 'allOf', 'if'].includes(e.keyword)).map((e) => {
    const field = e.params.missingProperty ?? e.params.additionalProperty
    const pointer = field === undefined ? e.instancePath : `${e.instancePath}/${String(field).replace(/~/g, '~0').replace(/\//g, '~1')}`
    return { e, pointer }
  })
  const groups = new Map()
  for (const { e, pointer } of errs.filter((x) => !errs.some((o) => o.pointer.startsWith(`${x.pointer}/`)))) {
    const parts = pointer.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    let value = result
    for (const p of parts) value = value?.[p]
    const path = 'result' + parts.map((p) => (/^\d+$/.test(p) ? '[]' : /^[A-Za-z_$][\w$]{0,31}$/.test(p) ? `.${p}` : '.*')).join('')
    const title = e.parentSchema?.title ? ` (${e.parentSchema.title})` : ''
    const group = groups.get(path + title) ?? { says: new Set(), got: new Set() }
    group.says.add(says(e))
    group.got.add(typeOf(value))
    groups.set(path + title, group)
  }
  const out = [...groups].map(([path, g]) => `${path}: schema says ${[...g.says].join(' or ')}, got ${[...g.got].join(' or ')}`)
  return out.length > 5 ? [...out.slice(0, 5), `and ${out.length - 5} more`] : out
}

// Runs the check through call(method, params) -> { status, json }. Returns the exit code, the lines to print (one per
// method that is not MATCH, then the total) and each method's result.
export async function liveCheck(call, { doc = spec, calls = CALLS, skips = SKIPS, routes = served.rest } = {}) {
  const problems = accounting(doc, calls, skips, routes)
  if (problems.length) return { code: 1, lines: [...problems.map((p) => `ACCOUNTING ${p}`), 'total: the lists do not match openrpc.json, nothing was called'], results: {} }
  const ajv = new Ajv({ strict: false, allErrors: true, verbose: true })
  const methods = new Map(doc.methods.map((m) => [m.name, m]))
  const compiled = new Map()
  const fresh = {}
  const results = {}

  const check = async (name) => {
    if (routes.includes(name)) {
      // A REST route has no schema in openrpc.json. It is the quote's REST form: a 200 must carry the quote's
      // destAmountOut as a string.
      const { status, json } = await call(name, examples[name])
      if (status !== 200) return { kind: 'UNREAD', why: status ? `status ${status}` : 'no answer' }
      return typeof json?.destAmountOut === 'string' ? { kind: 'MATCH' } : { kind: 'MISMATCH', why: `answer.destAmountOut: wanted a string, got ${typeOf(json?.destAmountOut)}` }
    }
    const m = methods.get(name)
    const params = FILLS[name] ? FILLS[name](fresh) : exampleParams(m)
    if (FILLS[name] && !params) return { kind: 'UNREAD', why: 'a fresh value it needs was not read' }
    const { status, json } = await call(name, params)
    if (!status) return { kind: 'UNREAD', why: 'no answer' }
    // Method not found: the spec names a method the services do not serve. A verdict, never retried.
    if (json?.error?.code === -32601) return { kind: 'NOT SERVED', why: 'the service does not serve it' }
    if (json?.error) return { kind: 'UNREAD', why: `status ${status}, error ${scrub(json.error.code).slice(0, 20)}: ${scrub(json.error.message ?? '').slice(0, 100)}` }
    if (status < 200 || status > 299) return { kind: 'UNREAD', why: `status ${status}` }
    if (!json || typeof json !== 'object' || !('result' in json)) return { kind: 'UNREAD', why: `status ${status}, the answer has no result` }
    try {
      for (const [k, v] of Object.entries(READS[name]?.(json.result) ?? {})) if (v != null) fresh[k] = v
    } catch { /* a result too far off its shape gives no fresh value; the schema check below says why */ }
    if (!compiled.has(name)) compiled.set(name, ajv.compile({ components: doc.components, allOf: [m.result.schema] }))
    const validate = compiled.get(name)
    return validate(json.result) ? { kind: 'MATCH' } : { kind: 'MISMATCH', why: mismatches(validate.errors, json.result).join('; ') }
  }

  for (const name of calls) results[name] = await check(name)
  const count = (kind) => calls.filter((n) => results[n].kind === kind).length
  // A first pass that read nothing (every call refused or unanswered) is not tried again: the run ends at once.
  const readSome = calls.some((n) => results[n].kind !== 'UNREAD')
  // A refusal is the service's state, not a shape: each UNREAD method is tried once more, in the same order. A quote id
  // expires within 30 seconds, so a retried swap first reads a fresh one; the quote's own verdict stands.
  const retried = new Set()
  for (const name of readSome ? calls : []) {
    if (results[name].kind !== 'UNREAD') continue
    if (name === 'swap' && !retried.has('quote')) {
      delete fresh.quoteId
      await check('quote')
    }
    retried.add(name)
    results[name] = await check(name)
  }

  const lines = calls.filter((n) => results[n].kind !== 'MATCH').map((n) => scrub(`${results[n].kind} ${n}: ${results[n].why}`))
  lines.push(`total: ${calls.length + Object.keys(skips).length} methods and routes, ${count('MATCH')} match, ${count('MISMATCH')} mismatch, ${count('NOT SERVED')} not served, ${count('UNREAD')} unread, ${Object.keys(skips).length} skipped (${Object.keys(skips).join(', ')})`)
  if (!readSome) lines.push('no answer was read: every call was refused or went unanswered, so nothing was checked')
  // A pass is every call read and fitting: a reading that is missing is not a pass.
  return { code: count('MISMATCH') || count('NOT SERVED') ? 1 : count('UNREAD') ? 3 : 0, lines, results }
}

// The HTTPS call: the key in the x-api-key header only, at most one call a second. A REST route is named "VERB /path"
// and takes its params as the query.
export function httpCall(key, url = spec.servers[0].url) {
  let id = 0
  let last = -Infinity
  return async (method, params) => {
    const wait = last + 1000 - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    last = Date.now()
    const [verb, path] = method.split(' ')
    const [target, init] = path
      ? [`${url}${path}?${new URLSearchParams(params)}`, { method: verb, headers: { 'x-api-key': key } }]
      : [url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }) }) }]
    try {
      const res = await fetch(target, { ...init, signal: AbortSignal.timeout(20_000) })
      const text = await res.text()
      let json
      try { json = JSON.parse(text) } catch { json = undefined }
      return { status: res.status, json }
    } catch {
      return { status: 0 }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const key = process.env.CARBIUM_KEY
  if (!key) {
    console.error('set CARBIUM_KEY to your c_serv_ key')
    process.exit(2)
  }
  const { code, lines } = await liveCheck(httpCall(key))
  for (const line of lines) console.log(line.replaceAll(key, '[key]'))
  process.exitCode = code
}
