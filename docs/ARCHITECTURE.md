# Architecture

## One idea

bb already has the right primitives: projects, worktree environments, threads on any provider, a queue, events, and a plugin SDK. The factory adds the one thing missing for a staged pipeline: something that decides **what starts next, where, on which model, and who is told**.

```text
Founder ──► Orchestrator (standing thread, main checkout)
                │  factory_enqueue
                ▼
        ┌──────────── lanes ────────────┐
        │ Coach:  JUS-12 ─► JUS-15 ─► … │   one ticket at a time per lane
        │ Plan:   JUS-20 ─► …           │   lanes run side by side, up to the cap
        └───────────────────────────────┘
                │ each ticket: its own worktree
                ▼
   plan ─► review plan ─► build ─► review code ─► ship
   (each stage: a fresh thread, the role's model, same worktree)
                │
                ├─ factory_stage_done ──► next stage / findings to author
                ├─ factory_ask_founder ─► Inbox ─► answer back to that thread
                └─ factory_message ─────► another thread
```

## Pieces

| Piece | File | Notes |
|---|---|---|
| Engine | `src/factory/engine.ts` | Pure rules. Serialises every mutation through one promise chain, so two events cannot both start a ticket. Talks to bb only through `Effects` |
| Store | `src/factory/store.ts` | Plugin SQLite: `items`, `inbox`, `agents`, `thread_bindings`, `configs`. JSON documents with indexed columns, validated on read |
| Effects | `server.ts` | `threads.spawn`, `threads.send`, `threads.retry`, `threads.get`, `threads.unpin`, `threads.interactions.list`, push notification RPC, realtime publish |
| Events | `server.ts` | `thread.idle`, `thread.active`, `thread.failed`, `thread.archived`, `thread.deleted`, `interaction.pending` |
| Agent tools | `server.ts` | `factory_stage_done`, `factory_ask_founder`, `factory_message`, `factory_enqueue`, `factory_status` |
| CLI | `src/factory/cli.ts` | `bb factory …`, the same operations for agents and scripts |
| Inbound hook | `server.ts` | `POST /api/v1/plugins/bbonductor/http/prompt` with the plugin token wakes a standing agent. Reachable from this machine only; bb's public address puts its own sign-in in front |
| Page | `app.tsx` | Nav panel at `/plugins/bbonductor/factory`, with an inbox count on the rail |
| Skills | `skills/` | `factory` (worker protocol), `factory-orchestrator`, `factory-harness-improver` |

## Configuration

Per bb project, falling back to `src/factory/defaults.ts`:

- **roles**: provider, model, thinking level, permission mode. Empty means the project default.
- **stages**: label, role, one-line prompt naming a project skill, and whether it is a review.
- **pipelines**: ordered stage lists. Defaults: `full`, `planned` (starts at plan review), `reviewed` (starts at build), `small-bug`.
- **maxActiveItems**: tickets in flight across all lanes. Default 8.
- **agents**: standing agents, each with a role, a charter skill, and a memory file path in the repo.

## Ticket lifecycle

```text
queued ─► running ─► done
            │  ▲
            │  └── answer / retry / thread resumed
            ├─► needs-founder   (asked a question, or reported blocked)
            ├─► returned        (review sent findings back to whoever queued it)
            ├─► stalled         (stopped twice without reporting)
            └─► failed          (turn failed, stage could not start, thread removed)
```

Every state except `queued`, `done` and `cancelled` holds its lane and counts toward the cap.

## Rules worth knowing

- **Independent review is structural.** Every stage is a new thread, so a reviewer never shares context with the author. The plugin also tells stage threads not to launch their own reviewer.
- **One review pass.** A review that requests changes is recorded as passed. Findings go to the author's existing thread; when the author reports done, the ticket skips that review unless the author passes `rereview`.
- **Findings with no author stage** (a ticket queued already planned) go to the thread that queued it, usually the orchestrator, which fixes the plan and runs `bb factory advance`.
- **Silence is handled.** A stage thread that goes idle without reporting gets one reminder. The second time, the ticket is `stalled` and the founder is told.
- **A ticket's planner is its plan reviewer.** `factory_ask_planner` sends a stage's question to the thread of the nearest earlier review stage (else whoever queued the ticket, else the orchestrator) and sets `with-planner`; the reply by `factory_message` to the stage's thread resumes it.
- **Builder tiers.** A stage may name a role per plan tier (`tierRoles`); the ticket's tier picks it, and a ticket without one uses the stage's own role.
- **Fallback on a usage limit.** A role may name a fallback model. When a factory thread's turn fails on a usage limit, the thread is moved to the fallback and rerun once, and the role's new threads start on the fallback until the limit's reported reset. With no fallback the failure goes to the inbox.
- **Tools are scoped.** Stage threads get report, ask and message. Standing agents also get enqueue and status. Other threads get nothing and use the CLI.
- **The inbox spans projects.** It is the founder's single queue.

## Standing agents

Four by default: the **Chief of staff** receives every blocked report and founder question from ticket threads and either settles it or asks the founder in plain words; the **Planner / strategist** (id `orchestrator`) plans and queues, **Watch** runs recurring checks and hands what is new to the orchestrator, and the **Harness improver** runs retros and machine cleanup. Scheduled work reaches them through bb Automations running `bb factory prompt <agent> "…"`, which starts the agent if it has no thread. A message to an unstarted standing agent starts it too.

A standing agent is a pinned thread in the project's main checkout, started from the page. Its first prompt names its charter skill and its memory file. "Fresh thread" asks the current thread to write everything it knows to the memory file; when that thread goes idle, a new thread starts from the file and the old one is unpinned.

## What the factory deliberately leaves to others

| Need | Who does it |
|---|---|
| Workspace sidebar, tabs, run script | bb's Conductor layout plugin (on bb's main branch, not yet in 0.49); until then bb's sidebar groups threads by worktree |
| Cap on running threads per machine | bb's built-in Concurrency limit plugin |
| Scheduled prompts (weekly retro, triage) | bb's built-in Automations plugin, running `bb factory prompt <agent> "…"` as a script |
| Notifications to phone and desktop | bb's built-in Push notifications plugin (the factory calls it) |
| Pull request status | bb's built-in GitHub PR status plugin |
| Taking turns for dev deploys, CI, and merging | The project's own scripts (in Justus: `dev-qa-turn.mjs`, `ship-turn.mjs`) |
| How to plan, review, build, ship | The project's own skills |

## Experimental bb APIs in use

- `app.slots.experimental_appOverlay` mounts the inbox chime once per window, so it plays on any page.

- `app.slots.navPanel({ experimental_useBadge })` for the rail count.
- `threads.interactions.list` result shape is read defensively.

Everything else is on stable SDK surfaces.
