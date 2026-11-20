// Factory — frontend entry. One page: the founder's inbox on top, the
// swimlanes under it, then who plays each role and the standing agents.
// React and @get-bb/plugin-sdk/app are provided by bb at load time.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Markdown,
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
const INBOX_ARRIVED = "factory-inbox-arrived";
const CHIME_KEY = "bbonductor.factory.chime";

/**
 * Two soft, falling bell notes, like a station announcement chime. Made with
 * the browser's own audio, so there is no sound file to ship.
 */
let audio: AudioContext | null = null;
function playChime() {
  try {
    audio ??= new AudioContext();
    const context = audio;
    void context.resume();
    const start = context.currentTime + 0.02;
    // E5 then C5: a calm falling third.
    [659.25, 523.25].forEach((frequency, index) => {
      const at = start + index * 0.42;
      const gain = context.createGain();
      gain.connect(context.destination);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.16, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.6);
      // A fundamental with a quiet octave above gives it a bell's warmth.
      for (const [multiple, level] of [[1, 1], [2, 0.25]] as const) {
        const tone = context.createOscillator();
        const mix = context.createGain();
        tone.type = "sine";
        tone.frequency.value = frequency * multiple;
        mix.gain.value = level;
        tone.connect(mix).connect(gain);
        tone.start(at);
        tone.stop(at + 1.7);
      }
    });
  } catch {
    // No audio available: the inbox count and push notification still arrive.
  }
}
const chimeOn = () => typeof localStorage === "undefined" || localStorage.getItem(CHIME_KEY) !== "off";

/** Mounted once per bb window, whatever page is showing. */
function InboxChime() {
  useRealtime(INBOX_ARRIVED, () => {
    if (chimeOn()) playChime();
  });
  return null;
}

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
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

function InboxCard({ entry, ticket, rpc, run }: { entry: InboxEntry; ticket: string | null; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
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
        {ticket === null ? null : <span className="font-mono text-sm font-medium">{ticket}</span>}
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-medium",
            urgent ? "bg-destructive/15 text-destructive" : "bg-secondary text-secondary-foreground",
          )}
        >
          {KIND_LABEL[entry.kind]}
        </span>
        <span className="text-muted-foreground">{ticket === null ? entry.from : entry.from.replace(` · ${ticket}`, "")}</span>
        <span className="text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</span>
      </div>
      <p className="text-sm font-medium">{entry.question}</p>
      {entry.context === "" ? null : <Markdown content={entry.context} className="text-sm" />}
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
        <Markdown content={`**Recommendation:** ${entry.recommendation}`} className="text-sm" />
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
  "needs-founder": "Waiting for you",
  "with-planner": "With plan reviewer",
  triage: "With chief of staff",
  returned: "Returned to planner",
  stalled: "Stalled",
  failed: "Failed",
  done: "Done",
  archived: "Archived",
  cancelled: "Cancelled",
};

function Ticket({ item, config, rpc, run, canMoveUp = false, canMoveDown = false, draggable = false }: { item: Item; config: Config; rpc: Rpc; run: (work: Promise<unknown>) => void; canMoveUp?: boolean; canMoveDown?: boolean; draggable?: boolean }) {
  const navigate = useBbNavigate();
  const [dropTarget, setDropTarget] = useState(false);
  const stages = config.pipelines[item.pipeline] ?? [];
  const stageId = stages[item.stageIndex];
  const stageLabel = stageId === undefined ? "" : (config.stages[stageId]?.label ?? stageId);
  const waiting = item.status === "queued";
  const forFounder = item.status === "needs-founder";
  // A ticket held before ship for the founder's check is in its own stage.
  const shown = item.status === "done" ? "Merged" : forFounder && item.founderCheck !== null && !item.founderCheck.approved ? "Founder testing" : stageLabel;
  const note =
    item.status === "running" || waiting || item.status === "done" || forFounder ? "" : STATUS_LABEL[item.status];
  // The thread doing the work now, the planner it is waiting on, or for a
  // finished ticket the last thread that worked on it.
  const threadId =
    item.consult?.threadId ??
    (stageId === undefined ? undefined : item.threads[stageId]) ??
    stages.map((id) => item.threads[id]).filter((id) => id !== undefined).at(-1);
  return (
    <div
      className={cn("space-y-1 rounded-md border border-border bg-card p-2.5 text-sm", draggable && "cursor-grab", dropTarget && "border-foreground")}
      data-testid="ticket"
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/factory-ticket", `${item.lane}|${item.id}`);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        if (!draggable) return;
        event.preventDefault();
        setDropTarget(true);
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(event) => {
        setDropTarget(false);
        const [lane, id] = event.dataTransfer.getData("text/factory-ticket").split("|");
        if (!draggable || lane !== item.lane || id === undefined || id === item.id) return;
        event.preventDefault();
        run(rpc.call("reorderBefore", { itemId: id, beforeId: item.id }));
      }}
    >
      <div className="flex items-center gap-2">
        {item.working ? (
          <span className="relative flex size-2 shrink-0" aria-label="Working now" data-testid="working">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
        ) : null}
        <span className="font-mono font-medium">{item.key}</span>
        <span className={cn("min-w-0 flex-1 truncate text-xs font-medium", note === "" ? "text-muted-foreground" : STATUS_STYLE[item.status])}>
          {note === "" ? shown : `${shown} · ${note}`}
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
          <div className="flex items-center justify-end gap-0.5">
            <button type="button" className="rounded px-1 text-xs leading-4 text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label={`Move ${item.key} earlier`} disabled={!canMoveUp} onClick={() => run(rpc.call("reorder", { itemId: item.id, direction: "up" }))}>
              ↑
            </button>
            <button type="button" className="rounded px-1 text-xs leading-4 text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label={`Move ${item.key} later`} disabled={!canMoveDown} onClick={() => run(rpc.call("reorder", { itemId: item.id, direction: "down" }))}>
              ↓
            </button>
          </div>
        ) : null
      ) : threadId === undefined ? null : (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => navigate.toThread(threadId)}>
            Open thread
          </Button>
          {forFounder ? <span className="text-xs font-medium text-destructive">Waiting for you</span> : null}
        </div>
      )}
    </div>
  );
}

function Swimlanes({ state, rpc, run }: { state: FactoryState; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const open = state.items.filter((item) => item.status !== "done" && item.status !== "archived" && item.status !== "cancelled");
  // Merged, with a workspace the founder has not archived yet.
  const finished = state.items.filter((item) => item.status === "done");
  const lanes = [...new Set([...open, ...finished].map((item) => item.lane))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // Only waiting tickets move, and only among the waiting tickets of their lane.
  const moves = (item: Item) => {
    const queue = open.filter((other) => other.lane === item.lane && other.status === "queued" && !other.parked);
    const index = queue.findIndex((other) => other.id === item.id);
    if (item.parked || index === -1) return { canMoveUp: false, canMoveDown: false, draggable: false };
    return { canMoveUp: index > 0, canMoveDown: index < queue.length - 1, draggable: queue.length > 1 };
  };
  const card = (item: Item) => <Ticket key={item.id} item={item} config={state.config} rpc={rpc} run={run} {...moves(item)} />;
  if (lanes.length === 0) {
    return <Empty>No tickets yet. Lanes fill from the swimlane schedule.</Empty>;
  }
  return (
    <>
      {/* Phones: one card per lane, tickets stacked in order. */}
      <div className="space-y-3 md:hidden">
        {lanes.map((lane) => (
          <div key={lane} className="space-y-2 rounded-lg border border-border p-3" data-testid="lane-card">
            <div className="text-sm font-medium">{lane}</div>
            {open.filter((item) => item.lane === lane).map(card)}
            {finished.some((item) => item.lane === lane) ? <div className="pt-1 text-xs font-medium text-muted-foreground">Done</div> : null}
            {finished.filter((item) => item.lane === lane).map(card)}
          </div>
        ))}
      </div>
      <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
        <table className="w-full min-w-[760px] table-fixed border-collapse text-left align-top">
          <thead className="bg-secondary/40 text-xs text-muted-foreground">
            <tr>
              <th className="w-24 px-3 py-2 font-medium">Track</th>
              <th className="px-3 py-2 font-medium">Right now</th>
              <th className="px-3 py-2 font-medium">Next up</th>
              <th className="px-3 py-2 font-medium">Done</th>
            </tr>
          </thead>
          <tbody>
            {lanes.map((lane) => {
              const inLane = open.filter((item) => item.lane === lane);
              // "Right now" is the ticket in flight; a lane with only waiting tickets has none.
              const head = inLane.find((item) => item.status !== "queued");
              return (
                <tr key={lane} className="border-t border-border align-top" data-testid="lane">
                  <td className="px-3 py-3 text-sm font-medium">{lane}</td>
                  <td className="px-3 py-3">{head === undefined ? null : card(head)}</td>
                  <td className="space-y-2 px-3 py-3">{inLane.filter((item) => item !== head).map(card)}</td>
                  <td className="space-y-2 px-3 py-3" data-testid="done-column">{finished.filter((item) => item.lane === lane).map(card)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
        const memory = state.memoryFiles.find((file) => file.agentId === agentId);
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
              </div>
            </div>
            {memory === undefined ? null : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void navigate.experimental_openFilePreview({ target: { kind: "host", hostId: memory.hostId, path: memory.path }, location: null })}
              >
                Memory
              </Button>
            )}
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
  const [chime, setChime] = useState(chimeOn);
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
        <Section title={`Inbox${inbox.length === 0 ? "" : ` (${inbox.length})`}`}>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={chime}
                onChange={(event) => {
                  localStorage.setItem(CHIME_KEY, event.target.checked ? "on" : "off");
                  setChime(event.target.checked);
                }}
              />
              Chime when something arrives
            </label>
            <button type="button" className="underline" onClick={playChime}>
              Hear it
            </button>
          </div>
          {inbox.length === 0 ? (
            <Empty>Nothing needs you.</Empty>
          ) : (
            <ul className="space-y-2">
              {inbox.map((entry) => (
                <InboxCard key={entry.id} entry={entry} ticket={state.items.find((item) => item.id === entry.itemId)?.key ?? null} rpc={rpc} run={run} />
              ))}
            </ul>
          )}
        </Section>
        {state.projectId === null ? (
          <Empty>Add a project to bb to start a factory.</Empty>
        ) : (
          <>
            <Section title="Swimlanes">
              <Swimlanes state={state} rpc={rpc} run={run} />
            </Section>
            <Section title="Standing agents">
              <Agents state={state} rpc={rpc} run={run} />
            </Section>
            <Section title="Who plays each role">
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
  app.slots.experimental_appOverlay({ id: "inbox-chime", component: InboxChime });
  app.slots.navPanel({
    id: "factory",
    title: "Factory",
    icon: "Workflow",
    path: "factory",
    component: FactoryPage,
    experimental_useBadge: useInboxBadge,
  });
});
