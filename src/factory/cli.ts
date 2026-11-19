// `bb factory …` — the same operations the Factory page and the agent tools
// use, for agents and scripts. Argument parsing is deliberately small: flags
// are `--name value`, everything else is positional.
import type { FactoryEngine } from "./engine.js";
import { FactoryError } from "./engine.js";
import type { FactoryStore } from "./store.js";

export const CLI_COMMANDS = [
  { name: "status", summary: "Show lanes, tickets and the inbox", usage: "bb factory status [--project <id>] [--json]" },
  { name: "enqueue", summary: "Add a ticket to a lane", usage: "bb factory enqueue <key> <title…> [--lane <name>] [--pipeline <name>] [--tier 1|2|3] [--brief <text>]" },
  { name: "lanes", summary: "Queue many tickets at once from JSON", usage: "bb factory lanes '<json>'   # {\"lanes\":[{\"name\":\"A\",\"items\":[{\"key\":\"JUS-1\",\"title\":\"…\",\"pipeline\":\"planned\",\"brief\":\"…\"}]}]}" },
  { name: "sync", summary: "Make the lanes match a schedule: queue new tickets, move changed ones, drop unstarted ones no longer listed. Never reorders a lane or stops started work", usage: "bb factory sync '<json>'   # same JSON as lanes; list every ticket that belongs in the factory" },
  { name: "move", summary: "Move a ticket to a lane and slot", usage: "bb factory move <key> --lane <name> [--position <n>]" },
  { name: "advance", summary: "Send a ticket on to its next stage", usage: "bb factory advance <key> [--summary <text>]" },
  { name: "cancel", summary: "Take a ticket out of the factory", usage: "bb factory cancel <key>" },
  { name: "done", summary: "Report this thread's stage (same as factory_stage_done)", usage: "bb factory done --outcome complete|changes_requested|blocked --summary <text> [--rereview]" },
  { name: "ask", summary: "Ask the founder (same as factory_ask_founder)", usage: "bb factory ask <question…> [--context <text>] [--option <text>]… [--recommend <text>]" },
  { name: "message", summary: "Message an agent or a ticket's thread", usage: "bb factory message <agent|KEY|KEY:stage> <text…>" },
  { name: "inbox", summary: "List open founder decisions", usage: "bb factory inbox [--json]" },
  { name: "answer", summary: "Answer an inbox entry", usage: "bb factory answer <entry-id> <text…>" },
  { name: "agent", summary: "Start or rotate a standing agent", usage: "bb factory agent start|rotate <agent-id> [--project <id>]" },
  { name: "prompt", summary: "Send a standing agent a prompt, starting it if needed (for automations)", usage: "bb factory prompt <agent-id> <text…> [--project <id>]" },
  { name: "role", summary: "Set which model plays a role", usage: "bb factory role <role> [--provider <id>] [--model <id>] [--reasoning <level>] [--permission accept-edits|auto|full] [--fallback-model <id>] [--fallback-reasoning <level>] [--project <id>]" },
  { name: "config", summary: "Print the factory configuration", usage: "bb factory config [--project <id>]" },
];

interface Parsed {
  positionals: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(["json", "rereview", "help"]);

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
    let value = inline;
    if (value === undefined) {
      if (BOOLEAN_FLAGS.has(name)) value = "true";
      else {
        value = argv[index + 1];
        if (value === undefined) throw new FactoryError(`--${name} needs a value.`);
        index += 1;
      }
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positionals, flags };
}

export interface CliContext {
  threadId?: string;
  projectId?: string;
}

export interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export async function runCli(
  argv: string[],
  ctx: CliContext,
  store: FactoryStore,
  engine: FactoryEngine,
): Promise<CliResult> {
  const usage = ["Usage:", ...CLI_COMMANDS.map((command) => `  ${command.usage}`)].join("\n");
  try {
    const { positionals, flags } = parse(argv);
    const [command, ...rest] = positionals;
    const flag = (name: string) => flags.get(name)?.at(-1);
    const json = flags.has("json");
    const ok = (value: unknown, text: string): CliResult => ({
      exitCode: 0,
      stdout: json ? JSON.stringify(value) : text,
    });
    const projectId = () => {
      const id = flag("project") ?? ctx.projectId;
      if (id === undefined) {
        throw new FactoryError("No project in context. Add --project <project-id> (see `bb project list`).");
      }
      return id;
    };
    const thread = () => {
      if (ctx.threadId === undefined) {
        throw new FactoryError("This command reports for the calling thread; run it from inside a factory thread.");
      }
      return ctx.threadId;
    };
    const itemByKey = (key: string | undefined) => {
      if (key === undefined) throw new FactoryError("Name the ticket key.");
      const item = store.findItemByKey(projectId(), key);
      if (item === null) throw new FactoryError(`No ticket "${key}" in this project's factory.`);
      return item;
    };

    switch (command) {
      case undefined:
      case "help":
        return { exitCode: 0, stdout: usage };
      case "status": {
        const items = store.listItems(projectId());
        const inbox = store.listInbox({ status: "open" }).filter((e) => e.projectId === projectId());
        return ok({ items, inbox }, formatStatus(store, projectId()));
      }
      case "enqueue": {
        const [key, ...title] = rest;
        if (key === undefined || title.length === 0) break;
        const item = await engine.enqueue({
          projectId: projectId(),
          key,
          title: title.join(" "),
          brief: flag("brief"),
          lane: flag("lane"),
          pipeline: flag("pipeline"),
          ...(flag("tier") === undefined ? {} : { tier: Number(flag("tier")) }),
          originThreadId: ctx.threadId ?? null,
        });
        return ok(item, `${item.key} queued in lane "${item.lane}" (${item.status}).`);
      }
      case "lanes": {
        const raw = rest.join(" ");
        let plan: unknown;
        try {
          plan = JSON.parse(raw);
        } catch {
          throw new FactoryError("`bb factory lanes` takes one JSON argument; see `bb factory help`.");
        }
        const lanes = (plan as { lanes?: unknown }).lanes;
        if (!Array.isArray(lanes)) throw new FactoryError('Expected {"lanes":[…]}.');
        const report: string[] = [];
        for (const lane of lanes as { name?: string; items?: unknown }[]) {
          for (const entry of (Array.isArray(lane.items) ? lane.items : []) as Record<string, string>[]) {
            try {
              const item = await engine.enqueue({
                projectId: projectId(),
                key: String(entry.key ?? ""),
                title: String(entry.title ?? entry.key ?? ""),
                brief: entry.brief,
                pipeline: entry.pipeline,
                lane: lane.name,
                originThreadId: ctx.threadId ?? null,
              });
              report.push(`${item.key}: queued in "${item.lane}"`);
            } catch (error) {
              report.push(`${entry.key}: skipped (${error instanceof Error ? error.message : String(error)})`);
            }
          }
        }
        return ok({ report }, report.join("\n") || "Nothing to queue.");
      }
      case "sync": {
        let plan: { lanes?: unknown };
        try {
          plan = JSON.parse(rest.join(" ")) as { lanes?: unknown };
        } catch {
          throw new FactoryError("`bb factory sync` takes one JSON argument; see `bb factory help`.");
        }
        if (!Array.isArray(plan.lanes)) throw new FactoryError('Expected {"lanes":[…]}.');
        const lanes = (plan.lanes as { name?: unknown; items?: unknown }[]).map((lane) => ({
          name: String(lane.name ?? ""),
          items: (Array.isArray(lane.items) ? (lane.items as Record<string, unknown>[]) : []).map((entry) => ({
            key: String(entry.key ?? ""),
            title: String(entry.title ?? entry.key ?? ""),
            ...(typeof entry.brief === "string" ? { brief: entry.brief } : {}),
            ...(typeof entry.pipeline === "string" ? { pipeline: entry.pipeline } : {}),
            ...(entry.tier === 1 || entry.tier === 2 || entry.tier === 3 ? { tier: entry.tier } : {}),
          })),
        }));
        const report = await engine.syncLanes(projectId(), lanes, ctx.threadId ?? null);
        return ok({ report }, report.join("\n") || "Lanes already match.");
      }
      case "move": {
        const item = itemByKey(rest[0]);
        const lane = flag("lane") ?? item.lane;
        const position = flag("position");
        const moved = await engine.move(item.id, lane, position === undefined ? undefined : Number(position));
        return ok(moved, `${moved.key} is now in "${moved.lane}" at slot ${moved.position}.`);
      }
      case "advance": {
        const moved = await engine.advance(itemByKey(rest[0]).id, flag("summary"));
        return ok(moved, `${moved.key} advanced (${moved.status}).`);
      }
      case "cancel": {
        const cancelled = await engine.cancel(itemByKey(rest[0]).id);
        return ok(cancelled, `${cancelled.key} cancelled.`);
      }
      case "done": {
        const outcome = flag("outcome");
        const summary = flag("summary");
        if (outcome !== "complete" && outcome !== "changes_requested" && outcome !== "blocked") break;
        if (summary === undefined) break;
        const text = await engine.stageDone(thread(), { outcome, summary, rereview: flags.has("rereview") });
        return ok({ message: text }, text);
      }
      case "ask": {
        if (rest.length === 0) break;
        const entry = await engine.ask(thread(), {
          question: rest.join(" "),
          context: flag("context"),
          options: flags.get("option") ?? [],
          recommendation: flag("recommend"),
        });
        return ok(entry, "Asked. The answer will arrive in this thread as a message. End your turn.");
      }
      case "message": {
        const [to, ...text] = rest;
        if (to === undefined || text.length === 0) break;
        const sent = await engine.message(projectId(), ctx.threadId ?? null, to, text.join(" "));
        return ok({ message: sent }, sent);
      }
      case "inbox": {
        const entries = store.listInbox({ status: "open" });
        return ok(
          entries,
          entries.length === 0
            ? "Inbox is empty."
            : entries.map((e) => `${e.id}  [${e.kind}] ${e.from}: ${e.question}`).join("\n"),
        );
      }
      case "answer": {
        const [id, ...text] = rest;
        if (id === undefined || text.length === 0) break;
        const entry = await engine.answer(id, text.join(" "));
        return ok(entry, "Answer delivered.");
      }
      case "agent": {
        const [action, agentId] = rest;
        if (agentId === undefined || (action !== "start" && action !== "rotate")) break;
        const state =
          action === "start"
            ? await engine.startAgent(projectId(), agentId)
            : await engine.rotateAgent(projectId(), agentId);
        return ok(state, `${agentId}: thread ${state.threadId ?? "pending"}${state.rotating ? " (handing off)" : ""}.`);
      }
      case "prompt": {
        const [agentId, ...text] = rest;
        if (agentId === undefined || text.length === 0) break;
        const state = await engine.promptAgent(projectId(), agentId, text.join(" "));
        return ok(state, `Prompt sent to ${agentId} (thread ${state.threadId}).`);
      }
      case "role": {
        const [roleId] = rest;
        const config = store.getConfig(projectId());
        const role = roleId === undefined ? undefined : config.roles[roleId];
        if (roleId === undefined || role === undefined) {
          throw new FactoryError(`Name a role: ${Object.keys(config.roles).join(", ")}.`);
        }
        const permission = flag("permission");
        if (permission !== undefined && !["", "accept-edits", "auto", "full"].includes(permission)) {
          throw new FactoryError("--permission is accept-edits, auto or full.");
        }
        const next = {
          ...role,
          providerId: flag("provider") ?? role.providerId,
          model: flag("model") ?? role.model,
          reasoningLevel: flag("reasoning") ?? role.reasoningLevel,
          permissionMode: (permission ?? role.permissionMode) as typeof role.permissionMode,
          fallbackModel: flag("fallback-model") ?? role.fallbackModel,
          fallbackReasoningLevel: flag("fallback-reasoning") ?? role.fallbackReasoningLevel,
        };
        store.setConfig(projectId(), { ...config, roles: { ...config.roles, [roleId]: next } });
        return ok(next, `${roleId}: ${describeRole(next)}`);
      }
      case "config":
        return { exitCode: 0, stdout: JSON.stringify(store.getConfig(projectId()), null, 2) };
    }
    return { exitCode: 1, stderr: usage };
  } catch (error) {
    if (error instanceof FactoryError || (error instanceof Error && error.name === "ZodError")) {
      return { exitCode: 1, stderr: error.message };
    }
    return { exitCode: 1, stderr: `Factory error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function describeRole(role: { providerId: string; model: string; reasoningLevel: string; fallbackModel?: string }): string {
  const parts = [role.providerId, role.model, role.reasoningLevel].filter((part) => part !== "");
  const base = parts.length === 0 ? "project default" : parts.join(" · ");
  return role.fallbackModel ? `${base} (falls back to ${role.fallbackModel})` : base;
}

export function formatStatus(store: FactoryStore, projectId: string): string {
  const config = store.getConfig(projectId);
  const items = store.listItems(projectId).filter((item) => item.status !== "cancelled");
  const lines: string[] = [];
  const lanes = [...new Set(items.map((item) => item.lane))];
  for (const lane of lanes) {
    lines.push(`${lane}`);
    for (const item of items.filter((candidate) => candidate.lane === lane)) {
      const stageId = config.pipelines[item.pipeline]?.[item.stageIndex];
      const stage = stageId === undefined ? "" : (config.stages[stageId]?.label ?? stageId);
      lines.push(`  ${item.key}  ${item.status}${item.status === "done" ? "" : `  ${stage}`}  — ${item.title}`);
    }
  }
  if (lines.length === 0) lines.push("No tickets in the factory.");
  const inbox = store.listInbox({ status: "open" }).filter((entry) => entry.projectId === projectId);
  lines.push("", inbox.length === 0 ? "Inbox: empty" : `Inbox: ${inbox.length} waiting on the founder`);
  for (const entry of inbox) lines.push(`  ${entry.id}  ${entry.from}: ${entry.question}`);
  return lines.join("\n");
}
