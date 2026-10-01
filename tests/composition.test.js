/**
 * Real-composition test: the plugin mounts into a real `@deepseek-ai/cordis`
 * `Context` and releases everything it registered when its fiber disposes.
 *
 * The unit suite drives plain-object fakes, which cannot show whether a
 * registration is released, and the Web client reloads profile rows on every
 * edit — a leaked command or projection unit would fail the next reload. The
 * optional `sessionProjections` seam is exercised both ways here: absent, and
 * provided as a real service.
 *
 * @module dsh-loop/composition
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Context, Service } from '@deepseek-ai/cordis'

import { apply } from '../index.js'

/** The command seam, tied to the consumer's context the way the registry is. */
class CommandsSeam extends Service {
  registered = new Map()

  constructor(ctx) {
    super(ctx, 'commands')
  }

  register(definition) {
    return this.ctx.effect(() => {
      this.registered.set(definition.name, definition)
      return () => { this.registered.delete(definition.name) }
    })
  }
}

/** The agent lookup the loop driver reads on `turn/end`. */
class AgentsSeam extends Service {
  agents = new Map()

  constructor(ctx) {
    super(ctx, 'agents')
  }

  get(sessionId) {
    return this.agents.get(sessionId)
  }
}

/** The projection registry the pill's state rides on. */
class ProjectionsSeam extends Service {
  units = new Map()

  constructor(ctx) {
    super(ctx, 'sessionProjections')
  }

  register(unit) {
    return this.ctx.effect(() => {
      this.units.set(unit.key, unit)
      return () => { this.units.delete(unit.key) }
    })
  }
}

test('the plugin mounts into a real Cordis context and releases its command', async () => {
  const ctx = new Context()
  const commands = new CommandsSeam(ctx)
  new AgentsSeam(ctx)

  const fiber = await ctx.plugin({ name: 'loop', inject: ['commands', 'agents'], apply }, {})
  assert.deepEqual([...commands.registered.keys()], ['loop'])

  await fiber.dispose()
  assert.deepEqual([...commands.registered.keys()], [], 'the command is released with the fiber')
})

test('the optional projection seam registers when it is mounted, and releases', async () => {
  const ctx = new Context()
  new CommandsSeam(ctx)
  new AgentsSeam(ctx)
  const projections = new ProjectionsSeam(ctx)

  const fiber = await ctx.plugin({ name: 'loop', inject: ['commands', 'agents'], apply }, {})
  assert.deepEqual([...projections.units.keys()], ['loop'], 'the pill unit is contributed')

  await fiber.dispose()
  assert.deepEqual([...projections.units.keys()], [], 'the unit is released with the fiber')
})

test('a session without the projections registry mounts anyway', async () => {
  const ctx = new Context()
  const commands = new CommandsSeam(ctx)
  new AgentsSeam(ctx)

  // No projection registry at all: the optional inject must never fire, and the
  // command has to be there regardless.
  const fiber = await ctx.plugin({ name: 'loop', inject: ['commands', 'agents'], apply }, {})
  assert.deepEqual([...commands.registered.keys()], ['loop'])
  await fiber.dispose()
})
