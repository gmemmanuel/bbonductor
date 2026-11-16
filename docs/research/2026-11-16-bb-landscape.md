# bb and its plugin ecosystem, 16 November 2026

Research done before building the first version of the factory. Sources: the open-source bb repository (`get-bb/bb`, main at 13 Nov 2026), the published `bb-app` 0.49.0 and `@get-bb/plugin-sdk` packages, the community marketplace repository (`get-bb/marketplace`), and a brief web search on persistent agent roles.

## bb today

- **Version:** 0.49.0 is current. The machine had the desktop app at 0.46.1, last opened in October.
- **bb describes itself as** "an agentic IDE that builds itself … laying the groundwork for your own software factory". It drives installed agent CLIs (Claude Code, Codex, Cursor, Pi, any ACP agent) and uses their existing sign-ins, so it runs on subscriptions rather than API tokens.
- **The plugin SDK has grown a lot** since this repo's first draft (which targeted SDK 0.4). What matters for a factory:
  - `threads.spawn` can choose provider, model, thinking level and permission mode, reuse an existing environment, or create a managed worktree. `threads.send` messages any thread and can name the sending thread.
  - Lifecycle events: thread created, active, idle, failed, archived, deleted; a pending question or approval; queued, dispatched and cancelled messages; failed turns.
  - A `message.dispatch` hook that can hold a message in the thread's queue until a plugin releases it. This is how the built-in concurrency limit works.
  - Native agent tools and per-thread tool selection keyed on thread metadata.
  - A plugin command under `bb <name>`, a page in the navigation rail with a badge, RPC, realtime signals, a private SQLite database, cron schedules, and background services.
  - A test harness with a fake host, and an echo provider example usable as a free model.

## Built-in plugins worth using as they are

Correction, same day: the Conductor layout plugin is in bb's repository but not in the 0.49 release; it cannot be installed yet.

| Plugin | What it gives us |
|---|---|
| **Conductor layout** | Sidebar of projects and workspaces, one row per worktree, chat tabs per workspace, a Run button that reads `.conductor/settings.toml`. This replaces the old bbonductor sidebar |
| **Concurrency limit** | Caps running threads per machine; extra turns wait in line |
| **Automations** | Cron or one-shot prompts that start a thread or re-prompt an existing one; also stored scripts |
| **Push notifications** | Phone, web and desktop; other plugins can send through it |
| **GitHub PR status**, **Git** | Pull request state and diffs per workspace |
| **Ask user question** | Multiple-choice questions for providers without a native one |
| **Account pool**, **Provider retry**, **Provider usage** | Several subscriptions behind one provider, automatic retry after limits, usage windows |
| **Workflows** | A script fans work out to hidden worker threads and collects structured results. Good for parallel research; not a ticket pipeline |
| **Tasks** | A built-in tracker with delegation presets. Overlaps with Linear, which Justus already uses |
| **Memory** | Provider-independent memory store. Not adopted: Gideon keeps knowledge in repo files that every tool can read |

## Community plugins that overlap with the factory

611 plugins are listed. The closest:

| Plugin | What it does | Why not adopted |
|---|---|---|
| **factory** (Software Factory) | A Lead plans tasks, specialists build, independent reviewers and a security reviewer comment on a draft pull request; you merge | Brings its own roles, review flow and merge rule. Reviews happen on an open pull request; in Justus review happens before the pull request exists, and ship merges |
| **loom** | Planner writes a spec and tickets; Loom itself commits, runs checks and decides pass or fail; reviewers on another model; integration branch | Loom owns commits, checks and merges, which Justus already does with its own scripts and receipts |
| **crew** | A standing team described in `crew.yaml`, members with fixed addresses and models that message each other; a "Needs you" list | The closest in spirit. A team of standing members, not a per-ticket pipeline with lanes; adopting it means expressing the pipeline as crew conventions and trusting a young third-party plugin with all orchestration |
| **treelanes** | One worktree per task moving through Design, TDD, Quality loop, Simplify, PR watch, with a model per step | Fixed stages and its own delivery skills |
| **harness** | Explore, Plan, Worker, Critic, Promote with role routing | Its own workflow |
| **orchestrator-mode** | Keeps one thread delegating instead of doing | Useful idea; the orchestrator charter covers it with instructions for now |
| **operator-inbox**, **inbox** (Needs You), **attention-sidebar** | Inboxes for threads that need the user | Thread-level attention, not founder decisions with options and a recommendation tied to a ticket. Could sit alongside |
| **linear** | Linear issue browser, thirteen agent tools, CLI | Candidate to adopt later for queueing from the board |
| **souls**, **agent-roles**, **role-picker** | Reusable personas per thread | Role charters ship as skills here; revisit if more roles appear |
| **ai-usage**, **lanes** | Subscription headroom across providers | Candidate input for quota-aware role settings |

**Conclusion.** The ideas are common across these plugins (a model per role, a worktree per ticket, independent review, a needs-you list). None runs someone else's pipeline. Gideon's pipeline is already encoded in project skills, review receipts and turn-taking scripts, so the smallest correct thing is a conductor for those skills. It is about 2,700 lines and has no opinion on how a stage does its work.

## Persistent agent roles

Practitioner writing (mostly blogs and vendor pages, so treat as anecdote) converges on a few points:

- Give the role an **identity file** (what the job is, what it must not do) and a **rolling memory file**, both plain text in the repository.
- Keep memory **in git** so it is reviewable and survives the thread.
- Some setups have a curator agent that only **proposes** memory or process changes for the founder to approve.
- A warning from one solo founder: concurrent writers corrupted a shared memory file. One writer per file avoids it.

Applied here: each standing agent has a charter skill and its own memory file, written only by that agent; replacing the thread is an explicit handoff through the file.

Sources:

- [Persistent agent identity + memory (Beads/Git)](https://visdom-maturity-matrix.virtuslab.com/guides/development/persistent-agent-identity-memory-beads-git)
- [I run a solo company with AI agent departments](https://dev.to/setas/i-run-a-solo-company-with-ai-agent-departments-50nf)
- [How to build an AI co-founder: the exact architecture that actually works](https://dev.to/michael_xero_ai/how-to-build-an-ai-co-founder-the-exact-architecture-that-actually-works-okp)
- [AI agent architecture guide: memory, identity and guardrails](https://dev.to/michael_xero_ai/ai-agent-architecture-guide-memory-identity-and-guardrails-2026-5972)
- [Designing AI agents that persist across tasks](https://memvid.com/blog/designing-ai-agents-that-persist-across-tasks)
- [bb repository](https://github.com/get-bb/bb) and [bb community marketplace](https://github.com/get-bb/marketplace)
