// The project's Run command: what the Run button starts in a ticket's
// workspace. It lives in the project, in `.conductor/settings.toml`, the same
// file Conductor and bb's Conductor layout read, so there is one place to set it.

/** bb's Conductor layout titles its Run terminal this; sharing it lets either Run button replace the other's. */
export const RUN_TERMINAL_TITLE = "Run";
export const RUN_SETTINGS_FILE = ".conductor/settings.toml";

function tomlString(raw: string): string | null {
  const value = raw.trim();
  if (value.startsWith('"""') || value.startsWith("'''")) return null;
  if (value.startsWith('"')) {
    let end = 1;
    while (end < value.length && value[end] !== '"') end += value[end] === "\\" ? 2 : 1;
    if (end >= value.length) return null;
    try {
      const parsed: unknown = JSON.parse(value.slice(0, end + 1));
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? null : value.slice(1, end);
  }
  return null;
}

/**
 * The run command in a settings file, or null. Reads both forms:
 * `[scripts] run = "…"`, and `[scripts.run.<name>]` with `command = "…"`,
 * where the table marked `default = true` wins, else the first.
 */
export function parseRunCommand(text: string): string | null {
  let section = "";
  let plain: string | null = null;
  let defaultTable: string | null = null;
  const tables = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      section = header[1]!.trim();
      continue;
    }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (assignment === null) continue;
    const key = section === "" ? assignment[1]! : `${section}.${assignment[1]}`;
    const table = /^scripts\.run\.([A-Za-z0-9_-]+)\.(command|default)$/.exec(key);
    if (table !== null) {
      if (table[2] === "default") {
        if (assignment[2]!.trim().startsWith("true")) defaultTable = table[1]!;
      } else {
        const command = tomlString(assignment[2]!)?.trim();
        if (command) tables.set(table[1]!, command);
      }
      continue;
    }
    if (key === "scripts.run") plain = tomlString(assignment[2]!)?.trim() || null;
  }
  if (plain !== null) return plain;
  return (defaultTable === null ? undefined : tables.get(defaultTable)) ?? [...tables.values()][0] ?? null;
}
