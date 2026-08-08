# Contributing to bbonductor

Thanks for helping make BB feel more like a workspace-first software factory.

## Principles

1. **Environment, not thread, is the workspace.** Do not reintroduce thread-scoped runtime/PR state.
2. **Use supported BB plugin APIs.** Avoid DOM scraping and private server endpoints when a plugin SDK primitive exists.
3. **Prefer provider-neutral behavior.** A workspace may contain Claude Code, Codex, Pi, Cursor, or other BB providers.
4. **Keep external integrations optional.** Linear and GitHub enhancements should degrade cleanly when unconfigured.
5. **Do not hide experimental dependencies.** If a feature relies on an `experimental_` BB API, document it.
6. **Mobile matters.** Controls should remain usable through BB Connect on compact viewports.

## Development

```sh
npm install
bb plugin install .
bb plugin dev
```

Run before opening a PR:

```sh
npm run typecheck
npm run build
```

> Note: this alpha draft still needs its first live validation against an installed BB build. If BB's current scaffold generates SDK declaration files for external plugins, preserve those generated declarations in the repository so contributors can typecheck without depending on BB internals.

## Good first contributions

- preserve selected `environment.id` when creating another thread in a workspace;
- richer terminal display/input;
- PR cache + background refresh;
- GitHub "Fix CI" agent action;
- GitHub "Resolve conflicts" agent action;
- Linear team/status discovery UI;
- tests for workspace grouping and one-project/multi-project sidebar behavior.
