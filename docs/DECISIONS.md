# Decisions

What Gideon has decided about the factory, newest first. Check here before re-opening a question.

## How to use this file

- **Add an entry when the founder decides something** he would notice in how the factory behaves, or that changes what gets built next. Technical choices with no visible effect do not belong here; put those in `LEARNINGS.md`.
- **Keep each entry to a few lines:** the decision, the reason in his words where possible, and what it replaces.
- **Never edit an old decision to change its meaning.** Add a new one and mark the old one "Replaced by".
- **Mark who decided.** "Founder" means Gideon said it. "Agent, pending founder" means an agent chose it to keep moving and he has not confirmed it yet.

---

## 21 November 2026 (follow-up tickets, Watch)

**Follow-up work on a shipped ticket continues in the same workspace under its new ticket.** The owner moves the workspace and its own thread to the new ticket; the shipped ticket leaves the board. No new workspace for a continuation. (Founder)

**Feedback should reach Watch when it arrives, from Justus or Slack, not on a schedule.** How is open: see Next up. (Founder)

## 20 November 2026 (issue owners)

**Each ticket has an issue owner, and the standing chief of staff is retired.** The thread that reviews a ticket's plan owns the ticket until it ships: it is the one thread the founder talks to about it, from the inbox or in the thread, and the only one that reaches his inbox for it. (Founder)
"That way there is always one thread that I talk to for each ticket. Builder and shipper are basically just sub agents of the issue owner." It supersedes the chief of staff decision below.

**His notes on a ticket go to the owner, who plans the fix and sends it to the builder.** (Founder: "I sent it to the plan reviewer because I wanted them to plan the fix and send that to the builder.")

**A reply typed in a thread clears that thread's inbox entry.** (Founder)

**Small bugs get no workspace of their own.** A planned small bug rides with the next-up ticket in a swimlane: the owner picks it up and the builder fixes it with the main ticket, so it gets no CI run of its own and does not wait. (Founder)

**The owner fields conversations; the factory still moves tickets.** A separate code reviewer always reviews a planned ticket, because the owner approved the plan and would miss where the plan was wrong. The owner keeps a short ticket note so a long thread cannot lose what the founder said. (Agent proposed; Founder: "I like your other push back.")

**Review findings still go straight to the builder**, not through the owner: each pass through the owner would cost a turn on the strongest model for no decision. The builder takes a disputed finding to the owner. (Agent)

**Builders and shippers stay as threads, not sub-agents, for now.** (Founder: "we don't have to do that now")

**A small bug with no planned ticket coming up runs alone, and its builder owns it.** (Agent)

## 20 November 2026 (inbox reply box)

**The inbox reply box behaves like a real composer.** It grows as he types, takes pictures, videos and other files, keeps an unsent draft when he leaves the page, and moves that draft into the thread's composer when he presses Open thread. (Founder: "Four big problems")

**What he was asked shows inside the thread it is about**, above that thread's composer, even when the chief of staff wrote it. (Founder)

**The whole ask travels with his answer** into the thread, not only its first line. No message is sent to the thread when the ask is filed: that would start an agent turn and spend quota for a note. (Agent)

## 20 November 2026 (run from the inbox)

**A to-do, a test or a "try before it ships" entry has a Run button that starts the project's Run command in that ticket's workspace.** It becomes Stop while that workspace is running. (Founder)

**The sidebar marks a workspace while its Run command is up**, not only while an agent is working. (Founder: "no indicator on a workspace when it's running like in Conductor")

**The Run command stays in the project's `.conductor/settings.toml`.** The Factory reads it and does not keep its own copy. (Agent)

## 20 November 2026 (clearer asks)

**An inbox entry shows the ticket title on its own line, then the ask.** A to-do or a test never shows options. No branch names or history of earlier requests in what he reads. (Founder)
"Very busy. Ticket title and the topic of the inbox message are hard to distinguish, a bunch of branch info I don't need, and it's framed as a decision when it's obviously just a test on your phone to do."

## 20 November 2026 (deployer)

**A standing Deployer runs deployments when the founder asks.** (Founder)
"This can be a simpler model which is why I wouldn't use the chief of staff or planner." It never deploys on its own initiative.

**The standing agents' workspace is named "Agents"**, not after whichever agent started first. (Founder asked why; Agent chose the name)

## 20 November 2026 (inbox labels)

**The inbox says what kind of thing each entry is:** Decision, Try before it ships, Try on main, To do. (Founder)
Test steps for shipped work had shown as "Decision"; he also asked for "To do" for things only he can physically do.

## 20 November 2026 (chime)

**A calm chime plays when something lands in the inbox.** (Founder)
"Conductor uses a subway train stop ding which I like but something creative/calm like that would be great." Two soft falling bell notes, in any open bb window; it can be switched off on the page.

## 20 November 2026 (page and message feedback)

**Threads in the factory end with one line, not a founder summary.** (Founder)
"Plan reviewed, made 3 changes, sent to a tier 2 builder": lightweight and factory-oriented. He never reads the handoff; it is written for the next agent.

**A "try before it ships" message has one fixed shape.** (Founder)
Before, why, now; "Needs your review"; the test account and password on their own line; bullet steps to test. No list of what the agent verified or fixed, and no setup narration. Built as fixed fields on the tool rather than routed through the chief of staff, to avoid spending tokens on reformatting (Agent's choice on his open question).

**Stage names:** Plan, Plan review, Execution, Code review, Ship, and Founder testing while a ticket waits for him. (Founder)

**Page:** real section headers with no helper text; Done is a column so its lane is visible; "Waiting for you" sits beside Open thread in red; waiting tickets reorder by drag, with small arrows as a fallback; agents show a Memory button instead of a path; roles show no sub-text; a ticket being worked on right now shows a moving mark; the inbox renders Markdown and leads with the ticket number. (Founder)

## 20 November 2026 (later)

**Agents may merge this repo's pull requests and update the founder's bb without asking.** (Founder)
"You can ship to bb without my approval." Covers the Factory plugin only. Verify with both suites first, merge, then `bb plugin update bbonductor --yes`.

**The founder archives workspaces himself; the factory never does.** (Founder)
"Let's make sure that threads don't auto archive, I want to archive them." Replaces "A finished ticket's threads are archived" below, decided earlier the same day.

**A merged ticket stays in a Done lane until its workspace is archived, then leaves the board.** (Founder)

**Tickets marked Later show in their lane in bb and never start on their own.** (Founder)

## 20 November 2026 (after the first night)

**A chief of staff stands between ticket threads and the founder.** (Founder)
"All the threads can message directly… takes the incoming from all the branches and then writes me messages with the clear thing I need to actually do." It settles what agents may settle and rewrites the rest in plain words. Split from the orchestrator, which becomes the **Planner / strategist** on the strongest model; the chief of staff runs on a lighter one.

**QA budgets are set by agents and raised by agents.** (Founder)
"I don't need to get in the weeds on the budgets. Really it should be product choice." The aim was only that weaker builders do not have unlimited budgets.

**Nothing a user can see ships until the founder has tried it.** (Founder)
"They should have sent me a message saying, 'This branch is ready to run. Check it,' and then ship." Review and everything else finish first; only ship waits. The message says exactly what changed and comes with a dev account, existing or seeded, to test it in.

**A lane still stops while its ticket is blocked or waiting for the founder.** (Agent, pending founder)
Founder asked for a view. Lanes group work that collides, so starting the next ticket would build on a base that is about to change.

**A finished ticket's threads are archived**, which removes its worktree. A new ticket never reuses a workspace. (Founder)

**A workspace is named by its ticket number alone.** (Founder)

**Model and provider are one dropdown per role.** (Founder)

## 20 November 2026

**The planner of a ticket is whoever reviewed its plan.** (Founder)
"The planner is actually the plan reviewer so I never take things back to the planner. The builder should send it back to the plan reviewer always when they have a back-and-forth and then the plan reviewer can send it back to the builder." Builder and plan reviewer go back and forth directly, as often as needed; the founder does not carry it. Applies in Conductor too.

**The Factory page is for watching and for reordering, not for operating.** (Founder)
"This is supposed to be headless." Removed: the add-ticket form, the lane dropdown, Cancel, Advance, the per-stage buttons and the "(queued)" label. A ticket shows its tier as a pill. Waiting tickets have arrows to reorder them. Those operations remain on the command line.

**One ticket in flight per lane; no separate limit on tickets in flight.** (Founder)
"We just have swim lanes and we can have one ticket in flight for each swim lane." The number of lanes is capped where lanes are made, in the sequencing skill.

## 19 November 2026 (evening)

**A role's fallback can be on another provider.** (Founder)
"The fallback inherently has to be a different provider, it can't be the same provider except for Fable which runs out before the rest." Replaces the same-provider-only fallback built earlier the same day.

**The inbox must work on bb's mobile web interface.** (Founder)
"That's going to be the most complex piece to get right."

**Lane 4 is the first lane run by bb.** (Founder)

## 19 November 2026 (later)

**Lanes pick up only planned work.** (Founder)
"Items that don't have a plan and that are marked with the later tag should not be automatically picked up, but anything else with a plan can be picked up." Enforced where lanes are filled, in the Justus `sequence` skill. A Small bug counts as planned because its ticket is its plan (Agent, pending founder).

**Builders are set per plan tier: tier 1, tier 2 and tier 3 each have their own model.** (Founder)
"There should actually be settings for a tier 1, 2 and 3 builder and I can set different models." The tier comes from the plan's implementer tier line.

**A role whose model runs out of usage falls back to another model without asking.** (Founder)
"I would like anything using Fable to fall back seamlessly to Opus if Fable credits for the week run out." Built as a fallback model per role, same provider.

**Plan and ship end with a light swimlane refresh, not the full sequencing run.** (Founder)

**Use bb's own Conductor layout, built from its source, until bb releases it.** (Founder asked whether to build a stopgap; Agent chose installing bb's unreleased plugin instead)

## 19 November 2026

**Swimlanes in bb are populated by the project's sequencing skill, not by hand.** (Founder)
"The swimlanes should operate headless." The Justus `sequence` skill tags each lane `bb` or `conductor` during the move off Conductor and pushes the `bb` lanes into the factory. The only thing the founder does in the factory's lanes is change the order inside a lane, so a sync never rewrites that order.

**Swimlanes are regenerated every time a ticket is planned or shipped.** (Founder)

**Linear stays the ticket system for now.** (Founder)
"Eventually we might just want to rebuild what we use Linear for in bb… but not now."

**The switch off Conductor is lane by lane.** (Founder)
Warm up the orchestrator with questions, move free lanes to bb starting at plan review, and retire the Conductor planning thread whenever it is no longer needed.

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
