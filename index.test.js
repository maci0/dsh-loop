import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, parseRoundLine, budgetLabel, roundMessage, apply, loopProjection } from './index.js'

/** Let the driver's deferred round queue, since a round never queues inside the turn/end publication. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

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
  assert.equal(parseArgs('status').kind, 'status')
  assert.equal(parseArgs('List').kind, 'status', 'a list verb answers the same question')
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
  const agent = { session, whenIdle: () => Promise.resolve(), followup: (m) => followups.push(m) }
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
  await settle()
  assert.equal(followups.length, 2)
  assert.match(followups[1].content.at(-1).text, /round 2\/2/)

  // Round 2 completes → budget spent, nothing more queues.
  listeners[0][1](session, turnEnd)
  await settle()
  assert.equal(followups.length, 2)
  listeners[0][1](session, turnEnd)
  await settle()
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
  const agent = { session, whenIdle: () => Promise.resolve(), followup: (m) => followups.push(m) }
  ctx.agents.set('s2', agent)
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })

  assert.match(invoke('0 /perf-review').text, /∞/)
  assert.equal(followups.length, 1)
  for (let i = 0; i < 3; i++) listeners[0][1](session, turnEnd)
  await settle()
  assert.equal(followups.length, 4, 'every completed turn queues the next round')

  assert.match(invoke('stop').text, /stopped after 4 round/)
  listeners[0][1](session, turnEnd)
  await settle()
  assert.equal(followups.length, 4, 'stopped loop queues nothing')

  assert.equal(invoke('stop').text, 'No loop is running.')
})

test('/loop status reports the live loop, and nothing when there is none', async () => {
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
  const agent = { session, whenIdle: () => Promise.resolve(), followup: (m) => followups.push(m) }
  ctx.agents.set('s3', agent)
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })

  assert.equal(invoke('status').text, 'No loop is running.')

  invoke('4 /perf-review')
  assert.equal(
    invoke('status').text,
    'Loop for "/perf-review" is running — round 1 of 4.',
  )

  listeners[0][1](session, turnEnd)
  await settle()
  assert.equal(invoke('status').text, 'Loop for "/perf-review" is running — round 2 of 4.')

  invoke('pause')
  assert.equal(invoke('status').text, 'Loop for "/perf-review" is paused — round 2 of 4.')

  invoke('stop')
  assert.equal(invoke('status').text, 'No loop is running.')
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
  ctx.agents.set('s3', { session, whenIdle: () => Promise.resolve(), followup: (m) => followups.push(m) })
  registered[0].handler({ rawInput: '5 continue', attachments: [], agent: ctx.agents.get('s3') })
  assert.equal(followups.length, 1)

  listeners[0][1](session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  listeners[0][1](session, { type: 'turn/start', data: {} })
  listeners[0][1]({ id: 'other' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(followups.length, 1, 'only a completed turn on the owning session advances')
})

test('the driver appends no custom events', async () => {
  // Regression: a plugin-owned `loop/state` type poisons the log — the
  // persistence read path refuses sessions with unknown non-ignorable types.
  // The driver must queue rounds without appending anything itself.
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
  const agent = { session, whenIdle: () => Promise.resolve(), followup: () => {} }
  ctx.agents.set('s4', agent)
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })

  invoke('2 continue')
  listeners[0][1](session, turnEnd)
  listeners[0][1](session, turnEnd)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(session.appended, [], 'no loop/state events anywhere')

  invoke('0 continue')
  invoke('pause')
  invoke('resume')
  invoke('stop')
  assert.deepEqual(session.appended, [], 'verbs also append nothing')
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
  const session = { id: 's6' }
  const followups = []
  const agent = { session, whenIdle: () => Promise.resolve(), followup: (m) => followups.push(m) }
  ctx.agents.set('s6', agent)
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })

  invoke('3 continue')
  assert.equal(invoke('pause').text, 'Loop for "continue" paused at round 1.')
  assert.equal(invoke('pause').text, 'Loop for "continue" is already paused at round 1.')
  listeners[0][1](session, turnEnd)
  await settle()
  assert.equal(followups.length, 1, 'a completed turn while paused queues nothing')

  assert.equal(invoke('resume').text, 'Loop for "continue" resumed at round 1.')
  assert.equal(invoke('resume').text, 'Loop for "continue" is already running.')
  // Resume queues the held round itself; no later turn/end exists to drive it,
  // since pause and resume are plugin commands.
  await settle()
  assert.equal(followups.length, 2, 'resume picks up exactly where it paused')
  assert.match(followups[1].content.at(-1).text, /round 2\/3/)

  assert.equal(invoke('stop').text, 'Loop for "continue" stopped after 2 round(s).')
})

test('a round never queues inside the turn/end publication', async () => {
  // Regression: `followup` appends, and a session refuses an append that
  // reenters the event it is publishing ("session append cannot reenter
  // while another append is being published"). The listener's throw is
  // swallowed, so the loop died silently after round 1.
  const registered = []
  const listeners = []
  const ctx = {
    commands: { register: (def) => { registered.push(def); return () => {} } },
    agents: new Map(),
    on: (event, fn) => { listeners.push([event, fn]); return () => {} },
    effect: (fn) => fn(),
  }
  apply(ctx)
  const session = { id: 's5' }
  const followups = []
  let publishing = false
  const agent = {
    session,
    // Quiescence arrives after the publication, never inside it.
    whenIdle: () => new Promise((resolve) => setImmediate(resolve)),
    followup: (m) => {
      if (publishing) throw new Error('session append cannot reenter while another append is being published')
      followups.push(m)
    },
  }
  ctx.agents.set('s5', agent)
  registered[0].handler({ rawInput: '2 continue', attachments: [], agent })
  assert.equal(followups.length, 1)

  publishing = true
  listeners[0][1](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  publishing = false
  await settle()
  await settle()
  assert.equal(followups.length, 2, 'round 2 queues after the publication ends')
  assert.match(followups[1].content.at(-1).text, /round 2\/2/)
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
  const agent = { session: { id: 's7', append() {} }, whenIdle: () => Promise.resolve(), followup: () => {} }
  const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })
  assert.equal(invoke('pause').text, 'No loop is running.')
  assert.equal(invoke('resume').text, 'No loop is running.')
})

test('verbs adopt the durable fold after the process forgets the loop', async () => {
  // Regression: a restart wipes the round-driver map while the projected
  // fold (command rows + relay lines) survives, so the pill stays up and
  // `/loop stop` answers "No loop is running". The verbs must reconcile
  // from the fold.
  const registered = []
  const listeners = []
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
  const session = { id: 's8' }
  const followups = []
  const agent = { session, whenIdle: () => Promise.resolve(), followup: (m) => followups.push(m) }
  ctx.agents.set('s8', agent)
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })

  // Stop lands on the adopted entry.
  assert.equal(invoke('stop').text, 'Loop for "continue" stopped after 1 round(s).')
  projected.phase = 'stopped'
  assert.equal(invoke('stop').text, 'No loop is running.', 'stopped stays dead, never re-adopts')

  // Pause adopts, holds, and resumes across the same gap.
  projected.phase = 'active'
  assert.equal(invoke('pause').text, 'Loop for "continue" paused at round 1.')
  listeners[0][1](session, turnEnd)
  await settle()
  assert.equal(followups.length, 0, 'adopted pause holds the round')
  assert.equal(invoke('resume').text, 'Loop for "continue" resumed at round 1.')
  await settle()
  assert.equal(followups.length, 1, 'adopted resume drives the next round')
  assert.match(followups[0].content.at(-1).text, /round 2\/10/)
})

test('verbs ignore a dead or absent fold', () => {
  for (const fold of [undefined, null]) {
    const registered = []
    const ctx = {
      commands: { register: (def) => { registered.push(def); return () => {} } },
      agents: new Map(),
      on: () => () => {},
      effect: (fn) => fn(),
      get: () => ({ stateOf: () => fold }),
    }
    apply(ctx)
    const agent = { session: { id: 's9' }, whenIdle: () => Promise.resolve(), followup: () => {} }
    const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })
    assert.equal(invoke('stop').text, 'No loop is running.', `fold ${JSON.stringify(fold)} stays dead`)
    assert.equal(invoke('pause').text, 'No loop is running.')
    assert.equal(invoke('resume').text, 'No loop is running.')
  }
})

test('projection unit folds the loop lifecycle without custom events', () => {
  assert.equal(loopProjection.init({}, 0), null)
  const turnEnd = { type: 'turn/end', data: {} }
  assert.equal(loopProjection.apply(null, turnEnd), null, 'uninterested events keep the reference')

  // `/loop 5 continue` starts the pill.
  const started = loopProjection.apply(null, {
    type: 'command/run', data: { commandId: 'cmd-1', name: 'loop', args: ' 5 continue ', source: { kind: 'user' } },
  })
  assert.deepEqual(started, { phase: 'active', command: 'continue', rounds: 5, run: 1 })

  // The claimed round-2 relay line advances the counter.
  const relay = (run, rounds) => ({
    type: 'user/message',
    data: {
      source: { kind: 'loop', form: 'relay' },
      content: [{ type: 'text', text: `[loop round ${run}/${rounds}]\ncontinue` }],
    },
  })
  const round2 = loopProjection.apply(started, relay(2, 5))
  assert.deepEqual(round2, { phase: 'active', command: 'continue', rounds: 5, run: 2 })

  // Pause and resume freeze and thaw the pill.
  const paused = loopProjection.apply(round2, {
    type: 'command/run', data: { commandId: 'cmd-2', name: 'loop', args: 'pause', source: { kind: 'user' } },
  })
  assert.deepEqual(paused, { phase: 'paused', command: 'continue', rounds: 5, run: 2 })
  const resumed = loopProjection.apply(paused, {
    type: 'command/run', data: { commandId: 'cmd-3', name: 'loop', args: 'resume', source: { kind: 'user' } },
  })
  assert.deepEqual(resumed, { phase: 'active', command: 'continue', rounds: 5, run: 2 })

  // Stop clears the pill; other commands and plugins never touch it.
  const stopped = loopProjection.apply(resumed, {
    type: 'command/run', data: { commandId: 'cmd-4', name: 'loop', args: 'stop', source: { kind: 'user' } },
  })
  assert.equal(stopped, null)
  assert.equal(loopProjection.apply(resumed, {
    type: 'command/run', data: { commandId: 'cmd-5', name: 'goal', args: 'x', source: { kind: 'user' } },
  }), resumed)
  assert.equal(loopProjection.apply(resumed, {
    type: 'user/message',
    data: { source: { kind: 'other', form: 'relay' }, content: [{ type: 'text', text: '[loop round 9/5]\nforged' }] },
  }), resumed, 'a forged relay from another plugin cannot move the counter')

  // The wire schema validates the view before it leaves the host.
  assert.deepEqual(loopProjection.wire.viewSchema.parse(round2), round2)
  assert.equal(loopProjection.wire.view(round2), round2)
  assert.equal(loopProjection.stateVersion, 3, 'the spent-budget fold rule changed the semantics')
})

test('a finite loop clears the pill when its budget is spent', () => {
  // Regression: the driver drops a spent loop from memory, but the fold kept
  // the last round relay's `active` state forever. The pill stranded on a
  // finished loop and /loop status answered "No loop is running" beside it.
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const relay = (run, rounds) => ({
    type: 'user/message',
    data: {
      source: { kind: 'loop', form: 'relay' },
      content: [{ type: 'text', text: `[loop round ${run}/${rounds}]\ncontinue` }],
    },
  })
  const started = loopProjection.apply(null, {
    type: 'command/run', data: { commandId: 'cmd-1', name: 'loop', args: '2 continue', source: { kind: 'user' } },
  })
  const lastRound = loopProjection.apply(started, relay(2, 2))
  assert.deepEqual(lastRound, { phase: 'active', command: 'continue', rounds: 2, run: 2 })

  assert.equal(
    loopProjection.apply(lastRound, turnEnd),
    null,
    'the last round settled: the fold is dead, never re-adopted',
  )

  // An infinite loop never spends, so its pill stays through every turn.
  const open = { phase: 'active', command: 'continue', rounds: 0, run: 5 }
  assert.equal(loopProjection.apply(open, turnEnd), open)
})

test('round-line parsing rejects garbage', () => {
  assert.equal(parseRoundLine('continue'), undefined)
  assert.equal(parseRoundLine('[loop round x/10]\ncontinue'), undefined)
  assert.equal(parseRoundLine('[loop round 2/10]\n   '), undefined)
  assert.deepEqual(parseRoundLine('[loop round 4/∞ (stop with /loop stop)]\n/perf-review'), {
    run: 4, rounds: 0, command: '/perf-review',
  })
})

test('fold rejects foreign events by reference within a CPU band', () => {
  // Deterministic perf gate: the fold runs on EVERY committed session event,
  // so foreign events must cost ~nothing and allocate nothing. Asserts on
  // process CPU time (never wall clock), median of 5 runs after warmup, with
  // a generous band — a regression that adds parsing/allocation to the
  // reject path breaks the band long before users feel it.
  // Host: process.cpuUsage; perf events unavailable in this container, stated.
  const events = [
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { type: 'assistant/message', data: {} },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    { type: 'command/run', data: { commandId: 'c', name: 'goal', args: 'x', source: { kind: 'user' } } },
  ]
  const live = { phase: 'active', command: 'continue', rounds: 5, run: 2 }
  for (const event of events) {
    assert.equal(loopProjection.apply(null, event), null)
    assert.equal(loopProjection.apply(live, event), live, `${event.type} must keep the reference`)
  }
  const ITERS = 100000
  for (let i = 0; i < 20000; i++) for (const event of events) loopProjection.apply(live, event)
  const samples = []
  for (let r = 0; r < 5; r++) {
    const c0 = process.cpuUsage()
    for (let i = 0; i < ITERS; i++) for (const event of events) loopProjection.apply(live, event)
    const c1 = process.cpuUsage(c0)
    samples.push(((c1.user + c1.system) / (ITERS * events.length)) * 1000)
  }
  samples.sort((a, b) => a - b)
  const median = samples[2]
  assert.ok(median < 500, `foreign fold median ${median.toFixed(1)}ns CPU/op exceeds 500ns band`)
})

test('resume queues the round a paused turn held back', async () => {
  // Regression: a completed turn while the loop is paused dropped its round
  // instead of holding it, and `pause`/`resume` are plugin commands that open
  // no turn of their own. Nothing was left to drive the loop, so `/loop status`
  // reported "running at round N" forever while no round ever ran.
  const registered = []
  const listeners = []
  const ctx = {
    commands: { register: (def) => { registered.push(def); return () => {} } },
    agents: new Map(),
    on: (event, fn) => { listeners.push([event, fn]); return () => {} },
    effect: (fn) => fn(),
  }
  apply(ctx)
  const session = { id: 's10' }
  const followups = []
  const agent = { session, whenIdle: () => Promise.resolve(), followup: (m) => followups.push(m) }
  ctx.agents.set('s10', agent)
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })

  invoke('3 continue')
  invoke('pause')
  listeners[0][1](session, turnEnd) // the paused round 1 turn settles: the round is held
  await settle()
  assert.equal(followups.length, 1, 'a paused turn queues nothing')

  assert.equal(invoke('resume').text, 'Loop for "continue" resumed at round 1.')
  await settle()
  assert.equal(followups.length, 2, 'resume drives the held round with no other turn left to come')
  assert.match(followups[1].content.at(-1).text, /round 2\/3/)
  assert.equal(invoke('status').text, 'Loop for "continue" is running — round 2 of 3.')
})

test('a round queued before unload never lands after the plugin disposes', async () => {
  // Regression: the deferred round waits for quiescence and the driver kept
  // its state after the effect disposed, so unloading the row mid-turn still
  // queued a follow-up into a plugin that was no longer mounted.
  const registered = []
  const listeners = []
  let teardown
  const ctx = {
    commands: { register: (def) => { registered.push(def); return () => {} } },
    agents: new Map(),
    on: (event, fn) => { listeners.push([event, fn]); return () => {} },
    effect: (fn) => { teardown = fn() },
  }
  apply(ctx)
  const session = { id: 's11' }
  const followups = []
  let release
  const agent = {
    session,
    whenIdle: () => new Promise((resolve) => { release = resolve }),
    followup: (m) => { followups.push(m) },
  }
  ctx.agents.set('s11', agent)
  const invoke = (input) => registered[0].handler({ rawInput: input, attachments: [], agent })

  invoke('5 continue')
  assert.equal(followups.length, 1, 'round 1 queues at start')
  listeners[0][1](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(typeof release, 'function', 'round 2 waits for quiescence')

  teardown() // the row is unloaded while round 2 is in flight
  release() // quiescence arrives after the unload
  await settle()
  assert.equal(followups.length, 1, 'an unloaded plugin queues no round')
})
