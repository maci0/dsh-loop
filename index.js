/**
 * dsh-loop: repeat a command on a cadence of agent turns.
 *
 * `/loop <rounds> <command>` queues the command as the agent's next turn and,
 * after each completed turn, queues the next round until the budget is spent.
 * rounds = 0 means loop forever; `/loop stop` ends the loop early.
 *
 * Examples:
 *   /loop 10 /perf-review
 *   /loop 10 /perf-review && /cordis-review
 *   /loop 10 continue
 *   /loop 0 continue
 *   /loop pause
 *   /loop resume
 *   /loop stop
 *
 * Install with `dsh plugin --profile <name> add github:maci0/dsh-loop#<tag>`.
 * For local development, `dsh plugin --profile <name> add <path-to-checkout>`.
 */
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

export const name = 'loop'
// `agents` resolves the session's agent on turn/end (round driver); the
// projection registry serves the pill's live loop state to the client half.
export const inject = ['commands', 'agents']

/**
 * Parse `/loop` arguments: `<rounds> <command>`, or `pause` / `resume` /
 * `stop` / `status` (`list` is an alias). The command is free text passed
 * verbatim to the agent each round, so slash-command chains such as
 * `/perf-review && /cordis-review` replay as written. There is one deliberate
 * restriction: a nested `/loop stop` would end the loop from inside its own
 * replay and leave the loop with no way to stop, so it is rejected before the
 * loop starts.
 * @param {string} input - raw text after `/loop`.
 * @returns {{ kind: 'pause' } | { kind: 'resume' } | { kind: 'stop' } | { kind: 'status' } |
 *            { kind: 'error', text: string } |
 *            { kind: 'loop', rounds: number, command: string }}
 *   `rounds` is the total round budget; 0 means infinite.
 */
export function parseArgs(input) {
  const trimmed = input.trim()
  const verb = trimmed.toLowerCase()
  if (verb === 'stop') return { kind: 'stop' }
  if (verb === 'pause') return { kind: 'pause' }
  if (verb === 'resume') return { kind: 'resume' }
  // A status verb exists because the pill is a Web surface: a session driven
  // from a terminal has no other way to ask whether a loop is running.
  if (verb === 'status' || verb === 'list') return { kind: 'status' }
  const match = /^(\d+)\s+(.+)$/.exec(trimmed)
  if (!match) {
    return {
      kind: 'error',
      text: 'Usage: /loop <rounds> <command>, for example /loop 10 /perf-review, /loop 10 /perf-review && /cordis-review, /loop 0 continue (0 = forever). Or /loop pause | resume | stop | status.',
    }
  }
  const command = match[2].trim()
  if (/\/loop\s+stop\b/i.test(command)) {
    return {
      kind: 'error',
      text: 'A nested /loop stop would end the loop from inside its own replay. Stop it from the composer instead.',
    }
  }
  // The budget rides in the projection's integer schema and the round relay
  // line, so it must stay an exact integer.
  const rounds = Number(match[1])
  if (!Number.isSafeInteger(rounds)) {
    return { kind: 'error', text: `Rounds must be a whole number from 0 to ${Number.MAX_SAFE_INTEGER}.` }
  }
  return { kind: 'loop', rounds, command }
}

/** Human label for the budget. */
export function budgetLabel(rounds) {
  return rounds === 0 ? '∞ (stop with /loop stop)' : String(rounds)
}

/** The queued user message for one round. */
export function roundMessage(command, run, rounds) {
  return `[loop round ${run}/${budgetLabel(rounds)}]\n${command}`
}

// Projection: the /loop pill's live state.
//
// The pill folds only events the harness already understands (the loop's own
// `command/run` and `command/done` rows, and the `user/message` relay lines
// the driver queues each round), so the plugin never appends a custom event
// type. A custom type would poison the log: the persistence read path refuses
// any session containing an unknown non-ignorable type, and the envelope
// marker cannot be attached through `Session.append`. Out-of-repo plugins
// cannot extend the known-type catalog, so the durable fold reads only
// canonical history.

/**
 * Parse one round relay line back into its loop fields. Returns `undefined`
 * for any message the driver did not write.
 */
export function parseRoundLine(text) {
  const match = /^\[loop round (\d+)\/(.+?)\]\n([\s\S]+)$/.exec(text)
  if (!match) return undefined
  const run = Number(match[1])
  // The infinite budget reads by its leading glyph: the label after it is
  // display text, and logs written by older releases must keep folding.
  const budget = /^∞(?: .*)?$/.test(match[2]) ? 0 : Number(match[2])
  const command = match[3].trim()
  if (!Number.isSafeInteger(run) || run < 1 || !Number.isSafeInteger(budget) || budget < 0 || command === '') return undefined
  return { run, rounds: budget, command }
}

/** True for a message the loop driver queued. */
function isLoopRelay(event) {
  return event.type === 'user/message'
    && event.data?.source?.kind === 'loop'
}

/** The pill's client view: the running or paused loop, or null for none. */
const loopViewSchema = z.object({
  phase: z.enum(['active', 'paused']),
  command: z.string().min(1),
  rounds: z.number().int().nonnegative(),
  run: z.number().int().positive(),
}).nullable()

/**
 * Fold state: the view plus the `/loop` invocation whose `command/run` row
 * awaits its `command/done`. The executor appends `command/run` before
 * attachment admission and the handler, so a verb applies only once its
 * paired `command/done` settles as `success`.
 */
const loopStateSchema = z.object({
  loop: loopViewSchema,
  pending: z.object({ commandId: z.string(), args: z.string() }).nullable(),
})

/** Apply one settled `/loop` invocation's arguments to the view. */
function applyVerb(loop, args) {
  const parsed = parseArgs(args)
  if (parsed.kind === 'loop') return { phase: 'active', command: parsed.command, rounds: parsed.rounds, run: 1 }
  if ((parsed.kind === 'pause' || parsed.kind === 'resume') && loop) {
    return { ...loop, phase: parsed.kind === 'pause' ? 'paused' : 'active' }
  }
  if (parsed.kind === 'stop') return null
  return loop
}

/** The state with a new view, keeping the reference when the view is unchanged. */
function withLoop(state, loop) {
  return loop === state.loop ? state : { ...state, loop }
}

/**
 * The projection unit: fold the loop's own settled invocations (start, pause,
 * resume, stop; the definition records input, so `command/run` carries the
 * verb verbatim in `args`) and the claimed `user/message` relay lines (round
 * counter advances) into the pill's client view. Registered through
 * `ctx.inject(['sessionProjections'], …)` so headless assemblies without the
 * registry stay unaffected.
 */
export const loopProjection = {
  key: 'loop',
  stateSchema: loopStateSchema,
  init: () => ({ loop: null, pending: null }),
  apply: (state, event) => {
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'completed') {
      // The spent budget is the fold's terminal edge. The driver drops a spent
      // loop with nothing appended (the round relay is the last canonical
      // row), so the completed turn/end is the only signal that the pill must
      // clear; without it the pill stranded on a finished loop while
      // /loop status answered "No loop is running" beside it.
      const loop = state.loop
      if (loop !== null && loop.rounds !== 0 && loop.run >= loop.rounds) return withLoop(state, null)
      return state
    }
    if (event.type === 'command/run' && event.data?.name === 'loop'
      && typeof event.data.commandId === 'string' && typeof event.data.args === 'string') {
      return { ...state, pending: { commandId: event.data.commandId, args: event.data.args } }
    }
    if (event.type === 'command/done') {
      const pending = state.pending
      if (pending === null || event.data?.commandId !== pending.commandId) return state
      const loop = event.data.kind === 'success' ? applyVerb(state.loop, pending.args) : state.loop
      return { loop, pending: null }
    }
    if (!isLoopRelay(event)) return state
    const blocks = Array.isArray(event.data?.content) ? event.data.content : []
    const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('')
    const round = parseRoundLine(text)
    if (!round) return state
    return withLoop(state, { phase: 'active', command: round.command, rounds: round.rounds, run: round.run })
  },
  wire: {
    viewSchema: loopViewSchema,
    view: state => state.loop,
  },
  stateVersion: 4,
}

/** One round's queued user message, tagged so the fold can claim it. */
function userMessage(invocation, text) {
  return createUserMessage({
    content: [...invocation.attachments, { type: 'text', text }],
    source: { kind: 'loop', form: 'relay' },
  })
}

/**
 * Read the durable loop view for one session. The round driver's `loops` map
 * is process memory and dies on restart; the session log and the projection
 * unit folding it survive. Without this fallback, a restart leaves the pill
 * showing an active loop the verbs cannot see: `/loop stop` answers "No loop
 * is running" while the pill never clears.
 */
function readProjectedLoop(ctx, session) {
  try {
    const projected = ctx.get?.('sessionProjections')?.stateOf?.(session, 'loop')
    return projected?.loop ?? undefined
  } catch {
    // A fold that cannot materialize (a gap in the log) leaves the verbs on
    // the live map alone, the same answer as a host without the registry.
    return undefined
  }
}

/**
 * The loop for one session: the live map entry, or the durable view adopted
 * back into the map when the process forgot it (restart, remount). A null
 * view (stopped or spent) stays dead.
 */
function liveLoop(ctx, state, session) {
  const loop = state.loops.get(session.id)
  if (loop) return loop
  const projected = readProjectedLoop(ctx, session)
  if (!projected) return undefined
  const adopted = {
    command: projected.command,
    rounds: projected.rounds,
    run: projected.run,
    paused: projected.phase === 'paused',
  }
  state.loops.set(session.id, adopted)
  return adopted
}

function loopHandler(invocation, state, ctx) {
  const parsed = parseArgs(invocation.rawInput)
  if (parsed.kind === 'error') return { kind: 'error', text: parsed.text }

  const sessionId = invocation.agent.session.id
  if (parsed.kind === 'stop') {
    const loop = liveLoop(ctx, state, invocation.agent.session)
    if (!loop) return { kind: 'success', text: 'No loop is running.' }
    state.loops.delete(sessionId)
    return { kind: 'success', text: `Loop for "${loop.command}" stopped after ${loop.run} round(s).` }
  }
  if (parsed.kind === 'status') {
    const loop = liveLoop(ctx, state, invocation.agent.session)
    if (!loop) return { kind: 'success', text: 'No loop is running.' }
    const state_ = loop.paused ? 'paused' : 'running'
    return {
      kind: 'success',
      text: `Loop for "${loop.command}" is ${state_} at round ${loop.run} of ${budgetLabel(loop.rounds)}.`,
    }
  }
  if (parsed.kind === 'pause') {
    const loop = liveLoop(ctx, state, invocation.agent.session)
    if (!loop) return { kind: 'success', text: 'No loop is running.' }
    if (loop.paused) return { kind: 'success', text: `Loop for "${loop.command}" is already paused at round ${loop.run}.` }
    loop.paused = true
    return { kind: 'success', text: `Loop for "${loop.command}" paused at round ${loop.run}.` }
  }
  if (parsed.kind === 'resume') {
    const loop = liveLoop(ctx, state, invocation.agent.session)
    if (!loop) return { kind: 'success', text: 'No loop is running.' }
    if (!loop.paused) return { kind: 'success', text: `Loop for "${loop.command}" is already running.` }
    loop.paused = false
    const text = `Loop for "${loop.command}" resumed at round ${loop.run}.`
    // The round a paused turn held back has to be queued here: pause and resume
    // are plugin commands and open no turn, so nothing else would ever drive it.
    const held = loop.held
    loop.held = undefined
    if (held !== undefined) {
      loop.run = held
      invocation.agent.followup(userMessage(invocation, roundMessage(loop.command, held, loop.rounds)))
    }
    return { kind: 'success', text }
  }

  state.loops.set(sessionId, { command: parsed.command, rounds: parsed.rounds, run: 1 })
  invocation.agent.followup(userMessage(invocation, roundMessage(parsed.command, 1, parsed.rounds)))
  return {
    kind: 'success',
    text: `Loop started: "${parsed.command}" for ${budgetLabel(parsed.rounds)} round(s).`,
  }
}

export function apply(ctx) {
  // Per-instance driver state: module-level state would outlive an unload and
  // leak across instances.
  const state = { loops: new Map() }

  // Serve the pill's live loop state when the projection registry is mounted.
  ctx.inject?.(['sessionProjections'], (scope) => {
    scope.sessionProjections.register(loopProjection)
  })

  ctx.effect(() => {
    const disposers = []
    disposers.push(ctx.commands.register({
      definitionId: 'dsh-loop:loop',
      name: 'loop',
      description: '⟳ Repeat a command each turn: /loop <rounds> <command> (0 = forever), /loop pause | resume | stop | status',
      input: { hint: '<rounds> <command> | pause | resume | stop | status', attachments: true },
      handler: (inv) => loopHandler(inv, state, ctx),
    }))
    // After each completed turn, queue the next round until the budget spends.
    // A paused loop holds its round: the completed turn settles with nothing
    // queued, and resume picks up exactly where it left off. The pill follows
    // the claimed `user/message` relay lines, so the driver appends nothing.
    const offTurn = ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end' || event?.data?.reason?.kind !== 'completed') return
      const agent = ctx.agents.get(session.id)
      if (!agent || agent.session !== session) return
      const loop = state.loops.get(session.id)
      if (!loop) return
      if (loop.rounds !== 0 && loop.run >= loop.rounds) {
        state.loops.delete(session.id)
        return
      }
      // A paused loop holds its round rather than dropping it; `resume` queues
      // it, because a turn/end is the only other driver and a plugin command
      // starts no turn.
      if (loop.paused) {
        loop.held = loop.run + 1
        return
      }
      loop.run += 1
      const run = loop.run
      // The round waits for quiescence: `followup` appends, and a session
      // refuses an append that reenters the event being published, while a
      // wake delivered before the retiring turn settles never opens a turn.
      // A stop, pause, or restart during the wait re-checks.
      void agent.whenIdle().then(() => {
        if (state.loops.get(session.id) !== loop) return
        if (loop.paused) {
          loop.held = run
          return
        }
        if (ctx.agents.get(session.id) !== agent) return
        agent.followup(userMessage({ attachments: [], agent }, roundMessage(loop.command, run, loop.rounds)))
      }, () => {})
    })
    return () => {
      offTurn?.()
      for (const d of disposers) d()
      // Drop the driven loops with the plugin: a round still waiting on
      // quiescence must not queue into an unloaded row, and a remount re-adopts
      // any live loop from the durable fold anyway.
      state.loops.clear()
    }
  })
}
