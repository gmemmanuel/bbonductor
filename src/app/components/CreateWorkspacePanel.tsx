import React, { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc";

export function CreateWorkspacePanel({ initialProjectId }: { initialProjectId?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [issues, setIssues] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void rpc.call("listProjects", null).then(({ projects }) => {
      setProjects(projects);
      if (!projectId && projects[0]) setProjectId(projects[0].id);
    });
  }, []);

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    void rpc.call("listLinearIssues", { projectId }).then((result) => {
      setIssues(result.issues);
      setError(result.error);
      setLoading(false);
    });
  }, [projectId]);

  return (
    <div className="mx-auto max-w-3xl p-5">
      <h2 className="mb-1 text-lg font-semibold">Create workspace</h2>
      <p className="mb-4 text-sm text-muted-foreground">Choose a Linear issue in the configured workflow state(s).</p>
      {projects.length > 1 ? (
        <select className="mb-4 w-full rounded-md border border-border bg-background px-3 py-2" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      ) : null}
      {loading ? <div>Loading Linear issues…</div> : null}
      {error ? <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</div> : null}
      <div className="divide-y divide-border rounded-md border border-border">
        {issues.map((issue) => (
          <button
            key={issue.id}
            className="flex w-full items-start gap-3 p-3 text-left hover:bg-accent"
            onClick={async () => {
              const created = await rpc.call("createWorkspaceFromLinear", { projectId, issueId: issue.id });
              navigate.toThread(created.threadId);
            }}
          >
            <span className="w-20 shrink-0 text-sm font-medium">{issue.identifier}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{issue.title}</span>
              <span className="block text-xs text-muted-foreground">{issue.state.name}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
