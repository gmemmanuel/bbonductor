# Factory (bbonductor)

A bb plugin that turns bb into Gideon's solo-founder software factory. TypeScript, bb plugin SDK. Plugin id `bbonductor`, shown in bb as **Factory**.

Read `LEARNINGS.md` and `docs/DECISIONS.md` before changing anything. Log each session in `docs/WORKLOG.md`.

## What this is for

Gideon builds the Justus app (and smaller projects) with a pipeline of independent agents: plan, review plan, build, review code, ship. In Conductor he moved tickets between those agents by hand. This plugin does the moving: it starts each stage in its own thread on the model chosen for that role, keeps colliding work in sequence with swimlanes, and puts only real founder decisions in one inbox.

**The plugin owns the flow, never the craft.** How to plan, review, build, or ship lives in the target project's own skills (`create-plan`, `review-plan`, `execute-plan`, `review-code`, `ship` in Justus). Stage prompts name a skill and add the reporting protocol. Do not copy project process into this plugin.

## Layout

| Path | What it is |
|---|---|
| `server.ts` | Backend entry: wires bb (threads, events, tools, CLI, RPC) to the engine |
| `src/factory/engine.ts` | The state machine: lanes, stages, handoffs, inbox, standing agents, messaging. All bb access goes through `Effects` |
| `src/factory/store.ts` | SQLite persistence (plugin database). Migrations are append-only |
| `src/factory/model.ts` | Zod shapes shared by server and page |
| `src/factory/defaults.ts` | Default roles, stages, pipelines, standing agents |
| `src/factory/cli.ts` | `bb factory …` |
| `app.tsx` | The Factory page: inbox, swimlanes, standing agents, roles |
| `skills/` | Agent-facing instructions shipped with the plugin (worker protocol; planner, chief-of-staff, watch and harness-improver charters) |
| `tests/factory.test.ts` | Behaviour tests on the SDK's fake plugin host |
| `scripts/live-check.mjs` | End-to-end check against a real, throwaway bb server |
| `components/`, `lib/`, `hooks/` | UI source vendored by `bb plugin new`. Ours to edit, but prefer leaving it alone |

## Rules

- **Verify with both suites before saying a change works:** `npm run verify` (typecheck, unit tests, build) and `node scripts/live-check.mjs`. The fake host cannot catch bb's real behaviour; two shipped-blocking bugs were found only by the live check (see `LEARNINGS.md`).
- **Add a test for every rule you add to the engine**, driven through a tool, an event, RPC, or the CLI, not by calling engine methods directly.
- **Use public SDK surfaces only.** No bb internals, no DOM scraping. `experimental_` APIs are allowed; note them in `docs/ARCHITECTURE.md`.
- **Reuse bb before building.** bb ships a Conductor-style sidebar, a thread concurrency limit, scheduled automations, push notifications, and PR status. The community marketplace has 600+ plugins. Check `docs/research/` before adding a surface.
- **Never spend the founder's model quota in tests.** The live check uses bb's echo provider. Do not point checks at Claude Code or Codex.
- **Never touch the founder's real bb data** (`~/.bb`). Checks run with their own data folder and ports.
- **Store migrations are append-only.** Never edit a shipped statement in `MIGRATIONS`.
- Founder-facing text (inbox entries, page copy, agent prompts) is plain language: no internal labels, no bare ticket numbers without titles.

## Commands

```sh
npm install
npm run verify                  # typecheck + unit tests + build
node scripts/live-check.mjs     # real bb, fake model, scratch project; add --keep to look at it
bb plugin install .             # install into your bb (needs bb 0.49+)
bb plugin dev                   # rebuild and reload on save
```

## Where knowledge goes

- `docs/DECISIONS.md`: what Gideon decided, newest first. Check before re-opening a question.
- `LEARNINGS.md`: non-obvious engineering and process lessons.
- `docs/WORKLOG.md`: one entry per session, plus **Next up**, which is the backlog.
- `docs/research/`: dated research notes and what was rejected.
- Do not use Claude's auto-memory for this project.
