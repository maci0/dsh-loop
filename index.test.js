import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, budgetLabel, roundMessage, apply, loopProjection } from './index.js'

test('parseArgs reads the documented forms', () => {
  assert.deepEqual(parseArgs('10 /perf-review'), { kind: 'loop', rounds: 10, command: '/perf-review' })
  assert.deepEqual(parseArgs(' 10 continue '), { kind: 'loop', rounds: 10, command: 'continue' })
  assert.deepEqual(parseArgs('0 continue'), { kind: 'loop', rounds: 0, command: 'continue' })
  assert.deepEqual(parseArgs('3 bash -c "echo hi"'), { kind: 'loop', rounds: 3, command: 'bash -c "echo hi"' })
  assert.deepEqual(
    parseArgs('10 /perf-review && /cordis-review'),
    { kind: 'loop', rounds: 10, command: '/perf-review && /cordis-review' },
  )
  assert.deepEqual(
    parseArgs('10 /perf-review; /cordis-review'),
    { kind: 'loop', rounds: 10, command: '/perf-review; /cordis-review' },
  )
})

test('parseArgs rejects a nested /loop stop', () => {
  const rejected = parseArgs('10 continue && /loop stop')
  assert.equal(rejected.kind, 'error')
  assert.match(rejected.text, /nested \/loop stop/)
})

test('parseArgs rejects malformed input', () => {
  assert.equal(parseArgs('').kind, 'error')
  assert.equal(parseArgs('stop').kind, 'stop')
  assert.equal(parseArgs('Stop').kind, 'stop')
  assert.equal(parseArgs('pause').kind, 'pause')
  assert.equal(parseArgs('Resume').kind, 'resume')
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

test('loop state events ride the session log at every transition', async () => {
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
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  invoke('2 continue')
  listeners[0][1](session, turnEnd)
  listeners[0][1](session, turnEnd)
  await flush()
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

test('rounds still queue when the state emit is rejected', async () => {
  // Regression: the turn/end listener runs inside the turn/end publication
  // boundary, where Session.append rejects reentrant appends. The round must
  // queue before (and regardless of) the state emit, or the loop wedges at
  // run 1 with the pill stuck — exactly the reported hang.
  const registered = []
  const listeners = []
  const ctx = {
    commands: { register: (def) => { registered.push(def); return () => {} } },
    agents: new Map(),
    on: (event, fn) => { listeners.push([event, fn]); return () => {} },
    effect: (fn) => fn(),
  }
  apply(ctx)
  const session = {
    id: 's5',
    reentrant: false,
    append() {
      if (this.reentrant) throw new Error('session append cannot reenter while another append is being published')
    },
  }
  const followups = []
  const agent = { session, followup: (m) => followups.push(m) }
  ctx.agents.set('s5', agent)
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })

  invoke('2 continue')
  session.reentrant = true
  listeners[0][1](session, turnEnd)
  assert.equal(followups.length, 2, 'round 2 queues even when the state emit throws')
  assert.match(followups[1].content.at(-1).text, /round 2\/2/)
  listeners[0][1](session, turnEnd)
  assert.equal(followups.length, 2, 'budget still spends')
  // The deferred emits still run (and warn) without surfacing.
  await new Promise((resolve) => setImmediate(resolve))
})

test('pause holds the round, resume continues it', async () => {
  const registered = []
  const listeners = []
  const ctx = {
    commands: { register: (def) => { registered.push(def); return () => {} } },
    agents: new Map(),
    on: (event, fn) => { listeners.push([event, fn]); return () => {} },
    effect: (fn) => fn(),
  }
  apply(ctx)
  const session = { id: 's6', appended: [], append(type, data) { this.appended.push([type, data]) } }
  const followups = []
  const agent = { session, followup: (m) => followups.push(m) }
  ctx.agents.set('s6', agent)
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  invoke('3 continue')
  assert.equal(invoke('pause').text, 'Loop for "continue" paused at round 1.')
  assert.equal(invoke('pause').text, 'Loop for "continue" is already paused at round 1.')
  listeners[0][1](session, turnEnd)
  assert.equal(followups.length, 1, 'a completed turn while paused queues nothing')

  assert.equal(invoke('resume').text, 'Loop for "continue" resumed at round 1.')
  assert.equal(invoke('resume').text, 'Loop for "continue" is already running.')
  listeners[0][1](session, turnEnd)
  assert.equal(followups.length, 2, 'resume picks up exactly where it paused')
  assert.match(followups[1].content.at(-1).text, /round 2\/3/)

  await flush()
  assert.deepEqual(session.appended.map(([, data]) => data.phase), ['active', 'paused', 'active', 'active'])

  assert.equal(invoke('stop').text, 'Loop for "continue" stopped after 2 round(s).')
})

test('pause and resume need a running loop', () => {
  const registered = []
  const ctx = {
    commands: { register: (def) => { registered.push(def); return () => {} } },
    agents: new Map(),
    on: () => () => {},
    effect: (fn) => fn(),
  }
  apply(ctx)
  const agent = { session: { id: 's7', append() {} }, followup: () => {} }
  const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })
  assert.equal(invoke('pause').text, 'No loop is running.')
  assert.equal(invoke('resume').text, 'No loop is running.')
})

test('verbs adopt the durable fold after the process forgets the loop', async () => {
  // Regression: a restart wipes the round-driver map while the projected
  // `loop/state` fold survives, so the pill stays up and `/loop stop`
  // answers "No loop is running". The verbs must reconcile from the fold.
  const registered = []
  const listeners = []
  // The fake fold tracks appends, like the real projection unit would.
  const projected = { phase: 'active', command: 'continue', rounds: 10, run: 1 }
  const ctx = {
    commands: { register: (def) => { registered.push(def); return () => {} } },
    agents: new Map(),
    on: (event, fn) => { listeners.push([event, fn]); return () => {} },
    effect: (fn) => fn(),
    get: (key) => key === 'sessionProjections'
      ? { stateOf: () => ({ ...projected }) }
      : undefined,
  }
  apply(ctx)
  const session = {
    id: 's8',
    appended: [],
    append(type, data) {
      this.appended.push([type, data])
      if (type === 'loop/state') Object.assign(projected, data)
    },
  }
  const followups = []
  const agent = { session, followup: (m) => followups.push(m) }
  ctx.agents.set('s8', agent)
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })

  // Stop lands on the adopted entry and clears the pill.
  assert.equal(invoke('stop').text, 'Loop for "continue" stopped after 1 round(s).')
  assert.deepEqual(session.appended.at(-1)[1], { phase: 'stopped', command: 'continue', rounds: 10, run: 1 })
  assert.equal(invoke('stop').text, 'No loop is running.', 'stopped stays dead, never re-adopts')

  // Pause adopts, holds, and resumes across the same gap.
  projected.phase = 'active'
  assert.equal(invoke('pause').text, 'Loop for "continue" paused at round 1.')
  listeners[0][1](session, turnEnd)
  assert.equal(followups.length, 0, 'adopted pause holds the round')
  assert.equal(invoke('resume').text, 'Loop for "continue" resumed at round 1.')
  listeners[0][1](session, turnEnd)
  assert.equal(followups.length, 1, 'adopted resume drives the next round')
  assert.match(followups[0].content.at(-1).text, /round 2\/10/)
})

test('verbs ignore a dead or absent fold', () => {
  for (const fold of [undefined, null, { phase: 'stopped', command: 'x', rounds: 2, run: 2 }, { phase: 'done', command: 'x', rounds: 2, run: 2 }]) {
    const registered = []
    const ctx = {
      commands: { register: (def) => { registered.push(def); return () => {} } },
      agents: new Map(),
      on: () => () => {},
      effect: (fn) => fn(),
      get: () => ({ stateOf: () => fold }),
    }
    apply(ctx)
    const agent = { session: { id: 's9', append() {} }, followup: () => {} }
    const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })
    assert.equal(invoke('stop').text, 'No loop is running.', `fold ${JSON.stringify(fold)} stays dead`)
    assert.equal(invoke('pause').text, 'No loop is running.')
    assert.equal(invoke('resume').text, 'No loop is running.')
  }
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
