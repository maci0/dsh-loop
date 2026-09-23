/**
 * dsh-loop — browser half.
 *
 * The loop pill in the conversation.input.dock strip (same dock as the goal
 * bar). Live state arrives through `useProjection('loop')` — the host half
 * registers a projection unit folding `loop/state` session events, so the
 * pill needs no polling and survives page reloads. Stop submits the host-side
 * `/loop stop` command (a plugin command, not a model turn).
 *
 * Plain JavaScript on purpose: the client module system serves this file as a
 * lazy-CJS factory on `window.__ModuleLoader__`; `react` is provided.
 */

window.__ModuleLoader__.load({
  id: 'dsh-loop',

  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const createElement = React.createElement

    // Full-width bar matching the goal bar's dock geometry (GoalBar.module.css:
    // same 36px bar, 12px radius, tip background, centered column). The dock
    // stack is vertical and full-width, so a fit-content chip floats left —
    // the bar fills the column exactly like the goal widget does.
    const CSS = [
      '.loop-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto}',
      '.loop-pill{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));height:36px;margin:0 auto;padding:4px 5px 4px 12px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-specific-tip)}',
      '.loop-pill-paused{opacity:.75}',
      '.loop-glyph{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.loop-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.loop-rounds{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.loop-btn{flex:none;appearance:none;font:inherit;font-size:12px;padding:2px 10px;cursor:pointer;color:var(--dsw-alias-label-primary);background:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px}',
      '.loop-btn:disabled{cursor:default;opacity:.5}',
    ].join('')

    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.textContent = CSS
      document.head.append(style)
    }

    /** Rounds text: 0 means forever. */
    const roundsText = (rounds) => (rounds === 0 ? '∞' : `${rounds}`)

    /**
     * Run a pill verb (`/loop pause | resume | stop`) for one session.
     * @param {Function} run - the injected runner.
     * @param {string} sessionId - the dock's session.
     * @param {string} verb - pause, resume, or stop.
     * @param {Function} setPending - the pending flag setter.
     */
    const runVerb = async (run, sessionId, verb, setPending) => {
      setPending(verb)
      try {
        await run(sessionId, verb)
      } finally {
        setPending(null)
      }
    }

    /**
     * The pill: visible while a loop is active or paused in this session,
     * mirroring the goal bar's pause/resume/stop verbs.
     * @param {object} props - standard dock props (sessionId, useProjection)
     *   plus the injected verb runner.
     */
    function LoopPill({ sessionId, useProjection, onLoop }) {
      const loop = useProjection('loop')
      const [pending, setPending] = React.useState(null)

      if (loop === undefined || loop === null || (loop.phase !== 'active' && loop.phase !== 'paused')) return null
      const paused = loop.phase === 'paused'

      return createElement('div', { className: 'loop-dock' },
        createElement('div', { className: paused ? 'loop-pill loop-pill-paused' : 'loop-pill' },
          createElement('span', { className: 'loop-glyph' }, '⟳'),
          createElement('span', { className: 'loop-label', title: loop.command }, `${paused ? 'Paused · ' : ''}${loop.command}`),
          createElement('span', { className: 'loop-rounds' }, ` ${loop.run}/${roundsText(loop.rounds)}`),
          createElement('button', {
            className: 'loop-btn',
            onClick: () => runVerb(onLoop, sessionId, paused ? 'resume' : 'pause', setPending),
            disabled: pending !== null,
          }, pending === 'pause' || pending === 'resume' ? '…' : paused ? 'Resume' : 'Pause'),
          createElement('button', {
            className: 'loop-btn',
            onClick: () => runVerb(onLoop, sessionId, 'stop', setPending),
            disabled: pending !== null,
          }, pending === 'stop' ? '…' : 'Stop'),
        ),
      )
    }

    exports.inject = ['slots', 'sessions']

    /**
     * Client plugin body: the loop pill dock entry.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'loop',
        order: 11,
        inject: (sessionId) => ({
          onLoop: async (id, verb) => {
            const binding = ctx.sessions.binding(id ?? sessionId)
            if (binding === undefined) throw new Error(`dsh-loop: session "${id ?? sessionId}" is unavailable`)
            const result = await binding.session.command(`/loop ${verb}`)
            if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
          },
        }),
      }, LoopPill))
    }

    exports.apply = apply
    return module.exports
  },
})
