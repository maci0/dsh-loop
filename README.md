# dsh-loop

Repeat a command across agent turns in DeepSeek Harness.

```
/loop 10 /perf-review               # run /perf-review for 10 rounds
/loop 10 /perf-review && /cordis-review  # run both commands every round
/loop 10 continue                   # send "continue" for 10 rounds
/loop 0 continue                    # loop forever (0 = infinite)
/loop pause                         # hold the round; resume picks it back up
/loop resume                        # continue a paused loop
/loop stop                          # end the running loop
```

## How it works

`/loop <rounds> <command>` queues the command as the agent's next turn (round
1). After each completed turn, the plugin queues the next round until the
budget is spent. `rounds = 0` never spends; `/loop stop` cancels at any time.
Loops are per-session; only a *completed* turn advances the round.

A round is queued once the agent reaches quiescence (`Agent.whenIdle()`),
never from inside the `turn/end` publication: `followup()` appends, a session
refuses an append that reenters the event it is publishing, and a wake
delivered before the retiring turn settles opens no turn.

## Install

`dsh plugin add dsh-loop`, or add the package to your profile's
`cordis.patch.yml` bundles. The bundled `cordis.patch.yml` inserts the `loop`
row automatically.

## Notes

- A command that names a skill (`/perf-review`) is queued as a user message
  containing that command; the agent invokes the skill on its turn.
- No round cap on infinite loops: it runs until `/loop stop`. Watch quota.

## The pill

While a loop is active or paused, a pill (`⟳ command run/rounds` + Pause /
Resume + Stop) docks in the same `conversation.input.dock` strip as the goal
bar, ordered right beside it. State path: a `sessionProjections` unit (key
`loop`) folds events the harness already understands, the plugin's own
`command/run` rows and the `user/message` relay lines the driver queues each
round, and the client half reads the projected view via
`useProjection('loop')`, push-based, no polling, correct across reloads. The
driver appends no custom event type: an unknown non-ignorable type makes the
persistence read path refuse the whole session. The buttons submit the
host-side `/loop pause | resume | stop` commands (no model turn).

## Restarts

The round driver is process memory; the folded log is durable. After a
restart the verbs re-adopt an `active` or `paused` fold from the projection
registry, so `/loop stop` clears a pill the fresh process never started and
the pill can never strand. A stopped or spent fold stays dead and is never
re-adopted.
