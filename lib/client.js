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

    const CSS = [
      '.loop-pill{display:flex;align-items:center;gap:8px;padding:4px 6px 4px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-3);width:fit-content;max-width:100%}',
      '.loop-glyph{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.loop-label{min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.loop-rounds{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.loop-stop{flex:none;appearance:none;font:inherit;font-size:12px;padding:2px 10px;cursor:pointer;color:var(--dsw-alias-label-primary);background:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px}',
      '.loop-stop:disabled{cursor:default;opacity:.5}',
    ].join('')

    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.textContent = CSS
      document.head.append(style)
    }

    /** Rounds text: 0 means forever. */
    const roundsText = (rounds) => (rounds === 0 ? '∞' : `${rounds}`)

    /**
     * The pill: visible only while a loop is active in this session.
     * @param {object} props - standard dock props (sessionId, useProjection)
     *   plus the injected onStop verb.
     */
    function LoopPill({ sessionId, useProjection, onStop }) {
      const loop = useProjection('loop')
      const [pending, setPending] = React.useState(false)

      if (loop === undefined || loop === null || loop.phase !== 'active') return null

      const stop = async () => {
        if (pending) return
        setPending(true)
        try {
          await onStop(sessionId)
        } finally {
          setPending(false)
        }
      }

      return createElement('div', { className: 'loop-pill' },
        createElement('span', { className: 'loop-glyph' }, '⟳'),
        createElement('span', { className: 'loop-label', title: loop.command }, loop.command),
        createElement('span', { className: 'loop-rounds' }, ` ${loop.run}/${roundsText(loop.rounds)}`),
        createElement('button', { className: 'loop-stop', onClick: stop, disabled: pending }, 'Stop'),
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
        order: 30,
        inject: (sessionId) => ({
          onStop: async (id) => {
            const binding = ctx.sessions.binding(id ?? sessionId)
            if (binding === undefined) throw new Error(`dsh-loop: session "${id ?? sessionId}" is unavailable`)
            const result = await binding.session.command('/loop stop')
            if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
          },
        }),
      }, LoopPill))
    }

    exports.apply = apply
    return module.exports
  },
})
