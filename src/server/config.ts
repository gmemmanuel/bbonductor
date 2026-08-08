import type { BbPluginApi } from "@bb/plugin-sdk";
import type { ProjectConfig } from "../shared/types";

export function createConfigStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS project_config (
      project_id TEXT PRIMARY KEY,
      run_command TEXT NOT NULL DEFAULT 'npm run dev',
      linear_team_id TEXT,
      linear_status_names TEXT NOT NULL DEFAULT '["Todo"]',
      merge_method TEXT NOT NULL DEFAULT 'squash'
    )`,
    `CREATE TABLE IF NOT EXISTS workspace_links (
      environment_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      linear_issue_id TEXT,
      linear_identifier TEXT,
      linear_title TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  ]);

  function get(projectId: string): ProjectConfig {
    const row = db.prepare(`SELECT * FROM project_config WHERE project_id = ?`).get(projectId) as any;
    if (!row) {
      return {
        projectId,
        runCommand: "npm run dev",
        linearStatusNames: ["Todo"],
        mergeMethod: "squash",
      };
    }
    return {
      projectId,
      runCommand: row.run_command,
      ...(row.linear_team_id ? { linearTeamId: row.linear_team_id } : {}),
      linearStatusNames: JSON.parse(row.linear_status_names),
      mergeMethod: row.merge_method,
    };
  }

  function save(config: ProjectConfig) {
    db.prepare(`
      INSERT INTO project_config(project_id, run_command, linear_team_id, linear_status_names, merge_method)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        run_command = excluded.run_command,
        linear_team_id = excluded.linear_team_id,
        linear_status_names = excluded.linear_status_names,
        merge_method = excluded.merge_method
    `).run(
      config.projectId,
      config.runCommand,
      config.linearTeamId ?? null,
      JSON.stringify(config.linearStatusNames),
      config.mergeMethod,
    );
  }

  return { db, get, save };
}
