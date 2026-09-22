import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, budgetLabel, roundMessage, apply, loopProjection } from './index.js'

test('parseArgs reads the documented forms', () => {
  assert.deepEqual(parseArgs('10 /perf-review'), { kind: 'loop', rounds: 10, command: '/perf-review' })
  assert.deepEqual(parseArgs(' 10 continue '), { kind: 'loop', rounds: 10, command: 'continue' })
  assert.deepEqual(parseArgs('0 continue'), { kind: 'loop', rounds: 0, command: 'continue' })
  assert.deepEqual(parseArgs('3 bash -c "echo hi"'), { kind: 'loop', rounds: 3, command: 'bash -c "echo hi"' })
})

test('parseArgs rejects malformed input', () => {
  assert.equal(parseArgs('').kind, 'error')
  assert.equal(parseArgs('stop').kind, 'stop')
  assert.equal(parseArgs('Stop').kind, 'stop')
  assert.equal(parseArgs('10').kind, 'error', 'rounds without a command')
  assert.equal(parseArgs('abc continue').kind, 'error', 'non-numeric rounds')
  assert.equal(parseArgs('10 ').kind, 'error', 'trailing space is not a command')
})

test('budget labels', () => {
  assert.equal(budgetLabel(0), '∞ (stop with /loop stop)')
  assert.equal(budgetLabel(10), '10')
})

test('roundMessage carries the command and the running count', () => {
  assert.equal(roundMessage('continue', 2, 10), '[loop round 2/10]\ncontinue')
  assert.match(roundMessage('/perf-review', 4, 0), /round 4\/∞/)
  assert.ok(roundMessage('/perf-review', 1, 10).includes('/perf-review'))
})

test('apply registers /loop and drives rounds on turn/end', async () => {
  const registered = []
  const listeners = []
  const ctx = {
    commands: { register: (def) => { registered.push(def); return () => {} } },
    agents: new Map(),
    on: (event, fn) => { listeners.push([event, fn]); return () => {} },
    effect: (fn) => fn(),
  }
  apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'loop')

  const session = { id: 's1', appended: [], append(type, data) { this.appended.push([type, data]) } }
  const followups = []
  const agent = { session, followup: (m) => followups.push(m) }
  ctx.agents.set('s1', agent)
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const invoke = (input) => registered[0].handler({
    rawInput: input,
    attachments: [],
    agent,
  })

  // Start a 2-round loop; round 1 queues immediately.
  const start = invoke('2 continue')
  assert.equal(start.kind, 'success')
  assert.equal(followups.length, 1)
  assert.match(followups[0].content.at(-1).text, /round 1\/2/)

  // Round 1 completes → round 2 queues.
  listeners[0][1](session, turnEnd)
  assert.equal(followups.length, 2)
  assert.match(followups[1].content.at(-1).text, /round 2\/2/)

  // Round 2 completes → budget spent, nothing more queues.
  listeners[0][1](session, turnEnd)
  assert.equal(followups.length, 2)
  listeners[0][1](session, turnEnd)
  assert.equal(followups.length, 2)
})

test('infinite loop keeps queueing until /loop stop', async () => {
  const registered = []
  const listeners = []
  const ctx = {
    commands: { register: (def) => { registered.push(def); return () => {} } },
    agents: new Map(),
    on: (event, fn) => { listeners.push([event, fn]); return () => {} },
    effect: (fn) => fn(),
  }
  apply(ctx)
  const session = { id: 's2', appended: [], append(type, data) { this.appended.push([type, data]) } }
  const followups = []
  const agent = { session, followup: (m) => followups.push(m) }
  ctx.agents.set('s2', agent)
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })

  assert.match(invoke('0 /perf-review').text, /∞/)
  assert.equal(followups.length, 1)
  for (let i = 0; i < 3; i++) listeners[0][1](session, turnEnd)
  assert.equal(followups.length, 4, 'every completed turn queues the next round')

  assert.match(invoke('stop').text, /stopped after 4 round/)
  listeners[0][1](session, turnEnd)
  assert.equal(followups.length, 4, 'stopped loop queues nothing')

  assert.equal(invoke('stop').text, 'No loop is running.')
})

test('non-completed turns and foreign sessions do not advance the loop', () => {
  const registered = []
  const listeners = []
  const ctx = {
    commands: { register: (def) => { registered.push(def); return () => {} } },
    agents: new Map(),
    on: (event, fn) => { listeners.push([event, fn]); return () => {} },
    effect: (fn) => fn(),
  }
  apply(ctx)
  const session = { id: 's3', appended: [], append(type, data) { this.appended.push([type, data]) } }
  const followups = []
  ctx.agents.set('s3', { session, followup: (m) => followups.push(m) })
  registered[0].handler({ rawInput: '5 continue', attachments: [], agent: ctx.agents.get('s3') })
  assert.equal(followups.length, 1)

  listeners[0][1](session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  listeners[0][1](session, { type: 'turn/start', data: {} })
  listeners[0][1]({ id: 'other' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(followups.length, 1, 'only a completed turn on the owning session advances')
})

test('loop state events ride the session log at every transition', () => {
  const registered = []
  const listeners = []
  const ctx = {
    commands: { register: (def) => { registered.push(def); return () => {} } },
    agents: new Map(),
    on: (event, fn) => { listeners.push([event, fn]); return () => {} },
    effect: (fn) => fn(),
  }
  apply(ctx)
  const session = { id: 's4', appended: [], append(type, data) { this.appended.push([type, data]) } }
  const agent = { session, followup: () => {} }
  ctx.agents.set('s4', agent)
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })

  invoke('2 continue')
  listeners[0][1](session, turnEnd)
  listeners[0][1](session, turnEnd)
  assert.deepEqual(session.appended.map(([type, data]) => [type, data.phase]), [
    ['loop/state', 'active'],
    ['loop/state', 'active'],
    ['loop/state', 'done'],
  ])
  assert.deepEqual(session.appended[0][1], { phase: 'active', command: 'continue', rounds: 2, run: 1 })

  invoke('0 continue')
  invoke('stop')
  assert.deepEqual(session.appended.at(-1)[1].phase, 'stopped')
})

test('projection unit folds loop/state events and passes others through', () => {
  assert.equal(loopProjection.init({}, 0), null)
  const state = { phase: 'active', command: 'continue', rounds: 5, run: 2 }
  assert.equal(loopProjection.apply(null, { type: 'turn/end', data: {} }), null, 'uninterested events keep the reference')
  assert.equal(loopProjection.apply(state, { type: 'turn/end', data: {} }), state)
  const done = { phase: 'done', command: 'continue', rounds: 5, run: 5 }
  assert.equal(loopProjection.apply(state, { type: 'loop/state', data: done }), done, 'whole-value fold')
  assert.equal(loopProjection.wire.view(done), done)
  // The wire schema validates the view before it leaves the host.
  assert.deepEqual(loopProjection.wire.viewSchema.parse(done), done)
  assert.equal(loopProjection.stateVersion, 1)
})
