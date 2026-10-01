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
 * Fold state: the view, the `/loop` invocation whose `command/run` row awaits
 * its `command/done`, whether the turn a round's relay opened is still
 * running (`inRound`), and the round a pause or an interruption holds back
 * (`held`). The executor appends `command/run` before attachment admission
 * and the handler, so a verb applies only once its paired `command/done`
 * settles as `success`. `inRound` and `held` mirror the driver's memory, so a
 * remount or restart adopts them.
 */
const loopStateSchema = z.object({
  loop: loopViewSchema,
  pending: z.object({ commandId: z.string(), args: z.string() }).nullable(),
  inRound: z.boolean(),
  held: z.number().int().positive().nullable(),
})

/** Apply one settled `/loop` invocation's arguments to the fold. */
function settleVerb(state, args) {
  const parsed = parseArgs(args)
  const loop = state.loop
  if (parsed.kind === 'loop') {
    // Round 1's relay always lands after this row: the agent appends it only
    // once its turn claims the inbox, past an await.
    return { loop: { phase: 'active', command: parsed.command, rounds: parsed.rounds, run: 1 }, pending: null, inRound: false, held: null }
  }
  if (parsed.kind === 'stop') return { loop: null, pending: null, inRound: false, held: null }
  if (loop === null) return { ...state, pending: null }
  if (parsed.kind === 'pause' && loop.phase === 'active') {
    // Paused between rounds, the driver holds the next round once its wait
    // for quiescence ends; a relay that still lands replaces this guess.
    const held = state.inRound ? state.held : loop.run + 1
    return { ...state, loop: { ...loop, phase: 'paused' }, pending: null, held }
  }
  if (parsed.kind === 'resume' && loop.phase === 'paused') {
    return { ...state, loop: { ...loop, phase: 'active' }, pending: null, held: null }
  }
  return { ...state, pending: null }
}

/**
 * The projection unit: fold the loop's own settled invocations (start, pause,
 * resume, stop; the definition records input, so `command/run` carries the
 * verb verbatim in `args`), the claimed `user/message` relay lines (round
 * counter advances), and the end of each turn a relay opened into the pill's
 * client view. A turn no relay opened never moves the fold. Registered
 * through `ctx.inject(['sessionProjections'], …)` so headless assemblies
 * without the registry stay unaffected.
 */
export const loopProjection = {
  key: 'loop',
  stateSchema: loopStateSchema,
  init: () => ({ loop: null, pending: null, inRound: false, held: null }),
  apply: (state, event) => {
    if (event.type === 'turn/end') {
      if (!state.inRound) return state
      const loop = state.loop
      if (event.data?.reason?.kind !== 'completed') {
        // An interrupted round pauses the loop and holds that same round.
        return { ...state, inRound: false, loop: { ...loop, phase: 'paused' }, held: loop.run }
      }
      // The spent budget is the fold's terminal edge. The driver drops a spent
      // loop with nothing appended (the round relay is the last canonical
      // row), so this turn/end is the only signal that the pill must clear.
      if (loop.rounds !== 0 && loop.run >= loop.rounds) return { ...state, inRound: false, loop: null, held: null }
      return { ...state, inRound: false, held: loop.phase === 'paused' ? loop.run + 1 : null }
    }
    if (event.type === 'command/run' && event.data?.name === 'loop'
      && typeof event.data.commandId === 'string' && typeof event.data.args === 'string') {
      return { ...state, pending: { commandId: event.data.commandId, args: event.data.args } }
    }
    if (event.type === 'command/done') {
      const pending = state.pending
      if (pending === null || event.data?.commandId !== pending.commandId) return state
      return event.data.kind === 'success' ? settleVerb(state, pending.args) : { ...state, pending: null }
    }
    if (!isLoopRelay(event)) return state
    const blocks = Array.isArray(event.data?.content) ? event.data.content : []
    const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('')
    const round = parseRoundLine(text)
    if (!round) return state
    // A relay queued before a pause still runs; the loop stays paused.
    const phase = state.loop?.phase === 'paused' ? 'paused' : 'active'
    return { ...state, inRound: true, held: null, loop: { phase, command: round.command, rounds: round.rounds, run: round.run } }
  },
  wire: {
    viewSchema: loopViewSchema,
    view: state => state.loop,
  },
  stateVersion: 5,
}

/**
 * Queue one round as the agent's next turn. The relay's message id is how the
 * driver recognizes the turn that round opened: only that turn's end moves
 * the loop, never a turn the user or another plugin opened.
 * @param {object} agent - the session's agent.
 * @param {object} loop - the driven loop.
 * @param {number} run - the round to queue.
 * @param {readonly object[]} attachments - blocks to send with the round.
 */
function queueRound(agent, loop, run, attachments) {
  const message = createUserMessage({
    content: [...attachments, { type: 'text', text: roundMessage(loop.command, run, loop.rounds) }],
    source: { kind: 'loop', form: 'relay' },
  })
  loop.run = run
  loop.relayId = message.id
  loop.turnOpen = false
  agent.followup(message)
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
    return projected?.loop ? projected : undefined
  } catch {
    // A fold that cannot materialize (a gap in the log) leaves the verbs on
    // the live map alone, the same answer as a host without the registry.
    return undefined
  }
}

/**
 * The loop for one session: the live map entry, or the durable view adopted
 * back into the map when the process forgot it (restart, remount), with the
 * round turn in flight and the held round. A null view (stopped or spent)
 * stays dead.
 */
function liveLoop(ctx, state, session) {
  const loop = state.loops.get(session.id)
  if (loop) return loop
  const fold = readProjectedLoop(ctx, session)
  if (!fold) return undefined
  const adopted = {
    command: fold.loop.command,
    rounds: fold.loop.rounds,
    run: fold.loop.run,
    paused: fold.loop.phase === 'paused',
    held: fold.held ?? undefined,
    turnOpen: fold.inRound === true,
  }
  state.loops.set(session.id, adopted)
  return adopted
}

function loopHandler(invocation, state, ctx) {
  const parsed = parseArgs(invocation.rawInput)
  if (parsed.kind === 'error') return { kind: 'error', text: parsed.text }

  // Only a start sends attachments (with round 1). A verb opens no turn of its
  // own, so it refuses them and the composer keeps the files, as the command
  // contract asks of a handler that cannot use them.
  if (parsed.kind !== 'loop' && invocation.attachments.length > 0) {
    return { kind: 'error', text: `/loop ${parsed.kind} takes no attachments; send them with the command a loop repeats.` }
  }

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
    // The round a paused or interrupted turn held back has to be queued here:
    // pause and resume are plugin commands and open no turn, so nothing else
    // would ever drive it.
    const held = loop.held
    loop.held = undefined
    if (held !== undefined) queueRound(invocation.agent, loop, held, [])
    return { kind: 'success', text }
  }

  const loop = { command: parsed.command, rounds: parsed.rounds, run: 1 }
  state.loops.set(sessionId, loop)
  queueRound(invocation.agent, loop, 1, invocation.attachments)
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
    // After the turn a round opened completes, queue the next round until the
    // budget spends. A turn the round did not open (one already running when
    // /loop was typed, one the user opened between rounds) never moves the
    // loop. A round turn that ends any other way (aborted, error, blocked,
    // max-tokens, interrupted by a restart) pauses the loop and holds that same
    // round for resume. A paused loop holds its next round: the completed turn
    // settles with nothing queued, and resume picks up exactly where it left
    // off. The pill follows the same rows, so the driver appends nothing.
    const offTurn = ctx.on('session/event', (session, event) => {
      const loop = state.loops.get(session.id)
      if (!loop) return
      if (event?.type === 'user/message') {
        if (event.data?.source?.kind === 'loop' && event.data.id === loop.relayId) loop.turnOpen = true
        return
      }
      if (event?.type !== 'turn/end' || !loop.turnOpen) return
      loop.turnOpen = false
      loop.relayId = undefined
      if (event.data?.reason?.kind !== 'completed') {
        loop.paused = true
        loop.held = loop.run
        return
      }
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
      const agent = ctx.agents.get(session.id)
      if (!agent || agent.session !== session) return
      const run = loop.run + 1
      loop.run = run
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
        queueRound(agent, loop, run, [])
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
