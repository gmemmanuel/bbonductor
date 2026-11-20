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
  /** Change the model an existing thread runs on. */
  switchModel(threadId: string, model: string, reasoningLevel: string): Promise<void>;
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
  "with-planner",
  "triage",
  "returned",
  "stalled",
  "failed",
]);
const CLOSED = new Set<Item["status"]>(["done", "archived", "cancelled"]);

export class FactoryError extends Error {}

export interface EnqueueInput {
  projectId: string;
  key: string;
  title: string;
  brief?: string;
  lane?: string;
  pipeline?: string;
  tier?: number | null;
  originThreadId?: string | null;
}

export interface StageDoneInput {
  outcome: "complete" | "changes_requested" | "blocked";
  summary: string;
  /** Author asks for the review to run again after their fixes. */
  rereview?: boolean;
  /** What the founder must try on the branch before it ships. */
  founderCheck?: string | FounderCheckInput;
}

export interface FounderCheckInput {
  before: string;
  why: string;
  now: string;
  account: string;
  steps: string[];
}

/** The one shape every "try before it ships" message takes. */
export function renderFounderCheck(check: FounderCheckInput): string {
  return [
    `**Before:** ${check.before.trim()}`,
    `**Why:** ${check.why.trim()}`,
    `**Now:** ${check.now.trim()}`,
    `**Needs your review**`,
    `Test account: ${check.account.trim()}`,
    `**Steps to test**\n${check.steps.map((step) => `- ${step.trim()}`).join("\n")}`,
  ].join("\n\n");
}

export interface AskInput {
  question: string;
  context?: string;
  options?: string[];
  recommendation?: string;
  /** Not a decision: something already shipped that the founder should try. */
  testing?: boolean;
  /** Chief of staff only: the thread this is about, as "KEY" or "KEY:stage". */
  about?: string;
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
        tier: input.tier ?? null,
        parked: false,
        working: false,
        stageIndex: 0,
        status: "queued",
        environmentId: null,
        threads: {},
        passedReviews: [],
        lastSummary: "",
        founderCheck: null,
        consult: null,
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

  /**
   * Make the lanes match a schedule produced elsewhere (a sequencing skill).
   * The schedule decides which tickets exist and which lane each is in; the
   * founder decides the order inside a lane, so that is never rewritten.
   *   - a ticket new to the factory is queued at the end of its lane
   *   - a ticket whose lane changed moves to the end of the new lane
   *   - a ticket that has not started and is no longer scheduled is cancelled
   *   - work that has started is never stopped or reordered by a sync
   */
  syncLanes(
    projectId: string,
    lanes: { name: string; items: { key: string; title: string; brief?: string; pipeline?: string; tier?: number; parked?: boolean }[] }[],
    originThreadId: string | null,
  ): Promise<string[]> {
    return this.exclusive(async () => {
      const config = this.store.getConfig(projectId);
      const report: string[] = [];
      const scheduled = new Set<string>();
      for (const lane of lanes) {
        const laneName = lane.name.trim();
        if (laneName === "") throw new FactoryError("Every lane needs a name.");
        for (const entry of lane.items) {
          const key = entry.key.trim();
          if (key === "" || scheduled.has(key.toUpperCase())) {
            throw new FactoryError(`Ticket "${key}" is missing or listed twice.`);
          }
          scheduled.add(key.toUpperCase());
          const pipeline = entry.pipeline ?? config.defaultPipeline;
          if (config.pipelines[pipeline] === undefined) {
            throw new FactoryError(`${key}: unknown pipeline "${pipeline}".`);
          }
          const existing = this.store.findItemByKey(projectId, key);
          const siblings = () =>
            this.store.listItems(projectId).filter((item) => item.lane === laneName && !CLOSED.has(item.status));
          if (existing !== null && existing.status === "done") {
            report.push(`${key}: already finished here`);
          } else if (existing !== null && existing.status !== "cancelled") {
            // A plan's tier can change while its ticket waits; follow it until the build starts.
            // While a ticket waits, it follows the schedule: its tier, where it
            // starts, and whether the founder has parked it.
            const waiting =
              existing.status === "queued"
                ? { ...existing, tier: entry.tier ?? existing.tier, pipeline, parked: entry.parked === true, title: entry.title.trim() || existing.title }
                : existing;
            if (waiting !== existing) this.store.saveItem(waiting);
            if (existing.lane === laneName) continue;
            const position = siblings().reduce((max, item) => Math.max(max, item.position), 0) + 1;
            this.store.saveItem({ ...waiting, lane: laneName, position });
            report.push(`${key}: moved from "${existing.lane}" to "${laneName}"`);
          } else {
            const now = Date.now();
            this.store.saveItem({
              id: newId("itm"),
              projectId,
              key,
              title: entry.title.trim() || key,
              brief: (entry.brief ?? "").trim(),
              lane: laneName,
              position: siblings().reduce((max, item) => Math.max(max, item.position), 0) + 1,
              pipeline,
              tier: entry.tier ?? null,
              parked: entry.parked === true,
              working: false,
              stageIndex: 0,
              status: "queued",
              environmentId: null,
              threads: {},
              passedReviews: [],
              lastSummary: "",
              founderCheck: null,
              consult: null,
              originThreadId,
              nudged: false,
              createdAt: now,
              updatedAt: now,
            });
            report.push(`${key}: queued in "${laneName}"`);
          }
        }
      }
      for (const item of this.store.listItems(projectId)) {
        if (item.status !== "queued" || scheduled.has(item.key.toUpperCase())) continue;
        this.store.saveItem({ ...item, status: "cancelled" });
        report.push(`${item.key}: removed (not started, and no longer scheduled)`);
      }
      await this.scheduleLocked(projectId);
      this.effects.changed();
      return report;
    });
  }

  /** The stage thread's turn ended: it is no longer working, whatever comes next. */
  markResting(threadId: string): Promise<void> {
    return this.exclusive(async () => {
      const current = this.currentStage(threadId);
      if (current === null || !current.item.working) return;
      this.store.saveItem({ ...current.item, working: false });
      this.effects.changed();
    });
  }

  /** Put a waiting ticket just before another waiting ticket of its lane, or last. */
  reorderBefore(itemId: string, beforeId: string | null): Promise<Item> {
    return this.exclusive(async () => {
      const item = this.requireItem(itemId);
      if (item.status !== "queued" || item.parked) throw new FactoryError(`${item.key} cannot be reordered.`);
      const waiting = this.store
        .listItems(item.projectId)
        .filter((other) => other.lane === item.lane && other.status === "queued" && !other.parked);
      const slots = waiting.map((other) => other.position).sort((a, b) => a - b);
      const rest = waiting.filter((other) => other.id !== item.id);
      const index = beforeId === null ? rest.length : rest.findIndex((other) => other.id === beforeId);
      if (index === -1) throw new FactoryError("That ticket is not waiting in the same lane.");
      rest.splice(index, 0, item);
      // The lane's waiting slots are reused in the new order, so nothing else moves.
      rest.forEach((other, position) => this.store.saveItem({ ...other, position: slots[position]! }));
      await this.scheduleLocked(item.projectId);
      this.effects.changed();
      return this.requireItem(itemId);
    });
  }

  /** Swap a waiting ticket with the waiting ticket before or after it in its lane. */
  reorder(itemId: string, direction: "up" | "down"): Promise<Item> {
    return this.exclusive(async () => {
      const item = this.requireItem(itemId);
      if (item.status !== "queued") throw new FactoryError(`${item.key} has started; only waiting tickets can be reordered.`);
      const waiting = this.store
        .listItems(item.projectId)
        .filter((other) => other.lane === item.lane && other.status === "queued" && !other.parked);
      const index = waiting.findIndex((other) => other.id === item.id);
      const neighbour = waiting[index + (direction === "up" ? -1 : 1)];
      if (neighbour === undefined) return item;
      this.store.saveItem({ ...item, position: neighbour.position });
      this.store.saveItem({ ...neighbour, position: item.position });
      await this.scheduleLocked(item.projectId);
      this.effects.changed();
      return this.requireItem(itemId);
    });
  }

  /**
   * A stage needs its planner. The planner of a ticket is the agent that
   * reviewed its plan; the founder never carries these. The question goes to
   * that thread, and the planner answers with a message to the stage's thread.
   */
  askPlanner(threadId: string, question: string): Promise<string> {
    return this.exclusive(async () => {
      const { item, stageId } = this.requireCurrentStage(threadId);
      const config = this.store.getConfig(item.projectId);
      const stages = config.pipelines[item.pipeline] ?? [];
      let planner: string | null = null;
      for (let index = item.stageIndex - 1; index >= 0 && planner === null; index -= 1) {
        const earlier = stages[index]!;
        if (config.stages[earlier]?.review === true) planner = item.threads[earlier] ?? null;
      }
      // A ticket queued already reviewed has no plan-review thread here: its
      // planner is whoever queued it, else the standing orchestrator.
      planner ??= item.originThreadId;
      if (planner === null && config.agents.orchestrator !== undefined) {
        const state = this.store.getAgent(item.projectId, "orchestrator");
        planner = state.threadId ?? (await this.spawnAgent(item.projectId, "orchestrator", "")).threadId;
      }
      if (planner === null || planner === threadId) {
        throw new FactoryError(`${item.key} has no planner thread to ask. Use factory_stage_done with outcome "blocked".`);
      }
      const label = config.stages[stageId]?.label ?? stageId;
      await this.effects.send(
        planner,
        `The ${label} stage for ${item.key} (${item.title}) has stopped and needs its planner. For this ticket that is you: the founder does not carry these. Decide, update the plan if it needs to change, then reply with factory_message (to: "${item.key}:${stageId}") so the work continues. Go back and forth as often as needed. Bring the founder only a product decision, with factory_ask_founder.\n\nFrom the ${label} stage:\n${question.trim()}`,
        threadId,
      );
      this.closeEntriesFor(item.id);
      this.store.saveItem({ ...item, status: "with-planner", consult: { threadId: planner, nudged: false } });
      this.effects.changed();
      return "Sent to this ticket's planner. Its answer will arrive in this thread as a message. End your turn.";
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
    // One ticket in flight per lane. How many lanes exist is decided where the
    // lanes are made (the sequencing skill caps them), not here.
    const lanes = [...new Set(items.map((item) => item.lane))];
    for (const lane of lanes) {
      // Parked ("Later") tickets are never started and never hold up the lane.
      const head = items.find((item) => item.lane === lane && !CLOSED.has(item.status) && !item.parked);
      if (head === undefined || head.status !== "queued") continue;
      await this.runStage(head, config);
    }
  }

  // ----------------------------------------------------------------- stages

  private async runStage(item: Item, config: Config, handover = ""): Promise<Item> {
    const stageId = config.pipelines[item.pipeline]?.[item.stageIndex];
    const stage = stageId === undefined ? undefined : config.stages[stageId];
    const roleId =
      stage === undefined ? undefined : (stage.tierRoles[String(item.tier ?? "")] ?? stage.role);
    const configured = roleId === undefined ? undefined : config.roles[roleId];
    const role = configured === undefined ? undefined : this.available(item.projectId, configured);
    if (stageId === undefined || stage === undefined || role === undefined) {
      return this.fail(item, `Stage ${item.stageIndex} of pipeline "${item.pipeline}" is not configured.`, null);
    }
    const prompt = [
      handover,
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
    ]
      .filter((part) => part !== "")
      .join("\n\n");
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
        // bb names a workspace after its first thread, so that one is the ticket.
        title: Object.keys(item.threads).length === 0 ? item.key : `${item.key} · ${stage.label}`,
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
        working: true,
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
      // Its threads stay until the founder archives the workspace himself; it
      // shows under Done until then (see onGone).
      await this.scheduleLocked(item.projectId);
      return done;
    }
    const next = config.stages[stages[index]!];
    if (next?.founderGate === true && item.founderCheck !== null && !item.founderCheck.approved) {
      // Everything before this stage is finished; it waits for the founder to
      // try the branch. Approving runs `forward` again from the same place.
      const held = this.store.saveItem({ ...item, status: "needs-founder", passedReviews: passed });
      this.openEntry({
        item: held,
        threadId: item.threads[stages[item.stageIndex] ?? ""] ?? "",
        kind: "check",
        from: `Founder testing · ${item.key}`,
        question: `${item.key} (${item.title}) is built and reviewed. Try it before it ships.`,
        context: item.founderCheck.text,
      });
      return held;
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

      const check = (
        typeof input.founderCheck === "object" ? renderFounderCheck(input.founderCheck) : (input.founderCheck ?? "")
      ).trim();
      if (check) item.founderCheck = { text: check, approved: false };

      if (input.outcome === "blocked") {
        if (await this.triage(item, threadId, `The ${stage?.label ?? stageId} stage reports it is blocked.`, summary)) {
          return "Recorded as blocked and sent to the chief of staff, who will either answer you or take it to the founder. The reply arrives in this thread. End your turn.";
        }
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
      const config = this.store.getConfig(binding.projectId);
      // The chief of staff asks on behalf of a ticket's thread: the entry
      // belongs to that thread, so the founder's answer goes straight to it.
      if (binding.agentId === "chief-of-staff" && input.about) {
        const target = this.resolveRecipient(binding.projectId, input.about.trim());
        const about = this.currentStage(target.threadId);
        if (about !== null) {
          this.closeEntriesFor(about.item.id);
          this.store.saveItem({ ...about.item, status: "needs-founder", consult: null });
          const entry = this.openEntry({
            item: about.item,
            threadId: target.threadId,
            kind: "question",
            from: `${config.stages[about.stageId]?.label ?? about.stageId} · ${about.item.key}`,
            question: input.question,
            context: input.context ?? "",
            options: input.options ?? [],
            recommendation: input.recommendation ?? "",
          });
          this.effects.changed();
          return entry;
        }
      }
      const item = binding.itemId === null ? null : this.store.getItem(binding.itemId);
      if (item !== null && binding.stage !== null && this.currentStage(threadId) !== null) {
        const body = [
          input.question,
          input.context ? `Context: ${input.context}` : "",
          (input.options ?? []).map((option, index) => `Option ${String.fromCharCode(65 + index)}: ${option}`).join("\n"),
          input.recommendation ? `Its recommendation: ${input.recommendation}` : "",
        ]
          .filter((part) => part !== "")
          .join("\n\n");
        const label = config.stages[binding.stage]?.label ?? binding.stage;
        if (await this.triage(item, threadId, `The ${label} stage wants a founder decision.`, body)) {
          this.effects.changed();
          return this.triagePlaceholder(item, threadId);
        }
      }
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
        kind: input.testing === true ? "test" : "question",
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

  /**
   * Hand something a ticket's thread wants from the founder to the chief of
   * staff first. It settles what agents may settle and writes the founder one
   * clear message for the rest. Returns false when there is no chief of staff.
   */
  private async triage(item: Item, threadId: string, headline: string, body: string): Promise<boolean> {
    const config = this.store.getConfig(item.projectId);
    if (config.agents["chief-of-staff"] === undefined) return false;
    const stageId = currentStageId(this.store, item) ?? "";
    let chief = this.store.getAgent(item.projectId, "chief-of-staff").threadId;
    try {
      chief ??= (await this.spawnAgent(item.projectId, "chief-of-staff", "")).threadId;
    } catch (error) {
      this.effects.log(`chief of staff could not start: ${messageOf(error)}`);
      return false;
    }
    if (chief === null || chief === threadId) return false;
    await this.effects.send(
      chief,
      `${headline}\nTicket: ${item.key} — ${item.title}\nThread: "${item.key}:${stageId}"\n\n${body.trim()}\n\nHandle this as your charter says: answer it yourself with factory_message (to: "${item.key}:${stageId}") if agents may decide it, or put one clear message to the founder with factory_ask_founder (about: "${item.key}:${stageId}").`,
      threadId,
    );
    this.closeEntriesFor(item.id);
    this.store.saveItem({ ...item, status: "triage", consult: { threadId: chief, nudged: false } });
    return true;
  }

  /** What `ask` returns while a question is with the chief of staff. */
  private triagePlaceholder(item: Item, threadId: string): InboxEntry {
    return {
      id: "",
      projectId: item.projectId,
      threadId,
      itemId: item.id,
      from: "",
      kind: "question",
      question: "",
      context: "",
      options: [],
      recommendation: "",
      status: "dismissed",
      answer: "",
      createdAt: Date.now(),
      resolvedAt: Date.now(),
    };
  }

  /** The founder tried the branch and it is good: let the gated stage start. */
  approveCheck(entryId: string): Promise<Item> {
    return this.exclusive(async () => {
      const entry = this.requireOpenEntry(entryId);
      const item = entry.itemId === null ? null : this.store.getItem(entry.itemId);
      if (entry.kind !== "check" || item === null || item.founderCheck === null) {
        throw new FactoryError("That inbox entry is not a check waiting for approval.");
      }
      this.store.saveInbox({ ...entry, status: "answered", answer: "Approved.", resolvedAt: Date.now() });
      const result = await this.forward(
        { ...item, founderCheck: { ...item.founderCheck, approved: true } },
        false,
      );
      this.effects.changed();
      return result;
    });
  }

  answer(entryId: string, answer: string): Promise<InboxEntry> {
    return this.exclusive(async () => {
      const entry = this.requireOpenEntry(entryId);
      const text = answer.trim();
      if (text === "") throw new FactoryError("An answer cannot be empty.");
      if (entry.kind === "check") {
        // Notes on a check send the ticket back to whoever built it.
        const item = entry.itemId === null ? null : this.store.getItem(entry.itemId);
        if (item === null) throw new FactoryError("That check's ticket no longer exists.");
        const config = this.store.getConfig(item.projectId);
        const stages = config.pipelines[item.pipeline] ?? [];
        let author = item.stageIndex;
        while (author > 0 && (config.stages[stages[author]!]?.review === true || item.threads[stages[author]!] === undefined)) author -= 1;
        const authorThread = item.threads[stages[author] ?? ""];
        if (authorThread === undefined) throw new FactoryError(`${item.key} has no build thread to send this to.`);
        await this.effects.send(
          authorThread,
          `The founder tried ${item.key} and wants changes before it ships:\n\n${text}\n\nMake them, verify, then call factory_stage_done again with an updated founder_check.`,
        );
        this.store.saveItem({ ...item, status: "running", nudged: false, stageIndex: author });
        const sent = this.store.saveInbox({ ...entry, status: "answered", answer: text, resolvedAt: Date.now() });
        this.effects.changed();
        return sent;
      }
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

  /** Correct what kind of entry something is (a test filed as a decision, say). */
  retag(entryId: string, kind: InboxKind): Promise<InboxEntry> {
    return this.exclusive(async () => {
      const saved = this.store.saveInbox({ ...this.requireOpenEntry(entryId), kind });
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
      const binding = this.store.getBinding(threadId);
      const asked =
        binding === null
          ? null
          : (this.store
              .listItems(binding.projectId)
              .find(
                (item) =>
                  (item.status === "with-planner" || item.status === "triage") &&
                  item.consult?.threadId === threadId,
              ) ?? null);
      if (asked !== null && asked.consult !== null) {
        const stageId = currentStageId(this.store, asked) ?? "";
        if (this.store.listInbox({ status: "open", threadId }).length > 0) return;
        if (!asked.consult.nudged) {
          this.store.saveItem({ ...asked, consult: { ...asked.consult, nudged: true } });
          await this.effects.send(
            threadId,
            `The ${stageId} stage for ${asked.key} is still waiting on you. Reply with factory_message (to: "${asked.key}:${stageId}"), or call factory_ask_founder if only the founder can decide.`,
          );
          return;
        }
        this.openEntry({
          item: asked,
          threadId,
          kind: "stalled",
          from: `${asked.status === "triage" ? "Chief of staff" : "Planner"} · ${asked.key}`,
          question: `${asked.key}'s ${asked.status === "triage" ? "chief of staff" : "planner"} stopped twice without answering the ${stageId} stage.`,
          context: (lastAssistantText ?? "").slice(0, 2000),
        });
        this.effects.changed();
        return;
      }
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
      if (current === null) return;
      const { status } = current.item;
      if (status !== "stalled" && status !== "failed") {
        if (!current.item.working) {
          this.store.saveItem({ ...current.item, working: true });
          this.effects.changed();
        }
        return;
      }
      // The founder, another agent, or a switch to a fallback model got it
      // moving again.
      this.store.saveItem({ ...current.item, status: "running", nudged: false, working: true });
      for (const entry of this.store.listInbox({ status: "open", threadId })) {
        if (entry.kind !== "stalled" && entry.kind !== "failed") continue;
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

  // -------------------------------------------------------- usage limits

  /** provider|model that hit a usage limit -> when it is expected back. */
  private readonly limited = new Map<string, number>();
  /** Threads already moved to their fallback, so one limit is one switch. */
  private readonly switched = new Set<string>();

  private limitKey(projectId: string, role: Role): string {
    return `${projectId}|${role.providerId}|${role.model}`;
  }

  /** The role as it should run right now: on its fallback while its model is limited. */
  private available(projectId: string, role: Role): Role {
    const until = this.limited.get(this.limitKey(projectId, role));
    if (role.fallbackModel === "" || until === undefined) return role;
    if (until <= Date.now()) {
      this.limited.delete(this.limitKey(projectId, role));
      return role;
    }
    return this.fallbackOf(role);
  }

  private fallbackOf(role: Role): Role {
    const otherProvider = role.fallbackProviderId !== "" && role.fallbackProviderId !== role.providerId;
    return {
      ...role,
      providerId: role.fallbackProviderId || role.providerId,
      model: role.fallbackModel,
      // A thinking level only carries over inside one provider.
      reasoningLevel: role.fallbackReasoningLevel || (otherProvider ? "" : role.reasoningLevel),
    };
  }

  private roleOf(threadId: string): { projectId: string; role: Role } | null {
    const binding = this.store.getBinding(threadId);
    if (binding === null) return null;
    const config = this.store.getConfig(binding.projectId);
    let roleId: string | undefined;
    if (binding.agentId !== null) roleId = config.agents[binding.agentId]?.role;
    else if (binding.stage !== null) {
      const stage = config.stages[binding.stage];
      const item = binding.itemId === null ? null : this.store.getItem(binding.itemId);
      roleId = stage === undefined ? undefined : (stage.tierRoles[String(item?.tier ?? "")] ?? stage.role);
    }
    const role = roleId === undefined ? undefined : config.roles[roleId];
    return role === undefined ? null : { projectId: binding.projectId, role };
  }

  /**
   * A factory thread's turn failed on a usage limit. If its role names a
   * fallback, move the thread to it and rerun the turn, and start that role's
   * new threads on the fallback until the limit resets. Returns whether it
   * switched; when it did not, the failure reaches the founder as usual.
   */
  onLimit(threadId: string, resetsAtMs: number | null): Promise<boolean> {
    return this.exclusive(async () => {
      const found = this.roleOf(threadId);
      if (found === null || found.role.fallbackModel === "" || this.switched.has(threadId)) return false;
      const { projectId, role } = found;
      // Without a reported reset, try the first choice again after an hour.
      this.limited.set(this.limitKey(projectId, role), resetsAtMs ?? Date.now() + 60 * 60 * 1000);
      this.switched.add(threadId);
      const fallback = this.fallbackOf(role);
      const who = this.describeThread(threadId);
      if (fallback.providerId === role.providerId) {
        // Same provider: the thread keeps its conversation and changes model.
        await this.effects.switchModel(threadId, fallback.model, fallback.reasoningLevel);
        await this.effects.retry(threadId);
      } else {
        // A thread cannot change provider, so its work moves to a new thread
        // on the fallback, which picks up from the worktree and the old log.
        const handover = `The thread that was doing this (${threadId}) ran out of usage on its model partway through and cannot continue. Before anything else, see what it finished: check the worktree (git status, git log) and read its conversation with \`bb thread log ${threadId}\`. Continue from there; do not redo finished work.`;
        const binding = this.store.getBinding(threadId);
        if (binding?.agentId != null) {
          const next = await this.spawnAgent(binding.projectId, binding.agentId, handover);
          this.switched.add(next.threadId ?? "");
        } else {
          const current = this.currentStage(threadId);
          if (current === null || CLOSED.has(current.item.status)) return false;
          this.closeEntriesFor(current.item.id);
          const started = await this.runStage(current.item, this.store.getConfig(projectId), handover);
          this.switched.add(started.threads[current.stageId] ?? "");
        }
        this.effects.changed();
      }
      this.effects.log(`${who} hit a usage limit on ${role.model}; continuing on ${fallback.providerId} ${fallback.model}.`);
      return true;
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
      // A finished ticket stays under Done until its workspace is archived:
      // when its last thread is gone, it leaves the board.
      const binding = this.store.getBinding(threadId);
      const finished = binding?.itemId == null ? null : this.store.getItem(binding.itemId);
      if (finished !== null && finished.status === "done") {
        const threads = Object.fromEntries(Object.entries(finished.threads).filter(([, id]) => id !== threadId));
        this.store.saveItem({ ...finished, threads, status: Object.keys(threads).length === 0 ? "archived" : "done" });
        this.effects.changed();
        return;
      }
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
    const configuredRole = config.roles[agent.role];
    if (configuredRole === undefined) throw new FactoryError(`Role "${agent.role}" is not defined.`);
    const role = this.available(projectId, configuredRole);
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
      // The planner answering is what puts a waiting stage back to work.
      const waiting = this.currentStage(target.threadId);
      if (waiting !== null && (waiting.item.status === "with-planner" || waiting.item.status === "triage")) {
        this.store.saveItem({ ...waiting.item, status: "running", consult: null, nudged: false });
        this.effects.changed();
      }
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
    `- If this ticket changes anything a user sees, pass founder_check when you call factory_stage_done. It ships only after the founder has tried it. Fill its fields plainly, for a founder who has not thought about this ticket in days: before (what the user saw), why (why it was changed), now (what the user sees instead), account (a test account and its password, one that exists or one you seeded; set up any data the steps need yourself and do not describe that work), and steps (short bullet steps saying what to do and what he should see). Nothing else: no list of what you verified, no fixes you made, no commit ids, no tool names.`,
    `- If only the founder can decide something, call factory_ask_founder with the situation, the options, and your recommendation, then end your turn. The answer arrives here as a message.`,
    `- If your project's process says something goes back to the planner, call factory_ask_planner with the full handoff. For this ticket the planner is the agent that reviewed its plan; its answer arrives here as a message, and you may go back and forth as often as needed. Never send planner questions to the founder.`,
    `- If you cannot proceed for any other reason, call factory_stage_done with outcome "blocked" and say why.`,
    `- To talk to another agent, call factory_message.`,
    `Do not start the next stage yourself and do not launch your own reviewer: the factory does both.`,
    `Nobody reads this thread while it runs, so after reporting, end your turn with one line and nothing more: what you did, how many changes you made, and where it went. For example "Plan reviewed, 3 changes, sent to a tier 2 builder." Put everything the next stage needs in the factory_stage_done summary, not in chat. This replaces any longer closing format your project's instructions ask for.`,
  ].join("\n");
}
