#!/usr/bin/env node
// Builds openrpc.json: one method per name in served.json, with its params and result generated from the SDK's
// own types. Rebuild it when those types change.
// Usage: node scripts/build-openrpc.mjs --sdk <carbium-js checkout> [--commit <the checkout's commit>]
import { createGenerator } from 'ts-json-schema-generator'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const at = process.argv.indexOf('--sdk')
if (at < 0 || !process.argv[at + 1]) { console.error('usage: build-openrpc.mjs --sdk <carbium-js checkout>'); process.exit(2) }
const src = join(process.argv[at + 1], 'packages/sdk/src')
const commitAt = process.argv.indexOf('--commit')
const sdkCommit = commitAt < 0 ? undefined : process.argv[commitAt + 1] // the carbium-js commit the types were read from
const json = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'))
const served = json('served.json')
const examples = json('examples.json')
const { METHODS } = await import(pathToFileURL(join(src, 'rpc/methods.gen.ts')).href)

const HTTP = 'https://services.carbium.sh'
const WSS = 'wss://services.carbium.sh'
const defs = {}
const sources = ['rpc/types.ts', 'ws.ts'].map((file) => readFileSync(join(src, file), 'utf8'))
const servedNames = new Set([...served.rpc, ...served.ws])

function sourceOf(length) {
  const found = sources.filter((text) => text.length === Number(length))
  if (found.length !== 1) throw new Error(`cannot tell which source file is ${length} characters long`)
  return found[0]
}

// The generator names a generic's argument by where it sits in the source file, which changes with every edit and
// with the folder the build runs in. Use the declared name instead, or for an inline type the method it belongs to.
// Its key for the file is a number, or for a short path the path itself, so the key is matched as any text.
function spansOf(id) {
  const tokens = id.slice('structure-'.length).split('-')
  for (let k = 1; k + 2 <= tokens.length; k++) {
    if (tokens.length % (k + 2)) continue
    const key = tokens.slice(0, k).join('-'), spans = []
    for (let at = 0; at < tokens.length; at += k + 2) {
      const [pos, end] = tokens.slice(at + k, at + k + 2)
      if (tokens.slice(at, at + k).join('-') !== key || !/^\d+$/.test(pos) || !/^\d+$/.test(end)) { spans.length = 0; break }
      spans.push([Number(pos), Number(end)])
    }
    if (spans.length) return spans
  }
  throw new Error(`cannot read the positions in ${id}`)
}
function stable(name) {
  return name
    .replace(/def-[a-z]+-[^<>,\s]+?-(\d+)-(\d+)-[^<>,\s]+?-0-(\d+)/g, (id, pos, end, length) => {
      const declared = /\b(?:interface|type|enum)\s+([A-Za-z0-9_]+)/.exec(sourceOf(length).slice(Number(pos), Number(end)))
      if (!declared) throw new Error(`no declared name for ${id}`)
      return declared[1]
    })
    .replace(/structure-[^<>,\s|()&[\]]+/g, (id) => {
      const spans = spansOf(id)
      const text = sourceOf(spans.at(-1)[1])
      for (const [pos, end] of spans) {
        const member = /^([A-Za-z0-9_]+)\??\s*:/.exec(text.slice(pos, end).replace(/^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*)+/, ''))?.[1]
        if (!servedNames.has(member)) continue
        const base = member[0].toUpperCase() + member.slice(1)
        return served.ws.includes(member) ? base.replace(/Subscribe$/, 'Notification') : `${base}Result`
      }
      throw new Error(`an inline type belongs to no served method: ${id}`)
    })
    .replace(/(?<=[A-Za-z])\d{6,}/g, '')
}

// One interface of { params, result } entries, as JSON Schema. Definition names become plain identifiers.
function load(file, type) {
  const schema = createGenerator({ path: join(src, file), type, jsDoc: 'none', topRef: false, skipTypeCheck: true, expose: 'all', additionalProperties: true }).createSchema(type)
  const plain = (name) => stable(decodeURIComponent(name)).replace(/\[\]/g, '_array').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const move = (node) => JSON.parse(JSON.stringify(node).replace(/"#\/definitions\/([^"]+)"/g, (_, name) => `"#/components/schemas/${plain(name)}"`))
  for (const [name, def] of Object.entries(schema.definitions ?? {})) {
    const key = plain(name), next = move(def)
    // A last guard: a name the steps above did not read must never be written.
    if (/\d{6,}|structure|def_(?:interface|type|enum|alias)|_ts_\d/.test(key)) throw new Error(`schema name still carries a source position: ${key}`)
    if (defs[key] && JSON.stringify(defs[key]) !== JSON.stringify(next)) throw new Error(`two different schemas named ${key}`)
    defs[key] = next
  }
  return Object.fromEntries(Object.entries(schema.properties).map(([name, entry]) => [name, move(entry.properties)]))
}

const deref = (schema) => (schema?.$ref ? defs[schema.$ref.split('/').pop()] : schema)

// The fields of an object-shaped params type: its properties and which are required.
function fields(schema) {
  const s = deref(schema)
  if (!s || s.type === 'null') return { props: {}, required: [] }
  if (s.allOf) return s.allOf.map(fields).reduce((a, b) => ({ props: { ...a.props, ...b.props }, required: [...a.required, ...b.required] }))
  if (s.anyOf) {
    const real = s.anyOf.filter((x) => deref(x).type !== 'null')
    if (real.length !== 1) throw new Error('a params type that is a union of objects needs its own handling')
    const one = fields(real[0])
    return real.length === s.anyOf.length ? one : { props: one.props, required: [] } // "X | void": nothing is required
  }
  if (s.type !== 'object') throw new Error(`params are not an object: ${JSON.stringify(s).slice(0, 80)}`)
  return { props: s.properties ?? {}, required: s.required ?? [] }
}

// A labelled tuple becomes one named param per position.
function positional(method, schema) {
  const s = deref(schema)
  const items = Array.isArray(s.items) ? s.items : s.items ? Array.from({ length: s.maxItems ?? 1 }, () => s.items) : []
  return items.map(({ title, ...rest }, i) => {
    if (!title) throw new Error(`${method}: param ${i} has no label in the SDK's types`)
    return { name: title, required: i < (s.minItems ?? 0), schema: rest }
  })
}

function named(schema) {
  const { props, required } = fields(schema)
  return Object.entries(props)
    .map(([name, s]) => ({ name, required: required.includes(name), schema: s }))
    .sort((a, b) => Number(b.required) - Number(a.required)) // OpenRPC: required params come first
}

function example(method, params, value, byName = false) {
  if (value === undefined) throw new Error(`${method}: no example in examples.json`)
  // examples.json writes an object-params call as a list holding that one object, or an empty list
  if (byName && Array.isArray(value)) {
    if (value.length > 1) throw new Error(`${method}: an object-params example holds more than one value`)
    value = value[0] ?? {}
  }
  const pairs = Array.isArray(value)
    ? value.map((v, i) => ({ name: params[i]?.name ?? `param${i}`, value: v }))
    : Object.entries(value).map(([name, v]) => ({ name, value: v }))
  // An example is an illustration: say which of its values a caller has to replace before sending it.
  const notes = []
  if (JSON.stringify(value).includes('"<')) notes.push('Replace each value in angle brackets with your own.')
  if (pairs.some((p) => /slot/i.test(p.name) && typeof p.value === 'number')) notes.push('The slot is an illustration: use a recent one from getSlot.')
  return [{ name: 'example', ...(notes.length ? { description: notes.join(' ') } : {}), params: pairs }]
}

const rpcTypes = load('rpc/types.ts', 'RpcMethods')
const wsTypes = load('ws.ts', 'SubscriptionMethods')
const methods = []

for (const name of served.rpc) {
  const spec = METHODS[name], types = rpcTypes[name]
  if (!spec || !types) throw new Error(`${name} is served but the SDK does not type it`)
  const byName = spec.params === 'object'
  const params = byName ? named(types.params) : positional(name, types.params)
  methods.push({
    name,
    tags: [{ name: spec.plane }],
    paramStructure: byName ? 'by-name' : 'by-position',
    params,
    result: { name: 'result', schema: types.result },
    examples: example(name, params, examples[name], byName),
    'x-batch': spec.batch,
    'x-permit': spec.permit,
  })
}

for (const name of served.ws) {
  const types = wsTypes[name]
  if (!types) throw new Error(`${name} is served but the SDK does not type it`)
  const params = positional(name, types.params)
  const servers = [{ name: 'websocket', url: WSS }]
  methods.push({
    name,
    tags: [{ name: 'websocket' }],
    servers,
    paramStructure: 'by-position',
    params,
    result: { name: 'subscription', schema: { type: 'integer' } },
    examples: example(name, params, examples[name]),
    'x-notification': { method: name.replace(/Subscribe$/, 'Notification'), result: types.result },
  })
  methods.push({
    name: name.replace(/Subscribe$/, 'Unsubscribe'),
    tags: [{ name: 'websocket' }],
    servers,
    paramStructure: 'by-position',
    params: [{ name: 'subscription', required: true, schema: { type: 'integer' } }],
    result: { name: 'result', schema: { type: 'boolean' } },
    examples: [{ name: 'example', params: [{ name: 'subscription', value: 1 }] }],
  })
}

const doc = {
  openrpc: '1.4.1',
  info: {
    title: 'carbium services JSON-RPC',
    version: json('package.json').version,
    description: 'Every JSON-RPC method served at services.carbium.sh: Solana RPC, DAS, the quote API and the WebSocket subscriptions. Send the API key in the x-api-key header.',
    license: { name: 'MIT' },
    ...(sdkCommit ? { 'x-sdk-commit': sdkCommit } : {}),
  },
  servers: [{ name: 'mainnet', url: HTTP }],
  methods,
  components: { schemas: Object.fromEntries(Object.entries(defs).sort(([a], [b]) => a.localeCompare(b))) },
}
writeFileSync(join(root, 'openrpc.json'), JSON.stringify(doc, null, 1) + '\n')
console.log(`openrpc.json: ${served.rpc.length} RPC methods, ${served.ws.length} subscriptions with their unsubscribes, ${Object.keys(defs).length} schemas`)
