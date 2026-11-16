# Factory (bbonductor)

**A solo-founder software factory for [bb](https://getbb.app).** Tickets move through your own plan, review, build, review, ship pipeline without you carrying them from agent to agent. You are asked only for decisions.

> Status: first version, 16 November 2026. Verified against a real bb 0.49 server with a fake model; not yet run on a real project.

## What it does

- **Swimlanes.** Put tickets that would collide in one lane and they run one at a time, in order. Lanes run side by side, up to a limit you set (8 by default).
- **A pipeline of independent agents.** Each stage runs in a fresh thread, in the ticket's own worktree, on the model you chose for that role. A review is always a different context from the work it reviews.
- **A model per role, as a setting.** Change who plays orchestrator, plan reviewer, builder, code reviewer and shipper whenever your limits change. It applies to the next stage that starts.
- **Handoffs without you.** A stage reports done and the next one starts. A review that wants changes sends them to the author's thread; when the author finishes, the ticket moves on.
- **One inbox.** Any agent can put a decision in front of you with the situation, the options and a recommendation. Your answer goes back to the thread that asked. Stalls and failures land there too.
- **Standing agents.** An orchestrator (your planner and strategist), a watch agent (recurring checks such as error triage), and a harness improver (retros on the factory itself) run as long-lived pinned threads, each with a memory file.
- **Agents talk to each other.** A worker can message the orchestrator, and the orchestrator can message any ticket's thread.

The factory owns the flow. How each stage does its work stays in your project's own skills: by default the stages call `create-plan`, `review-plan`, `execute-plan`, `review-code` and `ship`.

## Install

Needs bb 0.49 or later.

```sh
git clone https://github.com/gmemmanuel/bbonductor.git
cd bbonductor
npm install
bb plugin install .
```

Then open **Factory** in bb's navigation rail.

Recommended alongside it, all built into bb: **Concurrency limit**, **Automations**, and **Push notifications**. bb's own **Conductor layout** sidebar is on its main branch and not yet in the 0.49 release.

## First run

1. **Who plays each role:** pick a provider, model and thinking level per role.
2. **Standing agents:** start the Orchestrator.
3. **Queue work:** add a ticket on the page, or tell the orchestrator what you want built and let it queue the tickets.
4. **Watch the inbox.** That is the only place you are needed.

## For agents and scripts

```sh
bb factory status
bb factory enqueue JUS-12 "Rest days count as missed" --lane Coach --pipeline planned
bb factory lanes '{"lanes":[{"name":"Coach","items":[{"key":"JUS-12","title":"…"}]}]}'
bb factory role ship --provider codex --model <model-id> --reasoning low
bb factory inbox
bb factory prompt watch "Daily error check…"     # for scheduled automations; starts the agent if needed
bb factory answer <entry-id> "Count it as missed."
```

`bb factory help` lists everything. Threads inside the factory also get native tools: `factory_stage_done`, `factory_ask_founder`, `factory_message`, and for standing agents `factory_enqueue` and `factory_status`.

## Pipelines

| Name | Stages | Use for |
|---|---|---|
| `full` | Plan → Review plan → Build → Review code → Ship | A ticket with no plan yet |
| `planned` (default) | Review plan → Build → Review code → Ship | A ticket the orchestrator already planned |
| `reviewed` | Build → Review code → Ship | A ticket whose plan is already reviewed |
| `small-bug` | Fix | A small bug on the project's fast path |

Roles, stages, pipelines and standing agents are configuration, stored per bb project.

## Development

```sh
npm run verify                  # typecheck, unit tests, build
node scripts/live-check.mjs     # end to end on a throwaway bb server, with a fake model
```

See [AGENTS.md](AGENTS.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DECISIONS.md](docs/DECISIONS.md) and [docs/WORKLOG.md](docs/WORKLOG.md).

## History

This repo began as a Conductor-style sidebar for bb. bb is adding that itself as the **Conductor layout** plugin, so the sidebar was retired and the repo became the factory. The name is kept: bb plus the workflow that made Conductor pleasant. It is an independent project, not affiliated with Conductor or Melty Labs.

## License

MIT.
