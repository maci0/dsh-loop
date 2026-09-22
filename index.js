/**
 * dsh-loop — repeat a command on a cadence of agent turns.
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
 * Load via a row in ~/.dsh/profiles/<profile>/cordis.patch.yml, or
 * `--patch cordis.local.yml`.
 */
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

export const name = 'loop'
// `agents` resolves the session's agent on turn/end (round driver); the
// projection registry serves the pill's live loop state to the client half.
export const inject = ['commands', 'agents']

/**
 * Parse `/loop` arguments: `<rounds> <command...>`, or `pause` / `resume` /
 * `stop`. The command is free text passed verbatim to the agent each round,
 * so slash-command chains such as `/perf-review && /cordis-review` replay as
 * written. There is one deliberate restriction: a nested `/loop stop` would
 * end the loop from inside its own replay and leave the loop with no way to
 * stop, so it is rejected before the loop starts.
 * @param {string} input - raw text after `/loop`.
 * @returns {{ kind: 'pause' } | { kind: 'resume' } | { kind: 'stop' } |
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
  const match = /^(\d+)\s+(.+)$/.exec(trimmed)
  if (!match) {
    return {
      kind: 'error',
      text: 'Usage: /loop <rounds> <command> — e.g. /loop 10 /perf-review, /loop 10 /perf-review && /cordis-review, /loop 0 continue (0 = forever). Or /loop pause | resume | stop.',
    }
  }
  const command = match[2].trim()
  if (/\/loop\s+stop\b/i.test(command)) {
    return {
      kind: 'error',
      text: 'A nested /loop stop would end the loop from inside its own replay. Stop it from the composer instead.',
    }
  }
  const rounds = Number(match[1])
  return { kind: 'loop', rounds: Number(match[1]), command: match[2].trim() }
}

/** Human label for the budget. */
export function budgetLabel(rounds) {
  return rounds === 0 ? '∞ (stop with /loop stop)' : String(rounds)
}

/** The queued user message for one round. */
export function roundMessage(command, run, rounds) {
  return `[loop round ${run}/${budgetLabel(rounds)}]\n${command}`
}

// --- projection: the /loop pill's live state ---
//
// The pill folds only events the harness already understands — `command/run`
// (the loop's own lifecycle row) and the `user/message` relay lines the
// driver queues each round — so the plugin never appends a custom event
// type. A custom `loop/state` type would poison the log: the persistence
// read path refuses any session containing an unknown non-ignorable type,
// and the envelope marker cannot be attached through `Session.append`.
// Out-of-repo plugins cannot extend the known-type catalog, so the durable
// fold reads only canonical history.

/**
 * Parse one round relay line back into its loop fields. Returns `undefined`
 * for any message the driver did not write.
 */
export function parseRoundLine(text) {
  const match = /^\[loop round (\d+)\/(.+?)\]\n([\s\S]+)$/.exec(text)
  if (!match) return undefined
  const run = Number(match[1])
  const budget = match[2] === '∞ (stop with /loop stop)' ? 0 : Number(match[2])
  const command = match[3].trim()
  if (!Number.isInteger(run) || run < 1 || !Number.isInteger(budget) || budget < 0 || command === '') return undefined
  return { run, rounds: budget, command }
}

/** True for a message the loop driver queued. */
function isLoopRelay(event) {
  return event.type === 'user/message'
    && event.data?.source?.kind === 'plugin'
    && event.data?.source?.plugin === 'loop'
}

const loopStateSchema = z.object({
  phase: z.enum(['active', 'paused']),
  command: z.string().min(1),
  rounds: z.number().int().nonnegative(),
  run: z.number().int().positive(),
})

const loopProjectionSchema = loopStateSchema.nullable()

/**
 * The projection unit: fold the loop's own `command/run` rows (start, pause,
 * resume, stop — the definition records input, so `args` carries the verb
 * verbatim) and the claimed `user/message` relay lines (round counter
 * advances) into the pill's client view. A claimed stop/pause/resume
 * `command/done` row clears or freezes the pill without any custom event.
 * Registered through `ctx.inject(['sessionProjections'], …)` so headless
 * assemblies without the registry stay unaffected.
 */
export const loopProjection = {
  key: 'loop',
  stateSchema: loopProjectionSchema,
  init: () => null,
  apply: (state, event) => {
    if (event.type === 'command/run' && event.data?.name === 'loop' && typeof event.data?.args === 'string') {
      const parsed = parseArgs(event.data.args)
      if (parsed.kind === 'loop') {
        return { phase: 'active', command: parsed.command, rounds: parsed.rounds, run: 1 }
      }
      if ((parsed.kind === 'pause' || parsed.kind === 'resume') && state) {
        return { ...state, phase: parsed.kind === 'pause' ? 'paused' : 'active' }
      }
      if (parsed.kind === 'stop') return null
      return state
    }
    if (event.type === 'command/done' && event.data?.name === 'loop') return state
    if (!isLoopRelay(event)) return state
    const blocks = Array.isArray(event.data?.content) ? event.data.content : []
    const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('')
    const round = parseRoundLine(text)
    if (!round) return state
    return { phase: 'active', command: round.command, rounds: round.rounds, run: round.run }
  },
  wire: {
    viewSchema: loopProjectionSchema,
    view: state => state,
  },
  stateVersion: 2,
}

/**
 * Per-instance plugin state. Module-level state would outlive plugin unload
 * and leak across instances, so every apply() builds its own.
 */
function userMessage(invocation, text) {
  return createUserMessage({
    content: [...invocation.attachments, { type: 'text', text }],
    source: { kind: 'plugin', plugin: 'loop', form: 'relay' },
  })
}

/**
 * Read the durable loop fold for one session. The round driver's `loops` map
 * is process memory and dies on restart; the `loop/state` log plus the
 * projection unit survive. Without this fallback, a restart leaves the pill
 * showing an active loop the verbs cannot see — `/loop stop` answers "No
 * loop is running" while the pill never clears.
 */
function readProjectedLoop(ctx, session) {
  try {
    const projected = ctx.get?.('sessionProjections')?.stateOf?.(session, 'loop')
    if (!projected || typeof projected !== 'object') return undefined
    return projected
  } catch {
    return undefined
  }
}

/**
 * The loop for one session: the live map entry, or the durable fold adopted
 * back into the map when the process forgot it (restart, remount). Only an
 * `active` or `paused` fold adopts — `stopped` and `done` stay dead.
 */
function liveLoop(ctx, state, session) {
  const loop = state.loops.get(session.id)
  if (loop) return loop
  const projected = readProjectedLoop(ctx, session)
  if (!projected || (projected.phase !== 'active' && projected.phase !== 'paused')) return undefined
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
    return { kind: 'success', text: `Loop for "${loop.command}" resumed at round ${loop.run}.` }
  }

  state.loops.set(sessionId, { command: parsed.command, rounds: parsed.rounds, run: 1 })
  invocation.agent.followup(userMessage(invocation, roundMessage(parsed.command, 1, parsed.rounds)))
  return {
    kind: 'success',
    text: `Loop started: "${parsed.command}" for ${budgetLabel(parsed.rounds)} round(s).`,
  }
}

export function apply(ctx) {
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
      description: '⟳ Repeat a command each turn: /loop <rounds> <command> (0 = forever), /loop pause | resume | stop',
      input: { hint: '<rounds> <command> | pause | resume | stop', attachments: true },
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
      if (!loop || loop.paused) return
      if (loop.rounds !== 0 && loop.run >= loop.rounds) {
        state.loops.delete(session.id)
        return
      }
      loop.run += 1
      const run = loop.run
      // The round waits for quiescence: `followup` appends, and a session
      // refuses an append that reenters the event being published, while a
      // wake delivered before the retiring turn settles never opens a turn.
      // A stop, pause, or restart during the wait re-checks.
      void agent.whenIdle().then(() => {
        if (state.loops.get(session.id) !== loop || loop.paused) return
        if (ctx.agents.get(session.id) !== agent) return
        agent.followup(userMessage({ attachments: [], agent }, roundMessage(loop.command, run, loop.rounds)))
      }, () => {})
    })
    return () => {
      offTurn?.()
      for (const d of disposers) d()
    }
  })
}
