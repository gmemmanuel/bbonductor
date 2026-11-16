// Behavioural tests for the factory, driven through the same surfaces bb uses:
// agent tools, thread lifecycle events, RPC and the CLI, against the SDK's fake
// plugin host (real SQLite, recorded bb.sdk calls).
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { type FactoryState } from "../server.js";

const PROJECT = "proj_1";

interface Spawned {
  id: string;
  title: string;
  prompt: string;
  environment: { type: string; environmentId?: string; workspace?: { type: string } };
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
  pinned?: boolean;
  pluginMetadata: { binding: Record<string, string> };
}

function setup() {
  const spawned: Spawned[] = [];
  const sent: { threadId: string; text: string; senderThreadId?: string }[] = [];
  const retried: string[] = [];
  let failSpawn = false;
  const host = createFakePluginHost({
    pluginId: "bbonductor",
    agentSkillIds: ["factory", "factory-orchestrator", "factory-harness-improver", "factory-watch"],
    sdk: {
      projects: { list: async () => [{ id: PROJECT, name: "Justus" }] },
      system: { config: async () => ({ primaryHostId: "host_local" }) },
      threads: {
        spawn: async (args: Record<string, unknown>) => {
          if (failSpawn) throw new Error("provider unavailable");
          const id = `th_${spawned.length + 1}`;
          const environment = args.environment as Spawned["environment"];
          spawned.push({ ...(args as unknown as Spawned), id });
          // Like bb, a new worktree is not known yet when spawn returns.
          return makeThreadResponse({
            id,
            projectId: PROJECT,
            environmentId: environment.type === "reuse" ? environment.environmentId! : null,
          });
        },
        get: async (args: { threadId: string }) => {
          const thread = spawned.find((candidate) => candidate.id === args.threadId)!;
          return makeThreadResponse({
            id: thread.id,
            projectId: PROJECT,
            environmentId:
              thread.environment.type === "reuse" ? thread.environment.environmentId! : `env_${thread.id}`,
          });
        },
        send: async (args: { threadId: string; input: { text: string }[]; senderThreadId?: string }) => {
          sent.push({ threadId: args.threadId, text: args.input[0]!.text, senderThreadId: args.senderThreadId });
          return { ok: true, delivery: "sent" };
        },
        retry: async (args: { threadId: string }) => {
          retried.push(args.threadId);
          return {};
        },
        unpin: async () => ({}),
        interactions: { list: async () => [] },
      },
      plugins: { callRpc: async () => ({ ok: true, channels: [] }) },
    } as never,
  });
  const { harness } = host;
  const rpc = <T>(method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<T>;
  const state = () => rpc<FactoryState>("state", { projectId: PROJECT });
  const enqueue = (key: string, lane: string, pipeline = "full") =>
    rpc("enqueue", { projectId: PROJECT, key, title: `Title of ${key}`, brief: "", lane, pipeline });
  const tool = async (name: string, threadId: string, input: unknown) => {
    const result = await harness.behavior.callAgentTool(name, input, { threadId, projectId: PROJECT });
    return typeof result === "string" ? result : JSON.stringify(result);
  };
  const emit = (event: "thread.idle" | "thread.active" | "thread.failed" | "thread.archived", threadId: string, extra = {}) =>
    harness.behavior
      .emitThreadEvent(event, { thread: makeThreadResponse({ id: threadId, projectId: PROJECT }), ...extra } as never)
      // Handlers are fire-and-forget; let the engine's queue drain.
      .then(() => new Promise((resolve) => setTimeout(resolve, 20)));
  const item = async (key: string) => (await state()).items.find((candidate) => candidate.key === key)!;
  return {
    host,
    harness,
    spawned,
    sent,
    retried,
    rpc,
    state,
    enqueue,
    tool,
    emit,
    item,
    breakSpawn: (broken: boolean) => (failSpawn = broken),
  };
}

let t: ReturnType<typeof setup>;
beforeEach(async () => {
  t = setup();
  await plugin(t.host.bb);
});
afterEach(async () => {
  await t.harness.lifecycle.dispose();
});

describe("swimlanes", () => {
  it("works one ticket per lane, in order, and starts other lanes in parallel", async () => {
    await t.enqueue("JUS-1", "Coach");
    await t.enqueue("JUS-2", "Coach");
    await t.enqueue("JUS-3", "Plan");

    expect((await t.item("JUS-1")).status).toBe("running");
    expect((await t.item("JUS-2")).status).toBe("queued");
    expect((await t.item("JUS-3")).status).toBe("running");
    expect(t.spawned.map((thread) => thread.title)).toEqual(["JUS-1 · Plan", "JUS-3 · Plan"]);
  });

  it("gives each ticket its own new worktree", async () => {
    await t.enqueue("JUS-1", "Coach");
    expect(t.spawned[0]!.environment).toEqual({
      type: "host",
      hostId: "host_local",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
  });

  it("holds new lanes once the capacity limit is reached, and starts them as work finishes", async () => {
    const { config } = await t.state();
    await t.rpc("saveConfig", { projectId: PROJECT, config: { ...config, maxActiveItems: 1 } });
    await t.enqueue("JUS-1", "A", "small-bug");
    await t.enqueue("JUS-2", "B", "small-bug");
    expect((await t.item("JUS-2")).status).toBe("queued");

    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Fixed and merged." });
    expect((await t.item("JUS-1")).status).toBe("done");
    expect((await t.item("JUS-2")).status).toBe("running");
  });

  it("starts the next ticket in a lane when the one ahead of it is cancelled", async () => {
    await t.enqueue("JUS-1", "Coach");
    await t.enqueue("JUS-2", "Coach");
    await t.rpc("cancel", { itemId: (await t.item("JUS-1")).id });
    expect((await t.item("JUS-2")).status).toBe("running");
  });

  it("refuses a ticket that is already in the factory", async () => {
    await t.enqueue("JUS-1", "Coach");
    await expect(t.enqueue("jus-1", "Other")).rejects.toThrow(/already in the factory/);
  });
});

describe("pipeline handoffs", () => {
  it("runs each stage in a fresh thread, in the same worktree, on that role's model", async () => {
    const { config } = await t.state();
    await t.rpc("saveConfig", {
      projectId: PROJECT,
      config: {
        ...config,
        roles: {
          ...config.roles,
          "plan-review": { ...config.roles["plan-review"], providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" },
          build: { ...config.roles.build, providerId: "codex", model: "gpt-terra" },
        },
      },
    });
    await t.enqueue("JUS-1", "Coach");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Plan is at Plans/JUS-1.md." });

    const review = t.spawned[1]!;
    expect(review.title).toBe("JUS-1 · Review plan");
    expect(review.environment).toEqual({ type: "reuse", environmentId: "env_th_1" });
    expect(review).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
    expect(review.prompt).toContain("Use the `review-plan` skill");
    expect(review.prompt).toContain("Plan is at Plans/JUS-1.md.");
    expect(review.prompt).toContain("factory_stage_done");

    await t.tool("factory_stage_done", "th_2", { outcome: "complete", summary: "Plan reviewed; two corrections landed." });
    expect(t.spawned[2]).toMatchObject({ title: "JUS-1 · Build", providerId: "codex", model: "gpt-terra" });
    // Unset role fields are left to the project default rather than sent empty.
    expect(t.spawned[0]).not.toHaveProperty("providerId");
  });

  it("finishes the ticket after the last stage and frees its lane", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.enqueue("JUS-2", "Coach", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", summary: "Review complete." });
    const final = await t.tool("factory_stage_done", "th_3", { outcome: "complete", summary: "Merged." });

    expect(final).toContain("JUS-1 is done");
    expect((await t.item("JUS-1")).status).toBe("done");
    expect((await t.item("JUS-2")).status).toBe("running");
  });

  it("sends review findings to the author's thread, then moves past the review once fixed", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "changes_requested", summary: "Scope question: should rest days count?" });

    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1", senderThreadId: "th_2" });
    expect(t.sent.at(-1)!.text).toContain("should rest days count?");
    expect((await t.item("JUS-1")).stageIndex).toBe(0);
    expect(t.spawned).toHaveLength(2);

    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Findings folded in." });
    expect(t.spawned.at(-1)!.title).toBe("JUS-1 · Ship");
  });

  it("runs the review again, in a new thread, only when the author asks for it", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "changes_requested", summary: "Change X." });
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Changed scope.", rereview: true });

    expect(t.spawned.at(-1)).toMatchObject({ id: "th_3", title: "JUS-1 · Review code" });
  });

  it("returns findings to the thread that queued the ticket when the pipeline has no author stage", async () => {
    const orchestrator = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    await t.tool("factory_enqueue", orchestrator.threadId, { key: "JUS-1", title: "Rest days", lane: "Coach", pipeline: "planned" });
    await t.tool("factory_stage_done", "th_2", { outcome: "changes_requested", summary: "Plan misses migration." });

    expect(t.sent.at(-1)!.threadId).toBe(orchestrator.threadId);
    expect(t.sent.at(-1)!.text).toContain("bb factory advance JUS-1");
    expect((await t.item("JUS-1")).status).toBe("returned");

    const cli = await t.harness.behavior.runCli(["advance", "JUS-1"], { projectId: PROJECT, threadId: orchestrator.threadId });
    expect(cli.exitCode).toBe(0);
    expect(t.spawned.at(-1)!.title).toBe("JUS-1 · Build");
  });

  it("rejects a report from a thread whose stage is no longer current", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Built." });
    const late = await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Again." });
    expect(late).toContain("not the current stage");
    expect(t.spawned).toHaveLength(2);
  });

  it("does not let a non-review stage request changes", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    const result = await t.tool("factory_stage_done", "th_1", { outcome: "changes_requested", summary: "x" });
    expect(result).toContain("not a review stage");
  });
});

describe("founder inbox", () => {
  it("records a question, pauses the ticket, and delivers the answer to the asking thread", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.tool("factory_ask_founder", "th_1", {
      question: "Should a skipped run count as a rest day?",
      context: "Du skipped Tuesday; today Coach counts it as rest.",
      options: ["Count it as rest", "Count it as missed"],
      recommendation: "Count it as missed.",
    });

    const before = await t.state();
    expect(before.inbox).toHaveLength(1);
    expect(before.inbox[0]).toMatchObject({ kind: "question", from: "Build · JUS-1", threadId: "th_1" });
    expect((await t.item("JUS-1")).status).toBe("needs-founder");

    // The agent ending its turn while it waits is not a stall.
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Waiting." });
    expect(t.sent).toHaveLength(0);

    await t.rpc("answer", { entryId: before.inbox[0]!.id, answer: "Count it as missed." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("Count it as missed.");
    expect((await t.state()).inbox).toHaveLength(0);
    expect((await t.item("JUS-1")).status).toBe("running");
  });

  it("nudges a thread that stops without reporting, then escalates the second time", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.emit("thread.idle", "th_1", { lastAssistantText: "All done!" });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text).toContain("factory_stage_done");
    expect((await t.state()).inbox).toHaveLength(0);

    await t.emit("thread.idle", "th_1", { lastAssistantText: "Really done." });
    const { inbox } = await t.state();
    expect(inbox[0]).toMatchObject({ kind: "stalled", context: "Really done." });
    expect((await t.item("JUS-1")).status).toBe("stalled");

    // Typing in the thread by hand clears the stall.
    await t.emit("thread.active", "th_1");
    expect((await t.item("JUS-1")).status).toBe("running");
    expect((await t.state()).inbox).toHaveLength(0);
  });

  it("replaces a stall notice with the question when a stalled agent then asks the founder", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Hm." });
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Hm." });
    expect((await t.item("JUS-1")).status).toBe("stalled");

    await t.tool("factory_ask_founder", "th_1", { question: "Which unit?" });
    const { inbox } = await t.state();
    expect(inbox.map((entry) => entry.kind)).toEqual(["question"]);
    expect((await t.item("JUS-1")).status).toBe("needs-founder");
  });

  it("puts a failed turn in the inbox and retries it on request", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.emit("thread.failed", "th_1", { error: "rate limited" });
    const { inbox } = await t.state();
    expect(inbox[0]).toMatchObject({ kind: "failed", context: "rate limited" });

    await t.rpc("retry", { entryId: inbox[0]!.id });
    expect(t.retried).toEqual(["th_1"]);
    expect((await t.item("JUS-1")).status).toBe("running");
  });

  it("reports a stage that could not start, and starts it again on retry", async () => {
    t.breakSpawn(true);
    await t.enqueue("JUS-1", "Coach", "reviewed");
    const { inbox } = await t.state();
    expect(inbox[0]!.context).toContain("provider unavailable");

    t.breakSpawn(false);
    await t.rpc("retry", { entryId: inbox[0]!.id });
    expect(t.spawned[0]!.title).toBe("JUS-1 · Build");
    expect((await t.item("JUS-1")).status).toBe("running");
  });

  it("asks the founder when a stage reports blocked", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "blocked", summary: "Dev database is down." });
    expect((await t.state()).inbox[0]).toMatchObject({ kind: "blocked", context: "Dev database is down." });
  });

  it("flags a stage thread that was archived out from under its ticket", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.emit("thread.archived", "th_1");
    expect((await t.state()).inbox[0]!.kind).toBe("failed");
  });
});

describe("standing agents and messaging", () => {
  it("starts an agent once, pinned, in the main checkout, on its role's model", async () => {
    const first = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    const second = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });

    expect(second.threadId).toBe(first.threadId);
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0]).toMatchObject({
      pinned: true,
      environment: { type: "host", hostId: "host_local", workspace: { type: "unmanaged", path: null } },
    });
    expect(t.spawned[0]!.prompt).toContain("factory-orchestrator");
    expect(t.spawned[0]!.prompt).toContain("docs/agents/orchestrator/MEMORY.md");
  });

  it("rotates an agent: the old thread writes its memory, then a fresh thread takes over", async () => {
    const first = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    await t.rpc("rotateAgent", { projectId: PROJECT, agentId: "orchestrator" });
    expect(t.sent.at(-1)!.text).toContain("docs/agents/orchestrator/MEMORY.md");
    expect(t.spawned).toHaveLength(1);

    await t.emit("thread.idle", first.threadId, { lastAssistantText: "Memory updated." });
    expect(t.spawned).toHaveLength(2);
    const agent = (await t.state()).agents.find((state) => state.agentId === "orchestrator")!;
    expect(agent).toMatchObject({ threadId: "th_2", rotating: false });
  });

  it("lets a scheduled prompt start a standing agent and reuse its thread afterwards", async () => {
    const first = await t.harness.behavior.runCli(["prompt", "watch", "Daily", "check."], { projectId: PROJECT });
    expect(first.exitCode).toBe(0);
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0]!.prompt).toContain("factory-watch");
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1", text: "Daily check." });

    await t.harness.behavior.runCli(["prompt", "watch", "Again."], { projectId: PROJECT });
    expect(t.spawned).toHaveLength(1);
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1", text: "Again." });
  });

  it("lets an outside service wake a standing agent through the inbound hook", async () => {
    const response = await t.harness.behavior.fetchHttp("POST", "/prompt", {
      body: JSON.stringify({ projectId: PROJECT, agent: "watch", text: "New feedback row 123" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, threadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("New feedback row 123");
    expect(t.sent.at(-1)!.text).toContain("not from the founder");

    const unknown = await t.harness.behavior.fetchHttp("POST", "/prompt", {
      body: JSON.stringify({ projectId: PROJECT, agent: "nobody", text: "x" }),
      headers: { "content-type": "application/json" },
    });
    expect(unknown.status).toBe(400);

    const malformed = await t.harness.behavior.fetchHttp("POST", "/prompt", {
      body: JSON.stringify({ agent: "watch" }),
      headers: { "content-type": "application/json" },
    });
    expect(malformed.status).toBe(400);
  });

  it("starts the orchestrator when Watch hands it findings before it was ever started", async () => {
    await t.harness.behavior.runCli(["prompt", "watch", "Daily check."], { projectId: PROJECT });
    const result = await t.tool("factory_message", "th_1", { to: "orchestrator", message: "Two new error classes." });
    expect(result).toContain("Delivered to Orchestrator");
    expect(t.spawned.map((thread) => thread.title)).toEqual(["Watch", "Orchestrator"]);
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_2", senderThreadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("Message from Watch");
  });

  it("delivers messages between a worker and the orchestrator", async () => {
    const orchestrator = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.tool("factory_message", "th_2", { to: "orchestrator", message: "Plan and code disagree on units." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: orchestrator.threadId, senderThreadId: "th_2" });
    expect(t.sent.at(-1)!.text).toContain("Message from Build for JUS-1");

    await t.tool("factory_message", orchestrator.threadId, { to: "JUS-1", message: "Use miles." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_2" });
  });

  it("gives factory tools only to factory threads", async () => {
    const configure = (pluginMetadata: Record<string, unknown>) =>
      t.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata } as never));

    const names = (tools: readonly { name: string }[] | undefined) => (tools ?? []).map((tool) => tool.name);

    const outsider = await configure({});
    expect(names(outsider?.tools)).toEqual([]);

    const worker = await configure({ binding: { kind: "stage", itemId: "itm_1", stage: "build" } });
    expect(names(worker?.tools)).toEqual(["factory_stage_done", "factory_ask_founder", "factory_message"]);

    const orchestrator = await configure({ binding: { kind: "agent", agentId: "orchestrator", projectId: PROJECT } });
    expect(names(orchestrator?.tools)).toContain("factory_enqueue");
    expect(JSON.stringify(orchestrator?.skills)).toContain("factory-orchestrator");
  });
});

describe("configuration and CLI", () => {
  it("rejects a configuration whose stage names an undefined role", async () => {
    const { config } = await t.state();
    await expect(
      t.rpc("saveConfig", {
        projectId: PROJECT,
        config: { ...config, stages: { ...config.stages, build: { ...config.stages.build, role: "nobody" } } },
      }),
    ).rejects.toThrow(/role "nobody"/);
  });

  it("sets a role's model from the command line", async () => {
    const result = await t.harness.behavior.runCli(
      ["role", "ship", "--provider", "codex", "--model", "gpt-luna", "--reasoning", "low"],
      { projectId: PROJECT },
    );
    expect(result.stdout).toBe("ship: codex · gpt-luna · low");
    expect((await t.state()).config.roles.ship).toMatchObject({ providerId: "codex", model: "gpt-luna" });
  });

  it("queues a whole swimlane plan from JSON and prints the board", async () => {
    const plan = JSON.stringify({
      lanes: [
        { name: "Coach", items: [{ key: "JUS-1", title: "Rest days", pipeline: "reviewed" }, { key: "JUS-2", title: "Units" }] },
        { name: "Plan", items: [{ key: "JUS-3", title: "Week sizing", pipeline: "small-bug" }] },
      ],
    });
    const queued = await t.harness.behavior.runCli(["lanes", plan], { projectId: PROJECT });
    expect(queued.exitCode).toBe(0);

    const status = await t.harness.behavior.runCli(["status"], { projectId: PROJECT });
    expect(status.stdout).toContain("JUS-1  running  Build  — Rest days");
    expect(status.stdout).toContain("JUS-2  queued");
    expect(status.stdout).toContain("JUS-3  running  Fix");
  });

  it("keeps tickets and configuration across a plugin reload", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    const reloaded = await t.harness.lifecycle.reload(plugin);
    t.harness = reloaded.harness;
    const state = (await reloaded.harness.behavior.callRpc("state", { projectId: PROJECT })) as FactoryState;
    expect(state.items.map((item) => `${item.key} ${item.status}`)).toEqual(["JUS-1 running"]);
  });
});
