---
name: factory
description: How threads work inside the software factory. Use when you are running a factory stage for a ticket, are a standing factory agent, or need to queue work, report a stage, message another agent, or ask the founder for a decision.
---

# Working in the factory

The factory moves tickets through a pipeline of stages (for example plan,
review plan, build, review code, ship). Each stage runs in its own thread, in
the ticket's own worktree, on the model chosen for that stage's role. Nobody
watches your thread. The factory learns what happened only from what you
report.

## If you are running a stage

Your first message names the ticket, the stage, and the project skill to use.
Do that work to the project's own standard. Then report exactly once:

| Situation | What to call |
|---|---|
| The stage is completely finished | `factory_stage_done` with `outcome: "complete"` |
| You are a reviewer and the author must change something you cannot land yourself | `factory_stage_done` with `outcome: "changes_requested"` |
| Only the founder can decide | `factory_ask_founder`, then end your turn |
| You cannot proceed for another reason | `factory_stage_done` with `outcome: "blocked"` |

Rules:

- **Write the summary for a reader with no access to this thread.** Say what
  was done, where it lives (branch, plan path, commit), what was verified and
  how, and what is left. The next stage starts from that text.
- **Do not start the next stage, and do not launch your own reviewer.** The
  factory starts both, in fresh threads, so a review is always independent.
- **Findings come back to you.** If a reviewer requests changes, they arrive
  in this thread. Address them and call `factory_stage_done` again. Pass
  `rereview: true` only when your fixes raise a new product or scope decision;
  one review pass is the design.
- **Ask the founder only for founder decisions:** product behavior, scope,
  approval of a mockup, or a contradiction with a recorded decision. Give the situation, the options
  with what the user would see in each, and your recommendation. Decide
  technical choices yourself.
- If you stop without reporting, the factory reminds you once, then tells the
  founder the ticket has stalled.

## Talking to other agents

`factory_message` delivers a message to another factory thread:

- `to: "orchestrator"` (or another standing agent's id)
- `to: "JUS-12"` for the thread running that ticket's current stage
- `to: "JUS-12:build"` for a specific stage's thread

Use it for facts the other agent needs. A message is not a handoff: stages
still end with `factory_stage_done`.

## The command line

Every tool has a `bb factory` equivalent, which also works from threads that
are not part of the factory:

```sh
bb factory status                      # lanes, tickets, inbox
bb factory enqueue JUS-12 "Title" --lane Coach --pipeline planned --brief "…"
bb factory lanes '{"lanes":[{"name":"Coach","items":[{"key":"JUS-12","title":"…"}]}]}'
bb factory sync '{"lanes":[…]}'        # make lanes match a schedule; never reorders a lane
bb factory move JUS-12 --lane Plan --position 1
bb factory advance JUS-12              # send a ticket on to its next stage
bb factory cancel JUS-12
bb factory done --outcome complete --summary "…"
bb factory ask "Question?" --option "A: …" --option "B: …" --recommend "A, because …"
bb factory message orchestrator "…"
bb factory inbox
bb factory prompt watch "…"            # hand a standing agent a prompt; starts it if needed
bb factory role ship --provider codex --model <id> --reasoning low
bb factory config
```

Add `--json` for machine-readable output and `--project <id>` outside a
project thread.

## Swimlanes

A lane works one ticket at a time, in order; lanes run side by side, up to the
configured number of tickets in flight. Put tickets in the same lane when they
would collide: the same files, the same deployed function, or one depending on
the other. Put independent tickets in different lanes.

Pipelines choose where a ticket starts. `bb factory config` lists them; a
ticket that already has a reviewed plan does not need the planning stages.
