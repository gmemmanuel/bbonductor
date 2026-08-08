import type { LinearIssue, ProjectConfig } from "../shared/types";

const LINEAR_API = "https://api.linear.app/graphql";

async function linearRequest<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Linear returned HTTP ${response.status}`);
  const body = await response.json() as any;
  if (body.errors?.length) throw new Error(body.errors.map((e: any) => e.message).join("; "));
  return body.data as T;
}

export async function listConfiguredLinearIssues(apiKey: string, config: ProjectConfig): Promise<LinearIssue[]> {
  const data = config.linearTeamId
    ? await linearRequest<any>(apiKey, `
        query BbonductorIssues($teamId: ID!) {
          issues(
            first: 100,
            filter: { team: { id: { eq: $teamId } } }
          ) {
            nodes {
              id identifier title description url priority
              state { id name }
            }
          }
        }
      `, { teamId: config.linearTeamId })
    : await linearRequest<any>(apiKey, `
        query BbonductorIssues {
          issues(first: 100) {
            nodes {
              id identifier title description url priority
              state { id name }
            }
          }
        }
      `, {});

  const allowed = new Set(config.linearStatusNames.map((s) => s.toLowerCase()));
  return (data.issues?.nodes ?? [])
    .filter((issue: LinearIssue) => allowed.has(issue.state.name.toLowerCase()))
    .sort((a: LinearIssue, b: LinearIssue) => a.identifier.localeCompare(b.identifier));
}

export async function getLinearIssue(apiKey: string, issueId: string): Promise<LinearIssue> {
  const data = await linearRequest<any>(apiKey, `
    query BbonductorIssue($id: String!) {
      issue(id: $id) {
        id identifier title description url priority
        state { id name }
      }
    }
  `, { id: issueId });
  if (!data.issue) throw new Error("Linear issue not found");
  return data.issue;
}
