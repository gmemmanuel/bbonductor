#!/usr/bin/env node
// Live check: runs the factory against a real, throwaway bb server.
//
// It starts bb on its own ports with its own data folder (your real bb is not
// touched), installs this plugin plus bb's "echo" example provider (a fake
// model that costs nothing), creates a scratch git project, and walks tickets
// through the pipeline, asserting what bb actually did.
//
//   node scripts/live-check.mjs            run, print PASS/FAIL, tear down
//   node scripts/live-check.mjs --keep     leave the server up at :38990 to look at
//
// The echo model cannot call tools, so the script plays the agent's part by
// running `bb factory done` / `ask` with that thread's identity. Everything
// else (threads, worktrees, events, messages, the inbox) is real.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const work = join(root, ".context", "live");
const dataDir = join(work, "data");
const repoDir = join(work, "repo");
const echoDir = join(work, "echo-provider");
const PORT = 38990;
const DAEMON_PORT = 38991;
const bbBin = join(root, "node_modules", ".bin", "bb");
const bbAppBin = join(root, "node_modules", ".bin", "bb-app");
const bbVersion = JSON.parse(readFileSync(join(root, "node_modules", "bb-app", "package.json"), "utf8")).version;
const sdkVersion = JSON.parse(
  readFileSync(join(root, "node_modules", "@get-bb", "plugin-sdk", "package.json"), "utf8"),
).version;

const env = {
  ...process.env,
  BB_SERVER_URL: `http://127.0.0.1:${PORT}`,
  BB_DATA_DIR: dataDir,
  BB_HOST_DAEMON_PORT: String(DAEMON_PORT),
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sh = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const bb = (args, extraEnv = {}) => sh(bbBin, args, { env: { ...env, ...extraEnv }, cwd: repoDir }).trim();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === "" ? "" : `\n      ${detail}`}`);
}

/** Poll until `read()` returns something truthy, or give up. */
async function until(read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(400);
  }
}

let project = "";
const status = () => JSON.parse(bb(["factory", "status", "--project", project, "--json"]));
const ticket = (key) => status().items.find((item) => item.key === key);
const threads = () => JSON.parse(bb(["thread", "list", "--project", project, "--json"]));
const as = (threadId) => ({ BB_THREAD_ID: threadId, BB_PROJECT_ID: project });
const lastMessage = (threadId) => bb(["thread", "log", threadId]);

function prepareEchoProvider() {
  if (existsSync(join(echoDir, "node_modules"))) return;
  rmSync(echoDir, { recursive: true, force: true });
  const clone = join(work, "bb-src");
  if (!existsSync(clone)) {
    sh("git", ["clone", "--depth", "1", "--filter=blob:none", "--sparse", "--branch", `desktop-v${bbVersion}`, "https://github.com/get-bb/bb.git", clone]);
    sh("git", ["sparse-checkout", "set", "examples/plugins/echo-provider"], { cwd: clone });
  }
  cpSync(join(clone, "examples", "plugins", "echo-provider"), echoDir, { recursive: true });
  for (const file of readdirSync(echoDir)) {
    if (file.endsWith(".test.ts") || file === "vitest.config.ts") rmSync(join(echoDir, file));
  }
  const manifestPath = join(echoDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies["@get-bb/plugin-sdk"] = sdkVersion;
  manifest.devDependencies = { "@types/node": "^22.0.0" };
  delete manifest.scripts;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: echoDir });
}

async function main() {
  mkdirSync(work, { recursive: true });
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  sh("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# factory live check\n");
  sh("git", ["add", "."], { cwd: repoDir });
  sh("git", ["-c", "user.email=live@example.com", "-c", "user.name=Live", "commit", "-qm", "init"], { cwd: repoDir });

  console.log(`Preparing echo provider for bb ${bbVersion}…`);
  prepareEchoProvider();
  sh(bbBin, ["plugin", "build"], { cwd: root, env });

  // A server left over from an earlier `--keep` run would answer on the same
  // port with stale data, and the checks would pass against the wrong thing.
  const inUse = await fetch(`http://127.0.0.1:${PORT}/`).then(() => true, () => false);
  if (inUse) {
    throw new Error(`Port ${PORT} is already in use. Stop the earlier live-check server first (lsof -ti tcp:${PORT} | xargs ps -o pgid= | xargs -I{} kill -- -{}).`);
  }
  console.log("Starting a throwaway bb server…");
  const server = spawn(
    bbAppBin,
    ["--data-dir", dataDir, "--server-port", String(PORT), "--host-daemon-port", String(DAEMON_PORT), "--no-in-app-updates", "--bundled"],
    { env, stdio: "ignore", detached: true },
  );
  const stop = () => {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  };
  try {
    const up = await until(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${PORT}/`)).ok;
      } catch {
        return false;
      }
    }, 60_000);
    if (!up) throw new Error("bb server did not start");
    await until(() => {
      try {
        bb(["project", "list"]);
        return true;
      } catch {
        return false;
      }
    });

    bb(["plugin", "install", root, "--yes"]);
    bb(["plugin", "install", echoDir, "--yes"]);
    const loaded = bb(["plugin", "list"]);
    check("plugin loads on a real bb server", /bbonductor@\S+\s+running/.test(loaded), loaded.slice(0, 400));

    project = JSON.parse(bb(["project", "create", "--name", "Live check", "--root", repoDir, "--json"])).id;
    for (const role of ["orchestrator", "plan-review", "build", "code-review", "ship", "harness-improver"]) {
      bb(["factory", "role", role, "--provider", "echo-agent", "--model", "echo-1", "--reasoning", "low", "--project", project]);
    }

    // --- standing agent
    bb(["factory", "agent", "start", "orchestrator", "--project", project]);
    const orchestrator = await until(() => threads().find((t) => t.title === "Planner / strategist"));
    check("orchestrator starts as a pinned thread", orchestrator?.pinnedAt != null);
    const mainEnv = await until(() => threads().find((t) => t.title === "Planner / strategist")?.environmentId);
    const environments = bb(["environment", "list", "--project", project]);
    check(
      "orchestrator runs in the main checkout, not a worktree",
      new RegExp(`${mainEnv}\\s+\\S+\\s+project-checkout`).test(environments),
      environments,
    );

    // --- lanes
    bb(["factory", "enqueue", "LIVE-1", "First in lane", "--lane", "Coach", "--pipeline", "reviewed", "--project", project], as(orchestrator.id));
    bb(["factory", "enqueue", "LIVE-2", "Second in lane", "--lane", "Coach", "--pipeline", "reviewed", "--project", project]);
    bb(["factory", "enqueue", "LIVE-3", "Other lane", "--lane", "Plan", "--pipeline", "small-bug", "--project", project]);
    check("first ticket in a lane starts", ticket("LIVE-1").status === "running" || ticket("LIVE-1").status === "stalled");
    check("second ticket in the same lane waits", ticket("LIVE-2").status === "queued");
    check("a ticket in another lane starts in parallel", ticket("LIVE-3").status !== "queued");

    const build = ticket("LIVE-1").threads.build;
    const buildThread = await until(() => threads().find((t) => t.id === build && t.environmentId));
    check("the ticket runs on the configured model", buildThread?.providerId === "echo-agent");
    check(
      "the ticket gets its own worktree",
      new RegExp(`${buildThread?.environmentId}\\s+\\S+\\s+git-worktree`).test(bb(["environment", "list", "--project", project])),
    );

    // --- stall detection (the echo model never reports)
    const stalled = await until(() => (ticket("LIVE-1").status === "stalled" ? true : null), 30_000);
    check("a thread that stops without reporting is nudged, then escalated", stalled === true);
    check("the stall is in the founder inbox", status().inbox.some((e) => e.kind === "stalled" && e.from.includes("LIVE-1")));
    check("the nudge was delivered to the thread", lastMessage(build).includes("You stopped without reporting"));

    // --- handoff to an independent review in the same worktree
    bb(["factory", "done", "--outcome", "complete", "--summary", "Built on its branch; tests pass."], as(build));
    const review = await until(() => ticket("LIVE-1").threads["code-review"]);
    const reviewThread = await until(() => threads().find((t) => t.id === review && t.environmentId));
    check("review starts in a new thread", review && review !== build);
    check("review shares the builder's worktree", reviewThread?.environmentId === buildThread?.environmentId);
    check("review receives the builder's handoff", lastMessage(review).includes("Built on its branch; tests pass."));
    check("reporting a stage clears its stall from the inbox", !status().inbox.some((e) => e.threadId === build));

    // --- a stage's question goes to the chief of staff, who takes it to the founder
    bb(
      ["factory", "ask", "Should rest days count as missed?", "--context", "Today they count as rest.", "--option", "Count as rest", "--option", "Count as missed", "--recommend", "Count as missed."],
      as(review),
    );
    const chief = await until(() => threads().find((t) => t.title === "Chief of staff"));
    check("a stage's question starts the chief of staff and goes there first", Boolean(chief) && status().inbox.every((e) => e.kind !== "question"));
    check("the ticket shows as with the chief of staff", ticket("LIVE-1").status === "triage");
    bb(
      ["factory", "ask", "Should a rest day count as missed?", "--about", "LIVE-1:code-review", "--context", "Today it counts as rest.", "--option", "Count as rest", "--option", "Count as missed", "--recommend", "Count as missed."],
      as(chief.id),
    );
    const question = status().inbox.find((e) => e.kind === "question");
    check("the chief of staff's question lands in the inbox for that ticket", question?.from === "Code review · LIVE-1" && question.options.length === 2);
    check("the ticket shows as waiting on the founder", ticket("LIVE-1").status === "needs-founder");
    bb(["factory", "answer", question.id, "Count as missed."]);
    const answered = await until(() => (lastMessage(review).includes("Count as missed.") ? true : null));
    check("the answer is delivered to the thread that asked", answered === true);
    check("the inbox clears after answering", !status().inbox.some((e) => e.kind === "question"));

    // --- review returns changes; author fixes; ticket moves past the review
    bb(["factory", "done", "--outcome", "changes_requested", "--summary", "Rename the helper."], as(review));
    const findings = await until(() => (lastMessage(build).includes("Rename the helper.") ? true : null));
    check("review findings go to the builder's existing thread", findings === true);
    bb(["factory", "done", "--outcome", "complete", "--summary", "Helper renamed.", "--founder-check", "Open the greeting screen as demo@example.com and see the new name."], as(build));
    const gate = await until(() => status().inbox.find((e) => e.kind === "check"));
    check("a visible change waits for the founder to try it before ship", Boolean(gate) && !ticket("LIVE-1").threads.ship);
    bb(["factory", "approve", gate.id]);
    const ship = await until(() => ticket("LIVE-1").threads.ship);
    check("after fixes the ticket goes to ship without a second review", Boolean(ship));

    // --- agent-to-agent messaging
    bb(["factory", "message", "orchestrator", "Units differ between plan and code."], as(ship));
    const relayed = await until(() => (lastMessage(orchestrator.id).includes("Units differ between plan and code.") ? true : null));
    check("a worker can message the orchestrator", relayed === true);

    // --- finishing frees the lane
    bb(["factory", "done", "--outcome", "complete", "--summary", "Merged."], as(ship));
    check("the ticket finishes after its last stage", ticket("LIVE-1").status === "done");
    check("a finished ticket's threads are left for the founder to archive", threads().some((t) => t.id === build));
    for (const id of Object.values(ticket("LIVE-1").threads)) bb(["thread", "archive", id]);
    const cleared = await until(() => (status().items.find((i) => i.key === "LIVE-1")?.status === "archived" ? true : null));
    check("archiving its workspace clears a finished ticket from the board", cleared === true);
    const next = await until(() => (ticket("LIVE-2").status !== "queued" ? true : null));
    check("the next ticket in the lane starts", next === true);
  } finally {
    const failed = results.filter((result) => !result.ok).length;
    console.log(`\n${results.length - failed}/${results.length} live checks passed.`);
    if (keep) {
      console.log(`Server left running: http://127.0.0.1:${PORT}/plugins/bbonductor/factory  (stop with: kill -- -${server.pid})`);
      server.unref();
    } else {
      stop();
    }
    process.exitCode = failed === 0 && results.length > 0 ? 0 : 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
