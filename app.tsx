import React from "react";
import { definePluginApp } from "@bb/plugin-sdk/app";
import { WorkspaceSidebar } from "./src/app/components/WorkspaceSidebar";
import { CreateWorkspacePanel } from "./src/app/components/CreateWorkspacePanel";
import { SettingsSection } from "./src/app/components/SettingsSection";
import { RuntimePanel } from "./src/app/components/RuntimePanel";
import { PullRequestPanel } from "./src/app/components/PullRequestPanel";

function WorkspacesPanel({ subPath }: { subPath: string }) {
  const parts = subPath.split("/").filter(Boolean);
  if (parts[0] === "create") return <CreateWorkspacePanel initialProjectId={parts[1]} />;
  return <CreateWorkspacePanel />;
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "bbonductor-workspaces",
    title: "bbonductor",
    description: "Group bb threads by environment/worktree instead of treating every thread as a workspace.",
    component: WorkspaceSidebar,
  });

  app.slots.navPanel({
    id: "workspaces",
    title: "Workspaces",
    icon: "GitBranch",
    path: "workspaces",
    component: WorkspacesPanel,
  });

  app.slots.settingsSection({
    id: "secret-settings-help",
    title: "Linear connection",
    description: "Set the Linear API key in the host-rendered secret field above. Project-specific settings live under the bbonductor Configuration page.",
    component: () => <div className="text-sm text-muted-foreground">Use the Configuration page to set run commands, Linear workflow states, and merge behavior per project.</div>,
  });

  app.slots.navPanel({
    id: "configuration",
    title: "Configuration",
    icon: "Settings",
    path: "configuration",
    component: SettingsSection,
  });

  app.slots.threadPanelAction({
    id: "runtime",
    title: "Runtime",
    icon: "Terminal",
    layout: "flush",
    component: RuntimePanel,
  });

  app.slots.threadPanelAction({
    id: "pull-request",
    title: "Pull request",
    icon: "GitPullRequest",
    layout: "flush",
    component: PullRequestPanel,
  });
});
