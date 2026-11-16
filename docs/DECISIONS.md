# Decisions

What Gideon has decided about the factory, newest first. Check here before re-opening a question.

## How to use this file

- **Add an entry when the founder decides something** he would notice in how the factory behaves, or that changes what gets built next. Technical choices with no visible effect do not belong here; put those in `LEARNINGS.md`.
- **Keep each entry to a few lines:** the decision, the reason in his words where possible, and what it replaces.
- **Never edit an old decision to change its meaning.** Add a new one and mark the old one "Replaced by".
- **Mark who decided.** "Founder" means Gideon said it. "Agent, pending founder" means an agent chose it to keep moving and he has not confirmed it yet.

---

## 16 November 2026 (fourth session)

**The founder approves three things and nothing else: creating a ticket, mockups, and product decisions.** (Founder)
"I want to approve ticket creation and mockups and any other product decisions but that's all." Ticket approval is for "the first week or two" while he sees what the daily checks produce; revisit after that. This keeps the Justus rule that no agent files a ticket without his confirmation.

**A lane starts its next ticket as soon as the one ahead of it merges, without asking.** (Founder)
An approved ticket needs no second approval to start.

## 16 November 2026 (third session)

**The daily check covers watches, errors and traces, every day at 5:00.** (Founder)
"We're starting to get more traces, and it's just worth looking every day rather than every week." Replaces the weekday errors-only check and the Monday four-lane review below. There is no weekly evidence review.

**Review checks must be runnable at any cadence and track what they have looked at**, so the next run does not redo it. (Founder)
They were written as weekly passes but were never scheduled weekly.

**Athlete feedback should trigger a check when it arrives**, not wait for a scheduled review. (Founder)

**Watch finds; the orchestrator plans.** (Founder)
Watch runs the checks and forwards what is new to the orchestrator, which creates the issues and writes the plans. "That would be more efficient" than sending the checks straight to the planner.

**The weekly harness retro runs Mondays at 4:00.** (Founder)

**Computer cleanup runs every three days, done by the harness improver.** (Founder)

**Automations stay paused until the founder has tried the factory by hand.** (Founder)

## 16 November 2026 (later the same day)

**Ship starts automatically after a clean code review.** (Founder)
Confirms the agent's choice below. No "ship it?" prompt in the inbox.

**A lane whose ticket is waiting on the founder stays blocked.** (Founder)
Confirms the agent's choice below. Independent work belongs in another lane.

**Recurring checks run through a standing Watch agent, on a schedule.** (Agent; the schedule was replaced by the founder in the third session)
Weekdays 8:00: error triage only. Mondays 7:00: the full four-lane evidence review. Mondays 9:30: the harness retro. The four review skills are written as weekly passes, so running all of them daily would spend quota re-reading the same week.

**For Justus, standing agents keep their memory files in the planning vault**, under `Engineering/Development tooling/Factory agents/`. (Agent, pending founder)
The default path is inside the repo, which would leave uncommitted files in the Justus main checkout.

## 16 November 2026

**Build a software factory on bb, to replace hand-moving tickets between agents in Conductor.** (Founder)
"I have to do a huge amount of shuffling tickets from one agent to another." The pipeline of independent agents works; it is just not automated.

**It must run on the paid Claude and ChatGPT subscriptions, not API tokens.** (Founder)
API tokens for coding would be "incredibly expensive", so nothing fully custom. bb drives the installed Claude Code and Codex CLIs, which use the subscriptions.

**Do not reinvent what bb or its community already has.** (Founder)
"I definitely don't want to completely reinvent the wheel."

**Keep the Conductor workspace model:** each ticket works in its own local branch and worktree. (Founder)

**Swimlanes are essential.** (Founder)
They cap how much runs at once on a MacBook Air ("about eight threads going at once kind of works") and keep work that collides, such as two branches that deploy the same edge function, in sequence.

**One persistent orchestrator, outside the workspaces, plans and sees the whole picture.** (Founder)
"A single agent as the planner … can see the big picture, know what we've been working on recently, and plan tickets with that context."

**Which model plays which role is a setting, changed day to day.** (Founder)
It depends on remaining quota. Example given: a strong model as orchestrator, another for all plan reviews, a cheaper one for ship.

**The founder is pinged only for decisions, through an inbox.** (Founder)
Any thread can ask; the answer goes back to the thread that asked. "Everything that needs to happen independently can happen independently."

**A standing harness-improvement agent runs retros on the factory itself**, about weekly. (Founder)

**The first persistent role to get right is the planner/strategist "second brain".** (Founder)

**This repo keeps a lightweight decision log, learnings file and worklog**, like the offline learning games repo. (Founder)

**Build a thin factory plugin that drives the existing project skills, rather than adopt a community factory plugin.** (Agent, pending founder)
Community plugins `factory`, `loom`, `crew` and `treelanes` each replace the pipeline with their own. Gideon's pipeline already exists as skills with review receipts and turn-taking scripts.

**Drop the original bbonductor sidebar, pull-request panel, terminal panel and Linear panel.** (Agent, pending founder)
bb now ships an official Conductor layout, pull request status and terminals. The old code was an untested draft against a much older SDK.

**A stage that finishes starts the next stage automatically, including ship.** (Agent; confirmed by the founder later the same day)
This follows the Justus decision of 14 November 2026 that ship merges without a founder click. It does change who launches reviews: the factory, not the founder.

**A lane that is waiting on the founder stays blocked.** (Agent; confirmed by the founder later the same day)
Lanes exist because their tickets collide, so skipping ahead inside a lane would defeat them.
