// Factory — frontend entry. One page: the founder's inbox on top, the
// swimlanes under it, then who plays each role and the standing agents.
// React and @get-bb/plugin-sdk/app are provided by bb at load time.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { FactoryState, rpcContract } from "./server";
import type { Config, InboxEntry, Item, Role } from "./src/factory/model";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const CHANGED = "factory-changed";
const PROJECT_KEY = "bbonductor.factory.project";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
interface Catalog {
  providers: { id: string; name: string }[];
  models: { providerId: string; id: string; name: string; reasoning: string[] }[];
}

function useFactory() {
  const rpc = useRpc<typeof rpcContract>();
  const [projectId, setProjectId] = useState<string | null>(() =>
    typeof localStorage === "undefined" ? null : localStorage.getItem(PROJECT_KEY),
  );
  const [state, setState] = useState<FactoryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("state", { projectId }).then((next) => {
      setState(next);
      setError(null);
    }, report);
  }, [rpc, projectId, report]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED, refetch);
  const selectProject = useCallback((id: string) => {
    localStorage.setItem(PROJECT_KEY, id);
    setProjectId(id);
  }, []);
  /** Run a mutation, then refetch; failures show in the page's error line. */
  const run = useCallback(
    (work: Promise<unknown>) => work.then(refetch, report),
    [refetch, report],
  );
  return { rpc, state, error, run, selectProject };
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs text-foreground";

// ------------------------------------------------------------------- inbox

const KIND_LABEL: Record<InboxEntry["kind"], string> = {
  question: "Decision",
  interaction: "Waiting in thread",
  stalled: "Stalled",
  failed: "Failed",
  blocked: "Blocked",
  check: "Try before it ships",
};

function InboxCard({ entry, rpc, run }: { entry: InboxEntry; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const navigate = useBbNavigate();
  const [answer, setAnswer] = useState("");
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (answer.trim() === "") return;
    run(rpc.call("answer", { entryId: entry.id, answer }));
    setAnswer("");
  };
  const urgent = entry.kind === "failed" || entry.kind === "stalled";
  return (
    <li className="space-y-2 rounded-lg border border-border bg-card p-4" data-testid="inbox-entry">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-medium",
            urgent ? "bg-destructive/15 text-destructive" : "bg-secondary text-secondary-foreground",
          )}
        >
          {KIND_LABEL[entry.kind]}
        </span>
        <span className="font-medium">{entry.from}</span>
        <span className="text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</span>
      </div>
      <p className="text-sm font-medium">{entry.question}</p>
      {entry.context === "" ? null : (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{entry.context}</p>
      )}
      {entry.options.length === 0 ? null : (
        <div className="flex flex-col items-stretch gap-1.5 sm:items-start">
          {entry.options.map((option, index) => (
            <Button
              key={option}
              variant="outline"
              size="sm"
              className="h-auto min-h-10 justify-start whitespace-normal py-2 text-left sm:min-h-0 sm:py-1.5"
              onClick={() => setAnswer(option)}
            >
              {String.fromCharCode(65 + index)}. {option}
            </Button>
          ))}
        </div>
      )}
      {entry.recommendation === "" ? null : (
        <p className="text-sm">
          <span className="font-medium">Recommendation: </span>
          {entry.recommendation}
        </p>
      )}
      <form onSubmit={send} className="flex flex-wrap items-center gap-2">
        {entry.kind === "interaction" ? null : (
          <>
            <Input
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder={entry.kind === "question" ? "Your decision" : entry.kind === "check" ? "What to change (sends it back to the builder)" : "Tell the agent what to do"}
              aria-label={`Answer ${entry.from}`}
              className="h-10 w-full basis-full text-base sm:h-9 sm:w-auto sm:min-w-48 sm:flex-1 sm:basis-0 sm:text-sm"
            />
            <Button type="submit" size="sm" variant={entry.kind === "check" ? "outline" : "default"} className="h-10 flex-1 sm:h-8 sm:flex-none" disabled={answer.trim() === ""}>
              {entry.kind === "check" ? "Send back" : "Send"}
            </Button>
          </>
        )}
        {entry.kind === "check" ? (
          <Button type="button" size="sm" className="h-10 flex-1 sm:h-8 sm:flex-none" onClick={() => run(rpc.call("approve", { entryId: entry.id }))}>
            Approve and ship
          </Button>
        ) : null}
        {entry.kind === "failed" ? (
          <Button type="button" size="sm" variant="outline" onClick={() => run(rpc.call("retry", { entryId: entry.id }))}>
            Retry
          </Button>
        ) : null}
        {entry.threadId === "" ? null : (
          <Button type="button" size="sm" variant="outline" onClick={() => navigate.toThread(entry.threadId)}>
            Open thread
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={() => run(rpc.call("dismiss", { entryId: entry.id }))}>
          Dismiss
        </Button>
      </form>
    </li>
  );
}

// --------------------------------------------------------------- swimlanes

const STATUS_STYLE: Record<Item["status"], string> = {
  queued: "text-muted-foreground",
  running: "text-foreground",
  "needs-founder": "text-destructive",
  "with-planner": "text-foreground",
  triage: "text-foreground",
  returned: "text-foreground",
  stalled: "text-destructive",
  failed: "text-destructive",
  done: "text-muted-foreground",
  archived: "text-muted-foreground",
  cancelled: "text-muted-foreground",
};
const STATUS_LABEL: Record<Item["status"], string> = {
  queued: "Queued",
  running: "Running",
  "needs-founder": "Needs you",
  "with-planner": "With plan reviewer",
  triage: "With chief of staff",
  returned: "Returned to planner",
  stalled: "Stalled",
  failed: "Failed",
  done: "Done",
  archived: "Archived",
  cancelled: "Cancelled",
};

function Ticket({ item, config, rpc, run, canMoveUp = false, canMoveDown = false }: { item: Item; config: Config; rpc: Rpc; run: (work: Promise<unknown>) => void; canMoveUp?: boolean; canMoveDown?: boolean }) {
  const navigate = useBbNavigate();
  const stages = config.pipelines[item.pipeline] ?? [];
  const stageId = stages[item.stageIndex];
  const stageLabel = stageId === undefined ? "" : (config.stages[stageId]?.label ?? stageId);
  const waiting = item.status === "queued";
  // The thread doing the work now, the planner it is waiting on, or for a
  // finished ticket the last thread that worked on it.
  const threadId =
    item.consult?.threadId ??
    (stageId === undefined ? undefined : item.threads[stageId]) ??
    stages.map((id) => item.threads[id]).filter((id) => id !== undefined).at(-1);
  return (
    <div className="space-y-1 rounded-md border border-border bg-card p-2.5 text-sm" data-testid="ticket">
      <div className="flex items-center gap-2">
        <span className="font-mono font-medium">{item.key}</span>
        <span className={cn("min-w-0 flex-1 truncate text-xs font-medium", STATUS_STYLE[item.status])}>
          {item.status === "done"
            ? "Merged"
            : item.status === "running" || waiting
            ? stageLabel
            : `${STATUS_LABEL[item.status]}${stageLabel === "" ? "" : ` · ${stageLabel}`}`}
        </span>
        {item.parked ? (
          <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground" data-testid="later">
            Later
          </span>
        ) : null}
        {item.tier === null ? null : (
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground" data-testid="tier">
            Tier {item.tier}
          </span>
        )}
      </div>
      <p className="text-muted-foreground">{item.title}</p>
      {waiting ? (
        canMoveUp || canMoveDown ? (
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" className="h-7 w-8 px-0" aria-label={`Move ${item.key} earlier`} disabled={!canMoveUp} onClick={() => run(rpc.call("reorder", { itemId: item.id, direction: "up" }))}>
              ↑
            </Button>
            <Button variant="outline" size="sm" className="h-7 w-8 px-0" aria-label={`Move ${item.key} later`} disabled={!canMoveDown} onClick={() => run(rpc.call("reorder", { itemId: item.id, direction: "down" }))}>
              ↓
            </Button>
          </div>
        ) : null
      ) : threadId === undefined ? null : (
        <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => navigate.toThread(threadId)}>
          Open thread
        </Button>
      )}
    </div>
  );
}

function Swimlanes({ state, rpc, run }: { state: FactoryState; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const open = state.items.filter((item) => item.status !== "done" && item.status !== "archived" && item.status !== "cancelled");
  // Merged, with a workspace the founder has not archived yet.
  const finished = state.items.filter((item) => item.status === "done");
  const lanes = [...new Set(open.map((item) => item.lane))];
  const doneLane = finished.length === 0 ? null : (
    <div className="space-y-2">
      {finished.map((item) => (
        <Ticket key={item.id} item={item} config={state.config} rpc={rpc} run={run} />
      ))}
    </div>
  );
  // Only waiting tickets move, and only among the waiting tickets of their lane.
  const moves = (item: Item) => {
    const queue = open.filter((other) => other.lane === item.lane && other.status === "queued" && !other.parked);
    if (item.parked) return { canMoveUp: false, canMoveDown: false };
    const index = queue.findIndex((other) => other.id === item.id);
    return { canMoveUp: index > 0, canMoveDown: index !== -1 && index < queue.length - 1 };
  };
  if (lanes.length === 0 && finished.length === 0) {
    return <Empty>No tickets yet. Lanes fill from the swimlane schedule.</Empty>;
  }
  return (
    <>
    {/* Phones: one card per lane, tickets stacked in order. */}
    <div className="space-y-3 md:hidden">
      {lanes.map((lane) => (
        <div key={lane} className="space-y-2 rounded-lg border border-border p-3" data-testid="lane-card">
          <div className="text-sm font-medium">{lane}</div>
          {open
            .filter((item) => item.lane === lane)
            .map((item) => (
              <Ticket key={item.id} item={item} config={state.config} rpc={rpc} run={run} {...moves(item)} />
            ))}
        </div>
      ))}
      {doneLane === null ? null : (
        <div className="space-y-2 rounded-lg border border-border p-3" data-testid="done-lane">
          <div className="text-sm font-medium">Done</div>
          <p className="text-xs text-muted-foreground">Merged. Archive a workspace in the sidebar to clear it from here.</p>
          {doneLane}
        </div>
      )}
    </div>
    <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
      <table className="w-full min-w-[640px] border-collapse text-left align-top">
        <thead className="bg-secondary/40 text-xs text-muted-foreground">
          <tr>
            <th className="w-36 px-3 py-2 font-medium">Track</th>
            <th className="w-[42%] px-3 py-2 font-medium">Right now</th>
            <th className="px-3 py-2 font-medium">Next up</th>
          </tr>
        </thead>
        <tbody>
          {lanes.map((lane) => {
            const [head, ...rest] = open.filter((item) => item.lane === lane);
            return (
              <tr key={lane} className="border-t border-border align-top" data-testid="lane">
                <td className="px-3 py-3 text-sm font-medium">{lane}</td>
                <td className="px-3 py-3">
                  {head === undefined ? null : <Ticket item={head} config={state.config} rpc={rpc} run={run} {...moves(head)} />}
                </td>
                <td className="space-y-2 px-3 py-3">
                  {rest.map((item) => (
                    <Ticket key={item.id} item={item} config={state.config} rpc={rpc} run={run} {...moves(item)} />
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {doneLane === null ? null : (
        <div className="grid grid-cols-[9rem_1fr] border-t border-border" data-testid="done-lane">
          <div className="px-3 py-3 text-sm font-medium">
            Done
            <p className="mt-1 text-xs font-normal text-muted-foreground">Merged. Archive a workspace in the sidebar to clear it.</p>
          </div>
          <div className="grid gap-2 px-3 py-3 lg:grid-cols-2">
            {finished.map((item) => (
              <Ticket key={item.id} item={item} config={state.config} rpc={rpc} run={run} />
            ))}
          </div>
        </div>
      )}
    </div>
    </>
  );
}

// -------------------------------------------------------------------- roles

function Roles({ state, rpc, run }: { state: FactoryState; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const [catalog, setCatalog] = useState<Catalog>({ providers: [], models: [] });
  const projectId = state.projectId;
  useEffect(() => {
    if (projectId === null) return;
    rpc.call("catalog", { projectId }).then(setCatalog, () => undefined);
  }, [rpc, projectId]);
  if (projectId === null) return null;
  const save = (config: Config) => run(rpc.call("saveConfig", { projectId, config }));
  const setRole = (id: string, patch: Partial<Role>) =>
    save({ ...state.config, roles: { ...state.config.roles, [id]: { ...state.config.roles[id]!, ...patch } } });
  const usedBy = (roleId: string) => [
    ...Object.values(state.config.stages).filter((stage) => stage.role === roleId).map((stage) => stage.label),
    ...Object.values(state.config.stages).flatMap((stage) =>
      Object.entries(stage.tierRoles).filter(([, role]) => role === roleId).map(([tier]) => `${stage.label} for tier ${tier} plans`),
    ),
    ...Object.values(state.config.agents).filter((agent) => agent.role === roleId).map((agent) => agent.label),
  ];
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[700px] text-left text-sm">
          <thead className="bg-secondary/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Thinking</th>
              <th className="px-3 py-2 font-medium">If its limit runs out</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(state.config.roles).map(([id, role]) => {
              const models = catalog.models.filter((model) => role.providerId === "" || model.providerId === role.providerId);
              const reasoning = models.find((model) => model.id === role.model)?.reasoning ?? [];
              // Keep a saved value selectable even when the catalog does not list it.
              const withCurrent = (values: string[], current: string) =>
                current === "" || values.includes(current) ? values : [current, ...values];
              return (
                <tr key={id} className="border-t border-border" data-testid="role">
                  <td className="px-3 py-2">
                    <div className="font-medium">{role.label}</div>
                    <div className="text-xs text-muted-foreground">{usedBy(id).join(", ")}</div>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      className={cn(selectClass, "w-56")}
                      aria-label={`${role.label} model`}
                      value={role.model === "" ? "" : `${role.providerId}|${role.model}`}
                      onChange={(e) => {
                        const [providerId = "", model = ""] = e.target.value.split("|");
                        setRole(id, { providerId, model, reasoningLevel: "" });
                      }}
                    >
                      <option value="">Project default</option>
                      {role.model !== "" && !catalog.models.some((m) => m.providerId === role.providerId && m.id === role.model) ? (
                        <option value={`${role.providerId}|${role.model}`}>{role.model}</option>
                      ) : null}
                      {catalog.providers.map((provider) => (
                        <optgroup key={provider.id} label={provider.name}>
                          {catalog.models
                            .filter((m) => m.providerId === provider.id)
                            .map((m) => (
                              <option key={m.id} value={`${provider.id}|${m.id}`}>
                                {m.name}
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select className={cn(selectClass, "w-24")} aria-label={`${role.label} thinking`} value={role.reasoningLevel} onChange={(e) => setRole(id, { reasoningLevel: e.target.value })}>
                      <option value="">Default</option>
                      {withCurrent(reasoning, role.reasoningLevel).map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      className={cn(selectClass, "w-56")}
                      aria-label={`${role.label} fallback`}
                      value={role.fallbackModel === "" ? "" : `${role.fallbackProviderId || role.providerId}|${role.fallbackModel}`}
                      onChange={(e) => {
                        const [providerId = "", model = ""] = e.target.value.split("|");
                        setRole(id, {
                          fallbackProviderId: model === "" || providerId === role.providerId ? "" : providerId,
                          fallbackModel: model,
                          fallbackReasoningLevel: "",
                        });
                      }}
                    >
                      <option value="">Ask me</option>
                      {role.fallbackModel !== "" &&
                      !catalog.models.some((m) => m.providerId === (role.fallbackProviderId || role.providerId) && m.id === role.fallbackModel) ? (
                        <option value={`${role.fallbackProviderId || role.providerId}|${role.fallbackModel}`}>
                          {role.fallbackModel}
                        </option>
                      ) : null}
                      {catalog.providers.map((provider) => (
                        <optgroup key={provider.id} label={provider.name}>
                          {catalog.models
                            .filter((m) => m.providerId === provider.id && !(provider.id === role.providerId && m.id === role.model))
                            .map((m) => (
                              <option key={m.id} value={`${provider.id}|${m.id}`}>
                                {m.name}
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- agents

function Agents({ state, rpc, run }: { state: FactoryState; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const navigate = useBbNavigate();
  const projectId = state.projectId;
  if (projectId === null) return null;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {Object.entries(state.config.agents).map(([agentId, agent]) => {
        const live = state.agents.find((candidate) => candidate.agentId === agentId);
        const threadId = live?.threadId ?? null;
        return (
          <li key={agentId} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm" data-testid="agent">
            <div className="min-w-40 flex-1">
              <div className="font-medium">{agent.label}</div>
              <div className="text-xs text-muted-foreground">
                {threadId === null
                  ? "Not started"
                  : live?.rotating === true
                    ? "Writing its handoff; a fresh thread starts when it finishes"
                    : `Running since ${new Date(live?.startedAt ?? 0).toLocaleDateString()}`}
                {" · memory in "}
                <code>{agent.memoryPath}</code>
              </div>
            </div>
            {threadId === null ? (
              <Button size="sm" onClick={() => run(rpc.call("startAgent", { projectId, agentId }))}>
                Start
              </Button>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={() => navigate.toThread(threadId)}>
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Fresh thread: have it write its memory, then replace it"
                  disabled={live?.rotating === true}
                  onClick={() => run(rpc.call("rotateAgent", { projectId, agentId }))}
                >
                  Fresh thread
                </Button>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// --------------------------------------------------------------------- page

function FactoryPage() {
  const { rpc, state, error, run, selectProject } = useFactory();
  const inbox = useMemo(() => state?.inbox ?? [], [state]);
  if (state === null) {
    return <div className="p-5 text-sm text-muted-foreground">{error ?? "Loading the factory…"}</div>;
  }
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-5xl space-y-6 px-4 pb-8 pt-3 md:px-5 md:pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-muted-foreground" htmlFor="factory-project">
            Project
          </label>
          <select id="factory-project" className={selectClass} value={state.projectId ?? ""} onChange={(e) => selectProject(e.target.value)}>
            {state.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Section title={`Inbox${inbox.length === 0 ? "" : ` (${inbox.length})`}`} hint="Decisions only you can make, from every project.">
          {inbox.length === 0 ? (
            <Empty>Nothing needs you.</Empty>
          ) : (
            <ul className="space-y-2">
              {inbox.map((entry) => (
                <InboxCard key={entry.id} entry={entry} rpc={rpc} run={run} />
              ))}
            </ul>
          )}
        </Section>
        {state.projectId === null ? (
          <Empty>Add a project to bb to start a factory.</Empty>
        ) : (
          <>
            <Section title="Swimlanes" hint="One ticket in flight per lane. Use the arrows to reorder what is next.">
              <Swimlanes state={state} rpc={rpc} run={run} />
            </Section>
            <Section title="Standing agents" hint="Long-lived threads in the main checkout, each with a memory file in the repo.">
              <Agents state={state} rpc={rpc} run={run} />
            </Section>
            <Section title="Who plays each role" hint="Applies to the next stage that starts. Change it whenever your limits change.">
              <Roles state={state} rpc={rpc} run={run} />
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

/** Rail badge: how many things are waiting on the founder. */
function useInboxBadge() {
  const rpc = useRpc<typeof rpcContract>();
  const [count, setCount] = useState(0);
  const refetch = useCallback(() => {
    rpc.call("state", { projectId: null }).then(
      (state) => setCount(state.inbox.length),
      () => undefined,
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED, refetch);
  return count === 0 ? null : { count, label: `${count} waiting on you`, tone: "warning" as const };
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "factory",
    title: "Factory",
    icon: "Workflow",
    path: "factory",
    component: FactoryPage,
    experimental_useBadge: useInboxBadge,
  });
});
