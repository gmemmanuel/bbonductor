// The factory's state machine. It decides what runs next and who hears about
// it; everything that touches bb goes through `Effects`, so the rules here are
// tested without a server.
//
// Rules, in one place:
//   - A lane works one ticket at a time, in order. Lanes exist to keep work
//     that would collide (shared files, shared dev deploys) in sequence.
//   - At most `maxActiveItems` tickets are in flight across all lanes.
//   - Every stage runs in a fresh thread in the ticket's own worktree, on the
//     model its role names. A review is therefore always an independent
//     context from the work it reviews.
//   - A review that asks for changes sends them to the author's existing
//     thread. When the author finishes, the ticket moves past that review:
//     one review pass is the design, a second has to be asked for.
//   - Agents never wait on the founder silently. A question lands in the
//     inbox, and the answer is delivered to the thread that asked.
import {
  fillTemplate,
  type AgentState,
  type Config,
  type InboxEntry,
  type InboxKind,
  type Item,
  type Role,
  type ThreadBinding,
} from "./model.js";
import { newId, type FactoryStore } from "./store.js";

export type SpawnTarget =
  | { type: "new-worktree" }
  | { type: "reuse"; environmentId: string }
  | { type: "main-checkout" };

export interface SpawnRequest {
  projectId: string;
  target: SpawnTarget;
  title: string;
  prompt: string;
  role: Role;
  binding: ThreadBinding;
  pinned: boolean;
}

export interface Effects {
  spawn(request: SpawnRequest): Promise<{ threadId: string; environmentId: string | null }>;
  send(threadId: string, text: string, senderThreadId?: string): Promise<void>;
  retry(threadId: string): Promise<void>;
  /** The worktree a thread runs in; null until bb has provisioned it. */
  environmentOf(threadId: string): Promise<string | null>;
  /** Unpin a standing agent's thread once a fresh one replaces it. Must not throw. */
  unpin(threadId: string): void;
  /** True while bb still shows an unanswered question or approval on the thread. */
  hasPendingInteraction(threadId: string): Promise<boolean>;
  /** Best-effort push notification. Must not throw. */
  notify(title: string, body: string, threadId: string): void;
  /** Tell open pages to refetch. Must not throw. */
  changed(): void;
  log(message: string): void;
}

const ACTIVE = new Set<Item["status"]>([
  "running",
  "needs-founder",
  "returned",
  "stalled",
  "failed",
]);
const CLOSED = new Set<Item["status"]>(["done", "cancelled"]);

export class FactoryError extends Error {}

export interface EnqueueInput {
  projectId: string;
  key: string;
  title: string;
  brief?: string;
  lane?: string;
  pipeline?: string;
  originThreadId?: string | null;
}

export interface StageDoneInput {
  outcome: "complete" | "changes_requested" | "blocked";
  summary: string;
  /** Author asks for the review to run again after their fixes. */
  rereview?: boolean;
}

export interface AskInput {
  question: string;
  context?: string;
  options?: string[];
  recommendation?: string;
}

export class FactoryEngine {
  /** Serialises mutations so two events cannot both start the same ticket. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: FactoryStore,
    private readonly effects: Effects,
  ) {}

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- tickets

  enqueue(input: EnqueueInput): Promise<Item> {
    return this.exclusive(async () => {
      const config = this.store.getConfig(input.projectId);
      const pipeline = input.pipeline ?? config.defaultPipeline;
      if (config.pipelines[pipeline] === undefined) {
        throw new FactoryError(
          `Unknown pipeline "${pipeline}". Known: ${Object.keys(config.pipelines).join(", ")}.`,
        );
      }
      const key = input.key.trim();
      const existing = this.store.findItemByKey(input.projectId, key);
      if (existing !== null && !CLOSED.has(existing.status)) {
        throw new FactoryError(
          `${key} is already in the factory (${existing.status}, lane "${existing.lane}").`,
        );
      }
      const lane = (input.lane ?? "").trim() || "Lane 1";
      const siblings = this.store
        .listItems(input.projectId)
        .filter((item) => item.lane === lane);
      const now = Date.now();
      const item = this.store.saveItem({
        id: newId("itm"),
        projectId: input.projectId,
        key,
        title: input.title.trim(),
        brief: (input.brief ?? "").trim(),
        lane,
        position: siblings.reduce((max, s) => Math.max(max, s.position), 0) + 1,
        pipeline,
        stageIndex: 0,
        status: "queued",
        environmentId: null,
        threads: {},
        passedReviews: [],
        lastSummary: "",
        originThreadId: input.originThreadId ?? null,
        nudged: false,
        createdAt: now,
        updatedAt: now,
      });
      await this.scheduleLocked(input.projectId);
      this.effects.changed();
      return this.store.getItem(item.id) ?? item;
    });
  }

  /** Move a ticket to another lane and/or slot. Running work is not interrupted. */
  move(itemId: string, lane: string, position?: number): Promise<Item> {
    return this.exclusive(async () => {
      const item = this.requireItem(itemId);
      const targetLane = lane.trim() || item.lane;
      const others = this.store
        .listItems(item.projectId)
        .filter((other) => other.lane === targetLane && other.id !== item.id);
      const slot = Math.min(Math.max(position ?? others.length + 1, 1), others.length + 1);
      others.splice(slot - 1, 0, { ...item, lane: targetLane });
      others.forEach((other, index) =>
        this.store.saveItem({ ...other, position: index + 1 }),
      );
      await this.scheduleLocked(item.projectId);
      this.effects.changed();
      return this.requireItem(itemId);
    });
  }

  cancel(itemId: string): Promise<Item> {
    return this.exclusive(async () => {
      const item = this.requireItem(itemId);
      const saved = this.store.saveItem({ ...item, status: "cancelled" });
      this.closeEntriesFor(item.id);
      await this.scheduleLocked(item.projectId);
      this.effects.changed();
      return saved;
    });
  }

  /** Skip the current stage (or leave a `returned` hold) and carry on. */
  advance(itemId: string, summary?: string): Promise<Item> {
    return this.exclusive(async () => {
      const item = this.requireItem(itemId);
      if (CLOSED.has(item.status) || item.status === "queued") {
        throw new FactoryError(`${item.key} is ${item.status}; there is no stage to advance.`);
      }
      this.closeEntriesFor(item.id);
      const result = await this.forward(
        { ...item, lastSummary: summary?.trim() || item.lastSummary },
        false,
      );
      this.effects.changed();
      return result;
    });
  }

  /** Start whatever the lanes and the capacity limit now allow. */
  schedule(projectId: string): Promise<void> {
    return this.exclusive(async () => {
      await this.scheduleLocked(projectId);
      this.effects.changed();
    });
  }

  private async scheduleLocked(projectId: string): Promise<void> {
    const config = this.store.getConfig(projectId);
    const items = this.store.listItems(projectId);
    let active = items.filter((item) => ACTIVE.has(item.status)).length;
    const lanes = [...new Set(items.map((item) => item.lane))];
    for (const lane of lanes) {
      if (active >= config.maxActiveItems) return;
      const head = items.find((item) => item.lane === lane && !CLOSED.has(item.status));
      if (head === undefined || head.status !== "queued") continue;
      await this.runStage(head, config);
      active += 1;
    }
  }

  // ----------------------------------------------------------------- stages

  private async runStage(item: Item, config: Config): Promise<Item> {
    const stageId = config.pipelines[item.pipeline]?.[item.stageIndex];
    const stage = stageId === undefined ? undefined : config.stages[stageId];
    const role = stage === undefined ? undefined : config.roles[stage.role];
    if (stageId === undefined || stage === undefined || role === undefined) {
      return this.fail(item, `Stage ${item.stageIndex} of pipeline "${item.pipeline}" is not configured.`, null);
    }
    const prompt = [
      fillTemplate(stage.prompt, {
        key: item.key,
        title: item.title,
        brief: item.brief,
        lane: item.lane,
        previous:
          item.lastSummary === ""
            ? ""
            : `Handoff from the previous stage:\n${item.lastSummary}`,
      }).trim(),
      stageProtocol(item, stage.label, stage.review),
    ].join("\n\n");
    try {
      // bb assigns a worktree after the first thread is created, so the
      // ticket's worktree is read back from its earlier threads when needed.
      let workspace = item.environmentId;
      for (const earlier of Object.values(item.threads).reverse()) {
        if (workspace !== null) break;
        workspace = await this.effects.environmentOf(earlier).catch(() => null);
      }
      const { threadId, environmentId } = await this.effects.spawn({
        projectId: item.projectId,
        target:
          workspace === null
            ? { type: "new-worktree" }
            : { type: "reuse", environmentId: workspace },
        title: `${item.key} · ${stage.label}`,
        prompt,
        role,
        binding: { kind: "stage", itemId: item.id, stage: stageId },
        pinned: false,
      });
      this.store.bindThread({
        threadId,
        itemId: item.id,
        stage: stageId,
        agentId: null,
        projectId: item.projectId,
      });
      return this.store.saveItem({
        ...item,
        status: "running",
        nudged: false,
        environmentId: workspace ?? environmentId,
        threads: { ...item.threads, [stageId]: threadId },
      });
    } catch (error) {
      return this.fail(item, `Could not start ${stage.label}: ${messageOf(error)}`, null);
    }
  }

  /** Move to the next stage that still has to run, or finish the ticket. */
  private async forward(item: Item, rereview: boolean): Promise<Item> {
    const config = this.store.getConfig(item.projectId);
    const stages = config.pipelines[item.pipeline] ?? [];
    let index = item.stageIndex + 1;
    let passed = item.passedReviews;
    while (index < stages.length) {
      const id = stages[index]!;
      if (!passed.includes(id)) break;
      if (rereview) {
        passed = passed.filter((review) => review !== id);
        break;
      }
      index += 1;
    }
    if (index >= stages.length) {
      const done = this.store.saveItem({ ...item, status: "done", stageIndex: stages.length });
      this.effects.log(`${item.key} finished its pipeline.`);
      await this.scheduleLocked(item.projectId);
      return done;
    }
    return this.runStage({ ...item, stageIndex: index, passedReviews: passed }, config);
  }

  stageDone(threadId: string, input: StageDoneInput): Promise<string> {
    return this.exclusive(async () => {
      const { item, stageId } = this.requireCurrentStage(threadId);
      const config = this.store.getConfig(item.projectId);
      const stage = config.stages[stageId];
      const summary = input.summary.trim();
      this.closeEntriesFor(item.id);

      if (input.outcome === "blocked") {
        this.store.saveItem({ ...item, status: "needs-founder", lastSummary: summary });
        this.openEntry({
          item,
          threadId,
          kind: "blocked",
          from: `${stage?.label ?? stageId} · ${item.key}`,
          question: `${stage?.label ?? stageId} for ${item.key} is blocked.`,
          context: summary,
        });
        this.effects.changed();
        return "Recorded as blocked. The founder has been asked; their answer will arrive in this thread. End your turn.";
      }

      if (input.outcome === "changes_requested") {
        if (stage?.review !== true) {
          throw new FactoryError(
            `"${stageId}" is not a review stage, so it cannot request changes. Use outcome "complete" or "blocked".`,
          );
        }
        const passedReviews = [...new Set([...item.passedReviews, stageId])];
        const authorStage = config.pipelines[item.pipeline]?.[item.stageIndex - 1];
        const authorThread = authorStage === undefined ? undefined : item.threads[authorStage];
        const findings = `Review findings for ${item.key} from ${stage.label}:\n\n${summary}`;
        if (authorThread !== undefined) {
          this.store.saveItem({
            ...item,
            status: "running",
            nudged: false,
            stageIndex: item.stageIndex - 1,
            passedReviews,
            lastSummary: summary,
          });
          await this.effects.send(
            authorThread,
            `${findings}\n\nAddress these, then call factory_stage_done again. Pass rereview: true only if your changes raise a new product or scope decision.`,
            threadId,
          );
          this.effects.changed();
          return "Findings sent to the author's thread. Your review is recorded. End your turn.";
        }
        // No author stage in this pipeline: the ticket was queued already
        // authored (for example, planned by the orchestrator).
        this.store.saveItem({ ...item, status: "returned", passedReviews, lastSummary: summary });
        if (item.originThreadId !== null) {
          await this.effects.send(
            item.originThreadId,
            `${findings}\n\nWhen the findings are addressed, run \`bb factory advance ${item.key}\` to send the ticket on.`,
            threadId,
          );
        } else {
          this.openEntry({
            item,
            threadId,
            kind: "blocked",
            from: `${stage.label} · ${item.key}`,
            question: `${stage.label} returned changes for ${item.key}, and no thread owns the fixes.`,
            context: summary,
          });
        }
        this.effects.changed();
        return "Findings returned to the ticket's author. Your review is recorded. End your turn.";
      }

      const passedReviews =
        stage?.review === true
          ? [...new Set([...item.passedReviews, stageId])]
          : item.passedReviews;
      const next = await this.forward(
        { ...item, lastSummary: summary, passedReviews },
        input.rereview === true,
      );
      this.effects.changed();
      return next.status === "done"
        ? `${item.key} is done. End your turn.`
        : "Recorded. The next stage has started in its own thread. End your turn.";
    });
  }

  // ------------------------------------------------------------------ inbox

  ask(threadId: string, input: AskInput): Promise<InboxEntry> {
    return this.exclusive(async () => {
      const binding = this.store.getBinding(threadId);
      if (binding === null) {
        throw new FactoryError("This thread is not part of the factory.");
      }
      const item = binding.itemId === null ? null : this.store.getItem(binding.itemId);
      const config = this.store.getConfig(binding.projectId);
      const from =
        item !== null && binding.stage !== null
          ? `${config.stages[binding.stage]?.label ?? binding.stage} · ${item.key}`
          : (config.agents[binding.agentId ?? ""]?.label ?? "Factory agent");
      if (item !== null && (item.status === "running" || item.status === "stalled")) {
        this.store.saveItem({ ...item, status: "needs-founder" });
      }
      // A real question replaces any "it went quiet" notice for the same thread.
      for (const stale of this.store.listInbox({ status: "open", threadId })) {
        if (stale.kind !== "stalled") continue;
        this.store.saveInbox({ ...stale, status: "dismissed", resolvedAt: Date.now() });
      }
      const entry = this.openEntry({
        item,
        threadId,
        projectId: binding.projectId,
        kind: "question",
        from,
        question: input.question,
        context: input.context ?? "",
        options: input.options ?? [],
        recommendation: input.recommendation ?? "",
      });
      this.effects.changed();
      return entry;
    });
  }

  answer(entryId: string, answer: string): Promise<InboxEntry> {
    return this.exclusive(async () => {
      const entry = this.requireOpenEntry(entryId);
      const text = answer.trim();
      if (text === "") throw new FactoryError("An answer cannot be empty.");
      await this.effects.send(
        entry.threadId,
        `Founder answer to "${entry.question}":\n\n${text}`,
      );
      const saved = this.store.saveInbox({
        ...entry,
        status: "answered",
        answer: text,
        resolvedAt: Date.now(),
      });
      this.resumeIfClear(entry.itemId);
      this.effects.changed();
      return saved;
    });
  }

  dismiss(entryId: string): Promise<InboxEntry> {
    return this.exclusive(async () => {
      const entry = this.requireOpenEntry(entryId);
      const saved = this.store.saveInbox({
        ...entry,
        status: "dismissed",
        resolvedAt: Date.now(),
      });
      this.effects.changed();
      return saved;
    });
  }

  /** Re-run the failed turn behind a `failed` entry. */
  retry(entryId: string): Promise<InboxEntry> {
    return this.exclusive(async () => {
      const entry = this.requireOpenEntry(entryId);
      const item = entry.itemId === null ? null : this.store.getItem(entry.itemId);
      if (item !== null && item.threads[currentStageId(this.store, item) ?? ""] === undefined) {
        // The stage never got a thread (spawn failed): start it again.
        await this.runStage(item, this.store.getConfig(item.projectId));
      } else {
        await this.effects.retry(entry.threadId);
        if (item !== null) this.store.saveItem({ ...item, status: "running", nudged: false });
      }
      const saved = this.store.saveInbox({
        ...entry,
        status: "answered",
        answer: "Retried.",
        resolvedAt: Date.now(),
      });
      this.effects.changed();
      return saved;
    });
  }

  /** Drop interaction entries the founder already answered inside the thread. */
  reconcileInteractions(): Promise<void> {
    return this.exclusive(async () => {
      let changed = false;
      for (const entry of this.store.listInbox({ status: "open" })) {
        if (entry.kind !== "interaction") continue;
        let pending = true;
        try {
          pending = await this.effects.hasPendingInteraction(entry.threadId);
        } catch {
          continue;
        }
        if (pending) continue;
        this.store.saveInbox({
          ...entry,
          status: "answered",
          answer: "Answered in the thread.",
          resolvedAt: Date.now(),
        });
        this.resumeIfClear(entry.itemId);
        changed = true;
      }
      if (changed) this.effects.changed();
    });
  }

  // ----------------------------------------------------------- thread events

  onInteraction(threadId: string, summary: string): Promise<void> {
    return this.exclusive(async () => {
      const binding = this.store.getBinding(threadId);
      if (binding === null) return;
      const open = this.store.listInbox({ status: "open", threadId });
      if (open.some((entry) => entry.kind === "interaction")) return;
      const item = binding.itemId === null ? null : this.store.getItem(binding.itemId);
      const config = this.store.getConfig(binding.projectId);
      const from =
        item !== null && binding.stage !== null
          ? `${config.stages[binding.stage]?.label ?? binding.stage} · ${item.key}`
          : (config.agents[binding.agentId ?? ""]?.label ?? "Factory agent");
      if (item !== null && item.status === "running") {
        this.store.saveItem({ ...item, status: "needs-founder" });
      }
      this.openEntry({
        item,
        threadId,
        projectId: binding.projectId,
        kind: "interaction",
        from,
        question: summary,
        context: "Answer this one in the thread itself.",
      });
      this.effects.changed();
    });
  }

  onIdle(threadId: string, lastAssistantText: string | null): Promise<void> {
    return this.exclusive(async () => {
      const current = this.currentStage(threadId);
      if (current === null || current.item.status !== "running") return;
      const { item, stageId } = current;
      if (this.store.listInbox({ status: "open", threadId }).length > 0) return;
      if (!item.nudged) {
        this.store.saveItem({ ...item, nudged: true });
        await this.effects.send(
          threadId,
          `You stopped without reporting ${item.key}'s ${stageId} stage to the factory. If the stage is finished, call factory_stage_done. If you need a founder decision, call factory_ask_founder. Otherwise continue the work.`,
        );
        return;
      }
      this.store.saveItem({ ...item, status: "stalled" });
      this.openEntry({
        item,
        threadId,
        kind: "stalled",
        from: `${this.store.getConfig(item.projectId).stages[stageId]?.label ?? stageId} · ${item.key}`,
        question: `${item.key} stopped twice without finishing its ${stageId} stage.`,
        context: (lastAssistantText ?? "").slice(0, 2000),
      });
      this.effects.changed();
    });
  }

  onActive(threadId: string): Promise<void> {
    return this.exclusive(async () => {
      const current = this.currentStage(threadId);
      if (current === null || current.item.status !== "stalled") return;
      // The founder (or another agent) got it moving again by hand.
      this.store.saveItem({ ...current.item, status: "running", nudged: false });
      for (const entry of this.store.listInbox({ status: "open", threadId })) {
        if (entry.kind !== "stalled") continue;
        this.store.saveInbox({
          ...entry,
          status: "answered",
          answer: "Thread resumed.",
          resolvedAt: Date.now(),
        });
      }
      this.effects.changed();
    });
  }

  onFailed(threadId: string, error: string | null): Promise<void> {
    return this.exclusive(async () => {
      const current = this.currentStage(threadId);
      if (current === null || CLOSED.has(current.item.status)) return;
      await this.fail(current.item, error ?? "The agent's turn failed.", threadId);
      this.effects.changed();
    });
  }

  /** A stage thread was archived or deleted out from under its ticket. */
  onGone(threadId: string): Promise<void> {
    return this.exclusive(async () => {
      const current = this.currentStage(threadId);
      if (current === null || !ACTIVE.has(current.item.status)) return;
      const { item, stageId } = current;
      const threads = { ...item.threads };
      delete threads[stageId];
      this.closeEntriesFor(item.id);
      const saved = this.store.saveItem({ ...item, status: "failed", threads });
      this.openEntry({
        item: saved,
        threadId,
        kind: "failed",
        from: `${stageId} · ${item.key}`,
        question: `The ${stageId} thread for ${item.key} was archived or deleted.`,
        context: "Retry starts the stage again in a new thread.",
      });
      this.effects.changed();
    });
  }

  // --------------------------------------------------------- standing agents

  /** Start (or return) the long-lived thread for a standing agent. */
  startAgent(projectId: string, agentId: string): Promise<AgentState> {
    return this.exclusive(async () => {
      const state = this.store.getAgent(projectId, agentId);
      if (state.threadId !== null) return state;
      const started = await this.spawnAgent(projectId, agentId, "");
      this.effects.changed();
      return started;
    });
  }

  /**
   * Replace an agent's thread with a fresh one. The old thread first writes
   * what it knows to its memory file; the new thread starts when it goes idle.
   */
  rotateAgent(projectId: string, agentId: string): Promise<AgentState> {
    return this.exclusive(async () => {
      const state = this.store.getAgent(projectId, agentId);
      if (state.threadId === null) {
        const started = await this.spawnAgent(projectId, agentId, "");
        this.effects.changed();
        return started;
      }
      const agent = this.requireAgentConfig(projectId, agentId);
      await this.effects.send(
        state.threadId,
        `You are about to be replaced by a fresh thread with an empty context. Bring ${agent.memoryPath} fully up to date now: current goals, open threads of work, decisions and their reasons, and what you would tell your successor first. Commit it if the project commits such files. Then end your turn.`,
      );
      const saved = this.store.saveAgent({ ...state, rotating: true });
      this.effects.changed();
      return saved;
    });
  }

  /**
   * Hand a standing agent a prompt, starting its thread first if it has none.
   * This is what scheduled automations call.
   */
  promptAgent(projectId: string, agentId: string, text: string): Promise<AgentState> {
    return this.exclusive(async () => {
      let state = this.store.getAgent(projectId, agentId);
      if (state.threadId === null) state = await this.spawnAgent(projectId, agentId, "");
      await this.effects.send(state.threadId!, text.trim());
      this.effects.changed();
      return state;
    });
  }

  /** Called when any agent thread goes idle; finishes a pending rotation. */
  onAgentIdle(threadId: string): Promise<void> {
    return this.exclusive(async () => {
      const binding = this.store.getBinding(threadId);
      if (binding === null || binding.agentId === null) return;
      const state = this.store.getAgent(binding.projectId, binding.agentId);
      if (state.threadId !== threadId || !state.rotating) return;
      await this.spawnAgent(
        binding.projectId,
        binding.agentId,
        "You are taking over from an earlier thread in this role. Its handoff is in your memory file.",
      );
      this.effects.changed();
    });
  }

  private async spawnAgent(projectId: string, agentId: string, preface: string): Promise<AgentState> {
    const config = this.store.getConfig(projectId);
    const agent = this.requireAgentConfig(projectId, agentId);
    const role = config.roles[agent.role];
    if (role === undefined) throw new FactoryError(`Role "${agent.role}" is not defined.`);
    const prompt = [
      preface,
      `You are the ${agent.label} for this project: a standing role, not a one-off task. Use the \`${agent.skill}\` skill now; it is your charter.`,
      `Your rolling memory is ${agent.memoryPath}. Read it first if it exists; create it if it does not. Keep it current as you work: it is the only thing that survives when this thread is replaced.`,
      `Then say in a few lines what you understand the current state to be, and wait.`,
    ]
      .filter((part) => part !== "")
      .join("\n\n");
    const { threadId } = await this.effects.spawn({
      projectId,
      target: { type: "main-checkout" },
      title: agent.label,
      prompt,
      role,
      binding: { kind: "agent", agentId, projectId },
      pinned: true,
    });
    this.store.bindThread({ threadId, itemId: null, stage: null, agentId, projectId });
    const previous = this.store.getAgent(projectId, agentId).threadId;
    if (previous !== null) this.effects.unpin(previous);
    return this.store.saveAgent({
      agentId,
      projectId,
      threadId,
      startedAt: Date.now(),
      rotating: false,
    });
  }

  private requireAgentConfig(projectId: string, agentId: string) {
    const agent = this.store.getConfig(projectId).agents[agentId];
    if (agent === undefined) throw new FactoryError(`No standing agent "${agentId}".`);
    return agent;
  }

  // -------------------------------------------------------------- messaging

  /**
   * Deliver a message between factory threads. `to` is a standing agent id
   * ("orchestrator"), a ticket key ("JUS-12", its current stage), or
   * "JUS-12:build" for a specific stage's thread.
   */
  message(projectId: string, fromThreadId: string | null, to: string, text: string): Promise<string> {
    return this.exclusive(async () => {
      // A standing agent that has not been started yet is started by its
      // first message, so a scheduled check can always reach the planner.
      const agentId = to.trim();
      if (
        this.store.getConfig(projectId).agents[agentId] !== undefined &&
        this.store.getAgent(projectId, agentId).threadId === null
      ) {
        await this.spawnAgent(projectId, agentId, "");
      }
      const target = this.resolveRecipient(projectId, to.trim());
      if (target.threadId === fromThreadId) {
        throw new FactoryError("That is this thread. Pick another recipient.");
      }
      const sender = fromThreadId === null ? "the founder" : this.describeThread(fromThreadId);
      await this.effects.send(
        target.threadId,
        `Message from ${sender}:\n\n${text.trim()}`,
        fromThreadId ?? undefined,
      );
      return `Delivered to ${target.label}.`;
    });
  }

  private resolveRecipient(projectId: string, to: string): { threadId: string; label: string } {
    const config = this.store.getConfig(projectId);
    if (config.agents[to] !== undefined) {
      const state = this.store.getAgent(projectId, to);
      if (state.threadId === null) {
        throw new FactoryError(`${config.agents[to].label} has not been started yet.`);
      }
      return { threadId: state.threadId, label: config.agents[to].label };
    }
    const [key = "", stage] = to.split(":");
    const item = this.store.findItemByKey(projectId, key);
    if (item === null) {
      throw new FactoryError(
        `No recipient "${to}". Use a standing agent (${Object.keys(config.agents).join(", ")}), a ticket key, or KEY:stage.`,
      );
    }
    const stageId = stage ?? config.pipelines[item.pipeline]?.[item.stageIndex] ?? "";
    const threadId = item.threads[stageId];
    if (threadId === undefined) {
      throw new FactoryError(`${item.key} has no "${stageId}" thread. Threads: ${Object.keys(item.threads).join(", ") || "none"}.`);
    }
    return { threadId, label: `${item.key} ${stageId}` };
  }

  describeThread(threadId: string): string {
    const binding = this.store.getBinding(threadId);
    if (binding === null) return "a thread outside the factory";
    const config = this.store.getConfig(binding.projectId);
    if (binding.agentId !== null) return config.agents[binding.agentId]?.label ?? binding.agentId;
    const item = binding.itemId === null ? null : this.store.getItem(binding.itemId);
    const stage = binding.stage ?? "";
    return `${config.stages[stage]?.label ?? stage} for ${item?.key ?? "a ticket"}`;
  }

  // ---------------------------------------------------------------- helpers

  private async fail(item: Item, reason: string, threadId: string | null): Promise<Item> {
    const saved = this.store.saveItem({ ...item, status: "failed" });
    const stageId = currentStageId(this.store, item) ?? "stage";
    this.openEntry({
      item: saved,
      threadId: threadId ?? item.threads[stageId] ?? "",
      kind: "failed",
      from: `${stageId} · ${item.key}`,
      question: `${item.key} failed during ${stageId}.`,
      context: reason.slice(0, 2000),
    });
    return saved;
  }

  private openEntry(input: {
    item: Item | null;
    threadId: string;
    projectId?: string;
    kind: InboxKind;
    from: string;
    question: string;
    context?: string;
    options?: string[];
    recommendation?: string;
  }): InboxEntry {
    const entry = this.store.saveInbox({
      id: newId("inb"),
      projectId: input.item?.projectId ?? input.projectId ?? "",
      threadId: input.threadId,
      itemId: input.item?.id ?? null,
      from: input.from,
      kind: input.kind,
      question: input.question.trim(),
      context: (input.context ?? "").trim(),
      options: input.options ?? [],
      recommendation: (input.recommendation ?? "").trim(),
      status: "open",
      answer: "",
      createdAt: Date.now(),
      resolvedAt: null,
    });
    this.effects.notify(`Factory: ${entry.from}`, entry.question, entry.threadId);
    return entry;
  }

  /** Close what is open for a ticket; used when the ticket itself moves on. */
  private closeEntriesFor(itemId: string): void {
    for (const entry of this.store.listInbox({ status: "open" })) {
      if (entry.itemId !== itemId) continue;
      this.store.saveInbox({ ...entry, status: "dismissed", resolvedAt: Date.now() });
    }
  }

  private resumeIfClear(itemId: string | null): void {
    if (itemId === null) return;
    const item = this.store.getItem(itemId);
    if (item === null || item.status !== "needs-founder") return;
    const stillOpen = this.store
      .listInbox({ status: "open" })
      .some((entry) => entry.itemId === itemId);
    if (!stillOpen) this.store.saveItem({ ...item, status: "running", nudged: false });
  }

  private currentStage(threadId: string): { item: Item; stageId: string } | null {
    const binding = this.store.getBinding(threadId);
    if (binding === null || binding.itemId === null || binding.stage === null) return null;
    const item = this.store.getItem(binding.itemId);
    if (item === null) return null;
    if (currentStageId(this.store, item) !== binding.stage) return null;
    if (item.threads[binding.stage] !== threadId) return null;
    return { item, stageId: binding.stage };
  }

  private requireCurrentStage(threadId: string): { item: Item; stageId: string } {
    const binding = this.store.getBinding(threadId);
    if (binding === null || binding.itemId === null) {
      throw new FactoryError("This thread is not running a factory stage.");
    }
    const current = this.currentStage(threadId);
    if (current === null) {
      const item = this.store.getItem(binding.itemId);
      throw new FactoryError(
        `This thread's stage (${binding.stage}) is not the current stage of ${item?.key ?? "its ticket"}; nothing was recorded.`,
      );
    }
    if (CLOSED.has(current.item.status) || current.item.status === "queued") {
      throw new FactoryError(`${current.item.key} is ${current.item.status}; nothing was recorded.`);
    }
    return current;
  }

  private requireItem(id: string): Item {
    const item = this.store.getItem(id);
    if (item === null) throw new FactoryError(`No ticket with id ${id}.`);
    return item;
  }

  private requireOpenEntry(id: string): InboxEntry {
    const entry = this.store.getInbox(id);
    if (entry === null) throw new FactoryError(`No inbox entry with id ${id}.`);
    if (entry.status !== "open") throw new FactoryError("That inbox entry is already resolved.");
    return entry;
  }
}

function currentStageId(store: FactoryStore, item: Item): string | undefined {
  return store.getConfig(item.projectId).pipelines[item.pipeline]?.[item.stageIndex];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Appended to every stage prompt: how a worker reports back. */
export function stageProtocol(item: Item, stageLabel: string, review: boolean): string {
  return [
    `---`,
    `You are the "${stageLabel}" stage for ${item.key} in the software factory (lane "${item.lane}"). No one is watching this thread, so report through the factory tools:`,
    `- When this stage is completely finished, call factory_stage_done with outcome "complete" and a handoff summary the next stage can act on without reading this thread.`,
    review
      ? `- If the author must change something you cannot land yourself, call factory_stage_done with outcome "changes_requested" and the findings. They go to the author's thread.`
      : `- If a reviewer sends findings to this thread later, address them and call factory_stage_done again.`,
    `- If only the founder can decide something, call factory_ask_founder with the situation, the options, and your recommendation, then end your turn. The answer arrives here as a message.`,
    `- If you cannot proceed for any other reason, call factory_stage_done with outcome "blocked" and say why.`,
    `- To talk to another agent, call factory_message.`,
    `Do not start the next stage yourself and do not launch your own reviewer: the factory does both.`,
  ].join("\n");
}
