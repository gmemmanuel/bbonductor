Run tickets through your own pipeline of independent agents, in swimlanes, and get asked only for decisions.

## What you get

- A **Factory** page: your inbox, the swimlanes, standing agents, and who plays each role.
- Swimlanes that work one ticket at a time per lane and run lanes side by side, up to a limit you set.
- A pipeline where every stage is a fresh thread in the ticket's own worktree, on the model chosen for that role.
- An inbox for founder decisions, stalls and failures. Answers go back to the thread that asked.
- Standing agents (an orchestrator and a harness improver) as pinned threads with a memory file in your repo.

## How it works

Queue a ticket in a lane and pick a pipeline. The factory starts the first stage, which uses your project's own skill for that step. When the agent reports the stage done, the next stage starts; a review that requests changes sends them to the author's thread. Agents that stop without reporting are reminded once, then flagged to you.

## For agents

Factory threads get `factory_stage_done`, `factory_ask_founder` and `factory_message`; standing agents also get `factory_enqueue` and `factory_status`. Everything is also available as `bb factory`. The bundled `factory` skill explains the protocol.

## Requirements

bb 0.49 or later, a Git project, and at least one agent provider. Agent work uses your providers' own accounts and limits.
