# Contributing

Read [AGENTS.md](AGENTS.md) first; it is the working agreement for people and agents alike.

## Principles

1. **The factory owns flow, the project owns craft.** Do not put planning, review, build or ship instructions in this plugin. Stage prompts name a project skill.
2. **Reuse bb before building.** Check bb's built-in plugins and `docs/research/` before adding a surface.
3. **Public SDK only.** No bb internals and no DOM scraping. Note any `experimental_` API in `docs/ARCHITECTURE.md`.
4. **Provider-neutral.** Any role can be played by any provider bb supports.
5. **Every engine rule has a test** driven through a tool, an event, RPC or the CLI.

## Before opening a pull request

```sh
npm run verify
node scripts/live-check.mjs
```

Add a `docs/WORKLOG.md` entry, and record anything non-obvious in `LEARNINGS.md`.
