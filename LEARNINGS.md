# Learnings

Non-obvious decisions and process knowledge for agents working on the Factory plugin. Add to this when something would otherwise be rediscovered.

## bb behaviour the SDK docs do not make obvious

- **A new thread has no environment yet.** `threads.spawn` returns `environmentId: null` for a new worktree; bb provisions it afterwards. To put a later stage in the same worktree, read the id back from the earlier thread (`threads.get`). The first version stored the null and gave every stage its own worktree. Found only by the live check (16 Nov 2026).
- **`environment: { type: "host" }` needs a `hostId`** unless the workspace is personal, even on a single-machine install. Use `system.config().primaryHostId`. The fake plugin host accepts a missing one; real bb answers HTTP 400.
- **`{ type: "host", workspace: { type: "unmanaged", path: null } }` is the project's main checkout.** This is where standing agents run. `managed-worktree` with `baseBranch: { kind: "default" }` is a fresh worktree.
- **`thread.idle` is the only "turn ended" signal, and it fires for every stop**, including a turn that ended because the agent asked a question. Anything that reacts to idle must first check whether the thread has something open in the inbox.
- **Agents do not reliably call a "done" tool.** Expect a thread to end its turn with a chat summary and nothing else. The factory nudges once, then escalates to the founder. Do not infer completion from the last message.
- **Tool and skill selection happens through `bb.agents.configure`, keyed on thread plugin metadata.** Metadata is seeded at spawn (`pluginMetadata`). Any agent can write any thread's metadata, so it must never unlock something unsafe; here it only unlocks reporting tools.
- **A plugin's cron schedules are fixed at load.** Scheduled prompts for standing agents (the weekly retro) belong in bb's built-in Automations plugin, which can re-prompt an existing thread.
- **The fake host's `reload()` returns a new host.** Keep using the old harness and every call fails with "stale API handle".
- **`resolveAgentConfiguration` in the test harness returns tool objects, not names.**

- **A plugin database outlives `bb plugin remove`, including its migration ledger.** The old bbonductor draft had recorded migrations 0 and 1 in `~/.bb/plugins/bbonductor/data.db`. bb numbers migrations by position, so the new plugin's first two statements would have been skipped as "already applied". The stale file (two empty tables) was backed up to `~/.bb-backups/` and deleted before installing. Any plugin that reuses an id must check for this.
- **bb's Conductor layout plugin is on bb's main branch but not in the 0.49 release.** `bb plugin search conductor` finds only a theme. Released bb already collapses threads that share a worktree into one sidebar row (`sidebar.threadGrouping.environment`), which covers most of the need until the layout ships.
- **Automation scripts can call the factory.** A script automation runs on the bb server host with `$HOME` set, and `"$HOME/.bb/bin/bb" factory …` reaches the server. Scheduled work for a standing agent is a script that runs `bb factory prompt <agent> "<text>"`, which also starts the agent if it has no thread yet.
- **`bb automation delete` needs `--yes`** when run non-interactively.

- **bb's public address does not reach plugin HTTP routes for outside callers.** `https://<handle>.getbb.app/api/v1/plugins/<id>/http/…` answers with bb connect's own sign-in page (401) before the plugin's token check runs; the same route on `127.0.0.1` reaches the plugin. A cloud service therefore cannot call the factory's `/prompt` hook directly. `bb connect expose` shares a whole port publicly, which would expose all of bb, so it was not used. For events that start in the cloud, poll from the laptop instead.
- **Automations created with `--disabled` stay off** until `bb automation resume`; a paused automation shows no next run. bb must be running for the CLI to pause anything.

- **Reinstalling the plugin from another source keeps its data.** `bb plugin remove` then `bb plugin install git:…@main` kept the per-project configuration (roles, memory paths), because the plugin database survives removal. After merging to main, run `bb plugin update bbonductor` (or reinstall) to pick the change up; a git install does not follow the workspace.

- **Factory Droid runs in bb through the built-in ACP provider; no third-party plugin is needed.** `droid exec --output-format acp` speaks ACP, and `bb plugin config provider-acp set customAgents '[{"id":"droid","displayName":"Factory Droid","command":"<path to droid>","args":["exec","--output-format","acp"]}]'` registers it as provider `acp-droid` with Droid's full model list. Two community Droid plugins exist; they were not installed because plugins are full-trust code and the built-in route does the job. Droid is not in bb's ACP registry, so `bb acp add` does not find it.

- **A reused plugin id inherits the user's saved navigation.** `sidebar.pluginPanelOrder` still listed the old draft's `bbonductor/workspaces` and `bbonductor/configuration`, so the new `bbonductor/factory` page was not where the founder looked. Fix with `bb settings ui set sidebar.pluginPanelOrder '[…]'`.
- **A schedule sync must not own order inside a lane.** The sequencing skill decides which tickets exist and which lane each is in; the founder reorders inside a lane in bb. `syncLanes` therefore only appends, moves between lanes, and cancels unstarted tickets that left the schedule.

- **bb's unreleased built-ins can be installed from source.** Plugins listed in bb's `scripts/forkable-plugins.json` build outside the monorepo: scaffold with `bb plugin new`, copy the plugin's source over it, and pull the `@/components/ui/*` files it imports with `npx shadcn add @bb/<name>` (the scaffold's `components.json` points at the registry for the installed bb version). This is how the Conductor layout runs in the founder's bb; the copy lives in `~/Development/bb-plugin-conductor-layout` with its own notes.
- **bb has no model fallback of its own for plugins to configure.** The built-in Provider retry plugin waits for a limit to reset; it never changes model. The factory does it on `turn.failed` (categories `rate-limit`, `billing`, `budget-exceeded`): `threads.update({ model })` then `threads.retry`. A thread switches once. Which category a real weekly Claude limit reports is unverified.
- **A thread that becomes active again is running, whatever failed before.** `turn.failed` and `thread.failed` arrive in no guaranteed order, so the fallback does not try to suppress the failure entry; `onActive` clears it when the rerun starts.
- **A saved per-project configuration never sees new default roles.** `withNewDefaults` adds what a saved configuration lacks (the tiered builders, copied from the existing builder) on read, without touching what the founder set.

- **A bb thread cannot change provider.** `threads.update` takes a model, not a provider. A fallback on the same provider switches the thread in place and reruns the turn; a fallback on another provider starts a replacement thread in the same worktree with a handover that points at `bb thread log <old thread>` and the worktree's git state. The replacement is marked so a limit on the fallback goes to the founder and never bounces back.
- **Page layouts need a phone variant, not just a scroll container.** The swimlane table renders as one card per lane below the `md` breakpoint; inbox answer fields and option buttons go full width. Check with a 390 px wide headless screenshot.

- **The first real build stopped on a "planner" the factory did not know about.** Justus builders are told to return certain blockers to "the planner" with a `PLANNER INPUT REQUIRED` handoff; with no such role in the pipeline the builder reported `blocked` and it landed in the founder's inbox. The planner of a ticket is the thread that reviewed its plan: `factory_ask_planner` sends there, the reviewer answers with `factory_message` to `KEY:stage`, and that reply is what resumes the stage (`with-planner` status). Project vocabulary for roles has to map onto a thread, or it ends up with the founder.
- **A merged pull request is not installed.** bb tracks `git:…@main` but only moves on `bb plugin update bbonductor --yes`. The founder looked for a feature that was merged and not yet updated. Update right after every merge.

## Testing

- **The fake plugin host proves the rules; only real bb proves the wiring.** Run both. The live check starts bb with its own data folder and ports, so it never touches `~/.bb`.
- **bb's echo example provider is the free model.** It repeats its prompt and cannot call tools, so the live check plays the agent by running `bb factory done` / `ask` with `BB_THREAD_ID` and `BB_PROJECT_ID` set. That is exactly how the CLI identifies a calling thread.
- **The bb CLI needs three variables to reach a non-default server:** `BB_SERVER_URL`, `BB_DATA_DIR`, and `BB_HOST_DAEMON_PORT`. Without the last, project creation fails with "Cannot reach local host daemon".
- **A fresh bb data folder opens the setup guide.** `bb settings general onboardingCompletedAt <ms>` skips it. The setup guide shows the signed-in account email, so never share a screenshot of it.
- **Stop a kept live-check server by process group, not by port.** bb supervises its children: killing the processes listening on the port brings them straight back, and the next run then passes against the old server. `kill -- -<pgid>` stops it; the script now refuses to start when the port is busy.
- **Vitest must be limited to `tests/`.** `.context/live/` holds a checkout of bb with its own test files.
- **Headless Chromium from the Playwright cache takes the screenshot:** `chrome-headless-shell --headless --screenshot=… --virtual-time-budget=15000 <url>`.

## Design

- **The plugin owns flow, the project owns craft.** Stage prompts are one line naming a project skill. Every time process detail was tempting to add here, it already existed in the Justus skills.
- **One review pass is the design.** A review that requests changes is marked passed; when the author finishes, the ticket moves on. A second review happens only when the author passes `rereview`. This mirrors the Justus pipeline rule and avoids review ping-pong.
- **Lanes are sequential on purpose.** A lane blocked on the founder stays blocked. Work that should not wait belongs in another lane.
- **Community factory plugins were not adopted** (`factory`, `loom`, `crew`, `treelanes`, `harness`). Each brings its own pipeline, review rules, and merge policy. Gideon's process already exists as skills with receipts and turn-taking scripts, so the missing piece was a conductor for it, not a replacement. Details in `docs/research/2026-11-16-bb-landscape.md`.
- **The original bbonductor sidebar was dropped.** bb has an official "Conductor layout" plugin that does the same job (on its main branch; not yet in the 0.49 release).
