/**
 * Browser half: the loop pill.
 *
 * `lib/client.js` is imported once as a real module over a stub
 * `window.__ModuleLoader__`, which captures the factory the module system
 * would materialize. The factory is the per-mount unit: every case runs it
 * over its own minimal React (element trees plus `useState`), so the pill
 * renders without a DOM.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Import the client file and return the definition it registers. */
async function loadClient() {
  let captured
  globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
  try {
    await import('../lib/client.js')
  } finally {
    delete globalThis.window
  }
  return captured
}

const definition = await loadClient()

/** Element trees plus `useState` cells that persist across renders. */
function createReact() {
  const hooks = { cells: [], index: 0 }
  return {
    hooks,
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } }
    },
    useState(initial) {
      const cell = hooks.index++
      if (!Object.hasOwn(hooks.cells, cell)) hooks.cells[cell] = initial
      return [hooks.cells[cell], (next) => { hooks.cells[cell] = next }]
    },
  }
}

/** Every element with one class in a rendered tree, depth first. */
function byClass(node, className) {
  const found = []
  const visit = (current) => {
    if (current === null || typeof current !== 'object') return
    if (Array.isArray(current)) return current.forEach(visit)
    if (String(current.props?.className ?? '').split(' ').includes(className)) found.push(current)
    visit(current.props?.children ?? [])
  }
  visit(node)
  return found
}

/** The concatenated text of a rendered subtree. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children ?? [])
}

/** Mount the client plugin over a fake context and return the pill harness. */
async function mountPill({ command }) {
  assert.equal(definition.id, 'dsh-loop')
  const React = createReact()
  const exports = definition.factory((id) => {
    assert.equal(id, 'react')
    return React
  })
  assert.deepEqual(exports.inject, ['slots', 'sessions'])

  let entry
  let Pill
  const lines = []
  exports.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: (spec, component) => { entry = spec; Pill = component },
    },
    sessions: {
      binding: () => ({ session: { command: async (line) => { lines.push(line); return command(line) } } }),
    },
  })
  assert.equal(entry.name, 'conversation.input.dock')

  const state = { loop: { phase: 'active', command: 'continue', rounds: 3, run: 2 } }
  const render = () => {
    React.hooks.index = 0
    return Pill({ sessionId: 's1', useProjection: () => state.loop, ...entry.inject('s1') })
  }
  const click = async (label) => {
    const button = byClass(render(), 'loop-btn').find((candidate) => textOf(candidate) === label)
    assert.notEqual(button, undefined, `a ${label} button`)
    await button.props.onClick()
  }
  return { render, click, lines, state }
}

test('the pill renders the loop and runs its verbs', async () => {
  const pill = await mountPill({ command: async () => ({ ok: true, value: { matched: true } }) })
  const tree = pill.render()
  assert.equal(textOf(byClass(tree, 'loop-label')[0]), 'continue')
  assert.equal(textOf(byClass(tree, 'loop-rounds')[0]), ' 2/3')

  await pill.click('Pause')
  await pill.click('Stop')
  assert.deepEqual(pill.lines, ['/loop pause', '/loop stop'])
  assert.equal(byClass(pill.render(), 'loop-error').length, 0)

  pill.state.loop = null
  assert.equal(pill.render(), null, 'no loop, no pill')
})

test('a failed verb shows in the pill, never as an unhandled rejection', async () => {
  // Regression: runVerb only reset its pending flag, so a refused command
  // rejected out of the click handler and the pill showed nothing.
  const pill = await mountPill({
    command: async () => ({ ok: false, error: { code: 'unavailable', message: 'host gone' } }),
  })
  await pill.click('Stop')
  let label = byClass(pill.render(), 'loop-label')[0]
  assert.match(label.props.className, /loop-error/)
  assert.match(label.props.title, /unavailable: host gone/)
  assert.match(textOf(label), /Stop failed/)
  assert.equal(byClass(pill.render(), 'loop-btn').every((button) => button.props.disabled === false), true)

  // The next action clears the error.
  await pill.click('Pause')
  label = byClass(pill.render(), 'loop-label')[0]
  assert.match(textOf(label), /Pause failed/)

  // A projection change clears it too.
  pill.state.loop = { ...pill.state.loop, run: 3 }
  label = byClass(pill.render(), 'loop-label')[0]
  assert.doesNotMatch(label.props.className, /loop-error/)
  assert.equal(textOf(label), 'continue')
  assert.equal(label.props.title, 'continue')
})
