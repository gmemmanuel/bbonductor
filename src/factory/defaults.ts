// The out-of-the-box factory: the plan → review → build → review → ship
// pipeline, driven by skills the project already has. Stage prompts name a
// skill and nothing else, so the project's own skills stay the source of truth
// for how each stage works.
import type { Config } from "./model.js";

export const DEFAULT_CONFIG: Config = {
  roles: {
    orchestrator: {
      label: "Orchestrator / planner",
      providerId: "",
      model: "",
      reasoningLevel: "",
      permissionMode: "",
    },
    "plan-review": {
      label: "Plan reviewer",
      providerId: "",
      model: "",
      reasoningLevel: "",
      permissionMode: "",
    },
    build: {
      label: "Builder",
      providerId: "",
      model: "",
      reasoningLevel: "",
      permissionMode: "",
    },
    "code-review": {
      label: "Code reviewer",
      providerId: "",
      model: "",
      reasoningLevel: "",
      permissionMode: "",
    },
    ship: {
      label: "Shipper",
      providerId: "",
      model: "",
      reasoningLevel: "",
      permissionMode: "",
    },
    watch: {
      label: "Watch",
      providerId: "",
      model: "",
      reasoningLevel: "",
      permissionMode: "",
    },
    "harness-improver": {
      label: "Harness improver",
      providerId: "",
      model: "",
      reasoningLevel: "",
      permissionMode: "",
    },
  },
  stages: {
    plan: {
      label: "Plan",
      role: "orchestrator",
      review: false,
      prompt:
        "Use the `create-plan` skill to plan {key}: {title}.\n\n{brief}",
    },
    "plan-review": {
      label: "Review plan",
      role: "plan-review",
      review: true,
      prompt:
        "Use the `review-plan` skill to independently review the plan for {key}: {title}.\n\n{previous}",
    },
    build: {
      label: "Build",
      role: "build",
      review: false,
      prompt:
        "Use the `execute-plan` skill to build {key}: {title}.\n\n{brief}\n\n{previous}",
    },
    "code-review": {
      label: "Review code",
      role: "code-review",
      review: true,
      prompt:
        "Use the `review-code` skill to independently review the complete branch for {key}: {title}.\n\n{previous}",
    },
    ship: {
      label: "Ship",
      role: "ship",
      review: false,
      prompt:
        "Use the `ship` skill to close out and ship {key}: {title}.\n\n{previous}",
    },
    fix: {
      label: "Fix",
      role: "build",
      review: false,
      prompt:
        "{key}: {title} is a Small bug. Fix it on the fast path your project instructions describe, then ship it.\n\n{brief}",
    },
  },
  pipelines: {
    full: ["plan", "plan-review", "build", "code-review", "ship"],
    planned: ["plan-review", "build", "code-review", "ship"],
    reviewed: ["build", "code-review", "ship"],
    "small-bug": ["fix"],
  },
  defaultPipeline: "planned",
  maxActiveItems: 8,
  agents: {
    orchestrator: {
      label: "Orchestrator",
      role: "orchestrator",
      skill: "factory-orchestrator",
      memoryPath: "docs/agents/orchestrator/MEMORY.md",
    },
    watch: {
      label: "Watch",
      role: "watch",
      skill: "factory-watch",
      memoryPath: "docs/agents/watch/MEMORY.md",
    },
    "harness-improver": {
      label: "Harness improver",
      role: "harness-improver",
      skill: "factory-harness-improver",
      memoryPath: "docs/agents/harness-improver/MEMORY.md",
    },
  },
};
