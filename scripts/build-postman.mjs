#!/usr/bin/env node
// Builds carbium.postman_collection.json: one request per JSON-RPC method in openrpc.json that is sent over HTTPS,
// one per REST route in served.json (its query from examples.json), and one per operation in openapi.json (a copy of
// https://carbium.sh/openapi.json). Both keys are empty collection variables: a key is set in Postman or in the
// runner's environment, never in this file.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const json = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'))
const openrpc = json('openrpc.json')
const openapi = json('openapi.json')
const served = json('served.json')
const examples = json('examples.json')
const raw = (value) => ({ mode: 'raw', raw: JSON.stringify(value, null, 2), options: { raw: { language: 'json' } } })
const JSON_HEADER = [{ key: 'content-type', value: 'application/json' }]

// An unknown method also answers 200, so the test reads the body, not only the status.
const RPC_TEST = [{ listen: 'test', script: { type: 'text/javascript', exec: [
  "pm.test('answers with a result', () => {",
  '  pm.response.to.have.status(200)',
  '  const body = pm.response.json()',
  "  pm.expect(body, JSON.stringify(body.error)).to.not.have.property('error')",
  "  pm.expect(body).to.have.property('result')",
  '})',
] } }]

function rpcItem(method) {
  const [example] = method.examples
  const byName = method.paramStructure === 'by-name'
  const params = byName ? Object.fromEntries(example.params.map((p) => [p.name, p.value])) : example.params.map((p) => p.value)
  const call = { jsonrpc: '2.0', id: 1, method: method.name }
  if (!byName || example.params.length) call.params = params
  return {
    name: method.name,
    event: RPC_TEST,
    request: { method: 'POST', header: JSON_HEADER, url: '{{rpcUrl}}', body: raw(call), ...(example.description ? { description: example.description } : {}) },
  }
}

// The REST routes are the quote's REST form, so a test reads the quote's destAmountOut.
const REST_TEST = [{ listen: 'test', script: { type: 'text/javascript', exec: [
  "pm.test('answers with a quote', () => {",
  '  pm.response.to.have.status(200)',
  '  const body = pm.response.json()',
  "  pm.expect(body).to.be.an('object')",
  "  pm.expect(body).to.have.property('destAmountOut')",
  '})',
] } }]

function restItem(route) {
  const [verb, path] = route.split(' ')
  const query = Object.entries(examples[route]).map(([key, value]) => ({ key, value: String(value) }))
  return {
    name: route,
    event: REST_TEST,
    request: {
      method: verb,
      header: [],
      url: { raw: `{{rpcUrl}}${path}?${query.map((q) => `${q.key}=${q.value}`).join('&')}`, host: ['{{rpcUrl}}'], path: path.slice(1).split('/'), query },
    },
  }
}

function accountItem(verb, path, operation) {
  const body = operation.requestBody?.content?.['application/json']?.example
  const sessionOnly = operation.security.every((way) => 'session' in way)
  return {
    name: `${verb} ${path}`,
    request: {
      method: verb,
      header: body ? JSON_HEADER : [],
      url: {
        raw: `{{accountUrl}}${path.replace(/\{(\w+)\}/g, ':$1')}`,
        host: ['{{accountUrl}}'],
        path: path.slice(1).split('/').map((part) => part.replace(/^\{(\w+)\}$/, ':$1')),
        variable: [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ key: m[1], value: '' })),
      },
      ...(body ? { body: raw(body) } : {}),
      description: `${operation.description} Answers: ${operation.summary}.${sessionOnly ? ' Needs a dashboard session: an account API key is refused.' : ''}`,
    },
  }
}

const GROUPS = [['rpc', 'Solana RPC'], ['das', 'DAS'], ['quote', 'Quote API']]
const WRITES = 'Changes the account'
const SERVICE_AUTH = { type: 'apikey', apikey: [{ key: 'key', value: 'x-api-key', type: 'string' }, { key: 'value', value: '{{serviceKey}}', type: 'string' }, { key: 'in', value: 'header', type: 'string' }] }

export function build() {
  const overHttps = openrpc.methods.filter((m) => !m.servers) // WebSocket methods name their own server; Postman's collection format has no WebSocket request
  const account = Object.entries(openapi.paths).flatMap(([path, verbs]) => Object.entries(verbs).map(([verb, operation]) => accountItem(verb.toUpperCase(), path, operation)))
  return {
    info: {
      name: 'carbium services',
      description: [
        'Every JSON-RPC method served over HTTPS at services.carbium.sh (the WebSocket subscriptions are in openrpc.json), the REST form of the quote, and every account API call on carbium.sh.',
        'Keys: put serviceKey (a c_serv_ key) and accountKey (a c_acct_ key) in a Postman environment as current values, or in the Postman Vault, so a key never leaves with an exported or shared collection.',
        `Do not run the whole collection: the folder "${WRITES}" creates, changes and removes keys and webhooks, and some JSON-RPC calls cost many credits. Send those one at a time.`,
      ].join('\n\n'),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'rpcUrl', value: openrpc.servers[0].url, type: 'string' },
      { key: 'accountUrl', value: 'https://carbium.sh', type: 'string' },
      { key: 'serviceKey', value: '', type: 'string' },
      { key: 'accountKey', value: '', type: 'string' },
    ],
    item: [
      {
        name: 'JSON-RPC',
        description: 'One POST per method. A value in angle brackets is a placeholder to replace before sending.',
        auth: SERVICE_AUTH,
        item: GROUPS.map(([tag, name]) => ({ name, item: overHttps.filter((m) => m.tags[0].name === tag).map(rpcItem) })),
      },
      {
        name: 'REST',
        description: 'One request per REST route. These routes have no schema in openrpc.json, which describes JSON-RPC only.',
        auth: SERVICE_AUTH,
        item: served.rest.map(restItem),
      },
      {
        name: 'Account API',
        auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accountKey}}', type: 'string' }] },
        item: [
          { name: 'Reads', item: account.filter((i) => i.request.method === 'GET') },
          { name: WRITES, description: 'Each call here creates, changes or removes something on the account: POST /v1/keys, for one, creates a live key. Send them one at a time, never as a folder run.', item: account.filter((i) => i.request.method !== 'GET') },
        ],
      },
    ],
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const collection = build()
  writeFileSync(join(root, 'carbium.postman_collection.json'), JSON.stringify(collection, null, 1) + '\n')
  const count = (node) => node.item.reduce((n, i) => n + (i.item ? count(i) : 1), 0)
  console.log(`carbium.postman_collection.json: ${count(collection.item[0])} JSON-RPC requests, ${count(collection.item[1])} REST requests, ${count(collection.item[2])} account API requests`)
}
