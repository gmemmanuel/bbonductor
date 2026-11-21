// Factory — frontend entry. One page: the founder's inbox on top, the
// swimlanes under it, then who plays each role and the standing agents.
// React and @get-bb/plugin-sdk/app are provided by bb at load time.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  Markdown,
  definePluginApp,
  useBbNavigate,
  useComposer,
  useComposers,
  useRealtime,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { FactoryState, rpcContract } from "./server";
import type { Attachment, Config, InboxEntry, Item, Role } from "./src/factory/model";
import { RUN_SETTINGS_FILE, RUN_TERMINAL_TITLE, parseRunCommand } from "./src/factory/runScript";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const CHANGED = "factory-changed";
const PROJECT_KEY = "bbonductor.factory.project";
const INBOX_ARRIVED = "factory-inbox-arrived";
const CHIME_KEY = "bbonductor.factory.chime";
const OPEN_KEY = "bbonductor.factory.inbox.open";
const PANEL_WIDTH_KEY = "bbonductor.factory.inbox.width";
const PANEL_DEFAULT = 544;
const PANEL_MIN = 360;
/** The inbox list keeps at least this much room beside the panel. */
const LIST_MIN = 320;

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

type Sdk = ReturnType<typeof useSdk>;
type Navigate = ReturnType<typeof useBbNavigate>;

function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(content: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(content), (char) => char.charCodeAt(0)));
}

/** The Run terminals that are up, across the given threads. */
async function runningRuns(sdk: Sdk, threadIds: readonly string[]) {
  const lists = await Promise.all(
    threadIds.map((threadId) => sdk.terminals.list({ scope: { kind: "thread", threadId } }).catch(() => ({ sessions: [] }))),
  );
  return lists.flatMap((list) => list.sessions).filter((session) => session.title === RUN_TERMINAL_TITLE && (session.status === "running" || session.status === "starting"));
}

/**
 * Start the project's Run command in a ticket's workspace, as bb's own Run
 * button does: one Run per workspace, in a terminal titled "Run". The
 * terminal opens beside the inbox when this surface can show one (the QR code
 * for a phone is in it); otherwise bb goes to the thread.
 */
async function runInWorkspace(sdk: Sdk, navigate: Navigate, threadId: string): Promise<void> {
  const thread = await sdk.threads.get({ threadId });
  if (thread.environmentId === null) throw new Error("This thread has no workspace to run in.");
  const environment = await sdk.environments.get({ environmentId: thread.environmentId });
  if (environment.path === null) throw new Error("This workspace has no checkout to run in.");
  const file = await sdk.files
    .read({ hostId: environment.hostId, rootPath: environment.path, path: `${environment.path}/${RUN_SETTINGS_FILE}` })
    .catch(() => null);
  const command = file === null ? null : parseRunCommand(file.contentEncoding === "utf8" ? file.content : fromBase64(file.content));
  if (command === null) throw new Error(`This project has no Run command. Add one to ${RUN_SETTINGS_FILE}.`);
  const siblings = await sdk.threads.list({ environmentId: environment.id });
  const stale = await runningRuns(sdk, [...new Set([threadId, ...siblings.map((sibling) => sibling.id)])]);
  await Promise.all(stale.map((session) => sdk.terminals.close({ terminalId: session.id, mode: "force" }).catch(() => undefined)));
  const terminal = await sdk.terminals.create({ scope: { kind: "thread", threadId }, cols: 120, rows: 32, title: RUN_TERMINAL_TITLE, start: { mode: "shell" } });
  await sdk.terminals.input({ terminalId: terminal.id, dataBase64: toBase64(`${command}\n`) });
  await recheckRuns([threadId]);
  const shown = await navigate.experimental_openTerminal({ terminalId: terminal.id }).catch(() => false);
  if (!shown) navigate.toThread(threadId);
}

async function stopRuns(sdk: Sdk, sessions: readonly RunSession[]): Promise<void> {
  await Promise.all(sessions.map((session) => sdk.terminals.close({ terminalId: session.terminalId, mode: "force" })));
  await recheckRuns([...new Set(sessions.map((session) => session.threadId))]);
}

/**
 * Which Run commands are up, kept for the whole app: the sidebar marks those
 * workspaces and an inbox card turns its Run button into Stop. A plugin can
 * only decorate thread rows, and only from its app-wide script, so that script
 * hands its setter to the overlay below, which has the SDK to watch terminals.
 */
interface RunSession {
  terminalId: string;
  threadId: string;
  environmentId: string | null;
}
type RowStatusSetter = (threadId: string, status: { icon: string; label: string; tone: "running" } | null) => void;
const RUN_MARK = { icon: "Play", label: "Run is up in this workspace", tone: "running" } as const;
let runs: readonly RunSession[] = [];
const runListeners = new Set<() => void>();
let recheckRuns: (threadIds: readonly string[]) => Promise<void> = async () => undefined;
let setRowStatus: RowStatusSetter | null = null;
const marked = new Set<string>();

function syncMarks() {
  if (setRowStatus === null) return;
  const up = new Set(runs.map((session) => session.threadId));
  for (const threadId of marked) {
    if (up.has(threadId)) continue;
    marked.delete(threadId);
    setRowStatus(threadId, null);
  }
  for (const threadId of up) {
    if (marked.has(threadId)) continue;
    marked.add(threadId);
    setRowStatus(threadId, RUN_MARK);
  }
}

function RunWatch() {
  const sdk = useSdk();
  useEffect(() => {
    let stopped = false;
    const check = async (threadIds: readonly string[]) => {
      const found = await runningRuns(sdk, threadIds);
      if (stopped) return;
      runs = [
        ...runs.filter((session) => !threadIds.includes(session.threadId)),
        ...found.flatMap((session) => (session.threadId === null ? [] : [{ terminalId: session.id, threadId: session.threadId, environmentId: session.environmentId }])),
      ];
      syncMarks();
      for (const listener of runListeners) listener();
    };
    recheckRuns = check;
    sdk.threads.list({}).then((threads) => check(threads.map((thread) => thread.id)), () => undefined);
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        if (event.id !== undefined && event.changes.includes("terminals-changed")) void check([event.id]).catch(() => undefined);
      },
    });
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [sdk]);
  return null;
}

/** The Run terminals that are up in the workspace this thread belongs to. */
function useRunsBeside(threadId: string): readonly RunSession[] {
  const sdk = useSdk();
  const all = useSyncExternalStore(
    (listener) => {
      runListeners.add(listener);
      return () => runListeners.delete(listener);
    },
    () => runs,
  );
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  useEffect(() => {
    if (threadId === "") return;
    sdk.threads.get({ threadId }).then((thread) => setEnvironmentId(thread.environmentId), () => undefined);
  }, [sdk, threadId]);
  return useMemo(
    () => all.filter((session) => session.threadId === threadId || (environmentId !== null && session.environmentId === environmentId)),
    [all, environmentId, threadId],
  );
}

/**
 * What the founder has written on an inbox entry and not yet sent. Kept in the
 * browser so it survives leaving the page, and handed to the thread's own
 * composer when he opens the thread instead of answering here.
 */
interface ReplyDraft {
  text: string;
  attachments: Attachment[];
}
const DRAFT_KEY = "bbonductor.factory.draft.";
const NO_DRAFT: ReplyDraft = { text: "", attachments: [] };
const isBlank = (draft: ReplyDraft) => draft.text.trim() === "" && draft.attachments.length === 0;

function readDraft(entryId: string): ReplyDraft {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(DRAFT_KEY + entryId) ?? "null");
    if (typeof saved !== "object" || saved === null) return NO_DRAFT;
    const { text, attachments } = saved as Partial<ReplyDraft>;
    return { text: typeof text === "string" ? text : "", attachments: Array.isArray(attachments) ? attachments : [] };
  } catch {
    return NO_DRAFT;
  }
}

function writeDraft(entryId: string, draft: ReplyDraft) {
  try {
    if (isBlank(draft)) localStorage.removeItem(DRAFT_KEY + entryId);
    else localStorage.setItem(DRAFT_KEY + entryId, JSON.stringify(draft));
  } catch {
    // A full or blocked store only costs the draft its persistence.
  }
}

function useReplyDraft(entryId: string) {
  const [draft, setDraft] = useState(() => readDraft(entryId));
  const update = useCallback(
    (next: (current: ReplyDraft) => ReplyDraft) =>
      setDraft((current) => {
        const value = next(current);
        writeDraft(entryId, value);
        return value;
      }),
    [entryId],
  );
  return [draft, update] as const;
}

interface Handoff {
  entryId: string;
  threadId: string;
  draft: ReplyDraft;
  tries: number;
}
let handoff: Handoff | null = null;
const handoffListeners = new Set<() => void>();
function setHandoff(next: Handoff | null) {
  handoff = next;
  for (const listener of handoffListeners) listener();
}

/**
 * Moves an inbox draft into the thread's composer once that composer is on
 * screen. The inbox copy is cleared only after the composer shows it, so a
 * draft is never lost between the two.
 */
function DraftHandoff() {
  const composers = useComposers();
  const pending = useSyncExternalStore(
    (listener) => {
      handoffListeners.add(listener);
      return () => handoffListeners.delete(listener);
    },
    () => handoff,
  );
  useEffect(() => {
    if (pending === null) return;
    const composer = composers.find((candidate) => candidate.scope.kind === "thread" && candidate.scope.threadId === pending.threadId);
    if (composer === undefined) return;
    const missing = pending.draft.attachments.filter((file) => !composer.draft.attachments.some((present) => present.path === file.path));
    if (composer.text.includes(pending.draft.text) && missing.length === 0) {
      writeDraft(pending.entryId, NO_DRAFT);
      setHandoff(null);
      return;
    }
    if (pending.tries >= 3) {
      setHandoff(null);
      return;
    }
    pending.tries += 1;
    composer.replace((current) => ({
      text: current.text.includes(pending.draft.text) ? current.text : current.text.trim() === "" ? pending.draft.text : `${current.text}\n\n${pending.draft.text}`,
      mentions: current.mentions,
      attachments: [...current.attachments, ...missing],
    }));
  }, [composers, pending]);
  return null;
}

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
interface Catalog {
  providers: { id: string; name: string }[];
  models: { providerId: string; id: string; name: string; reasoning: string[] }[];
}

/**
 * What the founder was asked, shown above the composer of the thread it is
 * about, so the thread he opens to answer in shows the question.
 */
function InboxBanner() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const refetch = useCallback(() => {
    if (threadId === null) return;
    rpc.call("state", { projectId: null }).then(
      (state) => setEntries(state.inbox.filter((entry) => entry.threadId === threadId && entry.kind !== "interaction")),
      () => undefined,
    );
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED, refetch);
  if (entries.length === 0) return null;
  return (
    <div className="max-h-64 space-y-3 overflow-y-auto rounded-lg border border-border bg-card p-3" data-testid="inbox-banner">
      {entries.map((entry) => (
        <div key={entry.id} className="space-y-1">
          <p className="text-xs text-muted-foreground">Waiting for you · {KIND_LABEL[entry.kind]}</p>
          <p className="text-sm font-semibold">{entry.question}</p>
          {entry.context === "" ? null : <Markdown content={entry.context} className="text-sm" />}
          {entry.options.length === 0 ? null : <Markdown content={entry.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option}`).join("\n\n")} className="text-sm" />}
          {entry.recommendation === "" ? null : <Markdown content={`**Recommendation:** ${entry.recommendation}`} className="text-sm" />}
        </div>
      ))}
    </div>
  );
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
  interaction: "Answer in the thread",
  stalled: "Stopped",
  failed: "Failed",
  blocked: "Blocked",
  check: "Not released yet",
  test: "Released",
  todo: "To do",
};

/**
 * The founder does two kinds of thing, so the inbox has two columns:
 * decisions, and founder QA (trying work before or after it is released, and
 * anything else only he can do by hand). Work that stopped or failed asks him
 * what to do next, which is a decision.
 */
const COLUMNS: { id: string; title: string; empty: string; kinds: InboxEntry["kind"][] }[] = [
  { id: "decisions", title: "Decisions", empty: "Nothing to decide.", kinds: ["question", "interaction", "stalled", "failed", "blocked"] },
  { id: "qa", title: "Founder QA", empty: "Nothing to try.", kinds: ["check", "test", "todo"] },
];

const ACCENT: Record<InboxEntry["kind"], string> = {
  question: "border-l-sky-500",
  interaction: "border-l-sky-500",
  todo: "border-l-emerald-500",
  check: "border-l-emerald-500",
  test: "border-l-emerald-500/40",
  stalled: "border-l-red-500",
  failed: "border-l-red-500",
  blocked: "border-l-red-500",
};

function ago(time: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

function ticketLink(config: Config, key: string): string | null {
  return config.ticketUrl === "" ? null : config.ticketUrl.replace("{key}", encodeURIComponent(key));
}

/** A small arrow that opens the ticket where it is tracked. */
function TicketLink({ url, ticket }: { url: string | null; ticket: string }) {
  const navigate = useBbNavigate();
  if (url === null) return null;
  return (
    <button
      type="button"
      aria-label={`Open ${ticket} in the tracker`}
      title={`Open ${ticket} in the tracker`}
      data-testid="ticket-link"
      className="shrink-0 rounded px-1 text-sm leading-none text-muted-foreground hover:bg-secondary hover:text-foreground"
      onClick={() => navigate.openUrl(url)}
    >
      ↗
    </button>
  );
}

/** How many steps an entry lists. */
const stepCount = (entry: InboxEntry) => (entry.context.match(/(^|\n)- /g) ?? []).length;

/**
 * The one line a card may carry under the ticket's title: the direction
 * itself, when it is short enough to read whole. QA that only says "try it"
 * carries none, and nothing on a card is ever cut off with an ellipsis.
 */
function direction(entry: InboxEntry, ticket: string | null, title: string | null): string {
  if (entry.kind === "check" || entry.kind === "test") return "";
  let text = entry.question.trim();
  if (ticket !== null && title !== null) text = text.replace(`${ticket} (${title}) `, "").replace(`${ticket} (${title})`, "");
  return text.length <= 90 ? text : "";
}

/** The small card: the ticket, its status, and a direction only when there is a short one. */
function InboxTile({ entry, ticket, title, active, onOpen }: { entry: InboxEntry; ticket: string | null; title: string | null; active: boolean; onOpen: () => void }) {
  const steps = stepCount(entry);
  const line = direction(entry, ticket, title);
  return (
    <li>
      <button
        type="button"
        data-testid="inbox-tile"
        aria-pressed={active}
        className={cn(
          "block w-full space-y-1 rounded-lg border border-l-[3px] border-border bg-card px-3.5 py-2.5 text-left transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          ACCENT[entry.kind],
          active && "bg-secondary/60",
        )}
        onClick={onOpen}
      >
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono font-medium text-foreground">{ticket ?? entry.from}</span>
          <span>{KIND_LABEL[entry.kind]}</span>
          {steps === 0 ? null : <span>{steps} steps</span>}
          <span className="flex-1" />
          <span title={new Date(entry.createdAt).toLocaleString()}>{ago(entry.createdAt)}</span>
        </span>
        {title === null ? null : <span className="block text-sm font-medium leading-snug">{title}</span>}
        {line === "" ? null : <span className={cn("block text-sm leading-snug", title === null ? "font-medium" : "text-muted-foreground")}>{line}</span>}
      </button>
    </li>
  );
}

/** Everything about one entry: the full text, the reply box and every action. Fills the inbox panel below its header. */
function InboxCard({ entry, rpc, run }: { entry: InboxEntry; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const [confirmShip, setConfirmShip] = useState(false);
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const running = useRunsBeside(entry.threadId);
  const [draft, setDraft] = useReplyDraft(entry.id);
  const [uploading, setUploading] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const setAnswer = (text: string) => setDraft((current) => ({ ...current, text }));
  // Grow with the text, up to about a dozen lines, then scroll.
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight + 2, 320)}px`;
  }, [draft.text]);
  const attach = (files: readonly File[]) => {
    if (files.length === 0) return;
    setUploading((count) => count + files.length);
    run(
      Promise.all(
        files.map((file) =>
          sdk.projects.attachments
            .upload({ projectId: entry.projectId, clientFile: file })
            .then((uploaded) => setDraft((current) => ({ ...current, attachments: [...current.attachments, uploaded] })))
            .finally(() => setUploading((count) => count - 1)),
        ),
      ),
    );
  };
  const ready = !isBlank(draft) && uploading === 0;
  const submit = () => {
    if (!ready) return;
    if (handoff?.entryId === entry.id) setHandoff(null);
    run(rpc.call("answer", { entryId: entry.id, answer: draft.text, attachments: draft.attachments }).then(() => setDraft(() => NO_DRAFT)));
  };
  const send = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };
  // Enter sends, as in bb's own composer; on a phone it is a new line and the button sends.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches) return;
    event.preventDefault();
    submit();
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    attach(files);
  };
  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    attach(Array.from(event.dataTransfer.files));
  };
  const openThread = () => {
    if (!isBlank(draft)) setHandoff({ entryId: entry.id, threadId: entry.threadId, draft, tries: 0 });
    navigate.toThread(entry.threadId);
  };
  const urgent = entry.kind === "failed" || entry.kind === "stalled";
  const canRun = entry.threadId !== "" && (entry.kind === "todo" || entry.kind === "test" || entry.kind === "check");
  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4" data-testid="inbox-entry">
      {entry.kind === "check" ? null : <p className="text-sm font-semibold leading-snug">{entry.question}</p>}
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
        <div className="rounded-md bg-secondary/50 px-3 py-2">
          <Markdown content={`**Recommendation:** ${entry.recommendation}`} className="text-sm" />
        </div>
      )}
      <form onSubmit={send} onDrop={onDrop} onDragOver={(event) => event.preventDefault()} className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {entry.kind === "interaction" ? null : (
          <>
            <textarea
              ref={box}
              rows={1}
              value={draft.text}
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={entry.kind === "question" ? "Your decision" : entry.kind === "test" ? "Anything wrong? (goes to the builder)" : entry.kind === "todo" ? "Done? Add anything the agent should know" : entry.kind === "check" ? "What to change (sends it back to the builder)" : "Tell the agent what to do"}
              aria-label={`Answer ${entry.from}`}
              data-testid="inbox-reply"
              className="min-h-10 w-full basis-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:min-h-9 sm:text-sm"
            />
            {draft.attachments.length === 0 && uploading === 0 ? null : (
              <ul className="flex basis-full flex-wrap gap-1.5 text-xs" data-testid="inbox-attachments">
                {draft.attachments.map((file) => (
                  <li key={file.path} className="flex items-center gap-1 rounded bg-secondary px-2 py-1 text-secondary-foreground">
                    <span className="max-w-48 truncate">{file.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setDraft((current) => ({ ...current, attachments: current.attachments.filter((kept) => kept.path !== file.path) }))}
                    >
                      ×
                    </button>
                  </li>
                ))}
                {uploading === 0 ? null : <li className="px-2 py-1 text-muted-foreground">Uploading…</li>}
              </ul>
            )}
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              data-testid="inbox-attach-input"
              onChange={(event) => {
                attach(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            {/* Attach sits left of Send, Dismiss right of it, as in a chat composer. */}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-10 w-10 shrink-0 p-0 text-muted-foreground sm:h-8 sm:w-8"
              aria-label="Attach files"
              data-testid="inbox-attach"
              onClick={() => picker.current?.click()}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                <path d="M8 3v10M3 8h10" />
              </svg>
            </Button>
            <Button type="submit" size="sm" variant={entry.kind === "check" ? "outline" : "default"} className="h-10 flex-1 sm:h-8 sm:flex-none" disabled={!ready}>
              {entry.kind === "check" ? "Send back" : "Send"}
            </Button>
          </>
        )}
        <Button type="button" size="sm" variant="ghost" className="h-10 text-muted-foreground sm:h-8" data-testid="inbox-dismiss" onClick={() => run(rpc.call("dismiss", { entryId: entry.id }))}>
          Dismiss
        </Button>
        {entry.kind === "check" ? (
          // Shipping takes two presses, so a stray click cannot release anything.
          <Button
            type="button"
            size="sm"
            variant={confirmShip ? "destructive" : "default"}
            className="ml-auto h-10 sm:h-8"
            data-testid="inbox-approve"
            onClick={() => {
              if (confirmShip) run(rpc.call("approve", { entryId: entry.id }));
              else setConfirmShip(true);
            }}
            onBlur={() => setConfirmShip(false)}
          >
            {confirmShip ? "Press again to ship" : "Approve and ship"}
          </Button>
        ) : null}
        {entry.kind === "failed" ? (
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => run(rpc.call("retry", { entryId: entry.id }))}>
            Retry
          </Button>
        ) : null}
      </form>
      </div>
      {/* Leaving the inbox (the thread, the app) is pinned to the panel's bottom right. */}
      {!canRun && entry.threadId === "" ? null : (
        <div className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3" data-testid="inbox-panel-footer">
          {canRun ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-10 sm:h-8"
              data-testid="inbox-run"
              onClick={() => run(running.length > 0 ? stopRuns(sdk, running) : runInWorkspace(sdk, navigate, entry.threadId))}
            >
              {running.length > 0 ? "Stop" : "Run"}
            </Button>
          ) : null}
          {entry.threadId === "" ? null : (
            <Button type="button" size="sm" variant="outline" className="h-10 sm:h-8" data-testid="inbox-open-thread" onClick={openThread}>
              Open thread
            </Button>
          )}
        </div>
      )}
    </>
  );
}

// --------------------------------------------------------------- swimlanes

const STATUS_STYLE: Record<Item["status"], string> = {
  queued: "text-muted-foreground",
  running: "text-foreground",
  "needs-founder": "text-destructive",
  "with-owner": "text-foreground",
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
  "with-owner": "With issue owner",
  "with-planner": "With issue owner",
  triage: "With issue owner",
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
  const shown = item.status === "done" ? "Merged" : forFounder && item.founderCheck !== null && !item.founderCheck.approved ? "Founder QA" : stageLabel;
  const note =
    item.status === "running" || waiting || item.status === "done" || forFounder ? "" : STATUS_LABEL[item.status];
  // The founder talks to a ticket through its issue owner, so that is the
  // thread a ticket opens. Before it has one: the thread working on it now.
  const threadId =
    item.ownerThreadId ??
    stages.filter((id) => config.stages[id]?.owner === true).map((id) => item.threads[id]).find((id) => id !== undefined) ??
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
        <TicketLink url={ticketLink(config, item.key)} ticket={item.key} />
      </div>
      <p className="text-muted-foreground">{item.title}</p>
      {item.riders.length === 0 ? null : (
        <ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="riders">
          {item.riders.map((rider) => (
            <li key={rider.key}>
              + <span className="font-mono">{rider.key}</span> {rider.title}
            </li>
          ))}
        </ul>
      )}
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
              <th className="px-3 py-2 font-medium">Next up</th>
              <th className="px-3 py-2 font-medium">In Progress</th>
              <th className="px-3 py-2 font-medium">Done</th>
            </tr>
          </thead>
          <tbody>
            {lanes.map((lane) => {
              const inLane = open.filter((item) => item.lane === lane);
              // "In Progress" is the ticket in flight; a lane with only waiting tickets has none.
              const head = inLane.find((item) => item.status !== "queued");
              return (
                <tr key={lane} className="border-t border-border align-top" data-testid="lane">
                  <td className="px-3 py-3 text-sm font-medium">{lane}</td>
                  <td className="space-y-2 px-3 py-3">{inLane.filter((item) => item !== head).map(card)}</td>
                  <td className="px-3 py-3" data-testid="in-progress-column">{head === undefined ? null : card(head)}</td>
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

/** The frame every Factory page shares: a title, the page's own controls, and what went wrong if anything did. */
function Page({ title, width, error, aside, children }: { title: string; width: string; error: string | null; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto box-border w-full space-y-5 px-4 pb-10 pt-4 md:px-6 md:pt-6", width)}>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex-1 text-xl font-semibold tracking-tight">{title}</h1>
          {aside}
        </div>
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

function ProjectPicker({ state, selectProject }: { state: FactoryState; selectProject: (id: string) => void }) {
  if (state.projects.length < 2) return null;
  return (
    <select aria-label="Project" className={selectClass} value={state.projectId ?? ""} onChange={(e) => selectProject(e.target.value)}>
      {state.projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  );
}

const Loading = ({ error }: { error: string | null }) => <div className="p-5 text-sm text-muted-foreground">{error ?? "Loading the factory…"}</div>;

/**
 * The inbox panel's width, dragged from its left edge and remembered. Arrow
 * keys move the edge too, and a double-click puts it back.
 */
function usePanelWidth() {
  const [width, setWidth] = useState(() => {
    const saved = typeof localStorage === "undefined" ? NaN : Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= PANEL_MIN ? saved : PANEL_DEFAULT;
  });
  const clamp = (next: number, panel: HTMLElement | null) => {
    const room = panel?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.round(Math.max(PANEL_MIN, Math.min(next, room - LIST_MIN)));
  };
  const save = (next: number) => {
    setWidth(next);
    localStorage.setItem(PANEL_WIDTH_KEY, String(next));
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const panel = handle.parentElement;
    const startX = event.clientX;
    const startWidth = panel?.getBoundingClientRect().width ?? width;
    handle.setPointerCapture(event.pointerId);
    const body = document.body.style;
    const before = { cursor: body.cursor, userSelect: body.userSelect };
    body.cursor = "col-resize";
    body.userSelect = "none";
    let latest = startWidth;
    const move = (moved: PointerEvent) => {
      latest = clamp(startWidth + (startX - moved.clientX), panel);
      setWidth(latest);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      body.cursor = before.cursor;
      body.userSelect = before.userSelect;
      save(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const delta = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
    if (delta === 0) return;
    event.preventDefault();
    save(clamp(width + delta, event.currentTarget.parentElement));
  };
  const handle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      data-testid="inbox-panel-resize"
      className="group absolute inset-y-0 -left-1.5 z-10 hidden w-3 cursor-col-resize touch-none outline-none lg:block"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => save(clamp(PANEL_DEFAULT, null))}
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-ring group-focus-visible:bg-ring group-active:bg-ring" />
    </div>
  );
  return { width, handle };
}

function InboxPage() {
  const { rpc, state, error, run } = useFactory();
  const panel = usePanelWidth();
  // Which entry is open is remembered for this page alone, so the panel is
  // as he left it when he comes back from a thread or another page.
  const [openId, setOpen] = useState<string | null>(() => (typeof localStorage === "undefined" ? null : localStorage.getItem(OPEN_KEY)));
  const setOpenId = useCallback((id: string | null) => {
    if (id === null) localStorage.removeItem(OPEN_KEY);
    else localStorage.setItem(OPEN_KEY, id);
    setOpen(id);
  }, []);
  // The inbox in reading order, as last drawn: when the open entry is dealt
  // with, the panel moves to the one after it instead of closing.
  const order = useRef<string[]>([]);
  const ids = state === null ? null : COLUMNS.flatMap((column) => state.inbox.filter((entry) => column.kinds.includes(entry.kind)).map((entry) => entry.id));
  useEffect(() => {
    if (ids === null) return;
    if (openId !== null && !ids.includes(openId)) {
      const was = order.current.indexOf(openId);
      const after = was === -1 ? [] : [...order.current.slice(was + 1), ...order.current.slice(0, was).reverse()];
      setOpenId(after.find((id) => ids.includes(id)) ?? null);
    }
    order.current = ids;
  }, [ids?.join("|"), openId, setOpenId]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpenId]);
  if (state === null) return <Loading error={error} />;
  const itemOf = (entry: InboxEntry) => state.items.find((candidate) => candidate.id === entry.itemId);
  // An entry that was answered, approved or dismissed is gone, and its panel with it.
  const open = state.inbox.find((entry) => entry.id === openId) ?? null;
  const openItem = open === null ? undefined : itemOf(open);
  const openSteps = open === null ? 0 : stepCount(open);
  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className={cn("min-w-0 flex-1", open !== null && "hidden lg:block")}>
        <Page title="Inbox" width={open === null ? "max-w-5xl" : "max-w-xl"} error={error} aside={<span className="text-sm text-muted-foreground">{state.inbox.length === 0 ? "Nothing needs you" : `${state.inbox.length} waiting`}</span>}>
          <div className={cn("grid gap-6", open === null && "lg:grid-cols-2")}>
            {COLUMNS.map((column) => {
              const entries = state.inbox.filter((entry) => column.kinds.includes(entry.kind));
              return (
                <section key={column.id} className="space-y-2" data-testid={`inbox-column-${column.id}`}>
                  <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {column.title}
                    {entries.length === 0 ? null : <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-secondary-foreground">{entries.length}</span>}
                  </h2>
                  {entries.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-3.5 py-2.5 text-sm text-muted-foreground">{column.empty}</p>
                  ) : (
                    <ul className="space-y-2">
                      {entries.map((entry) => (
                        <InboxTile
                          key={entry.id}
                          entry={entry}
                          ticket={itemOf(entry)?.key ?? null}
                          title={itemOf(entry)?.title ?? null}
                          active={entry.id === openId}
                          onOpen={() => setOpenId(entry.id === openId ? null : entry.id)}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </Page>
      </div>
      {open === null ? null : (
        <aside
          className="relative flex h-full min-h-0 w-full flex-col border-l border-border bg-background lg:w-[var(--panel-width)] lg:shrink-0"
          style={{ "--panel-width": `${panel.width}px` } as CSSProperties}
          data-testid="inbox-panel"
        >
          {panel.handle}
          <div className="flex items-start gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span className="font-mono font-medium text-foreground">{openItem?.key ?? open.from}</span>
                <span>{KIND_LABEL[open.kind]}</span>
                {openSteps === 0 ? null : <span>{openSteps} steps</span>}
                <span>{ago(open.createdAt)}</span>
              </p>
              {openItem === undefined ? null : <h2 className="text-base font-semibold leading-snug">{openItem.title}</h2>}
            </div>
            <button type="button" aria-label="Close" className="rounded px-1.5 text-lg leading-none text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={() => setOpenId(null)}>
              ×
            </button>
          </div>
          <InboxCard key={open.id} entry={open} rpc={rpc} run={run} />
        </aside>
      )}
    </div>
  );
}

function SwimlanesPage() {
  const { rpc, state, error, run, selectProject } = useFactory();
  if (state === null) return <Loading error={error} />;
  return (
    <Page title="Swimlanes" width="max-w-6xl" error={error} aside={<ProjectPicker state={state} selectProject={selectProject} />}>
      {state.projectId === null ? <Empty>Add a project to bb to start a factory.</Empty> : <Swimlanes state={state} rpc={rpc} run={run} />}
    </Page>
  );
}

function OtherSettings({ state, rpc, run }: { state: FactoryState; rpc: Rpc; run: (work: Promise<unknown>) => void }) {
  const [chime, setChime] = useState(chimeOn);
  const [ticketUrl, setTicketUrl] = useState(state.config.ticketUrl);
  const { projectId } = state;
  const saveUrl = () => {
    if (projectId === null || ticketUrl.trim() === state.config.ticketUrl) return;
    run(rpc.call("saveConfig", { projectId, config: { ...state.config, ticketUrl: ticketUrl.trim() } }));
  };
  return (
    <div className="space-y-4 rounded-lg border border-border p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={chime}
            onChange={(event) => {
              localStorage.setItem(CHIME_KEY, event.target.checked ? "on" : "off");
              setChime(event.target.checked);
            }}
          />
          Chime when something arrives in the inbox
        </label>
        <button type="button" className="text-xs text-muted-foreground underline" onClick={playChime}>
          Hear it
        </button>
      </div>
      <label className="block space-y-1">
        <span>Link for a ticket</span>
        <input
          className="block w-full max-w-xl rounded-md border border-input bg-transparent px-3 py-1.5 text-sm outline-none focus-visible:border-ring"
          value={ticketUrl}
          placeholder="https://linear.app/your-team/issue/{key}"
          data-testid="ticket-url"
          onChange={(event) => setTicketUrl(event.target.value)}
          onBlur={saveUrl}
          onKeyDown={(event) => {
            if (event.key === "Enter") saveUrl();
          }}
        />
        <span className="block text-xs text-muted-foreground">Where the arrow on a ticket goes. {"{key}"} becomes the ticket's number.</span>
      </label>
    </div>
  );
}

function SettingsPage() {
  const { rpc, state, error, run, selectProject } = useFactory();
  if (state === null) return <Loading error={error} />;
  return (
    <Page title="Factory settings" width="max-w-5xl" error={error} aside={<ProjectPicker state={state} selectProject={selectProject} />}>
      {state.projectId === null ? (
        <Empty>Add a project to bb to start a factory.</Empty>
      ) : (
        <>
          <Section title="Agents">
            <Agents state={state} rpc={rpc} run={run} />
          </Section>
          <Section title="Who plays each role">
            <Roles state={state} rpc={rpc} run={run} />
          </Section>
          <Section title="Other settings">
            <OtherSettings state={state} rpc={rpc} run={run} />
          </Section>
        </>
      )}
    </Page>
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
  app.slots.experimental_appOverlay({ id: "run-watch", component: RunWatch });
  app.slots.experimental_appOverlay({ id: "draft-handoff", component: DraftHandoff });
  app.composer.customize({ id: "inbox", scopes: ["thread"], banners: [{ id: "waiting", chrome: "bare", component: InboxBanner }] });
  app.contentScripts.register({
    id: "run-marks",
    mount(context) {
      const setter = context.experimental_setThreadRowStatus;
      if (setter === undefined) return;
      setRowStatus = setter;
      syncMarks();
      return () => {
        if (setRowStatus !== setter) return;
        for (const threadId of marked) setter(threadId, null);
        marked.clear();
        setRowStatus = null;
      };
    },
  });
  app.slots.navPanel({ id: "factory", title: "Inbox", icon: "Mail", path: "factory", component: InboxPage, experimental_useBadge: useInboxBadge });
  app.slots.navPanel({ id: "factory-lanes", title: "Swimlanes", icon: "Workflow", path: "factory-lanes", component: SwimlanesPage });
  app.slots.navPanel({ id: "factory-settings", title: "Factory settings", icon: "SlidersHorizontal", path: "factory-settings", component: SettingsPage });
});
