# dsh-loop

Repeat a command across agent turns in DeepSeek Harness.

```
/loop 10 /perf-review   # run /perf-review for 10 rounds
/loop 10 continue       # send "continue" for 10 rounds
/loop 0 continue        # loop forever (0 = infinite)
/loop stop              # end the running loop
```

## How it works

`/loop <rounds> <command>` queues the command as the agent's next turn (round
1). After each completed turn, the plugin queues the next round until the
budget is spent. `rounds = 0` never spends; `/loop stop` cancels at any time.
Loops are per-session; only a *completed* turn advances the round.

## Install

`dsh plugin add dsh-loop`, or add the package to your profile's
`cordis.patch.yml` bundles. The bundled `cordis.patch.yml` inserts the `loop`
row automatically.

## Notes

- A command that names a skill (`/perf-review`) is queued as a user message
  containing that command; the agent invokes the skill on its turn.
- No round cap on infinite loops — it runs until `/loop stop`. Watch quota.

## The pill

While a loop is active, a pill (`⟳ command run/rounds` + Stop) docks above the
composer — the same `conversation.input.dock` strip as the goal bar. State
path: the host half appends whole-state `loop/state` session events on start,
each round, stop, and completion; a `sessionProjections` unit (key `loop`)
folds them, and the client half reads the projected view via
`useProjection('loop')` — push-based, no polling, correct across reloads.
The Stop button submits the host-side `/loop stop` command (no model turn).
