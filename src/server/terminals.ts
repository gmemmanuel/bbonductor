import type { BbPluginApi } from "@bb/plugin-sdk";
import { Buffer } from "node:buffer";

export async function createEnvironmentTerminal(
  bb: BbPluginApi,
  environmentId: string,
  options: { title?: string; command?: string },
) {
  return bb.sdk.terminals.create({
    scope: { kind: "environment", environmentId },
    cols: 120,
    rows: 40,
    title: options.title,
    start: options.command?.trim()
      ? { mode: "command", command: options.command.trim() }
      : { mode: "shell" },
  });
}

export async function terminalText(bb: BbPluginApi, terminalId: string, sinceSeq = 0) {
  const output = await bb.sdk.terminals.output({ terminalId, sinceSeq, tailBytes: 256_000 });
  const chunks = (output as any).chunks ?? [];
  let nextSeq = sinceSeq;
  const text = chunks.map((chunk: any) => {
    nextSeq = Math.max(nextSeq, Number(chunk.seq ?? nextSeq) + 1);
    if (chunk.data) return chunk.data;
    if (chunk.dataBase64) return Buffer.from(chunk.dataBase64, "base64").toString("utf8");
    return "";
  }).join("");
  const session = await bb.sdk.terminals.get({ terminalId }) as any;
  return {
    text,
    nextSeq,
    exited: Boolean(session.exitedAt || session.exitCode !== undefined && session.exitCode !== null),
    exitCode: typeof session.exitCode === "number" ? session.exitCode : null,
  };
}

export async function runEphemeralCommand(bb: BbPluginApi, environmentId: string, command: string) {
  const session = await createEnvironmentTerminal(bb, environmentId, {
    title: "bbonductor command",
    command,
  });
  const terminalId = (session as any).id as string;
  let seq = 0;
  let combined = "";
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const state = await terminalText(bb, terminalId, seq);
    seq = state.nextSeq;
    combined += state.text;
    if (state.exited) {
      await bb.sdk.terminals.close({ terminalId, mode: "force" }).catch(() => undefined);
      return { stdout: combined, exitCode: state.exitCode ?? 0 };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await bb.sdk.terminals.close({ terminalId, mode: "force" }).catch(() => undefined);
  throw new Error(`Command timed out: ${command}`);
}
