# bbonductor

**Conductor-style workspaces and issue-to-merge workflows for [bb](https://getbb.app).**

bb is excellent at running many coding agents, providers, threads, and remote sessions. Conductor is excellent at making a *branch/worktree* feel like the unit of software work. **bbonductor brings that workspace-first mental model to bb without replacing bb's agent runtime.**

> Status: **early community draft / alpha**. The architecture is based on bb's current plugin SDK, including experimental sidebar APIs that may change before BB 1.0.

## The core idea

In stock bb, the sidebar's visible primitive is usually a **thread**. bbonductor instead treats the BB **environment/worktree** as the primary object:

```text
Project (only shown when more than one project exists)

★ Main
  ├─ Chief / orchestrator
  ├─ Architecture discussion
  ├─ Runtime: npm run dev
  └─ Terminal: npm run dashboard

JUS-273 · fix post-activity routing       PR #602 ✓
  ├─ Claude Code · implementation
  ├─ Codex · investigate tests
  ├─ Claude Code · review
  ├─ Runtime: npm run dev
  └─ Terminal: shell
```

Threads remain independent conversations and can use different providers. They simply share the same filesystem, branch, runtime, PR, and development lifecycle.

## Goals

- **Many threads per branch/worktree.** A workspace is an environment, not a chat.
- **Main is a real workspace.** Pin long-lived orchestrator/chief threads at the top and run terminals on main too.
- **Issue → workspace in one action.** Create a workspace from a Linear issue rather than copying issue text around.
- **Environment-level runtimes.** `Run` belongs to the branch, not the active agent thread.
- **Many terminals per environment.** Keep `npm run dev`, dashboards, test watchers, shells, etc. alive beside the same workspace.
- **PR lifecycle in the workspace.** Show PR state, checks, mergeability, conflicts, and merge controls without bouncing to GitHub.
- **Provider agnostic.** Codex, Claude Code, Pi, Cursor, or any provider BB supports can participate in the same workspace.
- **Remote-friendly.** The same workspace model should work through BB Connect from a phone/tablet.

## MVP

### 1. Workspace sidebar

bbonductor replaces BB's thread list with an environment-grouped view.

- Group threads by `environment.id`.
- Main/default environment is pinned to the top.
- Pinned main threads naturally become long-lived orchestrator/chief threads.
- A workspace can contain any number of agent threads.
- Project headers appear **only when more than one BB project is present**. With a single project, the sidebar goes straight to its workspaces.
- Show branch name and PR badge/status on each workspace.
- `+` creates another thread for the same workspace (environment-preserving implementation is the highest-priority unfinished piece in this draft).

### 2. Create workspace from Linear

A **Create workspace** control lists issues from Linear.

Default behavior:

- only issues in `Todo`;
- configurable Linear workflow-state names per BB project;
- optional Linear team ID per BB project;
- selecting an issue creates the initial BB thread and passes the issue title, description, identifier, and URL as context.

The current draft relies on BB's `project-default` environment policy when spawning the first thread. Configure the BB project so new work starts in a fresh worktree. When BB exposes a stable explicit `createWorktree` SDK for third-party plugins, bbonductor should use it directly and control the branch name from the issue identifier.

### 3. Run + terminals

Each workspace has an environment-level **▶ Run** button.

The command is configurable per BB project and defaults to:

```sh
npm run dev
```

The Run process is a BB terminal scoped to the workspace environment, so changing from a Codex thread to a Claude Code thread does not restart the app.

You can also add arbitrary terminals to an environment for commands such as:

```sh
npm run dashboard
npm test -- --watch
supabase functions serve
```

The current panel implements a simple runtime/scrollback surface backed by BB's environment-scoped terminal API. A full xterm-style terminal UI is a good community contribution.

### 4. GitHub PR lifecycle

The sidebar uses BB's native per-thread PR lookup for the lightweight badge. bbonductor's PR panel uses the authenticated GitHub CLI (`gh`) from the environment for richer status:

- PR number/title/state;
- draft state;
- mergeability/conflict state;
- review decision;
- CI/status checks;
- configured merge method (`squash`, `merge`, or `rebase`);
- merge button.

**Next milestone:** one-click **Fix CI** and **Resolve conflicts** actions that spawn a new agent thread *inside the same environment*, with failing-check/conflict context preloaded.

## Configuration

Global plugin setting:

- **Linear API key** — stored as a BB secret setting.

Per-project settings:

- **Run command** — default `npm run dev`;
- **Linear team ID** — optional;
- **Linear statuses** — default `Todo`; comma-separated list supported;
- **Merge method** — squash / merge / rebase.

Future settings can live here without bloating the primary workspace UI.

## Install

Once this repository is published:

```sh
bb plugin install git:https://github.com/gmemmanuel/bbonductor.git@main
```

For development:

```sh
git clone https://github.com/gmemmanuel/bbonductor.git
cd bbonductor
npm install
bb plugin install .
bb plugin dev
```

Then choose **bbonductor** under **Settings → Appearance → Sidebar**.

## Requirements

- BB with plugin SDK `^0.4.1` or compatible;
- Git + a BB project backed by a Git repository;
- `gh` installed and authenticated for PR detail/merge controls;
- Linear API key only if using Linear workspace creation.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Short version:

```text
BB Project
   │
   ├── Main environment ──┬── Thread A (orchestrator)
   │                      ├── Thread B
   │                      ├── Run terminal
   │                      └── Other terminals
   │
   └── Worktree environment ─┬── Thread A (Codex)
                             ├── Thread B (Claude Code)
                             ├── Thread C (review)
                             ├── PR state
                             ├── Run terminal
                             └── Other terminals
```

The plugin deliberately avoids inventing a second workspace database. **BB's environment ID is the workspace ID.** Plugin storage only contains external metadata/configuration that BB does not own (Linear links, per-project preferences, etc.).

## Current draft limitations

This first public draft intentionally leaves a few pieces for implementation/testing against a live BB install:

1. **New thread in existing environment:** the sidebar button is wired to BB's stock new-thread action today. It needs to use BB's environment-seeded `experimental_NewThreadComposer` so the new conversation stays on the selected workspace.
2. **Explicit worktree creation/branch naming:** initial Linear work uses `project-default`. We should switch to a stable explicit worktree-creation SDK when available.
3. **Fix CI / Resolve conflicts:** PR state is surfaced, but the one-click repair-agent actions still need the stable existing-environment spawn selector.
4. **Terminal UI:** output works as a trace; richer interactive terminal emulation is not yet implemented.
5. **PR refresh/cache:** detail calls currently shell through `gh`. Add a small TTL cache/background refresh before broad use.

These are deliberately documented rather than hidden behind brittle calls to BB internals.

## Roadmap

- [x] Environment-first sidebar architecture
- [x] Hide project heading when only one project exists
- [x] Main workspace + pinned orchestrator threads
- [x] Configurable environment-level Run command
- [x] Multiple environment terminals
- [x] Linear issue filter config (default `Todo`)
- [x] Linear issue → initial BB work item
- [x] PR badge/status foundation
- [x] PR detail/checks/merge foundation
- [ ] New thread directly into selected existing environment
- [ ] Deterministic Linear issue → branch/worktree naming
- [ ] Open/create PR button
- [ ] Fix CI with agent
- [ ] Resolve conflicts with agent
- [ ] Push/update branch action
- [ ] Review action with configurable alternate provider
- [ ] Full terminal emulator
- [ ] Workspace archive/cleanup after merge
- [ ] Linear status update after PR merge
- [ ] Per-workspace runtime overrides
- [ ] Configurable workspace templates

## Contributing

PRs are welcome. The most useful early contributions are the items under **Current draft limitations**.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## Why "bbonductor"?

It is deliberately literal: **BB + the workspace workflow that makes Conductor pleasant to use.** This project is an independent community plugin and is not affiliated with Conductor or Melty Labs.

## License

MIT.
