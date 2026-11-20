# Work log

What was built, researched and learned, newest first. It replaces an issue tracker for this repo.

## How to use this file

- **Add one entry per working session**, at the top of the log, when the work finishes. Five to ten lines.
- **Each entry says:** what was built or changed (in plain language), what was researched (link the notes), what was checked and how, and what was left unfinished.
- **Keep "Next up" current.** It is the whole backlog. Reorder it, remove what is done, add what you found. Keep it under about fifteen lines.
- Decisions go in [DECISIONS.md](DECISIONS.md). Research and rejected ideas go in [research/](research/). Engineering lessons go in `../LEARNINGS.md`.

## Next up

In rough order.

1. **Founder picks models per role, starts the orchestrator, and runs one small Justus ticket by hand.** Then resume the three paused automations.
3. **Feedback that triggers a check when it arrives.** bb's public address cannot be called by the cloud function (see `LEARNINGS.md`), so plan a poller in Justus: a script automation every few minutes that asks preview for untriaged feedback newer than its marker, stays silent when there is none, and otherwise runs `bb factory prompt watch "…"` with the row ids. The `/prompt` hook is there if a safe public route appears.
4. **Revisit ticket approval around 30 November 2026.** The founder approves every new ticket for the first week or two; ask then whether the orchestrator may create them on its own.
5. **Teach the Justus instructions about the factory.** `AGENTS.md` there says the founder launches reviews and ship; under the factory the factory does.
7. **Install `tools/dashboard` dependencies in Justus worktrees** if a lane ever runs outside the main checkout.
8. **Rotate standing agents by context use.** Watch runs daily and will fill up first.
9. **Editing pipelines and stage prompts in the page.**
10. **Quota-aware roles.**
11. **Install bb's Conductor layout when it is released.**

## Log

### 20 November 2026 (sixth session): inbox chime

- The six open inbox entries were resent in the new format at the founder's request (stage threads re-reported; the chief of staff rewrote one).
- A chime plays in open bb windows when an inbox entry arrives: synthesized with Web Audio, no asset. Toggle and "Hear it" on the page. **Not checked:** the sound itself, which a headless run cannot hear.

### 20 November 2026 (fifth session): quieter page and messages

- Fixed-shape `founder_check`; one-line endings for stage threads; stages renamed (Plan review, Execution, Code review; Founder testing while held).
- Page: Markdown inbox with the ticket number first, Done column per lane, drag to reorder plus small arrows, "Waiting for you" beside Open thread, a pulse on tickets whose thread is in a turn, Memory button, no helper text or role sub-text.
- **Checked:** 54 behaviour tests, 29 live checks, screenshot. **Not checked:** drag and drop and the Memory button in a real browser session (headless screenshot only).

### 20 November 2026 (fourth session): four lanes in bb

- Lanes 3, 5 and 6 of the Justus board tagged `bb`; lanes 5 and 6 started plan review and reached build. Placed three new tickets into Conductor lanes by file overlap so the refresh could run.
- All role fallbacks cleared at the founder's request (he resets limits by hand for now).
- The three tickets shipped overnight each sent the founder test steps on request.
- A code review waiting on local CI was flagged stalled; the idle handler now ignores threads with background work running.
- The Justus "Later tickets show in bb" change merged on the third try: two waits died on network timeouts to GitHub.

### 20 November 2026 (third session): Done lane, Later, more lanes in bb

- The founder authorised merging this repo's pull requests and updating his bb without asking.
- Removed auto-archive (added that morning, not yet installed). A merged ticket shows under Done until all its threads are archived or deleted, then becomes `archived` and leaves the board.
- `parked` tickets: sent by the schedule for Later tickets, shown with a pill, never started, never holding their lane. A waiting ticket now follows the schedule's pipeline, tier, title and parked state.
- **Checked:** 51 behaviour tests, 29 live checks.

### 20 November 2026 (second session): what the first night showed

- **Overnight:** lane 4 shipped three tickets end to end on real agents (plan review, build, code review, ship) and stopped on the fourth with a "blocked" entry the founder could not act on. All three were visible changes and shipped without him trying them.
- **Chief of staff** standing agent: blocked reports and founder questions from ticket threads go there first; it answers or asks the founder with `about`. The orchestrator is renamed Planner / strategist.
- **Check before ship:** `founder_check` on `factory_stage_done`; the ship stage is gated; the inbox entry has Approve and ship, or notes that go back to the builder.
- **Finished tickets archive their threads.** First thread of a ticket is titled with the key alone. One model dropdown per role.
- Routed the fourth ticket's budget question to its plan reviewer with the loop from the previous session.
- **Checked:** 50 behaviour tests, 28 live checks.

### 20 November 2026: builder and plan reviewer talk directly; the page stops being a control panel

- **What the first real ticket showed.** JUS-1011 went through plan review and into build on real agents, then the builder stopped with a planner handoff that landed in the founder's inbox. Routed it by hand to the plan-review thread.
- **`factory_ask_planner`** and the `with-planner` status: stage to plan reviewer and back, any number of rounds; a quiet planner is reminded once, then the founder is told.
- **Page cleanup** per the founder: one "Open thread" button on a ticket in flight, reorder arrows on waiting tickets, tier pill; removed add-ticket, lane dropdown, Cancel, Advance, the in-flight limit.
- **Scheduling** is one ticket per lane with no global cap.
- **Checked:** 44 behaviour tests, 24 live checks, screenshot.

### 19 November 2026 (fourth session): first real lane, fallback on any provider, phone layout

- **Lane 4 of the Justus board runs in bb.** Tagged `bb` in the schedule; the refresh queued its five tickets and the first (JUS-1011, how a workout went comes before the reflection) started plan review on a real Claude Code thread in its own worktree. This is the first real agent run in the factory.
- **Fallback can be on another provider**: one picker lists every provider's models; mid-work the stage or standing agent moves to a replacement thread with a handover.
- **Phone layout** for the inbox and swimlanes; role table dropdowns have even widths.
- A session restart dropped four founder messages; he resent them as a screenshot.
- **Checked:** 39 behaviour tests, 24 live checks, phone and desktop screenshots. **Not checked:** a real usage-limit failure; the page on an actual phone through bb's remote address.

### 19 November 2026 (third session): builder tiers, model fallback, bb's Conductor layout

- **Builder tiers.** Roles `build`, `build-tier-2`, `build-tier-3`; the build stage picks by the ticket's plan tier, which arrives through `sync`, `lanes` and `enqueue`. Saved configurations gain the two new roles as copies of the existing builder.
- **Fallback model per role.** On a usage-limit failure the thread moves to the role's fallback and reruns; the role's new threads use the fallback until the reported reset. Page column "If its limit runs out".
- **Installed bb's own Conductor layout from source** in the founder's bb, with one local change so Run reads Conductor's `[scripts.run.<name>]` form.
- **Checked:** 37 behaviour tests, the live check. **Not checked:** a real usage-limit failure from Claude Code; Run against the real Justus project.

### 19 November 2026 (second session): lanes follow the sequencing skill

- Added `bb factory sync '<json>'`: queues tickets new to the schedule, moves a ticket whose lane changed, cancels an unstarted ticket that is no longer scheduled, and never reorders a lane or stops started work. Replaces `scripts/sequence-to-lanes.mjs`, which moved into the Justus `sequence` skill as `publish-bb.mjs`.
- The founder could not find the Factory page: his saved navigation order still listed the old draft's panels. Put `bbonductor/factory` first in `sidebar.pluginPanelOrder`.
- bb is now 0.50.1. Its Conductor layout plugin is still not released.
- The Justus side shipped as justus#2093: lanes carry a `bb` or `conductor` tag, `publish-bb.mjs` pushes bb lanes here, and `create-plan` and `ship` end by running `sequence`. Checked end to end against a throwaway bb. No lane is tagged `bb` yet; the founder names which three move.

### 19 November 2026: approval rules live, Factory Droid added as a provider

- Pull request #3 was merged; updated the installed plugin to it and confirmed the installed orchestrator charter contains the approval rules.
- Registered Factory Droid in the founder's bb as provider `acp-droid` through bb's built-in ACP support. bb lists 76 models through it, including Gemini 4 Carbon. Listing models was the only check; no Droid thread has run in bb yet, so tool calls, approvals and the factory tools are untested on it.
- Founder's plan for the switch: warm up the orchestrator with questions, then move Conductor lanes to bb one at a time as each frees up, starting at plan review.

### 16 November 2026 (third session): new schedule, Watch hands off to the planner, Justus checks at any cadence

- **Founder corrected the schedule.** Daily checks are watches, errors and traces at 5:00 every day; the retro is Mondays 4:00; computer cleanup every three days by the harness improver; no weekly evidence review. All three automations exist and are paused at his request.
- **Watch now finds and the orchestrator plans.** Watch sends one handoff of what is new; the orchestrator turns it into tickets and plans. A message to a standing agent that was never started now starts it.
- **Added an inbound hook** (`POST …/http/prompt`, plugin token) so an outside event can wake a standing agent. Found that bb's public address answers with its own sign-in page before the plugin sees the request, so the cloud function cannot call it; recommended a poller instead.
- **Pull request #1 merged**; bb now loads the plugin from `git:…/bbonductor.git@main` instead of a Conductor workspace folder. Roles and memory paths survived the reinstall.
- **Justus tooling change** on branch `gideon/bb-worktree-setup`, plan `NO-LINEAR - Review checks run at any cadence and bb worktrees set themselves up`: the lanes' scheduled mode is renamed `run`, error triage keeps a marker of what it covered, and bb worktrees set themselves up. Shipped through the Justus ship queue: pull request #1996 merged to Justus main as `0400f5e00` after CI passed.
- **Checked:** 30 behaviour tests, 24 live checks; Justus lane contract tests, cursor tests and dashboard tool tests; the Sentry "since" query against real Sentry.

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
