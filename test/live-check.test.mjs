// Each check is first shown catching a planted problem. No test reaches the network: the service is a stand-in that
// answers from a table, or, for the command line, a stand-in fetch loaded into the command's own process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { liveCheck, httpCall, accounting, CALLS, SKIPS, spec } from '../scripts/live-check.mjs'

const script = fileURLToPath(new URL('../scripts/live-check.mjs', import.meta.url))
const copy = (x) => structuredClone(x)
const served = JSON.parse(readFileSync(new URL('../served.json', import.meta.url), 'utf8'))
const examples = JSON.parse(readFileSync(new URL('../examples.json', import.meta.url), 'utf8'))
const answer = (result) => ({ status: 200, json: { jsonrpc: '2.0', id: 1, result } })
const refusal = { status: 200, json: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'not in the table' } } }
const notServed = { status: 200, json: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } } }

// A stand-in service: a method in the table answers from it (an answer, or a function of how many times the method
// has been called), every other method is refused (a REST route with a 503). It records each call.
async function run(table = {}, options) {
  const seen = []
  const call = async (method, params) => {
    seen.push({ method, params })
    const entry = table[method]
    return typeof entry === 'function' ? entry(seen.filter((c) => c.method === method).length) : entry ?? (method.includes(' ') ? { status: 503 } : refusal)
  }
  return { ...(await liveCheck(call, options)), seen }
}
const paramsOf = (out, method) => out.seen.find((c) => c.method === method)?.params

const health = { ok: true, quoteUpstream: {}, canBuild: true, families: ['a'], poolStore: {}, chainRpc: {}, priced: 1, total: 1, stale: 0, tableAgeSecs: 3, quote_refusal_ratio: 0 }
const reward = { epoch: 900, effectiveSlot: 1, amount: 5, postBalance: 10, commission: 5 }
const vote = 'Vote111111111111111111111111111111111111111'
// The methods whose results give the fresh values other calls need.
const producers = {
  getSlot: answer(5000),
  getBlocks: answer([4793, 4799]),
  getSignaturesForAddress: answer([{ signature: 'sig1' }]),
  getLatestBlockhash: answer({ context: { slot: 1 }, value: { blockhash: 'hash1', lastValidBlockHeight: 2 } }),
  getVoteAccounts: answer({ current: [{ votePubkey: vote }], delinquent: [] }),
  quote: answer({ quoteId: 'quote1' }),
}

test('a fitting answer is MATCH and prints no line', async () => {
  const planted = await run({ getSlot: answer('5000'), getHealth: answer('fine') })
  assert.equal(planted.results.getSlot.kind, 'MISMATCH')
  assert.equal(planted.results.getHealth.kind, 'MISMATCH')
  const out = await run({ getSlot: answer(5000), getHealth: answer('ok'), health: answer(health) })
  for (const name of ['getSlot', 'getHealth', 'health']) assert.deepEqual(out.results[name], { kind: 'MATCH' })
  assert.deepEqual(out.lines.filter((l) => / (getSlot|getHealth|health):/.test(l)), [])
  assert.equal(out.code, 3, 'the methods not in the table are still unread')
})

test('a wrong type is MISMATCH, names the path and fails the run', async () => {
  const planted = await run({ health: answer({ ...health, canBuild: 1 }), getBalance: answer({ context: { slot: 1 }, value: '5' }) })
  assert.deepEqual(planted.results.health, { kind: 'MISMATCH', why: 'result.canBuild: schema says boolean, got integer' })
  assert.deepEqual(planted.results.getBalance, { kind: 'MISMATCH', why: 'result.value: schema says number, got string' })
  assert.ok(planted.lines.includes('MISMATCH health: result.canBuild: schema says boolean, got integer'))
  assert.equal(planted.code, 1)
  const out = await run({ health: answer(health), getBalance: answer({ context: { slot: 1 }, value: 5 }) })
  assert.deepEqual([out.results.health, out.results.getBalance], [{ kind: 'MATCH' }, { kind: 'MATCH' }])
  assert.equal(out.code, 3, 'the methods not in the table are still unread')
})

test('a null where the schema has no null is MISMATCH', async () => {
  const planted = await run({ ...producers, getInflationReward: answer([{ ...reward, epoch: null }]), getBlockHeight: answer(null) })
  assert.deepEqual(planted.results.getInflationReward, { kind: 'MISMATCH', why: 'result[].epoch: schema says number, got null' })
  assert.deepEqual(planted.results.getBlockHeight, { kind: 'MISMATCH', why: 'result: schema says number, got null' })
  // A null the schema allows is not a mismatch.
  const out = await run({ ...producers, getInflationReward: answer([reward, { ...reward, commission: null }, null]), getBlockHeight: answer(7) })
  assert.deepEqual([out.results.getInflationReward, out.results.getBlockHeight], [{ kind: 'MATCH' }, { kind: 'MATCH' }])
})

test('fresh values are read in the same run and passed to the calls that need them', async () => {
  const planted = await run({})
  assert.deepEqual(planted.results.swap, { kind: 'UNREAD', why: 'a fresh value it needs was not read' })
  assert.equal(paramsOf(planted, 'getBlocks'), undefined, 'without a slot, getBlocks is not called')
  const out = await run(producers)
  assert.deepEqual(paramsOf(out, 'getBlocks'), [4792, 4800])
  assert.equal(paramsOf(out, 'getBlock')[0], 4799)
  assert.deepEqual(paramsOf(out, 'getSlotLeaders'), [5000, 3])
  assert.equal(paramsOf(out, 'getTransaction')[0], 'sig1')
  assert.equal(paramsOf(out, 'isBlockhashValid')[0], 'hash1')
  assert.deepEqual(paramsOf(out, 'getInflationReward'), [[vote], { commitment: 'finalized' }])
  assert.equal(paramsOf(out, 'swap').quote_id, 'quote1')
})

test('a retried swap first reads a fresh quote id, and the quote keeps its first verdict', async () => {
  const out = await run({ ...producers, quote: (n) => answer({ quoteId: `quote${n}` }), swap: (n) => (n === 1 ? { status: 503 } : notServed) })
  assert.deepEqual(out.seen.filter((c) => c.method === 'swap').map((c) => c.params.quote_id), ['quote1', 'quote2'])
  assert.equal(out.seen.filter((c) => c.method === 'quote').length, 2)
  assert.equal(out.results.quote.kind, 'MISMATCH', 'the first verdict on quote stands')
})

test('the swap call carries only the public address, the quote id and the fee setting', async () => {
  const out = await run(producers)
  // The address is the one the spec's own getBalance example uses.
  const address = spec.methods.find((m) => m.name === 'getBalance').examples[0].params[0].value
  const swaps = out.seen.filter((c) => c.method === 'swap')
  assert.ok(swaps.length > 0)
  for (const c of swaps) assert.deepEqual(c.params, { quote_id: 'quote1', user_pubkey: address, compute_unit_price_micro_lamports: 10000 })
})

test('a refusal is UNREAD and is tried once more at the end', async () => {
  const out = await run({
    getTransactionCount: answer(10),
    getSlot: { status: 503 },
    getHealth: { status: 429, json: { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'too many requests' } } },
    getVersion: { status: 402 },
    getBlockHeight: (n) => (n === 1 ? { status: 503 } : answer(7)),
  })
  assert.deepEqual(out.results.getSlot, { kind: 'UNREAD', why: 'status 503' })
  assert.equal(out.seen.filter((c) => c.method === 'getSlot').length, 2)
  assert.deepEqual(out.results.getHealth, { kind: 'UNREAD', why: 'status 429, error -32005: too many requests' })
  assert.deepEqual(out.results.getVersion, { kind: 'UNREAD', why: 'status 402' })
  assert.deepEqual(out.results.getIdentity, { kind: 'UNREAD', why: 'status 200, error -32000: not in the table' })
  // Answered on the second try: a MATCH, called exactly twice.
  assert.deepEqual(out.results.getBlockHeight, { kind: 'MATCH' })
  assert.equal(out.seen.filter((c) => c.method === 'getBlockHeight').length, 2)
  assert.ok(out.lines.includes('UNREAD getSlot: status 503'))
  assert.equal(out.lines.at(-1), `total: 69 methods and routes, 2 match, 0 mismatch, 0 not served, 62 unread, 5 skipped (${Object.keys(SKIPS).join(', ')})`)
  assert.equal(out.code, 3)
})

test('a method the service does not serve fails the run and is not tried again', async () => {
  const out = await run({ getTransactionCount: answer(10), getIdentity: notServed })
  assert.deepEqual(out.results.getIdentity, { kind: 'NOT SERVED', why: 'the service does not serve it' })
  assert.equal(out.seen.filter((c) => c.method === 'getIdentity').length, 1)
  assert.ok(out.lines.includes('NOT SERVED getIdentity: the service does not serve it'))
  assert.equal(out.code, 1)
})

test('a skipped method is never called, and every other method is', async () => {
  const skippedCalls = (out) => [...new Set(out.seen.map((c) => c.method))].filter((n) => n in SKIPS)
  const { sendTransaction, ...rest } = SKIPS
  const planted = await run(producers, { calls: [...CALLS, 'sendTransaction'], skips: rest })
  assert.deepEqual(skippedCalls(planted), ['sendTransaction'])
  const out = await run(producers)
  assert.deepEqual(skippedCalls(out), [])
  assert.deepEqual(new Set(out.seen.map((c) => c.method)), new Set(CALLS))
})

test('every HTTPS method is called or skipped, never neither and never both', async () => {
  const extra = copy(spec)
  extra.methods.push({ ...copy(spec.methods.find((m) => m.name === 'getSlot')), name: 'getNewThing' })
  assert.deepEqual(accounting(extra), ['getNewThing is in neither list'])
  const refused = await run(producers, { doc: extra })
  assert.equal(refused.code, 1)
  assert.equal(refused.seen.length, 0, 'nothing is called while the lists are wrong')
  assert.equal(refused.lines[0], 'ACCOUNTING getNewThing is in neither list')
  assert.deepEqual(accounting(spec, [...CALLS, 'sendTransaction']), ['sendTransaction is in both lists'])
  assert.deepEqual(accounting(spec, [...CALLS, 'getSlot']), ['getSlot is called twice'])
  const less = copy(spec)
  less.methods = less.methods.filter((m) => m.name !== 'getSlot')
  const neither = 'is listed but is neither an HTTPS method in openrpc.json nor a REST route in served.json'
  assert.deepEqual(accounting(less), [`getSlot ${neither}`])
  assert.deepEqual(accounting(spec, [...CALLS, 'slotSubscribe']), [`slotSubscribe ${neither}`])
  assert.deepEqual(accounting(spec, CALLS, SKIPS, [...served.rest, 'GET /cq1/other']), ['GET /cq1/other is in neither list'])
  assert.deepEqual(accounting(spec, CALLS, SKIPS, []), [`GET /cq1/quote ${neither}`])
  assert.deepEqual(accounting(), [])
  assert.equal(CALLS.length + Object.keys(SKIPS).length, spec.methods.filter((m) => !m.servers).length + served.rest.length)
})

test('exit 0 only when every call matched, 1 on a mismatch or a method not served, 3 while any call is unread', async () => {
  // A spec of two methods, so every call can be answered.
  const two = { doc: { ...spec, methods: spec.methods.filter((m) => ['getSlot', 'getBlockHeight'].includes(m.name)) }, calls: ['getSlot', 'getBlockHeight'], skips: {}, routes: [] }
  assert.equal((await run({ getSlot: answer(5000), getBlockHeight: { status: 503 } }, two)).code, 3, 'one reading missing is not a pass')
  assert.equal((await run({ getSlot: answer(5000), getBlockHeight: answer('7') }, two)).code, 1)
  assert.equal((await run({ getSlot: answer(5000), getBlockHeight: notServed }, two)).code, 1)
  assert.equal((await run({ getSlot: answer(5000), getBlockHeight: answer(7) }, two)).code, 0)
  // A first pass that read nothing ends at once: no call is tried again.
  const unavailable = await run(Object.fromEntries(CALLS.map((n) => [n, { status: 503 }])))
  assert.equal(unavailable.code, 3)
  assert.equal(unavailable.lines.at(-1), 'no answer was read: every call was refused or went unanswered, so nothing was checked')
  assert.equal(unavailable.seen.length, new Set(unavailable.seen.map((c) => c.method)).size, 'no method is called twice')
})

test('the REST quote route is MATCH on 200 with destAmountOut as a string, MISMATCH on another 200, UNREAD on a refusal', async () => {
  const route = 'GET /cq1/quote'
  for (const [entry, kind, why, calls] of [
    [answer('1'), 'MISMATCH', 'answer.destAmountOut: wanted a string, got nothing', 1],
    [{ status: 200, json: { destAmountOut: 1500000 } }, 'MISMATCH', 'answer.destAmountOut: wanted a string, got integer', 1],
    [{ status: 503, json: { destAmountOut: '1500000' } }, 'UNREAD', 'status 503', 2],
  ]) {
    const planted = await run({ getTransactionCount: answer(10), [route]: entry })
    assert.deepEqual(planted.results[route], { kind, why })
    assert.equal(planted.seen.filter((c) => c.method === route).length, calls)
    assert.notEqual(planted.code, 0)
  }
  const out = await run({ [route]: { status: 200, json: { destAmountOut: '1500000' } } })
  assert.deepEqual(out.results[route], { kind: 'MATCH' })
  assert.deepEqual(paramsOf(out, route), examples[route])
})

// The command line runs in its own process with a stand-in fetch loaded first.
const cli = (env, stub) => spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(`(${stub})()`)}`, script], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' })

// Any call ends the process with code 9.
function trap() {
  globalThis.fetch = () => {
    process.stderr.write('a call was made\n')
    process.exit(9)
  }
}

test('with no key it exits 2 before any call', () => {
  const planted = cli({ CARBIUM_KEY: 'any' }, trap)
  assert.equal(planted.status, 9, 'with a key the trap sees the first call')
  for (const env of [{}, { CARBIUM_KEY: '' }]) {
    const out = cli(env, trap)
    assert.deepEqual([out.status, out.stdout, out.stderr], [2, '', 'set CARBIUM_KEY to your c_serv_ key\n'])
  }
})

// A service that echoes the key back in its answers, and answers the REST quote only when its query arrived. Each call
// is recorded without the key: where the key arrived and when, on a clock that moves only when the command waits.
function echo() {
  const key = process.env.CARBIUM_KEY
  const realTimeout = setTimeout
  let now = 0
  Date.now = () => now
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    now += ms
    return realTimeout(fn, 0, ...args)
  }
  globalThis.fetch = async (url, init) => {
    const method = init.body ? JSON.parse(init.body).method : `${init.method} ${new URL(url).pathname}`
    const record = { method, at: now, header: init.headers['x-api-key'].includes(key), elsewhere: String(url).includes(key) || String(init.body ?? '').includes(key) }
    process.stderr.write(`stub ${JSON.stringify(record)}\n`)
    if (method === 'GET /cq1/quote' && new URL(url).searchParams.get('src_mint')) return new Response(JSON.stringify({ destAmountOut: '1500000' }), { status: 200 })
    const body = method === 'getSlot' ? { result: 5000 } : method === 'getBalance' ? { result: { context: { slot: 1 }, value: key } } : { error: { code: -32000, message: `refused ${key} here` } }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }), { status: 200 })
  }
}

test('the key never appears in the output, travels in the x-api-key header only, at most one call a second', () => {
  const canary = ['c_serv_', `Canary${process.pid}x${Math.random().toString(36).slice(2)}`].join('')
  const out = cli({ CARBIUM_KEY: canary }, echo)
  const calls = out.stderr.split('\n').filter((l) => l.startsWith('stub ')).map((l) => JSON.parse(l.slice(5)))
  // The planted echo reached the output: the words around the key are printed, the key is not.
  assert.ok(out.stdout.includes('UNREAD getHealth: status 200, error -32000: refused [key] here'))
  assert.ok(out.stdout.includes('MISMATCH getBalance: result.value: schema says number, got string'))
  assert.ok(!out.stdout.includes('GET /cq1/quote'), 'the REST quote went out as a GET with its query and was read')
  assert.ok(calls.some((c) => c.method === 'GET /cq1/quote'))
  assert.ok(!(out.stdout + out.stderr).includes(canary.slice('c_serv_'.length)))
  assert.equal(out.status, 1)
  assert.ok(calls.length > CALLS.length, 'each refused method is tried once more')
  assert.ok(calls.every((c) => c.header && !c.elsewhere))
  assert.deepEqual(calls.slice(1).filter((c, i) => c.at - calls[i].at < 1000), [])
})

// The HTTPS caller against a stand-in fetch that answers from a list, on a clock that moves only when the caller waits.
// A second call on the same caller follows the first, and no two requests may leave within a second of each other.
async function asked(answers) {
  const real = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, now: Date.now }
  const waits = []
  const sent = []
  let now = 0
  let asks = 0
  Date.now = () => now
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    waits.push(ms)
    now += ms
    return real.setTimeout(fn, 0, ...args)
  }
  globalThis.fetch = async () => {
    sent.push(now)
    const [status, after] = answers[Math.min(asks++, answers.length - 1)]
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: asks }), { status, headers: after === undefined ? {} : { 'retry-after': String(after) } })
  }
  try {
    const call = httpCall('any', 'https://stand-in.invalid')
    const out = await call('getSupply')
    const first = { status: out.status, result: out.json?.result, asks, waits: [...waits] }
    await call('getSlot')
    assert.deepEqual(sent.slice(1).filter((at, i) => at - sent[i] < 1000), [], 'at most one request a second, the asks again included')
    return first
  } finally {
    Object.assign(globalThis, { fetch: real.fetch, setTimeout: real.setTimeout })
    Date.now = real.now
  }
}

test('a 503 with Retry-After is asked again after that wait, 30 seconds at most, and four asks at most', async () => {
  // A cold cache as the service answers it: wait 1, wait longer, wait 1, then the answer.
  assert.deepEqual(await asked([[503, 1], [503, 45], [503, 1], [200]]), { status: 200, result: 4, asks: 4, waits: [1000, 30000, 1000] })
  assert.deepEqual(await asked([[503, 1]]), { status: 503, result: 4, asks: 4, waits: [1000, 1000, 1000] }, 'still refused at the fourth ask: handed back, so the run calls it UNREAD')
  assert.deepEqual(await asked([[503]]), { status: 503, result: 1, asks: 1, waits: [] }, 'a 503 with no Retry-After is not asked again')
  assert.deepEqual(await asked([[429, 5]]), { status: 429, result: 1, asks: 1, waits: [] }, 'a rate limit is not asked again')
  assert.deepEqual((await asked([[503, 0.5], [200]])).waits, [1000], 'never sooner than a second')
})
