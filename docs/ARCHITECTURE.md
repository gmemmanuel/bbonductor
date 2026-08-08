# Architecture

## Principle: environment is the aggregate root

bbonductor does not invent its own workspace primitive. BB already has the correct durable object: an **environment** representing the project root or a worktree.

The plugin projects four kinds of state onto that environment:

1. **Threads** — sourced from BB's sidebar thread cache.
2. **Terminals/runtime** — sourced from `bb.sdk.terminals` with `{ kind: "environment", environmentId }` scope.
3. **Pull request** — lightweight status from BB's sidebar PR hook; richer state through authenticated `gh` commands in the environment.
4. **Issue metadata** — Linear identifier/title/link stored only as supplementary plugin metadata when needed.

## Sidebar projection

```text
threads[]
  -> group by projectId
  -> group by environment.id
  -> classify main/default environment
  -> sort main first
  -> sort pinned threads first within main
  -> annotate representative thread with native PR lookup
```

Project labels are shown only when the current dataset contains more than one project.

## Runtime lifecycle

`Run` is intentionally workspace-level.

```text
Run click
  -> resolve project config
  -> stop previous run terminal for environment (if any)
  -> terminals.create(scope=environment, start=command)
  -> store terminalId in ephemeral runtime map
  -> open Runtime panel
```

Additional terminals use the same BB environment scope but are independent sessions.

## PR lifecycle

The sidebar should stay cheap, so it uses BB's native PR lookup hook.

The PR detail panel may run:

```sh
gh pr view --json number,title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
```

Merge uses the configured merge method. Repair actions should not try to resolve conflicts deterministically in plugin code. Instead, they should spawn a coding-agent thread in the same environment with a precise task and relevant GitHub context.

## Linear lifecycle

Linear is an optional external source of work.

- API key: BB secret setting.
- Team/status filters: per-project configuration.
- Default state filter: `Todo`.
- Create workspace: fetch issue, compose initial prompt, spawn initial BB thread.

The first draft uses BB's project-default environment policy. We should adopt a stable explicit worktree creation API when one is available to third-party plugins.

## Why not fork BB?

Everything here maps naturally onto BB's plugin extension points:

- replacement sidebar thread list;
- custom nav panel;
- custom settings section;
- thread side-panel tabs;
- RPC/realtime;
- environment-scoped terminals;
- agent/thread spawning.

Staying a plugin lets bbonductor follow BB releases while remaining independently forkable and installable.
