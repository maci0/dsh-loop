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
 * Parse `/loop` arguments: `<rounds> <command...>`, or `stop`. The command is
 * free text passed verbatim to the agent each round, so slash-command chains
 * such as `/perf-review && /cordis-review` replay as written. There is one
 * deliberate restriction: a nested `/loop stop` would end the loop from
 * inside its own replay and leave the loop with no way to stop, so it is
 * rejected before the loop starts.
 * @param {string} input - raw text after `/loop`.
 * @returns {{ kind: 'stop' } | { kind: 'error', text: string } |
 *            { kind: 'loop', rounds: number, command: string }}
 *   `rounds` is the total round budget; 0 means infinite.
 */
export function parseArgs(input) {
  const trimmed = input.trim()
  if (trimmed.toLowerCase() === 'stop') return { kind: 'stop' }
  const match = /^(\d+)\s+(.+)$/.exec(trimmed)
  if (!match) {
    return {
      kind: 'error',
      text: 'Usage: /loop <rounds> <command> — e.g. /loop 10 /perf-review, /loop 10 /perf-review && /cordis-review, /loop 0 continue (0 = forever). Or /loop stop.',
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

/**
 * Whole loop state as a durable `loop/state` session event (whole-value rule:
 * each event carries the complete post-change state, never a delta). The
 * projection unit below folds these; the client pill reads the projected view.
 * @param {object} state - { phase, command, rounds, run }.
 */
const loopStateSchema = z.object({
  phase: z.enum(['active', 'stopped', 'done']),
  command: z.string().min(1),
  rounds: z.number().int().nonnegative(),
  run: z.number().int().positive(),
})

const loopProjectionSchema = loopStateSchema.nullable()

/**
 * The projection unit: fold `loop/state` events into the pill's client view.
 * Registered through `ctx.inject(['sessionProjections'], …)` so headless
 * assemblies without the registry stay unaffected.
 */
export const loopProjection = {
  key: 'loop',
  stateSchema: loopProjectionSchema,
  init: () => null,
  apply: (state, event) => event.type === 'loop/state' ? event.data : state,
  wire: {
    viewSchema: loopProjectionSchema,
    view: state => state,
  },
  stateVersion: 1,
}

/** Append one whole loop-state event to the session log. */
function emitLoopState(session, state) {
  session.append('loop/state', state)
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

function loopHandler(invocation, state) {
  const parsed = parseArgs(invocation.rawInput)
  if (parsed.kind === 'error') return { kind: 'error', text: parsed.text }

  const sessionId = invocation.agent.session.id
  if (parsed.kind === 'stop') {
    const loop = state.loops.get(sessionId)
    if (!loop) return { kind: 'success', text: 'No loop is running.' }
    state.loops.delete(sessionId)
    emitLoopState(invocation.agent.session, { phase: 'stopped', command: loop.command, rounds: loop.rounds, run: loop.run })
    return { kind: 'success', text: `Loop for "${loop.command}" stopped after ${loop.run} round(s).` }
  }

  state.loops.set(sessionId, { command: parsed.command, rounds: parsed.rounds, run: 1 })
  emitLoopState(invocation.agent.session, { phase: 'active', command: parsed.command, rounds: parsed.rounds, run: 1 })
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
      description: '⟳ Repeat a command each turn: /loop <rounds> <command> (0 = forever), /loop stop',
      input: { hint: '<rounds> <command> | stop', attachments: true },
      recordInput: false,
      handler: (inv) => loopHandler(inv, state),
    }))
    // After each completed turn, queue the next round until the budget spends.
    const offTurn = ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end' || event?.data?.reason?.kind !== 'completed') return
      const agent = ctx.agents.get(session.id)
      if (!agent || agent.session !== session) return
      const loop = state.loops.get(session.id)
      if (!loop) return
      if (loop.rounds !== 0 && loop.run >= loop.rounds) {
        state.loops.delete(session.id)
        emitLoopState(session, { phase: 'done', command: loop.command, rounds: loop.rounds, run: loop.run })
        return
      }
      loop.run += 1
      emitLoopState(session, { phase: 'active', command: loop.command, rounds: loop.rounds, run: loop.run })
      agent.followup(userMessage({ attachments: [], agent }, roundMessage(loop.command, loop.run, loop.rounds)))
    })
    return () => {
      offTurn?.()
      for (const d of disposers) d()
    }
  })
}
