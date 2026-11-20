// Shared shapes for the factory. Server and app both import from here; the app
// imports types only, so nothing in this file may touch Node APIs.
import { z } from "zod";

/** Which model plays a role. Empty strings mean "use the project's default". */
export const roleSchema = z.object({
  label: z.string().min(1).max(60),
  providerId: z.string().max(80).default(""),
  model: z.string().max(120).default(""),
  reasoningLevel: z.string().max(40).default(""),
  permissionMode: z.enum(["", "accept-edits", "auto", "full"]).default(""),
  /**
   * Where this role's work goes when its model hits a usage limit: a model,
   * on this provider or (when `fallbackProviderId` is set) another one. An
   * empty model means no fallback: the limit lands in the founder's inbox.
   */
  fallbackProviderId: z.string().max(80).default(""),
  fallbackModel: z.string().max(120).default(""),
  fallbackReasoningLevel: z.string().max(40).default(""),
});
export type Role = z.infer<typeof roleSchema>;

/** One step of a pipeline. `prompt` supports {key} {title} {brief} {previous} {lane}. */
export const stageSchema = z.object({
  label: z.string().min(1).max(60),
  role: z.string().min(1),
  prompt: z.string().min(1).max(8000),
  /** This stage does not start until the founder approves a recorded check. */
  founderGate: z.boolean().default(false),
  /** A review stage sends requested changes back to the stage before it. */
  review: z.boolean().default(false),
  /**
   * Roles for tickets whose plan declares an implementer tier, keyed "1".."3".
   * A ticket with no tier, or a tier not listed, uses `role`.
   */
  tierRoles: z.record(z.string(), z.string()).default({}),
});
export type Stage = z.infer<typeof stageSchema>;

/** A long-lived agent with a fixed job, pinned in the project's main checkout. */
export const standingAgentSchema = z.object({
  label: z.string().min(1).max(60),
  role: z.string().min(1),
  /** The plugin skill that holds this agent's charter. */
  skill: z.string().min(1),
  /** Repo-relative file the agent keeps as its rolling memory. */
  memoryPath: z.string().min(1).max(300),
});
export type StandingAgent = z.infer<typeof standingAgentSchema>;

export const configSchema = z.object({
  roles: z.record(z.string(), roleSchema),
  stages: z.record(z.string(), stageSchema),
  pipelines: z.record(z.string(), z.array(z.string()).min(1)),
  defaultPipeline: z.string().min(1),
  /** Tickets being worked at once, across all lanes. */
  maxActiveItems: z.number().int().min(1).max(64),
  agents: z.record(z.string(), standingAgentSchema),
});
export type Config = z.infer<typeof configSchema>;

export const ITEM_STATUSES = [
  "queued",
  "running",
  "needs-founder",
  "with-planner",
  "triage",
  "returned",
  "stalled",
  "failed",
  "done",
  "cancelled",
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const itemSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  key: z.string(),
  title: z.string(),
  brief: z.string(),
  lane: z.string(),
  position: z.number(),
  pipeline: z.string(),
  /** The plan's implementer tier (1 to 3), when it declares one. */
  tier: z.number().int().min(1).max(3).nullable().default(null),
  stageIndex: z.number().int(),
  status: z.enum(ITEM_STATUSES),
  environmentId: z.string().nullable(),
  /** stage id -> thread id of the latest thread that ran it. */
  threads: z.record(z.string(), z.string()),
  /** Review stages already passed once; skipped when the author finishes fixes. */
  passedReviews: z.array(z.string()),
  lastSummary: z.string(),
  /** What the founder must try before this ships, and whether he approved it. */
  founderCheck: z.object({ text: z.string(), approved: z.boolean() }).nullable().default(null),
  /** The planner thread a stage is waiting on, and whether it was reminded. */
  consult: z.object({ threadId: z.string(), nudged: z.boolean() }).nullable().default(null),
  /** Thread that queued this ticket; review findings with no author stage go here. */
  originThreadId: z.string().nullable(),
  nudged: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Item = z.infer<typeof itemSchema>;

export const INBOX_KINDS = [
  "question",
  "interaction",
  "stalled",
  "failed",
  "blocked",
  "check",
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const inboxSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  itemId: z.string().nullable(),
  /** Who is asking, in plain words: "Build · JUS-12" or "Orchestrator". */
  from: z.string(),
  kind: z.enum(INBOX_KINDS),
  question: z.string(),
  context: z.string(),
  options: z.array(z.string()),
  recommendation: z.string(),
  status: z.enum(["open", "answered", "dismissed"]),
  answer: z.string(),
  createdAt: z.number(),
  resolvedAt: z.number().nullable(),
});
export type InboxEntry = z.infer<typeof inboxSchema>;

export const agentStateSchema = z.object({
  agentId: z.string(),
  projectId: z.string(),
  threadId: z.string().nullable(),
  startedAt: z.number().nullable(),
  /** The current thread has been asked to hand off and will be replaced. */
  rotating: z.boolean().default(false),
});
export type AgentState = z.infer<typeof agentStateSchema>;

/** What a thread is to the factory, kept in its plugin metadata. */
export type ThreadBinding =
  | { kind: "stage"; itemId: string; stage: string }
  | { kind: "agent"; agentId: string; projectId: string };

export function fillTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? (values[name] ?? "")
      : match,
  );
}
