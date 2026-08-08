# Implementation notes for the first live test

The starter code is intentionally conservative around BB APIs that are still experimental or not yet exposed as stable third-party primitives.

## Must validate against a live BB install

### Existing-environment thread creation

BB documents an environment-seeded `experimental_NewThreadComposer`, which is the intended path for "new thread in this workspace." The current sidebar button falls back to BB's stock new-thread action until we confirm the exact environment seed shape from the installed BB release.

Target behavior:

```text
Workspace +
  -> open bbonductor composer
  -> seed current environment/worktree
  -> user chooses provider/model
  -> spawn thread in same environment
```

### Linear → deterministic worktree

`createWorkspaceFromLinear` currently uses `environment: { type: "project-default" }` so it stays on a supported documented SDK path. In a project whose default new-work behavior is a fresh worktree, this produces the desired result.

Target behavior once BB exposes a stable explicit third-party API:

```text
JUS-273
  -> create worktree from configured base branch
  -> branch: jus-273-post-activity-routing
  -> spawn initial thread in that environment
```

### Agent repair buttons

The PR panel already detects conflict/check state. The desired next actions are:

- **Fix CI** → spawn new default-provider thread in the same environment with failing checks and logs.
- **Resolve conflicts** → spawn new default-provider thread in the same environment instructing it to update from base, resolve, test, commit, and push.

Do not implement these by reaching into BB private internals. Confirm the stable existing-environment spawn selector first.

## PR handling

The implementation uses `gh` because BB's own official GitHub plugin is also gh-CLI-backed and the CLI provides mergeability, checks, review decision, and merge commands cleanly.

Before production use, add:

- 10–30 second PR detail cache;
- explicit `gh auth status` diagnostics;
- protected-branch/merge-queue handling;
- create/open PR control;
- update-branch action;
- better failed-check log retrieval.

## Terminal handling

BB's terminal SDK natively supports environment scope, multiple sessions, command mode, scrollback, input, restart, rename, and close. The starter UI intentionally renders a simple text trace. A production-quality terminal should use an ANSI/xterm renderer while continuing to use BB terminal sessions underneath.
