import React, { useEffect, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc";

export function SettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [config, setConfig] = useState<any>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void rpc.call("listProjects", null).then(({ projects }) => {
      setProjects(projects);
      if (projects[0]) setProjectId(projects[0].id);
    });
  }, []);

  useEffect(() => {
    if (!projectId) return;
    setConfig(null);
    void rpc.call("getProjectConfig", { projectId }).then(setConfig);
  }, [projectId]);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-5">
      <div>
        <h2 className="text-lg font-semibold">bbonductor configuration</h2>
        <p className="text-sm text-muted-foreground">Project-specific workflow settings. The Linear API key is stored separately as a secret in BB's plugin settings.</p>
      </div>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">BB project</span>
        <select className="w-full rounded-md border border-border bg-background px-3 py-2" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      {!config ? <p className="text-sm text-muted-foreground">Loading…</p> : <>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Run command</span>
          <input className="w-full rounded-md border border-border bg-background px-3 py-2" value={config.runCommand} onChange={(e) => setConfig({ ...config, runCommand: e.target.value })} />
          <span className="mt-1 block text-xs text-muted-foreground">Used by the workspace-level ▶ Run button. Example: npm run dev</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Linear team ID</span>
          <input className="w-full rounded-md border border-border bg-background px-3 py-2" value={config.linearTeamId ?? ""} onChange={(e) => setConfig({ ...config, linearTeamId: e.target.value || undefined })} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Linear statuses</span>
          <input className="w-full rounded-md border border-border bg-background px-3 py-2" value={config.linearStatusNames.join(", ")} onChange={(e) => setConfig({ ...config, linearStatusNames: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} />
          <span className="mt-1 block text-xs text-muted-foreground">Default: Todo. Only issues in these states appear under Create workspace.</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Merge method</span>
          <select className="w-full rounded-md border border-border bg-background px-3 py-2" value={config.mergeMethod} onChange={(e) => setConfig({ ...config, mergeMethod: e.target.value })}>
            <option value="squash">Squash</option>
            <option value="merge">Merge commit</option>
            <option value="rebase">Rebase</option>
          </select>
        </label>
        <button className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground" onClick={async () => { const cleaned = { ...config }; if (!cleaned.linearTeamId) delete cleaned.linearTeamId; await rpc.call("saveProjectConfig", cleaned); setSaved(true); setTimeout(() => setSaved(false), 1500); }}>
          {saved ? "Saved" : "Save settings"}
        </button>
      </>}
    </div>
  );
}
