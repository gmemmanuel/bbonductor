# Work log

What was built, researched and learned, newest first. It replaces an issue tracker for this repo.

## How to use this file

- **Add one entry per working session**, at the top of the log, when the work finishes. Five to ten lines.
- **Each entry says:** what was built or changed (in plain language), what was researched (link the notes), what was checked and how, and what was left unfinished.
- **Keep "Next up" current.** It is the whole backlog. Reorder it, remove what is done, add what you found. Keep it under about fifteen lines.
- Decisions go in [DECISIONS.md](DECISIONS.md). Research and rejected ideas go in [research/](research/). Engineering lessons go in `../LEARNINGS.md`.

## Next up

In rough order.

1. **Merge the Justus setup branch.** `gideon/bb-worktree-setup` in `~/Development/justus-app-bb-setup` adds `.bb-env-setup.sh` and `.worktreeinclude`. Until it is on Justus main, a factory ticket's worktree has no dependencies. It must go through the Justus pipeline.
2. **Merge this repo's branch to main**, then reinstall the plugin from the stable checkout or from git. Today bb loads it from the Conductor workspace folder; archiving that workspace would break the factory.
3. **Founder picks models per role, starts the orchestrator, and runs one small Justus ticket.** Everything below should bend to what that shows.
4. **Teach the Justus instructions about the factory.** `AGENTS.md` there says the founder launches reviews and ship; under the factory the factory does.
5. **Move the sequence adapter into the Justus `sequence` skill.** `scripts/sequence-to-lanes.mjs` here converts the skill's output into `bb factory lanes` input; it belongs beside the skill, with the orchestrator charter telling it when to run.
6. **Watch the first scheduled runs** (daily error check, weekly evidence review, weekly retro) and tune the prompts.
7. **Rotate standing agents by context use.** Today "Fresh thread" is a button; the Watch agent will need it most.
8. **Linear.** The factory does not read or write Linear. Justus agents already do through repo scripts; decide whether the page should show ticket titles and states from Linear.
9. **Editing pipelines and stage prompts in the page.**
10. **Quota-aware roles.**
11. **Install bb's Conductor layout when it is released.**

## Log

### 16 November 2026 (second session): installed for real, schedules, Justus setup

- **Installed the Factory into the founder's bb 0.49**, replacing the old draft. The old draft's leftover database would have made bb skip the new tables; it was backed up and removed first.
- **Added a Watch standing agent** and `bb factory prompt <agent> "<text>"`, which starts the agent if needed. Scheduled automations use it.
- **Created three automations in the Justus project:** daily error check (weekdays 8:00 ET), weekly evidence review (Mondays 7:00), weekly harness retro (Mondays 9:30). Verified that an automation script can reach the factory; the three themselves have not fired yet.
- **Justus memory files point at the planning vault.**
- **Wrote the Justus worktree setup** on branch `gideon/bb-worktree-setup` (committed locally, not pushed or merged): `.bb-env-setup.sh` reuses `scripts/ensure-deps.sh`; `.worktreeinclude` carries `.env.local`. Ran it in a fresh worktree with a clean environment: ready in about a minute.
- **Wrote `scripts/sequence-to-lanes.mjs`** and tried it on the latest real sequence output. Nothing was queued.
- **Checked:** 28 behaviour tests, 24 live checks. Found that bb's Conductor layout is not in the 0.49 release and corrected the docs.
- **Not checked:** a real agent run; bb running the setup script itself; a scheduled run.

### 16 November 2026: first version of the factory

- **Researched** bb as it is now (0.49, plugin SDK 0.6.x) and its ecosystem: 49 built-in plugins and 611 community plugins. Notes in [research/2026-11-16-bb-landscape.md](research/2026-11-16-bb-landscape.md). Main findings: bb now ships an official Conductor-style sidebar, so the old bbonductor draft is redundant; several community "factory" plugins exist but each replaces the pipeline with its own.
- **Replaced the old draft** (sidebar, pull request panel, terminal panel, Linear panel; never run against a live bb) with the Factory plugin: swimlanes, a staged pipeline with a model per role, a founder inbox, standing agents with memory files, agent-to-agent messaging, `bb factory` CLI, five agent tools, three skills, and the Factory page.
- **Set up project memory:** `AGENTS.md`, `LEARNINGS.md`, `docs/DECISIONS.md`, this log.
- **Checked:** 27 behaviour tests on the SDK's fake host; 24 end-to-end checks against a real bb 0.49 server using a fake model and a scratch project (`node scripts/live-check.mjs`); the page rendered in real bb and was screenshotted. The live check caught two bugs the unit tests could not (missing machine id; worktree id not known at spawn).
- **Not checked:** a real Claude Code or Codex agent calling the factory tools, and the Justus project under bb. Both need the founder's bb and quota. No push notification was observed on a device.
- **Left for next time:** everything in Next up. Nothing is installed in the founder's own bb yet.
