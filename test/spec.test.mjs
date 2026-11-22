// Each check returns the problems it finds, so every test first shows the check catching a planted problem.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateOpenRPCDocument } from '@open-rpc/schema-utils-js'
import Ajv from 'ajv'

const json = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))
const doc = json('openrpc.json')
const served = json('served.json')
const copy = (x) => structuredClone(x)
const unsubscribe = (name) => name.replace(/Subscribe$/, 'Unsubscribe')

function invalid(d) {
  const result = validateOpenRPCDocument(d)
  return result === true ? [] : [result.message]
}

function names(d) {
  const want = new Set([...served.rpc, ...served.ws, ...served.ws.map(unsubscribe)])
  const have = d.methods.map((m) => m.name)
  return [
    ...[...want].filter((n) => !have.includes(n)).map((n) => `served but missing: ${n}`),
    ...have.filter((n) => !want.has(n)).map((n) => `listed but not served: ${n}`),
    ...have.filter((n, i) => have.indexOf(n) !== i).map((n) => `listed twice: ${n}`),
  ]
}

function shapes(d) {
  const ajv = new Ajv({ strict: false })
  const out = []
  for (const m of d.methods) {
    if (!Array.isArray(m.params) || !m.result?.schema) { out.push(`${m.name}: no params or no result`); continue }
    if (!m.examples?.length) { out.push(`${m.name}: no example`); continue }
    const given = new Map(m.examples[0].params.map((p) => [p.name, p.value]))
    for (const p of m.params) {
      if (!given.has(p.name)) { if (p.required) out.push(`${m.name}: the example lacks ${p.name}`); continue }
      if (!ajv.validate({ components: d.components, allOf: [p.schema] }, given.get(p.name))) out.push(`${m.name}: the example's ${p.name} does not fit its schema (${ajv.errorsText()})`)
    }
    for (const name of given.keys()) if (!m.params.some((p) => p.name === name)) out.push(`${m.name}: the example gives ${name}, which is not a param`)
  }
  return out
}

// The word may appear only as a field name the services themselves send, never in our own text.
function wording(d) {
  const out = []
  const walk = (node, path, fieldList) => {
    if (typeof node === 'string') { if (/validator/i.test(node) && !(fieldList && node === 'validator')) out.push(`${path}: ${node.slice(0, 60)}`) }
    else if (Array.isArray(node)) node.forEach((x, i) => walk(x, `${path}[${i}]`, path.endsWith('.required')))
    else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`, false)
  }
  walk(d, 'openrpc', false)
  return out
}

test('openrpc.json is a valid OpenRPC document', () => {
  const bad = copy(doc)
  delete bad.methods[0].params
  assert.notDeepEqual(invalid(bad), [], 'a method without params must be refused')
  assert.deepEqual(invalid(doc), [])
})

test('it lists exactly the served methods', () => {
  const less = copy(doc)
  less.methods = less.methods.filter((m) => m.name !== 'getSlot')
  assert.deepEqual(names(less), ['served but missing: getSlot'])
  const more = copy(doc)
  more.methods.push({ ...more.methods[0], name: 'notAMethod' })
  assert.deepEqual(names(more), ['listed but not served: notAMethod'])
  assert.deepEqual(names(doc), [])
  assert.equal(doc.methods.length, served.rpc.length + 2 * served.ws.length)
})

test('every method has params, a result and an example that fits its schemas', () => {
  const bad = copy(doc)
  bad.methods.find((m) => m.name === 'getBalance').examples[0].params[0].value = 5
  assert.equal(shapes(bad).length, 1, 'a number where an address belongs must be refused')
  const bare = copy(doc)
  delete bare.methods.find((m) => m.name === 'getSlot').result
  assert.deepEqual(shapes(bare), ['getSlot: no params or no result'])
  assert.deepEqual(shapes(doc), [])
})

// A schema name must come from the SDK's types alone, never from a file position or the build folder.
const positional = (d) => Object.keys(d.components.schemas).filter((name) => /\d{6,}|structure|def_(?:interface|type|enum|alias)|_ts_\d/.test(name))

test('no schema name depends on where the build ran', () => {
  // One plant per form, each with no long digit run and no other form in it, so its own pattern must catch it.
  for (const name of ['Account123456', 'WithContext_structure_src_x_41_58', 'WithContext_def_interface_x_59_89', 'X_def_type_x_5_9', 'X_def_enum_x_5_9', 'X_def_alias_x_5_9', 'WithContext_src_ws_ts_4091']) {
    const bad = copy(doc)
    bad.components.schemas[name] = {}
    assert.deepEqual(positional(bad), [name])
  }
  assert.deepEqual(positional(doc), [])
})

test('our own text never uses the word the copy rule reserves for service error strings', () => {
  const bad = copy(doc)
  bad.info.description += ' Answers come from a validator.'
  assert.equal(wording(bad).length, 1)
  assert.deepEqual(wording(doc), [])
})
