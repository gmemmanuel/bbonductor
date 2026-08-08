import React, { useEffect, useRef, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc";

export function RuntimePanel({ params }: { threadId: string; params: any }) {
  const rpc = useRpc<typeof rpcContract>();
  const environmentId = params?.environmentId as string | undefined;
  const initialTerminalId = params?.terminalId as string | undefined;
  const [terminals, setTerminals] = useState<Array<{ id: string; title: string }>>([]);
  const [selected, setSelected] = useState<string | undefined>(initialTerminalId);
  const [output, setOutput] = useState("");
  const seq = useRef(0);

  async function refreshTerminals() {
    if (!environmentId) return;
    const result = await rpc.call("listTerminals", { environmentId });
    setTerminals(result.terminals);
    if (!selected && result.terminals[0]) setSelected(result.terminals[0].id);
  }

  useEffect(() => { void refreshTerminals(); }, [environmentId]);
  useEffect(() => {
    setOutput("");
    seq.current = 0;
    if (!selected) return;
    const timer = window.setInterval(async () => {
      const result = await rpc.call("terminalOutput", { terminalId: selected, sinceSeq: seq.current });
      seq.current = result.nextSeq;
      if (result.text) setOutput((current) => current + result.text);
    }, 500);
    return () => window.clearInterval(timer);
  }, [selected]);

  if (!environmentId) return <div className="p-4">No workspace environment.</div>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <select className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs" value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
          {terminals.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.title}</option>)}
        </select>
        <button
          className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
          onClick={async () => {
            const title = window.prompt("Terminal title", "Terminal") ?? "Terminal";
            const command = window.prompt("Command (leave blank for shell)", "") ?? "";
            const result = await rpc.call("createTerminal", { environmentId, title, command: command || undefined });
            await refreshTerminals();
            setSelected(result.terminalId);
          }}
        >+ Terminal</button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs">{output || "Waiting for output…"}</pre>
    </div>
  );
}
