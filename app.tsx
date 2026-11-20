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
              placeholder={entry.kind === "question" ? "Your decision" : "Tell the agent what to do"}
              aria-label={`Answer ${entry.from}`}
              className="h-10 w-full basis-full text-base sm:h-9 sm:w-auto sm:min-w-48 sm:flex-1 sm:basis-0 sm:text-sm"
            />
            <Button type="submit" size="sm" className="h-10 flex-1 sm:h-8 sm:flex-none" disabled={answer.trim() === ""}>
              Send
            </Button>
          </>
        )}
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
  returned: "text-foreground",
  stalled: "text-destructive",
  failed: "text-destructive",
  done: "text-muted-foreground",
  cancelled: "text-muted-foreground",
};
const STATUS_LABEL: Record<Item["status"], string> = {
  queued: "Queued",
  running: "Running",
  "needs-founder": "Needs you",
  returned: "Returned to planner",
  stalled: "Stalled",
  failed: "Failed",
  done: "Done",
  cancelled: "Cancelled",
};

function Ticket({ item, config, lanes, rpc, run }: { item: Item; config: Config; lanes: string[]; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const navigate = useBbNavigate();
  const stages = config.pipelines[item.pipeline] ?? [];
  const stageId = stages[item.stageIndex];
  const stageLabel = stageId === undefined ? "" : (config.stages[stageId]?.label ?? stageId);
  return (
    <div className="space-y-1 rounded-md border border-border bg-card p-2.5 text-sm" data-testid="ticket">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono font-medium">{item.key}</span>
        <span className={cn("text-xs font-medium", STATUS_STYLE[item.status])}>
          {item.status === "running" || item.status === "queued"
            ? `${stageLabel}${item.status === "queued" ? " (queued)" : ""}`
            : `${STATUS_LABEL[item.status]}${stageLabel === "" ? "" : ` · ${stageLabel}`}`}
        </span>
      </div>
      <p className="text-muted-foreground">
        {item.title}
        {item.tier === null ? null : <span className="text-xs"> · tier {item.tier} plan</span>}
      </p>
      <div className="flex flex-wrap items-center gap-1">
        {stages
          .filter((id) => item.threads[id] !== undefined)
          .map((id) => (
            <Button key={id} variant="outline" size="sm" className="h-6 px-2" onClick={() => navigate.toThread(item.threads[id]!)}>
              {config.stages[id]?.label ?? id}
            </Button>
          ))}
        <select
          className={cn(selectClass, "h-6")}
          aria-label={`Move ${item.key} to lane`}
          value={item.lane}
          onChange={(event) => run(rpc.call("move", { itemId: item.id, lane: event.target.value }))}
        >
          {lanes.map((lane) => (
            <option key={lane} value={lane}>
              {lane}
            </option>
          ))}
        </select>
        {item.status === "queued" ? null : (
          <Button variant="ghost" size="sm" className="h-6 px-2" aria-label="Advance: skip the current stage" onClick={() => run(rpc.call("advance", { itemId: item.id }))}>
            Advance
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => run(rpc.call("cancel", { itemId: item.id }))}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Swimlanes({ state, rpc, run }: { state: FactoryState; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const open = state.items.filter((item) => item.status !== "done" && item.status !== "cancelled");
  const lanes = [...new Set(open.map((item) => item.lane))];
  const done = state.items.filter((item) => item.status === "done").length;
  if (lanes.length === 0) {
    return <Empty>No tickets yet. Add one below, or ask the orchestrator to queue work.</Empty>;
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
              <Ticket key={item.id} item={item} config={state.config} lanes={lanes} rpc={rpc} run={run} />
            ))}
        </div>
      ))}
      {done === 0 ? null : <p className="text-xs text-muted-foreground">{done} finished</p>}
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
                  {head === undefined ? null : <Ticket item={head} config={state.config} lanes={lanes} rpc={rpc} run={run} />}
                </td>
                <td className="space-y-2 px-3 py-3">
                  {rest.map((item) => (
                    <Ticket key={item.id} item={item} config={state.config} lanes={lanes} rpc={rpc} run={run} />
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {done === 0 ? null : <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{done} finished</p>}
    </div>
    </>
  );
}

function AddTicket({ state, rpc, run }: { state: FactoryState; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [lane, setLane] = useState("");
  const [pipeline, setPipeline] = useState(state.config.defaultPipeline);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (state.projectId === null || key.trim() === "" || title.trim() === "") return;
    run(rpc.call("enqueue", { projectId: state.projectId, key, title, brief: "", lane, pipeline }));
    setKey("");
    setTitle("");
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Key (JUS-123)" aria-label="Ticket key" className="w-full sm:w-32" />
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ticket title" aria-label="Ticket title" className="min-w-48 flex-1" />
      <Input value={lane} onChange={(e) => setLane(e.target.value)} placeholder="Lane" aria-label="Lane" className="w-full sm:w-32" />
      <select className={selectClass} aria-label="Pipeline" value={pipeline} onChange={(e) => setPipeline(e.target.value)}>
        {Object.entries(state.config.pipelines).map(([name, stages]) => (
          <option key={name} value={name}>
            {name}: {stages.map((id) => state.config.stages[id]?.label ?? id).join(" → ")}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" disabled={key.trim() === "" || title.trim() === ""}>
        Add ticket
      </Button>
    </form>
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
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="bg-secondary/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Provider</th>
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
                    <select className={cn(selectClass, "w-36")} aria-label={`${role.label} provider`} value={role.providerId} onChange={(e) => setRole(id, { providerId: e.target.value, model: "", reasoningLevel: "" })}>
                      <option value="">Project default</option>
                      {withCurrent(catalog.providers.map((p) => p.id), role.providerId).map((providerId) => (
                        <option key={providerId} value={providerId}>
                          {catalog.providers.find((p) => p.id === providerId)?.name ?? providerId}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select className={cn(selectClass, "w-48")} aria-label={`${role.label} model`} value={role.model} onChange={(e) => setRole(id, { model: e.target.value, reasoningLevel: "" })}>
                      <option value="">Default</option>
                      {withCurrent([...new Set(models.map((m) => m.id))], role.model).map((modelId) => (
                        <option key={modelId} value={modelId}>
                          {models.find((m) => m.id === modelId)?.name ?? modelId}
                        </option>
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
      <label className="flex items-center gap-2 text-sm">
        Tickets in flight at once
        <select
          className={selectClass}
          value={state.config.maxActiveItems}
          onChange={(e) => save({ ...state.config, maxActiveItems: Number(e.target.value) })}
        >
          {Array.from({ length: 16 }, (_, index) => index + 1).map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </select>
      </label>
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
            <Section title="Swimlanes" hint="A lane works one ticket at a time, top to bottom. Lanes run side by side.">
              <Swimlanes state={state} rpc={rpc} run={run} />
              <AddTicket state={state} rpc={rpc} run={run} />
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
