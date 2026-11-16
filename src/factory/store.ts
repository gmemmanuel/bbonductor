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
    return configSchema.parse(JSON.parse(row.data));
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

/** Cross-field rules zod cannot express: every reference must resolve. */
export function validateConfig(config: Config): void {
  for (const [id, stage] of Object.entries(config.stages)) {
    if (config.roles[stage.role] === undefined) {
      throw new Error(`Stage "${id}" uses role "${stage.role}", which is not defined.`);
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
