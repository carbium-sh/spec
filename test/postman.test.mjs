// Each check returns the problems it finds, so every test first shows the check catching a planted problem.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { build } from '../scripts/build-postman.mjs'

const newman = createRequire(import.meta.url)('newman')
const json = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))
const collection = json('carbium.postman_collection.json')
const served = json('served.json')
const examples = json('examples.json')
const structure = Object.fromEntries(json('openrpc.json').methods.map((m) => [m.name, m.paramStructure]))
const openapi = json('openapi.json')
const copy = (x) => structuredClone(x)
const folder = (c, name) => c.item.find((f) => f.name === name)
const requests = (node) => node.item.flatMap((i) => (i.item ? requests(i) : [i]))

function rpcProblems(c) {
  const items = requests(folder(c, 'JSON-RPC'))
  const have = items.map((i) => i.name)
  const out = [
    ...served.rpc.filter((n) => !have.includes(n)).map((n) => `served but missing: ${n}`),
    ...have.filter((n) => !served.rpc.includes(n)).map((n) => `listed but not served: ${n}`),
  ]
  for (const i of items) {
    const text = i.request.body.raw
    const call = JSON.parse(text)
    if (call.method !== i.name) out.push(`${i.name}: the body calls another method`)
    const listed = Array.isArray(call.params)
    if (structure[i.name] === 'by-position' ? !listed : listed) out.push(`${i.name}: params have the wrong shape for a ${structure[i.name]} method`)
    if (text.includes('"params"') && text.indexOf('"method"') > text.indexOf('"params"')) out.push(`${i.name}: params come before method`)
    if (i.request.url !== '{{rpcUrl}}' || i.request.method !== 'POST') out.push(`${i.name}: not a POST to the RPC address`)
    if (!i.event?.length) out.push(`${i.name}: no test`)
  }
  return out
}

function restProblems(c) {
  const items = requests(folder(c, 'REST'))
  const have = items.map((i) => i.name)
  const out = [
    ...served.rest.filter((r) => !have.includes(r)).map((r) => `served but missing: ${r}`),
    ...have.filter((n) => !served.rest.includes(n)).map((n) => `listed but not served: ${n}`),
  ]
  for (const i of items.filter((x) => served.rest.includes(x.name))) {
    const [verb, path] = i.name.split(' ')
    if (i.request.method !== verb || `/${i.request.url.path.join('/')}` !== path || i.request.url.host[0] !== '{{rpcUrl}}') out.push(`${i.name}: not a ${verb} to {{rpcUrl}}${path}`)
    if (JSON.stringify(Object.fromEntries(i.request.url.query.map((q) => [q.key, q.value]))) !== JSON.stringify(examples[i.name])) out.push(`${i.name}: the query is not the example`)
    if (!i.event?.length) out.push(`${i.name}: no test`)
  }
  return out
}

function accountProblems(c) {
  const want = Object.entries(openapi.paths).flatMap(([path, verbs]) => Object.keys(verbs).map((verb) => `${verb.toUpperCase()} ${path}`))
  const have = requests(folder(c, 'Account API')).map((i) => i.name)
  // A call that changes the account must sit in the folder that says so, so a run of the reads changes nothing.
  const misplaced = requests(folder(folder(c, 'Account API'), 'Reads')).filter((i) => i.request.method !== 'GET').map((i) => `changes the account but sits among the reads: ${i.name}`)
  return [...want.filter((n) => !have.includes(n)).map((n) => `missing: ${n}`), ...have.filter((n) => !want.includes(n)).map((n) => `not in openapi.json: ${n}`), ...misplaced]
}

// A key lives in a variable that ships empty; nothing else in the file may carry one.
function keyProblems(c) {
  const out = c.variable.filter((v) => /key/i.test(v.key) && v.value !== '').map((v) => `${v.key} is set`)
  const header = folder(c, 'JSON-RPC').auth.apikey.find((p) => p.key === 'value').value
  const rest = folder(c, 'REST').auth.apikey.find((p) => p.key === 'value').value
  const bearer = folder(c, 'Account API').auth.bearer.find((p) => p.key === 'token').value
  if (header !== '{{serviceKey}}') out.push('the JSON-RPC key is not the serviceKey variable')
  if (rest !== '{{serviceKey}}') out.push('the REST key is not the serviceKey variable')
  if (bearer !== '{{accountKey}}') out.push('the account key is not the accountKey variable')
  return out
}

// A stand-in for the door: a result for a served name sent with a key, "method not found" for any other name, 401 with
// no key, and for a GET to a served REST route the given quote. It lets the collection run with no network and no real key.
function stub(names, quote = { destAmountOut: '1500000', srcAmountIn: '10000000000' }) {
  const server = createServer((req, res) => {
    let text = ''
    req.on('data', (chunk) => { text += chunk })
    req.on('end', () => {
      const { id = null, method } = JSON.parse(text || '{}')
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      const answer = (status, body) => send(status, { jsonrpc: '2.0', id, ...body })
      if (!req.headers['x-api-key']) return answer(401, { error: { code: -32001, message: 'missing api key' } })
      if (req.method === 'GET') return served.rest.includes(`GET ${new URL(req.url, 'http://stand-in').pathname}`) ? send(200, quote) : send(404, { error: 'not found' })
      if (!names.includes(method)) return answer(200, { error: { code: -32601, message: 'method not found' } })
      answer(200, { result: 0 })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })))
}

const run = (c, url, key, only = 'JSON-RPC') => new Promise((resolve, reject) => {
  newman.run({ collection: c, folder: only, envVar: [{ key: 'rpcUrl', value: url }, { key: 'serviceKey', value: key }] }, (error, summary) => {
    if (error) reject(error)
    else resolve({ requests: summary.run.stats.requests.total, failed: summary.run.failures.length })
  })
})

test('the collection is in the format Postman imports', () => {
  assert.equal(collection.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json')
  assert.deepEqual(collection.item.map((f) => f.name), ['JSON-RPC', 'REST', 'Account API'])
})

test('it has one request per served RPC method, each a well-formed call', () => {
  const less = copy(collection)
  folder(less, 'JSON-RPC').item[0].item = folder(less, 'JSON-RPC').item[0].item.filter((i) => i.name !== 'getSlot')
  assert.deepEqual(rpcProblems(less), ['served but missing: getSlot'])
  const wrong = copy(collection)
  const first = requests(folder(wrong, 'JSON-RPC'))[0]
  first.request.body.raw = first.request.body.raw.replace(first.name, 'getSlott')
  assert.equal(rpcProblems(wrong).length, 1)
  const shaped = copy(collection)
  const slot = requests(folder(shaped, 'JSON-RPC')).find((i) => i.name === 'getSlot')
  slot.request.body.raw = slot.request.body.raw.replace('"params": []', '"params": {}')
  assert.deepEqual(rpcProblems(shaped), ['getSlot: params have the wrong shape for a by-position method'])
  assert.deepEqual(rpcProblems(collection), [])
})

test('it has exactly one request per REST route, a GET with the example query', () => {
  const less = copy(collection)
  folder(less, 'REST').item = []
  assert.deepEqual(restProblems(less), ['served but missing: GET /cq1/quote'])
  const more = copy(collection)
  folder(more, 'REST').item.push({ ...copy(folder(more, 'REST').item[0]), name: 'GET /cq1/other' })
  assert.deepEqual(restProblems(more), ['listed but not served: GET /cq1/other'])
  const query = copy(collection)
  folder(query, 'REST').item[0].request.url.query.pop()
  assert.deepEqual(restProblems(query), ['GET /cq1/quote: the query is not the example'])
  assert.deepEqual(restProblems(collection), [])
  assert.equal(requests(folder(collection, 'REST')).length, served.rest.length)
})

test('it has one request per account API operation', () => {
  const less = copy(collection)
  folder(less, 'Account API').item[0].item.pop()
  assert.equal(accountProblems(less).length, 1)
  const moved = copy(collection)
  const [reads, writes] = folder(moved, 'Account API').item
  reads.item.push(writes.item.pop())
  assert.equal(accountProblems(moved).length, 1)
  assert.deepEqual(accountProblems(collection), [])
})

test('the committed collection is exactly what the builder writes', () => {
  const edited = copy(collection)
  edited.info.description += ' edited by hand'
  assert.notDeepEqual(build(), edited)
  assert.deepEqual(build(), collection)
})

test('no key ships in the file', () => {
  const bad = copy(collection)
  bad.variable.find((v) => v.key === 'serviceKey').value = 'something'
  assert.deepEqual(keyProblems(bad), ['serviceKey is set'])
  const inline = copy(collection)
  folder(inline, 'REST').auth.apikey.find((p) => p.key === 'value').value = 'something'
  assert.deepEqual(keyProblems(inline), ['the REST key is not the serviceKey variable'])
  assert.deepEqual(keyProblems(collection), [])
})

test('it runs in the Postman runtime: every request passes against a stand-in door', async () => {
  const door = await stub(served.rpc)
  try {
    const wrong = copy(collection)
    const first = requests(folder(wrong, 'JSON-RPC'))[0]
    first.request.body.raw = first.request.body.raw.replace(first.name, 'getSlott')
    assert.equal((await run(wrong, door.url, 'test')).failed, 1, 'a misspelt method must fail its request')
    assert.equal((await run(collection, door.url, '')).failed, served.rpc.length, 'with no key every request must fail')
    assert.deepEqual(await run(collection, door.url, 'test'), { requests: served.rpc.length, failed: 0 })
    assert.equal((await run(collection, door.url, '', 'REST')).failed, served.rest.length, 'with no key every REST request must fail')
    assert.deepEqual(await run(collection, door.url, 'test', 'REST'), { requests: served.rest.length, failed: 0 })
  } finally {
    door.close()
  }
  const noQuote = await stub(served.rpc, { outAmount: '1500000' })
  try {
    assert.equal((await run(collection, noQuote.url, 'test', 'REST')).failed, 1, 'an answer without destAmountOut must fail its request')
  } finally {
    noQuote.close()
  }
})
