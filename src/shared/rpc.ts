import { defineRpcContract } from "@bb/plugin-sdk";
import { z } from "zod";

const projectConfig = z.object({
  projectId: z.string(),
  runCommand: z.string(),
  linearTeamId: z.string().optional(),
  linearStatusNames: z.array(z.string()),
  mergeMethod: z.enum(["merge", "squash", "rebase"]),
});

const linearIssue = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  state: z.object({ id: z.string(), name: z.string() }),
  priority: z.number().nullable().optional(),
});

export const rpcContract = defineRpcContract({
  listProjects: {
    input: z.null(),
    output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() })) }),
  },
  getProjectConfig: {
    input: z.object({ projectId: z.string() }),
    output: projectConfig,
  },
  saveProjectConfig: {
    input: projectConfig,
    output: z.object({ ok: z.literal(true) }),
  },
  listLinearIssues: {
    input: z.object({ projectId: z.string() }),
    output: z.object({ issues: z.array(linearIssue), error: z.string().nullable() }),
  },
  createWorkspaceFromLinear: {
    input: z.object({ projectId: z.string(), issueId: z.string() }),
    output: z.object({ threadId: z.string(), issueIdentifier: z.string() }),
  },
  startRun: {
    input: z.object({ environmentId: z.string(), projectId: z.string() }),
    output: z.object({ terminalId: z.string() }),
  },
  listTerminals: {
    input: z.object({ environmentId: z.string() }),
    output: z.object({
      terminals: z.array(z.object({ id: z.string(), title: z.string() })),
    }),
  },
  createTerminal: {
    input: z.object({
      environmentId: z.string(),
      title: z.string().optional(),
      command: z.string().optional(),
    }),
    output: z.object({ terminalId: z.string() }),
  },
  terminalOutput: {
    input: z.object({ terminalId: z.string(), sinceSeq: z.number().optional() }),
    output: z.object({
      text: z.string(),
      nextSeq: z.number(),
      exited: z.boolean(),
      exitCode: z.number().nullable(),
    }),
  },
  terminalInput: {
    input: z.object({ terminalId: z.string(), text: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  closeTerminal: {
    input: z.object({ terminalId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  getPullRequestDetails: {
    input: z.object({ environmentId: z.string() }),
    output: z.object({
      pullRequest: z.object({
        number: z.number(),
        title: z.string(),
        url: z.string(),
        state: z.string(),
        isDraft: z.boolean().optional(),
        mergeable: z.string().optional(),
        mergeStateStatus: z.string().optional(),
        reviewDecision: z.string().optional(),
        checks: z.array(z.object({
          name: z.string(),
          status: z.string().optional(),
          conclusion: z.string().optional(),
          detailsUrl: z.string().optional(),
        })).optional(),
      }).nullable(),
      error: z.string().nullable(),
    }),
  },
  mergePullRequest: {
    input: z.object({ environmentId: z.string(), projectId: z.string() }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
});
