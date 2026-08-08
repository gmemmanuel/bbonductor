export type MergeMethod = "merge" | "squash" | "rebase";

export interface ProjectConfig {
  projectId: string;
  runCommand: string;
  linearTeamId?: string;
  linearStatusNames: string[];
  mergeMethod: MergeMethod;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url?: string | null;
  state: { id: string; name: string };
  priority?: number | null;
}

export interface WorkspaceRuntime {
  environmentId: string;
  runTerminalId?: string;
  terminals: Array<{
    id: string;
    title: string;
  }>;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  checks?: Array<{
    name: string;
    status?: string;
    conclusion?: string;
    detailsUrl?: string;
  }>;
}
