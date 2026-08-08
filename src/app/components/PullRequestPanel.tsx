import React, { useEffect, useState } from "react";
import { useBbContext, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc";

export function PullRequestPanel({ params }: { threadId: string; params: any }) {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId } = useBbContext();
  const environmentId = params?.environmentId as string | undefined;
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!environmentId) return;
    const result = await rpc.call("getPullRequestDetails", { environmentId });
    setData(result.pullRequest);
    setError(result.error);
  }
  useEffect(() => { void refresh(); }, [environmentId]);

  if (!environmentId) return <div className="p-4">No workspace environment.</div>;
  if (error) return <div className="p-4 text-destructive">{error}</div>;
  if (!data) return <div className="p-4 text-sm text-muted-foreground">No pull request found for this branch.</div>;

  const failing = (data.checks ?? []).filter((c: any) => c.conclusion && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion));
  return (
    <div className="space-y-4 p-4">
      <div>
        <div className="text-xs text-muted-foreground">PR #{data.number}</div>
        <div className="font-medium">{data.title}</div>
        <div className="mt-1 text-xs text-muted-foreground">{data.mergeable ?? "UNKNOWN"} · {data.reviewDecision ?? "No review decision"}</div>
      </div>
      <div>
        <div className="mb-2 text-sm font-medium">Checks</div>
        <div className="space-y-1">
          {(data.checks ?? []).map((check: any) => (
            <div key={check.name} className="flex justify-between gap-3 text-xs">
              <span className="truncate">{check.name}</span>
              <span className="text-muted-foreground">{check.conclusion ?? check.status ?? "pending"}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="rounded border border-border px-3 py-2 text-sm hover:bg-accent" onClick={() => void refresh()}>Refresh</button>
        <button
          disabled={!projectId || data.isDraft || data.mergeable === "CONFLICTING" || failing.length > 0}
          className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
          onClick={async () => {
            if (!projectId) return;
            const result = await rpc.call("mergePullRequest", { environmentId, projectId });
            window.alert(result.message);
            await refresh();
          }}
        >Merge</button>
      </div>
      {(data.mergeable === "CONFLICTING" || failing.length > 0) ? (
        <div className="rounded-md border border-border p-3 text-sm">
          <strong>Agent repair actions are next.</strong>
          <p className="mt-1 text-muted-foreground">The MVP reads conflicts and CI state. The next milestone adds one-click “Resolve conflicts” and “Fix CI” actions that spawn a new agent thread in this same environment with the failing context attached.</p>
        </div>
      ) : null}
    </div>
  );
}
