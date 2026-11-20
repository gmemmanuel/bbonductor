// Behavioural tests for the factory, driven through the same surfaces bb uses:
// agent tools, thread lifecycle events, RPC and the CLI, against the SDK's fake
// plugin host (real SQLite, recorded bb.sdk calls).
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
  makeTurnFailedEvent,
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
  const archived: string[] = [];
  const updated: { threadId: string; model?: string; reasoningLevel?: string }[] = [];
  let failSpawn = false;
  const host = createFakePluginHost({
    pluginId: "bbonductor",
    agentSkillIds: ["factory", "factory-orchestrator", "factory-chief-of-staff", "factory-harness-improver", "factory-watch"],
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
        archive: async (args: { threadId: string }) => {
          archived.push(args.threadId);
          return {};
        },
        update: async (args: { threadId: string; model?: string; reasoningLevel?: string }) => {
          updated.push(args);
          return {};
        },
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
    archived,
    updated,
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
    expect(t.spawned.map((thread) => thread.title)).toEqual(["JUS-1", "JUS-3"]);
  });

  it("gives each ticket its own new worktree", async () => {
    await t.enqueue("JUS-1", "Coach");
    expect(t.spawned[0]!.environment).toEqual({
      type: "host",
      hostId: "host_local",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
  });

  it("runs one ticket per lane with no overall limit on lanes", async () => {
    for (const lane of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]) {
      await t.enqueue(`JUS-${lane}1`, lane, "small-bug");
      await t.enqueue(`JUS-${lane}2`, lane, "small-bug");
    }
    const items = (await t.state()).items;
    expect(items.filter((item) => item.status === "running")).toHaveLength(10);
    expect(items.filter((item) => item.status === "queued")).toHaveLength(10);
  });

  it("lets the founder drag a waiting ticket to a new place in its lane", async () => {
    for (const key of ["JUS-1", "JUS-2", "JUS-3", "JUS-4"]) await t.enqueue(key, "Coach", "small-bug");
    const order = async () => (await t.state()).items.filter((item) => item.lane === "Coach").map((item) => item.key);
    const id = async (key: string) => (await t.item(key)).id;
    await t.rpc("reorderBefore", { itemId: await id("JUS-4"), beforeId: await id("JUS-2") });
    expect(await order()).toEqual(["JUS-1", "JUS-4", "JUS-2", "JUS-3"]);
    await t.rpc("reorderBefore", { itemId: await id("JUS-4"), beforeId: null });
    expect(await order()).toEqual(["JUS-1", "JUS-2", "JUS-3", "JUS-4"]);
    await expect(t.rpc("reorderBefore", { itemId: await id("JUS-1"), beforeId: null })).rejects.toThrow(/cannot be reordered/);
  });

  it("marks a ticket as working while its thread is in a turn", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    expect((await t.item("JUS-1")).working).toBe(true);
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Paused." });
    expect((await t.item("JUS-1")).working).toBe(false);
    await t.emit("thread.active", "th_1");
    expect((await t.item("JUS-1")).working).toBe(true);
  });

  it("lets the founder reorder the tickets waiting in a lane, and never the one in flight", async () => {
    for (const key of ["JUS-1", "JUS-2", "JUS-3", "JUS-4"]) await t.enqueue(key, "Coach", "small-bug");
    const order = async () =>
      (await t.state()).items.filter((item) => item.lane === "Coach").map((item) => item.key);
    const reorder = async (key: string, direction: "up" | "down") =>
      t.rpc("reorder", { itemId: (await t.item(key)).id, direction });

    await reorder("JUS-4", "up");
    expect(await order()).toEqual(["JUS-1", "JUS-2", "JUS-4", "JUS-3"]);
    await reorder("JUS-4", "up");
    expect(await order()).toEqual(["JUS-1", "JUS-4", "JUS-2", "JUS-3"]);
    // Already first among the waiting tickets: nothing moves, and it cannot pass the one in flight.
    await reorder("JUS-4", "up");
    expect(await order()).toEqual(["JUS-1", "JUS-4", "JUS-2", "JUS-3"]);
    await expect(reorder("JUS-1", "down")).rejects.toThrow(/has started/);

    // The new order is what runs next, and a schedule sync does not undo it.
    await t.harness.behavior.runCli(["sync", JSON.stringify({ lanes: [{ name: "Coach", items: ["JUS-2", "JUS-3", "JUS-4"].map((key) => ({ key, title: key, pipeline: "small-bug" })) }] })], { projectId: PROJECT });
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Fixed." });
    expect((await t.item("JUS-4")).status).toBe("running");
    expect(await order()).toEqual(["JUS-1", "JUS-4", "JUS-2", "JUS-3"]);
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
    expect(review.title).toBe("JUS-1 · Plan review");
    expect(review.environment).toEqual({ type: "reuse", environmentId: "env_th_1" });
    expect(review).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
    expect(review.prompt).toContain("Use the `review-plan` skill");
    expect(review.prompt).toContain("Plan is at Plans/JUS-1.md.");
    expect(review.prompt).toContain("factory_stage_done");

    await t.tool("factory_stage_done", "th_2", { outcome: "complete", summary: "Plan reviewed; two corrections landed." });
    expect(t.spawned[2]).toMatchObject({ title: "JUS-1 · Execution", providerId: "codex", model: "gpt-terra" });
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

    expect(t.spawned.at(-1)).toMatchObject({ id: "th_3", title: "JUS-1 · Code review" });
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
    expect(t.spawned.at(-1)!.title).toBe("JUS-1 · Execution");
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

describe("builder and plan reviewer go back and forth without the founder", () => {
  const start = async () => {
    await t.enqueue("JUS-1", "Coach", "planned");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Plan reviewed." });
    expect(t.spawned.at(-1)).toMatchObject({ id: "th_2", title: "JUS-1 · Execution" });
  };

  it("sends the builder's question to the thread that reviewed the plan, and resumes on its reply", async () => {
    await start();
    const asked = await t.tool("factory_ask_planner", "th_2", { question: "PLANNER INPUT REQUIRED: the replay contract cannot requalify." });
    expect(asked).toContain("planner");
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1", senderThreadId: "th_2" });
    expect(t.sent.at(-1)!.text).toContain("the replay contract cannot requalify");
    expect(t.sent.at(-1)!.text).toContain('to: "JUS-1:build"');
    expect((await t.item("JUS-1")).status).toBe("with-planner");
    expect((await t.state()).inbox).toEqual([]);

    // The builder ending its turn while it waits is not a stall.
    await t.emit("thread.idle", "th_2", { lastAssistantText: "Waiting on the planner." });
    expect(t.sent.at(-1)!.threadId).toBe("th_1");

    await t.tool("factory_message", "th_1", { to: "JUS-1:build", message: "Requalify against v5.12.0; plan updated." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_2", senderThreadId: "th_1" });
    expect((await t.item("JUS-1")).status).toBe("running");

    // Round two works the same way, and the build then finishes normally.
    await t.tool("factory_ask_planner", "th_2", { question: "One more: which fixture?" });
    await t.tool("factory_message", "th_1", { to: "JUS-1", message: "The hand-log one." });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", summary: "Built." });
    expect(t.spawned.at(-1)!.title).toBe("JUS-1 · Code review");
    expect((await t.state()).inbox).toEqual([]);
  });

  it("reminds a planner that goes quiet, then tells the founder", async () => {
    await start();
    await t.tool("factory_ask_planner", "th_2", { question: "Blocked on X." });
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Thinking." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("still waiting on you");
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Still thinking." });
    expect((await t.state()).inbox[0]).toMatchObject({ kind: "stalled", from: "Planner · JUS-1" });
  });

  it("asks whoever queued the ticket when no plan review ran here", async () => {
    const orchestrator = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    await t.tool("factory_enqueue", orchestrator.threadId, { key: "JUS-9", title: "Nine", lane: "Coach", pipeline: "reviewed" });
    await t.tool("factory_ask_planner", "th_2", { question: "Blocked." });
    expect(t.sent.at(-1)!.threadId).toBe(orchestrator.threadId);
  });

  it("offers the tool to every stage thread", async () => {
    const config = await t.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { binding: { kind: "stage", itemId: "itm_1", stage: "build" } } } as never),
    );
    expect((config?.tools ?? []).map((tool: { name: string }) => tool.name)).toContain("factory_ask_planner");
  });
});

describe("founder inbox", () => {
  it("sends a stage's founder question to the chief of staff first, who can settle it without the founder", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    const reply = await t.tool("factory_ask_founder", "th_1", {
      question: "May I raise the QA call budget from 10 to 20?",
      context: "The replay needs 20 calls.",
    });
    expect(reply).toContain("chief of staff");

    // The chief of staff is started on demand and receives the whole question.
    expect(t.spawned.at(-1)).toMatchObject({ id: "th_2", title: "Chief of staff", pinned: true });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_2", senderThreadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("raise the QA call budget");
    expect(t.sent.at(-1)!.text).toContain('"JUS-1:build"');
    expect((await t.state()).inbox).toEqual([]);
    expect((await t.item("JUS-1")).status).toBe("triage");

    // Waiting on the chief of staff is not a stall.
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Waiting." });
    expect(t.sent.at(-1)!.threadId).toBe("th_2");

    await t.tool("factory_message", "th_2", { to: "JUS-1:build", message: "Yes, 20 calls. Record it in the plan." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1" });
    expect((await t.item("JUS-1")).status).toBe("running");
    expect((await t.state()).inbox).toEqual([]);
  });

  it("lets the chief of staff put one clear question to the founder, whose answer goes to the ticket's thread", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.tool("factory_ask_founder", "th_1", { question: "Rest day or missed?", context: "long agent text" });
    await t.tool("factory_ask_founder", "th_2", {
      about: "JUS-1:build",
      question: "Should a skipped run count as a rest day?",
      context: "Du skipped Tuesday; today Coach counts it as rest.",
      options: ["Count it as rest", "Count it as missed"],
      recommendation: "Count it as missed.",
    });
    const before = await t.state();
    expect(before.inbox).toHaveLength(1);
    expect(before.inbox[0]).toMatchObject({ kind: "question", from: "Execution · JUS-1", threadId: "th_1", question: "Should a skipped run count as a rest day?" });
    expect((await t.item("JUS-1")).status).toBe("needs-founder");

    await t.rpc("answer", { entryId: before.inbox[0]!.id, answer: "Count it as missed." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("Count it as missed.");
    expect((await t.state()).inbox).toHaveLength(0);
    expect((await t.item("JUS-1")).status).toBe("running");
  });

  it("reminds a chief of staff that goes quiet, then tells the founder", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "blocked", summary: "Dev database is down." });
    expect(t.sent.at(-1)!.text).toContain("Dev database is down.");
    await t.emit("thread.idle", "th_2", { lastAssistantText: "Hm." });
    expect(t.sent.at(-1)!.text).toContain("still waiting on you");
    await t.emit("thread.idle", "th_2", { lastAssistantText: "Hm." });
    expect((await t.state()).inbox[0]).toMatchObject({ kind: "stalled", from: "Chief of staff · JUS-1" });
  });

  it("lets a standing agent ask the founder directly", async () => {
    const planner = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    await t.tool("factory_ask_founder", planner.threadId, { question: "Create a ticket for the new error class?" });
    expect((await t.state()).inbox[0]).toMatchObject({ kind: "question", from: "Planner / strategist" });
  });

  it("does not remind a thread that is waiting on its own background work", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    const waiting = (extra: object) =>
      t.harness.behavior
        .emitThreadEvent("thread.idle", { thread: { ...makeThreadResponse({ id: "th_1", projectId: PROJECT }), ...extra }, lastAssistantText: "Local CI is still running." } as never)
        .then(() => new Promise((resolve) => setTimeout(resolve, 20)));
    await waiting({ activeBackgroundCommandCount: 1 });
    await waiting({ activeBackgroundAgentCount: 1 });
    expect(t.sent).toEqual([]);
    expect((await t.item("JUS-1")).status).toBe("running");
    // With nothing running in the background, the usual reminder applies.
    await waiting({});
    expect(t.sent).toHaveLength(1);
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

  it("clears a stall notice when a stalled agent then asks for a decision", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Hm." });
    await t.emit("thread.idle", "th_1", { lastAssistantText: "Hm." });
    expect((await t.item("JUS-1")).status).toBe("stalled");

    await t.tool("factory_ask_founder", "th_1", { question: "Which unit?" });
    expect((await t.state()).inbox).toEqual([]);
    expect((await t.item("JUS-1")).status).toBe("triage");
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
    expect(t.spawned[0]!.title).toBe("JUS-1");
    expect((await t.item("JUS-1")).status).toBe("running");
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
    expect(result).toContain("Delivered to Planner / strategist");
    expect(t.spawned.map((thread) => thread.title)).toEqual(["Watch", "Planner / strategist"]);
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_2", senderThreadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("Message from Watch");
  });

  it("delivers messages between a worker and the orchestrator", async () => {
    const orchestrator = await t.rpc<{ threadId: string }>("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.tool("factory_message", "th_2", { to: "orchestrator", message: "Plan and code disagree on units." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: orchestrator.threadId, senderThreadId: "th_2" });
    expect(t.sent.at(-1)!.text).toContain("Message from Execution for JUS-1");

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
    expect(names(worker?.tools)).toEqual(["factory_stage_done", "factory_ask_founder", "factory_ask_planner", "factory_message"]);

    const orchestrator = await configure({ binding: { kind: "agent", agentId: "orchestrator", projectId: PROJECT } });
    expect(names(orchestrator?.tools)).toContain("factory_enqueue");
    expect(JSON.stringify(orchestrator?.skills)).toContain("factory-orchestrator");
  });
});

describe("the founder tries a visible change before it ships", () => {
  const CHECK = {
    before: "Checking off a set took two taps.",
    why: "Athletes mid-lift want one tap.",
    now: "One tap checks a set off.",
    account: "demo+strength@example.com / lift-1234",
    steps: ["Open today's strength session.", "Tap the first set: it shows a check."],
  };
  const RENDERED = [
    "**Before:** Checking off a set took two taps.",
    "**Why:** Athletes mid-lift want one tap.",
    "**Now:** One tap checks a set off.",
    "**Needs your review**",
    "Test account: demo+strength@example.com / lift-1234",
    "**Steps to test**\n- Open today's strength session.\n- Tap the first set: it shows a check.",
  ].join("\n\n");
  const toGate = async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", summary: "Review complete.", founder_check: CHECK });
  };

  it("holds before ship with the check in the inbox, and ships when he approves", async () => {
    await toGate();
    expect(t.spawned).toHaveLength(2);
    const { inbox } = await t.state();
    expect(inbox[0]).toMatchObject({ kind: "check", from: "Founder testing · JUS-1", context: RENDERED });
    expect((await t.item("JUS-1")).status).toBe("needs-founder");

    await t.rpc("approve", { entryId: inbox[0]!.id });
    expect(t.spawned.at(-1)!.title).toBe("JUS-1 · Ship");
    expect((await t.state()).inbox).toEqual([]);
  });

  it("sends his notes to the builder, and asks him again after the fix", async () => {
    await toGate();
    const first = (await t.state()).inbox[0]!;
    await t.rpc("answer", { entryId: first.id, answer: "The check mark is too small." });
    expect(t.sent.at(-1)).toMatchObject({ threadId: "th_1" });
    expect(t.sent.at(-1)!.text).toContain("The check mark is too small.");
    expect((await t.item("JUS-1")).status).toBe("running");

    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Bigger check mark.", founder_check: { ...CHECK, now: "One tap checks a set off, with a 24pt mark." } });
    // No second code review, and still no ship until he has tried it again.
    expect(t.spawned).toHaveLength(2);
    expect((await t.state()).inbox[0]).toMatchObject({ kind: "check" });
    expect((await t.state()).inbox[0]!.context).toContain("with a 24pt mark.");
  });

  it("ships straight through when no stage recorded a check", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", summary: "Review complete." });
    expect(t.spawned.at(-1)!.title).toBe("JUS-1 · Ship");
  });

  it("keeps a merged ticket under Done until the founder archives its workspace, and never archives for him", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Built." });
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", summary: "Reviewed." });
    await t.tool("factory_stage_done", "th_3", { outcome: "complete", summary: "Merged." });
    expect(t.archived).toEqual([]);
    expect((await t.item("JUS-1")).status).toBe("done");

    await t.emit("thread.archived", "th_1");
    await t.emit("thread.archived", "th_2");
    expect((await t.item("JUS-1")).status).toBe("done");
    await t.emit("thread.archived", "th_3");
    expect((await t.item("JUS-1")).status).toBe("archived");
    expect((await t.state()).inbox).toEqual([]);
  });

  it("shows a ticket parked for later in its lane and never starts it", async () => {
    const sync = (items: unknown[]) =>
      t.harness.behavior.runCli(["sync", JSON.stringify({ lanes: [{ name: "Coach", items }] })], { projectId: PROJECT });
    await sync([
      { key: "JUS-1", title: "Parked", pipeline: "planned", parked: true },
      { key: "JUS-2", title: "Ready", pipeline: "small-bug" },
    ]);
    // The parked ticket does not hold the lane up.
    expect(await t.item("JUS-1")).toMatchObject({ status: "queued", parked: true });
    expect((await t.item("JUS-2")).status).toBe("running");
    await t.tool("factory_stage_done", "th_1", { outcome: "complete", summary: "Fixed." });
    expect(t.spawned).toHaveLength(1);

    // The founder removes the Later label: the next schedule starts it.
    await sync([{ key: "JUS-1", title: "Parked", pipeline: "reviewed" }]);
    expect(t.spawned.at(-1)!.title).toBe("JUS-1");
    expect(await t.item("JUS-1")).toMatchObject({ status: "running", parked: false, pipeline: "reviewed" });
  });
});

describe("builder tiers", () => {
  it("builds a ticket on the model set for its plan's tier, and tier 1 or no tier on the base builder", async () => {
    const { config } = await t.state();
    await t.rpc("saveConfig", {
      projectId: PROJECT,
      config: {
        ...config,
        roles: {
          ...config.roles,
          build: { ...config.roles.build, providerId: "codex", model: "gpt-sol" },
          "build-tier-2": { ...config.roles["build-tier-2"], providerId: "claude-code", model: "claude-opus-5-5" },
          "build-tier-3": { ...config.roles["build-tier-3"], providerId: "claude-code", model: "claude-fable-5-2" },
        },
      },
    });
    const sync = JSON.stringify({
      lanes: [
        { name: "A", items: [{ key: "JUS-1", title: "One", pipeline: "reviewed", tier: 1 }] },
        { name: "B", items: [{ key: "JUS-2", title: "Two", pipeline: "reviewed", tier: 2 }] },
        { name: "C", items: [{ key: "JUS-3", title: "Three", pipeline: "reviewed", tier: 3 }] },
        { name: "D", items: [{ key: "JUS-4", title: "Four", pipeline: "reviewed" }] },
      ],
    });
    await t.harness.behavior.runCli(["sync", sync], { projectId: PROJECT });
    expect(t.spawned.map((thread) => `${thread.title} ${thread.model}`)).toEqual([
      "JUS-1 gpt-sol",
      "JUS-2 claude-opus-5-5",
      "JUS-3 claude-fable-5-2",
      "JUS-4 gpt-sol",
    ]);
    // The tier chooses the builder only; the reviewer is the same for all.
    await t.tool("factory_stage_done", "th_3", { outcome: "complete", summary: "Built." });
    expect(t.spawned.at(-1)).not.toHaveProperty("model");
  });
});

describe("falling back when a model's limit runs out", () => {
  const limit = (threadId: string, resetsAtMs: number | null = Date.now() + 3_600_000) =>
    t.harness.behavior
      .emitThreadEvent("turn.failed", makeTurnFailedEvent({
        threadId,
        errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null },
        rateLimits: resetsAtMs === null ? null : ({ windows: [{ resetsAtMs }] } as never),
      } as never) as never)
      .then(() => new Promise((resolve) => setTimeout(resolve, 20)));
  const withFallback = async () => {
    const { config } = await t.state();
    await t.rpc("saveConfig", {
      projectId: PROJECT,
      config: {
        ...config,
        roles: {
          ...config.roles,
          build: { ...config.roles.build, providerId: "claude-code", model: "claude-fable-5-2", reasoningLevel: "medium", fallbackModel: "claude-opus-5-5" },
        },
      },
    });
  };

  it("moves the thread to the fallback model and reruns the turn, without bothering the founder", async () => {
    await withFallback();
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await limit("th_1");
    await t.emit("thread.failed", "th_1", { error: "usage limit reached" });
    expect(t.updated).toEqual([{ threadId: "th_1", model: "claude-opus-5-5", reasoningLevel: "medium" }]);
    expect(t.retried).toEqual(["th_1"]);

    // The rerun starts: the ticket is running again and the failure leaves the inbox.
    await t.emit("thread.active", "th_1");
    expect((await t.item("JUS-1")).status).toBe("running");
    expect((await t.state()).inbox).toEqual([]);
  });

  it("starts that role's new threads on the fallback until the limit resets", async () => {
    await withFallback();
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await limit("th_1", Date.now() + 3_600_000);
    await t.enqueue("JUS-2", "Plan", "reviewed");
    expect(t.spawned.at(-1)).toMatchObject({ title: "JUS-2", model: "claude-opus-5-5" });
  });

  it("switches a thread once: a limit on the fallback too goes to the founder", async () => {
    await withFallback();
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await limit("th_1");
    await limit("th_1");
    expect(t.updated).toHaveLength(1);
    await t.emit("thread.failed", "th_1", { error: "usage limit reached" });
    expect((await t.state()).inbox[0]).toMatchObject({ kind: "failed" });
  });

  it("hands a stage to a new thread on another provider, in the same worktree, with a handover", async () => {
    const { config } = await t.state();
    await t.rpc("saveConfig", {
      projectId: PROJECT,
      config: {
        ...config,
        roles: {
          ...config.roles,
          build: { ...config.roles.build, providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", fallbackProviderId: "codex", fallbackModel: "gpt-sol" },
        },
      },
    });
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await t.emit("thread.failed", "th_1", { error: "usage limit reached" });
    await limit("th_1");

    // A thread cannot change provider: nothing is switched in place.
    expect(t.updated).toEqual([]);
    expect(t.retried).toEqual([]);
    const replacement = t.spawned.at(-1)!;
    expect(replacement).toMatchObject({ id: "th_2", title: "JUS-1 · Execution", providerId: "codex", model: "gpt-sol" });
    expect(replacement).not.toHaveProperty("reasoningLevel");
    expect(replacement.environment).toEqual({ type: "reuse", environmentId: "env_th_1" });
    expect(replacement.prompt).toContain("bb thread log th_1");
    expect(replacement.prompt).toContain("do not redo finished work");
    expect((await t.item("JUS-1")).status).toBe("running");
    expect((await t.state()).inbox).toEqual([]);

    // The new thread reports for the stage; the old one no longer can.
    await t.tool("factory_stage_done", "th_2", { outcome: "complete", summary: "Built." });
    expect(t.spawned.at(-1)!.title).toBe("JUS-1 · Code review");
    // A limit on the fallback as well goes to the founder, not back and forth.
    await t.enqueue("JUS-2", "Plan", "reviewed");
    expect(t.spawned.at(-1)).toMatchObject({ title: "JUS-2", providerId: "codex" });
  });

  it("moves a standing agent to a new thread on another provider when its limit runs out", async () => {
    const { config } = await t.state();
    await t.rpc("saveConfig", {
      projectId: PROJECT,
      config: {
        ...config,
        roles: {
          ...config.roles,
          orchestrator: { ...config.roles.orchestrator, providerId: "claude-code", model: "claude-opus-5-5", fallbackProviderId: "codex", fallbackModel: "gpt-sol" },
        },
      },
    });
    await t.rpc("startAgent", { projectId: PROJECT, agentId: "orchestrator" });
    await limit("th_1");
    expect(t.spawned.at(-1)).toMatchObject({ id: "th_2", title: "Planner / strategist", providerId: "codex", model: "gpt-sol", pinned: true });
    expect(t.spawned.at(-1)!.prompt).toContain("bb thread log th_1");
    expect((await t.state()).agents.find((agent) => agent.agentId === "orchestrator")!.threadId).toBe("th_2");
  });

  it("leaves a role with no fallback alone", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    await limit("th_1");
    expect(t.updated).toEqual([]);
    expect(t.retried).toEqual([]);
  });
});

describe("configuration and CLI", () => {
  it("gives a configuration saved before builder tiers existed tier 2 and 3 builders copied from its builder", async () => {
    const { config } = await t.state();
    const { "build-tier-2": _two, "build-tier-3": _three, ...roles } = config.roles;
    const old = {
      ...config,
      roles: { ...roles, build: { ...roles.build, label: "Builder", providerId: "codex", model: "gpt-sol", reasoningLevel: "medium" } },
      stages: { ...config.stages, build: { ...config.stages.build, tierRoles: {} } },
    };
    await t.rpc("saveConfig", { projectId: PROJECT, config: old });
    const upgraded = (await t.state()).config;
    expect(upgraded.roles.build.label).toBe("Builder, tier 1");
    expect(upgraded.roles["build-tier-3"]).toMatchObject({ label: "Builder, tier 3", providerId: "codex", model: "gpt-sol", reasoningLevel: "medium" });
    expect(upgraded.stages.build.tierRoles).toEqual({ "2": "build-tier-2", "3": "build-tier-3" });
  });

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
    expect(status.stdout).toContain("JUS-1  running  Execution  — Rest days");
    expect(status.stdout).toContain("JUS-2  queued");
    expect(status.stdout).toContain("JUS-3  running  Fix");
  });

  it("syncs lanes to a schedule without reordering a lane or touching started work", async () => {
    const sync = (lanes: unknown) =>
      t.harness.behavior.runCli(["sync", JSON.stringify({ lanes })], { projectId: PROJECT });
    await sync([
      { name: "Lane 1", items: [{ key: "JUS-1", title: "One", pipeline: "reviewed" }, { key: "JUS-2", title: "Two" }, { key: "JUS-3", title: "Three" }] },
      { name: "Lane 2", items: [{ key: "JUS-4", title: "Four", pipeline: "reviewed" }] },
    ]);
    expect((await t.item("JUS-1")).status).toBe("running");
    expect((await t.item("JUS-2")).status).toBe("queued");

    // The founder puts JUS-3 ahead of JUS-2 inside the lane.
    await t.rpc("move", { itemId: (await t.item("JUS-3")).id, lane: "Lane 1", position: 2 });

    // Next schedule: JUS-5 is new, JUS-2 left the board, JUS-4 changed lanes,
    // and the running JUS-1 is no longer listed.
    const second = await sync([
      { name: "Lane 1", items: [{ key: "JUS-3", title: "Three" }, { key: "JUS-5", title: "Five" }, { key: "JUS-4", title: "Four" }] },
    ]);
    expect(second.stdout).toContain('JUS-5: queued in "Lane 1"');
    expect(second.stdout).toContain("JUS-2: removed");
    expect(second.stdout).toContain('JUS-4: moved from "Lane 2" to "Lane 1"');
    expect((await t.item("JUS-1")).status).toBe("running");
    expect((await t.item("JUS-4")).status).toBe("running");
    const lane = (await t.state()).items
      .filter((item) => item.lane === "Lane 1" && item.status !== "cancelled")
      .map((item) => item.key);
    expect(lane).toEqual(["JUS-1", "JUS-3", "JUS-5", "JUS-4"]);

    // Running the same schedule again changes nothing.
    expect((await sync([{ name: "Lane 1", items: [{ key: "JUS-3", title: "Three" }, { key: "JUS-5", title: "Five" }, { key: "JUS-4", title: "Four" }] }])).stdout).toBe("Lanes already match.");
    expect(t.spawned).toHaveLength(2);
  });

  it("keeps tickets and configuration across a plugin reload", async () => {
    await t.enqueue("JUS-1", "Coach", "reviewed");
    const reloaded = await t.harness.lifecycle.reload(plugin);
    t.harness = reloaded.harness;
    const state = (await reloaded.harness.behavior.callRpc("state", { projectId: PROJECT })) as FactoryState;
    expect(state.items.map((item) => `${item.key} ${item.status}`)).toEqual(["JUS-1 running"]);
  });
});
