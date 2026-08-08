import type { BbPluginApi } from "@bb/plugin-sdk";
import type { MergeMethod, PullRequestSummary } from "../shared/types";
import { runEphemeralCommand } from "./terminals";

export async function getPullRequestDetails(bb: BbPluginApi, environmentId: string): Promise<PullRequestSummary | null> {
  const fields = [
    "number", "title", "url", "state", "isDraft", "mergeable", "mergeStateStatus",
    "reviewDecision", "statusCheckRollup",
  ].join(",");
  const result = await runEphemeralCommand(
    bb,
    environmentId,
    `gh pr view --json ${fields} 2>/dev/null`,
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  const raw = JSON.parse(result.stdout.trim());
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    isDraft: raw.isDraft,
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
    reviewDecision: raw.reviewDecision,
    checks: (raw.statusCheckRollup ?? []).map((check: any) => ({
      name: check.name ?? check.context ?? "check",
      status: check.status,
      conclusion: check.conclusion ?? check.state,
      detailsUrl: check.detailsUrl ?? check.targetUrl,
    })),
  };
}

export async function mergePullRequest(
  bb: BbPluginApi,
  environmentId: string,
  method: MergeMethod,
) {
  const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";
  const result = await runEphemeralCommand(bb, environmentId, `gh pr merge ${flag}`);
  return {
    ok: result.exitCode === 0,
    message: result.stdout.trim() || (result.exitCode === 0 ? "Merged" : "Merge failed"),
  };
}
