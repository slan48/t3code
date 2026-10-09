import {
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { TextGenerationPolicy, TextGenerationPolicyKind } from "./TextGenerationPolicy.ts";

/** The later approval orchestration layer's classifier deadline. */
export const NAVIGATOR_APPROVAL_CLASSIFIER_TIMEOUT_MS = 10_000;

/**
 * The approval classifier is intentionally pinned to the built-in Codex
 * instance and text-generation defaults. It must not inherit a Navigator
 * thread's provider/model or the configurable general text-generation choice.
 */
export const navigatorApprovalClassifierPreset = {
  modelSelection: createModelSelection(
    ProviderInstanceId.make("codex"),
    DEFAULT_TEXT_GENERATION_MODEL,
    [{ id: "reasoningEffort", value: DEFAULT_TEXT_GENERATION_REASONING_EFFORT }],
  ),
  timeoutMs: NAVIGATOR_APPROVAL_CLASSIFIER_TIMEOUT_MS,
} as const;

export const defaultTextGenerationPolicy: TextGenerationPolicy = {
  kind: "default",
  inferRepositoryConventions: false,
};

export const conventionalCommitsTextGenerationPolicy: TextGenerationPolicy = {
  kind: "conventional_commits",
  commitInstructions:
    "Use Conventional Commits when generating commit subjects. Prefer the narrowest accurate type and include a scope only when it is obvious from the diff.",
  changeRequestInstructions:
    "Keep the change request title concise. Do not force Conventional Commit syntax into the title unless the repository already uses it.",
  inferRepositoryConventions: false,
};

export const repositoryConventionsTextGenerationPolicy: TextGenerationPolicy = {
  kind: "repo_conventions",
  commitInstructions:
    "Follow the repository's established commit message style when examples are available.",
  changeRequestInstructions:
    "Follow the repository's established change request title and body style when examples are available.",
  inferRepositoryConventions: true,
};

export const customTextGenerationPolicy = (
  overrides: Omit<Partial<TextGenerationPolicy>, "kind">,
): TextGenerationPolicy => ({
  kind: "custom",
  inferRepositoryConventions: false,
  ...overrides,
});

export const textGenerationPresets: Record<
  Exclude<TextGenerationPolicyKind, "custom">,
  TextGenerationPolicy
> = {
  default: defaultTextGenerationPolicy,
  conventional_commits: conventionalCommitsTextGenerationPolicy,
  repo_conventions: repositoryConventionsTextGenerationPolicy,
};
