// Durable factory state in the plugin's own SQLite database. Rows are JSON
// documents with a few indexed columns; every read is validated on the way out
// so a bad row fails loudly instead of steering the pipeline.
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFAULT_CONFIG } from "./defaults.js";
import {
  agentStateSchema,
  configSchema,
  inboxSchema,
  itemSchema,
  type AgentState,
  type Config,
  type InboxEntry,
  type Item,
} from "./model.js";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS items (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     key TEXT NOT NULL,
     status TEXT NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS items_project ON items (project_id, status)`,
  `CREATE TABLE IF NOT EXISTS inbox (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS inbox_status ON inbox (status, created_at)`,
  `CREATE TABLE IF NOT EXISTS agents (
     project_id TEXT NOT NULL,
     agent_id TEXT NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (project_id, agent_id)
   )`,
  `CREATE TABLE IF NOT EXISTS thread_bindings (
     thread_id TEXT PRIMARY KEY,
     item_id TEXT,
     stage TEXT,
     agent_id TEXT,
     project_id TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS configs (
     project_id TEXT PRIMARY KEY,
     data TEXT NOT NULL
   )`,
];

export interface ThreadBindingRow {
  threadId: string;
  itemId: string | null;
  stage: string | null;
  agentId: string | null;
  projectId: string;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class FactoryStore {
  constructor(private readonly db: Database) {}

  static open(bb: BbPluginApi): FactoryStore {
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    return new FactoryStore(db);
  }

  // ----- config (per project, falling back to the built-in default) -----

  getConfig(projectId: string): Config {
    const row = this.db
      .prepare(`SELECT data FROM configs WHERE project_id = ?`)
      .get(projectId) as { data: string } | undefined;
    if (row === undefined) return structuredClone(DEFAULT_CONFIG);
    return withNewDefaults(configSchema.parse(JSON.parse(row.data)));
  }

  setConfig(projectId: string, config: Config): Config {
    const parsed = configSchema.parse(config);
    validateConfig(parsed);
    this.db
      .prepare(
        `INSERT INTO configs (project_id, data) VALUES (?, ?)
         ON CONFLICT(project_id) DO UPDATE SET data = excluded.data`,
      )
      .run(projectId, JSON.stringify(parsed));
    return parsed;
  }

  // ----- items -----

  saveItem(item: Item): Item {
    const next = { ...item, updatedAt: Date.now() };
    this.db
      .prepare(
        `INSERT INTO items (id, project_id, key, status, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           key = excluded.key, status = excluded.status, data = excluded.data`,
      )
      .run(next.id, next.projectId, next.key, next.status, JSON.stringify(next));
    return next;
  }

  getItem(id: string): Item | null {
    const row = this.db.prepare(`SELECT data FROM items WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row === undefined ? null : itemSchema.parse(JSON.parse(row.data));
  }

  /** Newest item with this key in the project, whatever its status. */
  findItemByKey(projectId: string, key: string): Item | null {
    const rows = this.db
      .prepare(`SELECT data FROM items WHERE project_id = ? AND key = ? COLLATE NOCASE`)
      .all(projectId, key) as { data: string }[];
    const items = rows.map((row) => itemSchema.parse(JSON.parse(row.data)));
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items[0] ?? null;
  }

  listItems(projectId?: string): Item[] {
    const rows = (
      projectId === undefined
        ? this.db.prepare(`SELECT data FROM items`).all()
        : this.db
            .prepare(`SELECT data FROM items WHERE project_id = ?`)
            .all(projectId)
    ) as { data: string }[];
    return rows
      .map((row) => itemSchema.parse(JSON.parse(row.data)))
      .sort(
        (a, b) =>
          a.lane.localeCompare(b.lane) ||
          a.position - b.position ||
          a.createdAt - b.createdAt,
      );
  }

  deleteItem(id: string): void {
    this.db.prepare(`DELETE FROM items WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM thread_bindings WHERE item_id = ?`).run(id);
  }

  // ----- thread bindings -----

  bindThread(row: ThreadBindingRow): void {
    this.db
      .prepare(
        `INSERT INTO thread_bindings (thread_id, item_id, stage, agent_id, project_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           item_id = excluded.item_id, stage = excluded.stage,
           agent_id = excluded.agent_id, project_id = excluded.project_id`,
      )
      .run(row.threadId, row.itemId, row.stage, row.agentId, row.projectId);
  }

  getBinding(threadId: string): ThreadBindingRow | null {
    const row = this.db
      .prepare(
        `SELECT thread_id AS threadId, item_id AS itemId, stage, agent_id AS agentId,
                project_id AS projectId
         FROM thread_bindings WHERE thread_id = ?`,
      )
      .get(threadId) as ThreadBindingRow | undefined;
    return row ?? null;
  }

  // ----- inbox -----

  saveInbox(entry: InboxEntry): InboxEntry {
    this.db
      .prepare(
        `INSERT INTO inbox (id, project_id, thread_id, status, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      )
      .run(
        entry.id,
        entry.projectId,
        entry.threadId,
        entry.status,
        entry.createdAt,
        JSON.stringify(entry),
      );
    return entry;
  }

  getInbox(id: string): InboxEntry | null {
    const row = this.db.prepare(`SELECT data FROM inbox WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row === undefined ? null : inboxSchema.parse(JSON.parse(row.data));
  }

  listInbox(filter: { status?: "open"; threadId?: string } = {}): InboxEntry[] {
    const rows = this.db
      .prepare(`SELECT data FROM inbox ORDER BY created_at ASC`)
      .all() as { data: string }[];
    return rows
      .map((row) => inboxSchema.parse(JSON.parse(row.data)))
      .filter(
        (entry) =>
          (filter.status === undefined || entry.status === filter.status) &&
          (filter.threadId === undefined || entry.threadId === filter.threadId),
      );
  }

  // ----- standing agents -----

  getAgent(projectId: string, agentId: string): AgentState {
    const row = this.db
      .prepare(`SELECT data FROM agents WHERE project_id = ? AND agent_id = ?`)
      .get(projectId, agentId) as { data: string } | undefined;
    if (row === undefined) {
      return { agentId, projectId, threadId: null, startedAt: null, rotating: false };
    }
    return agentStateSchema.parse(JSON.parse(row.data));
  }

  saveAgent(state: AgentState): AgentState {
    this.db
      .prepare(
        `INSERT INTO agents (project_id, agent_id, data) VALUES (?, ?, ?)
         ON CONFLICT(project_id, agent_id) DO UPDATE SET data = excluded.data`,
      )
      .run(state.projectId, state.agentId, JSON.stringify(state));
    return state;
  }
}

/**
 * A saved configuration predates roles added later. Bring in what it lacks
 * without touching anything the founder set: the tiered builder roles start as
 * copies of the builder he already chose.
 */
function withNewDefaults(saved: Config): Config {
  let config = saved;
  // The issue owner replaced the chief of staff on 20 November: the thread
  // that reviews a ticket's plan now fields everything about that ticket.
  if (!Object.values(config.stages).some((stage) => stage.owner)) {
    const { "chief-of-staff": _agent, ...agents } = config.agents;
    const chiefInUse = Object.values(config.stages).some((stage) => stage.role === "chief-of-staff" || Object.values(stage.tierRoles).includes("chief-of-staff"));
    const { "chief-of-staff": chiefRole, ...otherRoles } = config.roles;
    const roles = chiefInUse && chiefRole !== undefined ? config.roles : otherRoles;
    const reviewer = roles["plan-review"];
    config = {
      ...config,
      agents,
      roles: reviewer !== undefined && reviewer.label === "Plan reviewer" ? { ...roles, "plan-review": { ...reviewer, label: "Issue owner" } } : roles,
      stages: Object.fromEntries(Object.entries(config.stages).map(([id, stage]) => [id, id === "plan-review" || id === "fix" ? { ...stage, owner: true } : stage])),
    };
  }
  // The planner is the CTO and Watch is the Observer (founder, 21 November),
  // wherever the earlier default name is still in place.
  const renamedAgents: Record<string, [string, string]> = { orchestrator: ["Planner / strategist", "CTO"], watch: ["Watch", "Observer"] };
  const relabel = <T extends { label: string }>(entries: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, renamedAgents[id] !== undefined && entry.label === renamedAgents[id][0] ? { ...entry, label: renamedAgents[id][1] } : entry]));
  if (Object.entries(renamedAgents).some(([id, [old]]) => config.roles[id]?.label === old || config.agents[id]?.label === old)) {
    config = { ...config, roles: relabel(config.roles), agents: relabel(config.agents) };
  }
  // The deployer, added 20 November.
  if (config.agents.deploy === undefined && config.roles.deploy === undefined) {
    const sibling = config.agents.orchestrator;
    config = {
      ...config,
      roles: { ...config.roles, deploy: structuredClone(DEFAULT_CONFIG.roles.deploy!) },
      agents: {
        ...config.agents,
        deploy: {
          ...structuredClone(DEFAULT_CONFIG.agents.deploy!),
          memoryPath:
            sibling === undefined
              ? DEFAULT_CONFIG.agents.deploy!.memoryPath
              : sibling.memoryPath.replace(/[^/]*$/u, "Deployer memory.md"),
        },
      },
    };
  }
  // Stage names the founder chose on 20 November, where the old default is still in place.
  const renamed: Record<string, [string, string]> = {
    "plan-review": ["Review plan", "Plan review"],
    build: ["Build", "Execution"],
    "code-review": ["Review code", "Code review"],
  };
  if (Object.entries(renamed).some(([id, [old]]) => config.stages[id]?.label === old)) {
    config = {
      ...config,
      stages: Object.fromEntries(
        Object.entries(config.stages).map(([id, stage]) => [
          id,
          renamed[id] !== undefined && stage.label === renamed[id][0] ? { ...stage, label: renamed[id][1] } : stage,
        ]),
      ),
    };
  }
  const build = config.stages.build;
  if (build === undefined || Object.keys(build.tierRoles).length > 0) return config;
  if (config.roles["build-tier-2"] !== undefined || config.roles["build-tier-3"] !== undefined) return config;
  const base = config.roles[build.role];
  if (base === undefined) return config;
  return {
    ...config,
    roles: {
      ...config.roles,
      [build.role]: { ...base, label: base.label === "Builder" ? "Builder, tier 1" : base.label },
      "build-tier-2": { ...base, label: "Builder, tier 2" },
      "build-tier-3": { ...base, label: "Builder, tier 3" },
    },
    stages: {
      ...config.stages,
      build: { ...build, tierRoles: { "2": "build-tier-2", "3": "build-tier-3" } },
    },
  };
}

/** Cross-field rules zod cannot express: every reference must resolve. */
export function validateConfig(config: Config): void {
  for (const [id, stage] of Object.entries(config.stages)) {
    for (const role of [stage.role, ...Object.values(stage.tierRoles)]) {
      if (config.roles[role] === undefined) {
        throw new Error(`Stage "${id}" uses role "${role}", which is not defined.`);
      }
    }
  }
  for (const [name, stages] of Object.entries(config.pipelines)) {
    stages.forEach((stage) => {
      if (config.stages[stage] === undefined) {
        throw new Error(`Pipeline "${name}" lists stage "${stage}", which is not defined.`);
      }
    });
  }
  if (config.pipelines[config.defaultPipeline] === undefined) {
    throw new Error(`Default pipeline "${config.defaultPipeline}" is not defined.`);
  }
  for (const [id, agent] of Object.entries(config.agents)) {
    if (config.roles[agent.role] === undefined) {
      throw new Error(`Agent "${id}" uses role "${agent.role}", which is not defined.`);
    }
  }
}
