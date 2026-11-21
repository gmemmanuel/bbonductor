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
import { homedir } from "node:os";
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

/** A Chromium to drive the page with: Playwright's cached one, else Chrome. */
function findBrowser() {
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  const cached = existsSync(cache)
    ? readdirSync(cache)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort()
        .reverse()
        .flatMap((name) => readdirSync(join(cache, name)).map((dir) => join(cache, name, dir, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")))
    : [];
  return [...cached, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => existsSync(path)) ?? null;
}

const runTerminals = (threadId) =>
  JSON.parse(bb(["terminal", "list", "--thread", threadId, "--json"])).sessions.filter((session) => session.title === "Run" && session.status === "running");

async function runButtonChecks(entry) {
  const executablePath = findBrowser();
  if (executablePath === null) {
    check("the inbox Run button starts the project's Run command", false, "No Chromium found. Run: npx playwright install chromium");
    return;
  }
  // A new bb opens on its first-run setup guide, which would cover the page.
  bb(["settings", "general", "onboardingCompletedAt", String(Date.now())]);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(`http://127.0.0.1:${PORT}/plugins/bbonductor/factory`);
    // The inbox shows small cards; a card opens a pop-up with the whole entry.
    const openTile = async (key) => {
      await page.locator('[data-testid="inbox-tile"]').first().waitFor({ timeout: 30_000 });
      await page.keyboard.press("Escape");
      const tile = page.locator('[data-testid="inbox-tile"]').filter({ hasText: key });
      await tile.waitFor({ timeout: 30_000 });
      await tile.click();
      await page.locator('[data-testid="inbox-panel"] [data-testid="inbox-entry"]').waitFor({ timeout: 15_000 });
    };
    const tiles = page.locator('[data-testid="inbox-tile"]');
    await tiles.first().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: join(work, "page-inbox.png") });
    check(
      "the inbox is two columns of small cards, Decisions and Founder QA, with no actions on them",
      (await page.locator('[data-testid="inbox-column-qa"] [data-testid="inbox-tile"]').count()) === 1 &&
        (await page.locator('[data-testid="inbox-column-decisions"] [data-testid="inbox-tile"]').count()) === 1 &&
        (await page.getByRole("button", { name: "Approve and ship" }).count()) === 0,
    );
    await openTile("LIVE-1");
    await page.screenshot({ path: join(work, "page-inbox-open.png") });
    const button = page.locator('[data-testid="inbox-run"]').first();
    await button.waitFor({ timeout: 30_000 });
    await button.click();
    const started = await until(() => runTerminals(entry.threadId)[0] ?? null);
    check("the inbox Run button starts a Run terminal in the ticket's workspace", started !== null);
    const ran = started === null ? null : await until(() => (bb(["terminal", "output", started.id]).includes("factory-run-42") ? true : null));
    check("it runs the command from the project's settings file", ran === true);
    const mark = page.getByLabel("Run is up in this workspace").first();
    const marked = await mark.waitFor({ state: "attached", timeout: 15_000 }).then(() => true, () => false);
    check("the sidebar marks a workspace whose Run is up", marked);
    await page.screenshot({ path: join(work, "run-button.png") });

    // While it is up the same button stops it.
    const stopLabel = await button.filter({ hasText: "Stop" }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check("the Run button reads Stop while that workspace is running", stopLabel);
    await button.click();
    const stopped = await until(() => (runTerminals(entry.threadId).length === 0 ? true : null));
    check("pressing Stop ends the Run command", stopped === true);
    const cleared = await mark.waitFor({ state: "detached", timeout: 15_000 }).then(() => true, () => false);
    check("the mark clears when Run stops", cleared);
    const runLabel = await button.filter({ hasText: "Run" }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check("the button reads Run again", runLabel);

    // --- the other two pages
    // Shipping takes two presses.
    const approve = page.locator('[data-testid="inbox-approve"]');
    await approve.click();
    const asksAgain = (await approve.innerText()).includes("Press again") && Boolean(status().inbox.find((e) => e.id === entry.id));
    check("one press on Approve and ship releases nothing; it asks for a second", asksAgain);
    await page.keyboard.press("Escape");
    await page.goto(`http://127.0.0.1:${PORT}/plugins/bbonductor/factory-lanes`);
    const lanes = await page.locator('[data-testid="lane"]').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    await page.screenshot({ path: join(work, "page-lanes.png") });
    check("swimlanes have their own page", lanes && (await page.locator('[data-testid="inbox-entry"]').count()) === 0);
    await page.goto(`http://127.0.0.1:${PORT}/plugins/bbonductor/factory-settings`);
    const url = page.locator('[data-testid="ticket-url"]');
    await url.waitFor({ timeout: 30_000 });
    await url.fill("https://tracker.example/issue/{key}");
    await url.press("Enter");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(work, "page-settings.png") });
    await page.goto(`http://127.0.0.1:${PORT}/plugins/bbonductor/factory-lanes`);
    const arrow = await page.locator('[data-testid="ticket-link"]:visible').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    check("settings has its own page, and a ticket link set there puts an arrow on each ticket", arrow);
    await page.goto(`http://127.0.0.1:${PORT}/plugins/bbonductor/factory`);
    await openTile("LIVE-1");

    // --- the reply box on that entry
    // The check waiting on the founder, wherever its group puts it on the page.
    const gateCard = () => page.locator('[data-testid="inbox-entry"]');
    const reply = gateCard().locator('[data-testid="inbox-reply"]');
    const oneLine = (await reply.boundingBox()).height;
    await reply.fill("The name is right.\nThe spacing under it is too tight.\nSee the picture.\nFourth line.");
    const grew = await until(async () => ((await reply.boundingBox()).height > oneLine * 2 ? true : null), 5_000);
    check("the reply box grows as the founder types more lines", grew === true);
    writeFileSync(join(work, "shot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    await gateCard().locator('[data-testid="inbox-attach-input"]').setInputFiles(join(work, "shot.png"));
    const attached = await page.locator('[data-testid="inbox-attachments"]').getByText("shot.png").waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check("a picture can be attached to the reply", attached);
    await page.reload();
    await openTile("LIVE-1");
    const kept = await until(async () => ((await gateCard().locator('[data-testid="inbox-reply"]').inputValue().catch(() => "")).includes("spacing under it") ? true : null), 20_000);
    const keptFile = (await page.locator('[data-testid="inbox-attachments"]').getByText("shot.png").count()) > 0;
    check("the draft and its attachment survive leaving the page", kept === true && keptFile);
    await gateCard().locator('[data-testid="inbox-open-thread"]').click();
    const composer = page.getByText("The spacing under it is too tight.").first();
    const carried = await composer.waitFor({ timeout: 20_000 }).then(() => true, () => false);
    check("opening the thread brings the draft into its composer", carried && page.url().includes(entry.threadId), page.url());
    const banner = await page.locator('[data-testid="inbox-banner"]').getByText("Try it before it ships").first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check("the thread shows what the founder was asked, above its composer", banner);
    await page.screenshot({ path: join(work, "draft-in-thread.png") });
    await page.goto(`http://127.0.0.1:${PORT}/plugins/bbonductor/factory`);
    await openTile("LIVE-1");
    const again = gateCard().locator('[data-testid="inbox-reply"]');
    await again.waitFor({ timeout: 30_000 });
    check("the draft has moved, not been copied: the inbox box is empty again", (await again.inputValue()) === "");

    // Answering from the inbox sends the words and the picture to the thread.
    // Done on the stalled entry, so the ticket under test stays where it is.
    const stalled = status().inbox.find((e) => e.kind === "stalled");
    await openTile("LIVE-3");
    const card = page.locator('[data-testid="inbox-entry"]').filter({ hasText: stalled.question });
    await card.locator('[data-testid="inbox-reply"]').fill("Carry on from the last step.");
    await card.locator('[data-testid="inbox-attach-input"]').setInputFiles(join(work, "shot.png"));
    await card.locator('[data-testid="inbox-attachments"]').getByText("shot.png").waitFor({ timeout: 15_000 });
    await page.screenshot({ path: join(work, "reply-box.png") });
    await card.getByRole("button", { name: "Send", exact: true }).click();
    const delivered = await until(() => (lastMessage(stalled.threadId).includes("Carry on from the last step.") ? true : null));
    check("an answer with a picture attached reaches the thread", delivered === true && !status().inbox.some((e) => e.id === stalled.id), bb(["thread", "log", stalled.threadId]).slice(-600));
  } finally {
    await browser.close();
  }
}

async function main() {
  mkdirSync(work, { recursive: true });
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  sh("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# factory live check\n");
  // The Run command the inbox Run button starts. The shell does the sum, so
  // the marker only appears in the output if the command really ran.
  mkdirSync(join(repoDir, ".conductor"), { recursive: true });
  writeFileSync(join(repoDir, ".conductor", "settings.toml"), '[scripts.run.run]\ncommand = "echo factory-run-$((40+2)); sleep 600"\ndefault = true\n');
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
    const orchestrator = await until(() => threads().find((t) => t.title === "CTO"));
    check("orchestrator starts as a pinned thread", orchestrator?.pinnedAt != null);
    const mainEnv = await until(() => threads().find((t) => t.title === "CTO")?.environmentId);
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

    const named = await until(() => (JSON.parse(bb(["environment", "list", "--json"])).find((e) => e.id === buildThread?.environmentId)?.name === "LIVE-1" ? true : null), 15_000);
    check("the thread is titled with its role and the workspace with its ticket", buildThread?.title === "Execution" && named === true, `${buildThread?.title}`);

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

    // --- a stage's question goes to the ticket's issue owner, who takes it to the founder
    bb(
      ["factory", "ask", "Should rest days count as missed?", "--context", "Today they count as rest.", "--option", "Count as rest", "--option", "Count as missed", "--recommend", "Count as missed."],
      as(review),
    );
    const owner = await until(() => threads().find((t) => t.title === "Issue owner"));
    check("a stage's question starts the ticket's issue owner and goes there first", Boolean(owner) && status().inbox.every((e) => e.kind !== "question"));
    check("the owner works in the ticket's own workspace", (await until(() => threads().find((t) => t.id === owner.id)?.environmentId)) === buildThread?.environmentId);
    check("the ticket shows as with its issue owner", ticket("LIVE-1").status === "with-owner");
    const toOwner = await until(() => (lastMessage(owner.id).includes("Should rest days count as missed?") ? true : null));
    check("the owner receives the stage's question", toOwner === true);
    bb(
      ["factory", "ask", "Should a rest day count as missed?", "--context", "Today it counts as rest.", "--option", "Count as rest", "--option", "Count as missed", "--recommend", "Count as missed."],
      as(owner.id),
    );
    const question = status().inbox.find((e) => e.kind === "question");
    check("the owner's question lands in the inbox, in the owner's thread", question?.from === "Issue owner · LIVE-1" && question.threadId === owner.id && question.options.length === 2);
    check("the ticket shows as waiting on the founder", ticket("LIVE-1").status === "needs-founder");
    // The founder answers by typing in the owner's thread, not in the inbox.
    bb(["thread", "tell", owner.id, "Count as missed.", "--mode", "auto"]);
    const cleared1 = await until(() => (status().inbox.some((e) => e.kind === "question") ? null : true));
    check("typing the answer in the thread clears the inbox entry", cleared1 === true);
    check("the ticket then waits on its owner to pass the answer on", ticket("LIVE-1").status === "with-owner");
    bb(["factory", "note", "Founder: a rest day counts as missed."], as(owner.id));
    bb(["factory", "message", "LIVE-1:code-review", "Count as missed."], as(owner.id));
    const answered = await until(() => (lastMessage(review).includes("Count as missed.") ? true : null));
    const after = ticket("LIVE-1").status;
    // The echo model answers at once and never reports, so by now it may have been reminded and flagged.
    check("the owner's reply reaches the stage that asked, and the ticket is back with that stage", answered === true && (after === "running" || after === "stalled"), `answered=${answered} status=${after}`);

    // --- a small bug gets no workspace: it rides with the next planned ticket in its lane
    const before = threads().length;
    bb(["factory", "enqueue", "LIVE-4", "Typo on the greeting", "--lane", "Coach", "--pipeline", "small-bug", "--project", project]);
    check("a small bug rides with the next ticket in its lane", ticket("LIVE-2").riders?.[0]?.key === "LIVE-4" && !ticket("LIVE-4") && threads().length === before);

    // --- review returns changes; author fixes; ticket moves past the review
    bb(["factory", "done", "--outcome", "changes_requested", "--summary", "Rename the helper."], as(review));
    const findings = await until(() => (lastMessage(build).includes("Rename the helper.") ? true : null));
    check("review findings go to the builder's existing thread", findings === true);
    bb(["factory", "done", "--outcome", "complete", "--summary", "Helper renamed.", "--founder-check", "Open the greeting screen as demo@example.com and see the new name."], as(build));
    const gate = await until(() => status().inbox.find((e) => e.kind === "check"));
    check("a visible change waits for the founder to try it before ship", Boolean(gate) && !ticket("LIVE-1").threads.ship);
    check("his check lives in the owner's thread", gate.threadId === owner.id);

    // --- the founder presses Run on that inbox entry, in a real browser
    await runButtonChecks(gate);

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

    // --- follow-up work under a new ticket continues in the same workspace
    bb(["factory", "follow-up", "LIVE-9", "Round two", "--handoff", "Rename it back."], as(owner.id));
    const followUp = await until(() => ticket("LIVE-9")?.threads.build);
    const followThread = await until(() => threads().find((t) => t.id === followUp && t.environmentId));
    check("a follow-up ticket takes over the shipped ticket's workspace", followThread?.environmentId === buildThread?.environmentId && ticket("LIVE-1").status === "archived");
    const workspaces = () => JSON.parse(bb(["environment", "list", "--json"]));
    const renamed = await until(() => (workspaces().find((e) => e.id === buildThread?.environmentId)?.name === "LIVE-9" ? true : null), 8_000);
    check("the workspace takes the new ticket's name", renamed === true, JSON.stringify(workspaces().map((e) => [e.id, e.name])) + ` want ${buildThread?.environmentId}`);
    bb(["factory", "cancel", "LIVE-9", "--project", project]);
    // LIVE-2 was held up behind it only for the length of this check.
    bb(["factory", "done", "--outcome", "complete", "--summary", "Built."], as(ticket("LIVE-3").threads.fix));
    for (const id of Object.values(ticket("LIVE-3").threads)) bb(["thread", "archive", id]);
    const cleared = await until(() => (status().items.find((i) => i.key === "LIVE-3")?.status === "archived" ? true : null));
    check("archiving its workspace clears a finished ticket from the board", cleared === true);
    const next = await until(() => (ticket("LIVE-2").status !== "queued" ? true : null));
    check("the next ticket in the lane starts", next === true);
    const told = await until(() => (lastMessage(ticket("LIVE-2").threads.build ?? "").includes("LIVE-4: Typo on the greeting") ? true : null));
    check("its builder is told about the small bug riding with it", told === true);
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
