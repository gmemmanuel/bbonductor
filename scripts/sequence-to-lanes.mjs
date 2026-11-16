#!/usr/bin/env node
// Adapter: turn the Justus `sequence` skill's output into the JSON that
// `bb factory lanes` accepts. Read-only; it prints, it does not queue.
//
//   node scripts/sequence-to-lanes.mjs <sequence-board.json> <sequence-schedule.json>
//   bb factory lanes "$(node scripts/sequence-to-lanes.mjs board.json schedule.json)" --project <id>
//
// The schedule says which tickets share a lane and in what order. The board
// says how far each ticket already is, which picks the pipeline:
//   label "Small bug"      -> small-bug  (fix and ship in one stage)
//   label "Plan reviewed"  -> reviewed   (start at build)
//   a plan document exists -> planned    (start at plan review)
//   otherwise              -> full       (start at plan)
// Tickets already being built or reviewed elsewhere (In Progress, In Review)
// are left out and listed on stderr, so the factory does not start them twice.
import { readFileSync } from "node:fs";

const [boardPath, schedulePath] = process.argv.slice(2);
if (!boardPath || !schedulePath) {
  console.error("Usage: sequence-to-lanes.mjs <sequence-board.json> <sequence-schedule.json>");
  process.exit(2);
}
const board = JSON.parse(readFileSync(boardPath, "utf8"));
const schedule = JSON.parse(readFileSync(schedulePath, "utf8"));
const issues = new Map(board.issues.map((issue) => [issue.key, issue]));
const IN_FLIGHT = new Set(["In Progress", "In Review"]);

const pipelineFor = (issue) => {
  const labels = issue.labels ?? [];
  if (labels.includes("Small bug")) return "small-bug";
  if (labels.includes("Plan reviewed")) return "reviewed";
  if (issue.plan_doc) return "planned";
  return "full";
};

const skipped = [];
const lanes = schedule.lanes
  .map((lane, index) => ({
    name: `Lane ${index + 1}`,
    items: lane.issues.flatMap((key) => {
      const issue = issues.get(key);
      if (issue === undefined) {
        skipped.push(`${key}: not on the board snapshot`);
        return [];
      }
      if (IN_FLIGHT.has(issue.state)) {
        skipped.push(`${key}: already ${issue.state}`);
        return [];
      }
      return [
        {
          key,
          title: issue.title,
          pipeline: pipelineFor(issue),
          brief: [issue.url, issue.plan_doc ? `Plan: ${issue.plan_doc}` : ""].filter(Boolean).join("\n"),
        },
      ];
    }),
  }))
  .filter((lane) => lane.items.length > 0);

for (const line of skipped) console.error(`left out ${line}`);
console.log(JSON.stringify({ lanes }));
