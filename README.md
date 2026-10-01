# dsh-loop

Repeat a command across agent turns in DeepSeek Harness. `/loop` queues a
command as the agent's next turn and queues it again after each completed
turn, for a fixed number of rounds or until you stop it.

## What you get

```
/loop 10 /perf-review               # run /perf-review for 10 rounds
/loop 10 /perf-review && /cordis-review  # run both commands every round
/loop 10 continue                   # send "continue" for 10 rounds
/loop 0 continue                    # loop forever (0 = infinite)
/loop pause                         # hold the round; resume picks it back up
/loop resume                        # continue a paused loop
/loop stop                          # end the running loop
/loop status                        # what is running, and how far along
```

In the Web client, a pill above the composer shows the running loop with
Pause, Resume, and Stop buttons.

## Install

> **Install it as a bundle.** `dsh plugin add …` mounts the row from the
> package's own patch layer, which is what the settings editor can write to. A
> row added with `--patch` is an overlay: it disappears at the next start.

```sh
dsh plugin --profile web add github:maci0/dsh-loop#v0.8.0
```

Pin a release tag: a bare `github:` spec floats on `main`. To upgrade, run the
same command with the newer tag, then restart `dsh web` (bundle layers compose
at boot).

The bundled `cordis.patch.yml` inserts the `loop` row automatically.

## How it works

`/loop <rounds> <command>` queues the command as the agent's next turn (round
1). When the turn that round opened completes, the plugin queues the next
round until the budget is spent. `rounds = 0` never spends; `/loop stop`
cancels at any time, and `/loop status` answers whether one is running or
paused, and at which round. The pill shows the same state, but only the Web
client has a pill. Loops are per-session.

Only the turn a round's own queued message opened moves the loop. A turn
already running when `/loop` was typed, or one you open between rounds,
leaves the round where it is. A round turn that ends any way other than
`completed` (aborted, error, blocked, max-tokens, or interrupted by a
restart) pauses the loop at that round; `/loop resume` runs the same round
again.

A round is queued once the agent reaches quiescence (`Agent.whenIdle()`),
never from inside the `turn/end` publication: `followup()` appends, a session
refuses an append that reenters the event it is publishing, and a wake
delivered before the retiring turn settles opens no turn.

### The pill

While a loop is active or paused, a pill (`⟳ command run/rounds` + Pause /
Resume + Stop) docks in the same `conversation.input.dock` strip as the goal
bar, ordered right beside it. State path: a `sessionProjections` unit (key
`loop`) folds events the harness already understands (the plugin's own
`command/run` and `command/done` rows, and the `user/message` relay lines the
driver queues each round), and the client half reads the projected view via
`useProjection('loop')`: push-based, no polling, correct across reloads. A
verb moves the pill only once its `command/done` settles as `success`. The
driver appends no custom event type: an unknown non-ignorable type makes the
persistence read path refuse the whole session. The buttons submit the
host-side `/loop pause | resume | stop` commands (no model turn). A verb that
fails replaces the label with "Stop failed" (or Pause, Resume), the error
message as its tooltip, until the next action or projection change.

### Restarts

The round driver is process memory; the folded log is durable. After a
restart the verbs re-adopt an `active` or `paused` fold from the projection
registry, with the round turn in flight and the round a pause or interruption
holds, so `/loop stop` clears a pill the fresh process never started, the pill
can never strand, and `/loop resume` runs the held round. A round turn cut off
by the restart is closed as `interrupted` in the log, which pauses the loop. A
stopped or spent fold stays dead and is never re-adopted.

## Limits

- A command that names a skill (`/perf-review`) is queued as a user message
  containing that command; the agent invokes the skill on its turn.
- No round cap on infinite loops: it runs until `/loop stop`. Watch quota.
- A finite budget is a whole number up to 9007199254740991; larger values are
  rejected.

## Development

dsh loads plugins on Node `^22.19.0 || >=24.0.0`; development and tests run on
bun.

```sh
bun install --frozen-lockfile
bun test
```

For local development, `dsh plugin --profile <name> add <path-to-checkout>`.

## Licence

MIT, see [LICENSE](LICENSE).
