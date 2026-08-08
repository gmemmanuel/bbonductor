import type { BbPluginApi } from "@bb/plugin-sdk";
import { Buffer } from "node:buffer";
import { rpcContract } from "./src/shared/rpc";
import { createConfigStore } from "./src/server/config";
import { getLinearIssue, listConfiguredLinearIssues } from "./src/server/linear";
import { createEnvironmentTerminal, terminalText } from "./src/server/terminals";
import { getPullRequestDetails, mergePullRequest } from "./src/server/github";

void Buffer;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    linearApiKey: {
      type: "string",
      label: "Linear API key",
      secret: true,
    },
  });

  const config = createConfigStore(bb);
  const runtimeByEnvironment = new Map<string, string>();

  bb.rpc.register(rpcContract, {
    async listProjects() {
      const result = await bb.sdk.projects.list() as any;
      const projects = Array.isArray(result) ? result : (result?.projects ?? []);
      return {
        projects: projects.map((project: any) => ({
          id: String(project.id),
          name: String(project.name ?? project.id),
        })),
      };
    },

    getProjectConfig({ projectId }) {
      return config.get(projectId);
    },

    saveProjectConfig(input) {
      config.save(input);
      return { ok: true as const };
    },

    async listLinearIssues({ projectId }) {
      const { linearApiKey } = await settings.get();
      if (!linearApiKey) return { issues: [], error: "Configure a Linear API key first." };
      try {
        return { issues: await listConfiguredLinearIssues(linearApiKey, config.get(projectId)), error: null };
      } catch (error) {
        return { issues: [], error: error instanceof Error ? error.message : String(error) };
      }
    },

    async createWorkspaceFromLinear({ projectId, issueId }) {
      const { linearApiKey } = await settings.get();
      if (!linearApiKey) throw new Error("Configure a Linear API key first.");
      const issue = await getLinearIssue(linearApiKey, issueId);
      const prompt = [
        `Work on Linear issue ${issue.identifier}: ${issue.title}`,
        issue.description ?? "",
        issue.url ? `Linear: ${issue.url}` : "",
        "Implement the issue in this workspace. Keep the branch focused on this issue, run relevant checks, and open or update a pull request when ready.",
      ].filter(Boolean).join("\n\n");

      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: { type: "project-default" },
        title: `${issue.identifier}: ${issue.title}`,
        prompt,
      });

      return { threadId: thread.id, issueIdentifier: issue.identifier };
    },

    async startRun({ environmentId, projectId }) {
      const existing = runtimeByEnvironment.get(environmentId);
      if (existing) {
        await bb.sdk.terminals.close({ terminalId: existing, mode: "force" }).catch(() => undefined);
      }
      const command = config.get(projectId).runCommand || "npm run dev";
      const session = await createEnvironmentTerminal(bb, environmentId, {
        title: `Run · ${command}`,
        command,
      });
      const terminalId = (session as any).id as string;
      runtimeByEnvironment.set(environmentId, terminalId);
      bb.realtime.publish("runtime-changed", { environmentId, terminalId });
      return { terminalId };
    },

    async listTerminals({ environmentId }) {
      const result = await bb.sdk.terminals.list({ scope: { kind: "environment", environmentId } }) as any;
      return {
        terminals: (result.sessions ?? []).map((session: any) => ({
          id: String(session.id),
          title: String(session.title ?? "Terminal"),
        })),
      };
    },

    async createTerminal({ environmentId, title, command }) {
      const session = await createEnvironmentTerminal(bb, environmentId, { title, command });
      const terminalId = (session as any).id as string;
      bb.realtime.publish("terminal-changed", { environmentId, terminalId });
      return { terminalId };
    },

    async terminalOutput({ terminalId, sinceSeq }) {
      return terminalText(bb, terminalId, sinceSeq ?? 0);
    },

    async terminalInput({ terminalId, text }) {
      await bb.sdk.terminals.input({
        terminalId,
        dataBase64: Buffer.from(text, "utf8").toString("base64"),
      });
      return { ok: true as const };
    },

    async closeTerminal({ terminalId }) {
      await bb.sdk.terminals.close({ terminalId, mode: "force" });
      for (const [environmentId, id] of runtimeByEnvironment) {
        if (id === terminalId) runtimeByEnvironment.delete(environmentId);
      }
      return { ok: true as const };
    },

    async getPullRequestDetails({ environmentId }) {
      try {
        return { pullRequest: await getPullRequestDetails(bb, environmentId), error: null };
      } catch (error) {
        return { pullRequest: null, error: error instanceof Error ? error.message : String(error) };
      }
    },

    async mergePullRequest({ environmentId, projectId }) {
      return mergePullRequest(bb, environmentId, config.get(projectId).mergeMethod);
    },
  });

  bb.events.on("thread.created", ({ thread }) => {
    bb.realtime.publish("workspace-changed", { threadId: thread.id });
  });
  bb.events.on("thread.archived", ({ thread }) => {
    bb.realtime.publish("workspace-changed", { threadId: thread.id });
  });
}
