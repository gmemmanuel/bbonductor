import React, { useMemo, useState } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  useBbNavigate,
  useRpc,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc";

function PrBadge({ threadId, environmentId }: { threadId: string; environmentId: string }) {
  const { pullRequest } = useSidebarThreadPullRequest(threadId);
  const navigate = useBbNavigate();
  if (!pullRequest) return null;
  const attention = pullRequest.attention ? " !" : "";
  return (
    <button
      className="rounded px-1 text-xs text-muted-foreground hover:bg-accent"
      title={pullRequest.title}
      onClick={() => navigate.openThreadPanel({
        actionId: "pull-request",
        title: `PR #${pullRequest.number}`,
        params: { environmentId },
      })}
    >PR #{pullRequest.number}{attention}</button>
  );
}

function WorkspaceRow({
  workspace,
  activeThreadId,
  onNavigate,
}: {
  workspace: any;
  activeThreadId: string | null;
  onNavigate: () => void;
}) {
  const actions = useSidebarThreadActions();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [expanded, setExpanded] = useState(true);
  const representative = workspace.threads[0];

  async function run() {
    const { terminalId } = await rpc.call("startRun", {
      environmentId: workspace.environmentId,
      projectId: workspace.projectId,
    });
    const target = workspace.threads.find((t: any) => t.id === activeThreadId) ?? representative;
    if (target) {
      actions.open(target.id);
      navigate.openThreadPanel({
        actionId: "runtime",
        title: "Runtime",
        params: { environmentId: workspace.environmentId, terminalId },
      });
    }
  }

  return (
    <div className="border-b border-border/50 py-1">
      <div className="flex items-center gap-1 px-2 py-1">
        <button className="min-w-0 flex-1 text-left" onClick={() => setExpanded(!expanded)}>
          <div className="truncate text-sm font-medium">{workspace.label}</div>
          <div className="truncate text-xs text-muted-foreground">{workspace.branchName || "main"}</div>
        </button>
        {representative ? <PrBadge threadId={representative.id} environmentId={workspace.environmentId} /> : null}
        <button className="rounded px-2 py-1 text-xs hover:bg-accent" onClick={() => void run()} title="Run configured command">▶</button>
        <button
          className="rounded px-2 py-1 text-xs hover:bg-accent"
          title="New thread in this workspace"
          onClick={() => {
            actions.openNewThread({ projectId: workspace.projectId });
          }}
        >+</button>
      </div>
      {expanded ? (
        <div className="pb-1 pl-3">
          {workspace.threads.map((thread: any) => (
            <a
              key={thread.id}
              data-sidebar-thread-shortcut-target=""
              data-sidebar-thread-id={thread.id}
              className={`block cursor-pointer truncate rounded px-2 py-1 text-sm hover:bg-accent ${thread.id === activeThreadId ? "bg-accent" : ""}`}
              onClick={(event) => {
                event.preventDefault();
                actions.open(thread.id);
                onNavigate();
              }}
            >
              <span>{thread.isPinned ? "★ " : ""}{thread.title}</span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceSidebar(props: {
  activeThreadId: string | null;
  activeProjectId: string | null;
  isCompactViewport: boolean;
  onNavigate: () => void;
  searchQuery: string;
}) {
  const { status, threads, projects } = useSidebarThreads();
  const navigate = useBbNavigate();

  const grouped = useMemo(() => {
    const projectMap = new Map<string, any[]>();
    for (const thread of threads) {
      const haystack = `${thread.title} ${thread.environment?.branchName ?? ""}`.toLowerCase();
      if (props.searchQuery && !haystack.includes(props.searchQuery.toLowerCase())) continue;
      const list = projectMap.get(thread.projectId) ?? [];
      list.push(thread);
      projectMap.set(thread.projectId, list);
    }

    return [...projectMap.entries()].map(([projectId, projectThreads]) => {
      const environments = new Map<string, any>();
      for (const thread of projectThreads) {
        const environmentId = thread.environment?.id ?? `thread:${thread.id}`;
        const current = environments.get(environmentId) ?? {
          environmentId,
          projectId,
          branchName: thread.environment?.branchName ?? null,
          threads: [],
        };
        current.threads.push(thread);
        environments.set(environmentId, current);
      }
      const workspaces = [...environments.values()].map((workspace) => {
        const isMain = !workspace.branchName || workspace.branchName === "main" || workspace.branchName === "master";
        workspace.threads.sort((a: any, b: any) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt.localeCompare(a.updatedAt));
        workspace.isMain = isMain;
        workspace.label = isMain
          ? "Main"
          : workspace.threads.find((t: any) => /^([A-Z]+-\d+)/.test(t.title))?.title ?? workspace.branchName;
        return workspace;
      });
      workspaces.sort((a, b) => Number(b.isMain) - Number(a.isMain));
      return {
        projectId,
        projectName: projects.find((p: any) => p.id === projectId)?.name ?? "Project",
        workspaces,
      };
    });
  }, [threads, projects, props.searchQuery]);

  if (status !== "ready") return <div className="p-3 text-sm text-muted-foreground">Loading workspaces…</div>;

  const showProjectHeaders = grouped.length > 1;
  return (
    <div>
      <div className="flex items-center gap-2 px-2 pb-2 pt-1">
        <button
          className="w-full rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent"
          onClick={() => {
            const projectId = props.activeProjectId ?? (grouped.length === 1 ? grouped[0]?.projectId : undefined);
            navigate.toPluginPanel("workspaces", { subPath: projectId ? `create/${projectId}` : "create" });
          }}
        >
          + Create workspace
        </button>
      </div>
      {grouped.map((project) => (
        <div key={project.projectId}>
          {showProjectHeaders ? (
            <div className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{project.projectName}</div>
          ) : null}
          {project.workspaces.map((workspace: any) => (
            <WorkspaceRow
              key={workspace.environmentId}
              workspace={workspace}
              activeThreadId={props.activeThreadId}
              onNavigate={props.onNavigate}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
