import { memo, useCallback, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  existingRunIdFromRefusal,
  parseSafetyLimit,
  validateStartRun,
  type PeerLoopErrorPresentation,
} from "~/peerLoopPresentation";
import { PeerLoopErrorNotice } from "./PeerLoopPrimitives";

export interface StartRunProject {
  readonly id: string;
  readonly title: string;
  /** The environment-local path Peer Loop will be pointed at. */
  readonly workspaceRoot: string;
}

/**
 * Which project the form is actually about.
 *
 * The owner's choice while it still exists, otherwise the first project there
 * is. One value drives the select, the validation and the submission, so the
 * form cannot display one project and send another — which is the failure a
 * separately seeded piece of state produced.
 */
export function resolveEffectiveProject(
  projects: readonly StartRunProject[],
  chosen: string | null,
): string | null {
  if (chosen !== null && projects.some((project) => project.id === chosen)) return chosen;
  return projects[0]?.id ?? null;
}

export interface StartRunSubmission {
  readonly projectPath: string;
  readonly objective: string;
  readonly safetyLimit: number | undefined;
}

/**
 * Start a run.
 *
 * Projects come from the ones this T3 Code environment already knows, and what
 * is sent is that project's own workspace root — never a path typed here.
 * There is no executable field, no permission mode and no recovery default:
 * naming a program for a machine to run, or pre-choosing how an interrupted
 * turn is resolved, is not something a browser on a phone should be able to do.
 *
 * `newRun` is deliberately absent. Forcing a second run past Peer Loop's
 * duplicate-run refusal forks the Reviewer's conversation, which cannot be
 * recreated; the refusal instead points at the run that already exists.
 */
export const PeerLoopStartRun = memo(function PeerLoopStartRun({
  projects,
  pending,
  error,
  disabled,
  disabledReason,
  onSubmit,
}: {
  readonly projects: readonly StartRunProject[];
  readonly pending: boolean;
  readonly error: PeerLoopErrorPresentation | null;
  readonly errorSource?: import("@t3tools/contracts").PeerLoopError | null;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly onSubmit: (submission: StartRunSubmission) => void;
}) {
  const [open, setOpen] = useState(false);
  /** What the owner picked, if they picked. Null means "whatever is first". */
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);
  const [objective, setObjective] = useState("");
  const [safetyLimit, setSafetyLimit] = useState("");

  // DERIVED, NOT SEEDED. Initialising state from `projects[0]` on the first
  // render captured an empty list — the project atom resolves asynchronously —
  // and never caught up, so the select displayed a project while validation
  // still held null and the button stayed disabled until the owner reselected
  // the option that was already showing.
  const projectId = resolveEffectiveProject(projects, chosenProjectId);

  const validation = useMemo(
    () => validateStartRun({ projectId, objective, safetyLimit }),
    [projectId, objective, safetyLimit],
  );

  const submit = useCallback(
    (formEvent: React.FormEvent) => {
      formEvent.preventDefault();
      if (!validation.ok || pending || disabled) return;
      const project = projects.find((entry) => entry.id === projectId);
      if (project === undefined) return;
      onSubmit({
        projectPath: project.workspaceRoot,
        objective: objective.trim(),
        safetyLimit: parseSafetyLimit(safetyLimit),
      });
    },
    [disabled, objective, onSubmit, pending, projectId, projects, safetyLimit, validation.ok],
  );

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || projects.length === 0}
          onClick={() => setOpen(true)}
        >
          Start a run
        </Button>
        {disabledReason === null ? null : (
          <p className="text-xs text-muted-foreground">{disabledReason}</p>
        )}
        {projects.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Add a project to this environment first — Peer Loop is pointed at one of them.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className="flex min-w-0 flex-col gap-3 rounded-lg border px-3 py-3"
      onSubmit={submit}
      aria-label="Start a Peer Loop run"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="peer-loop-project">
          Project
        </label>
        <select
          id="peer-loop-project"
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={projectId ?? ""}
          disabled={pending}
          onChange={(changeEvent) => setChosenProjectId(changeEvent.target.value || null)}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
        {validation.projectError === null ? null : (
          <p className="text-xs text-destructive">{validation.projectError}</p>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="peer-loop-objective">
          Objective
        </label>
        <Textarea
          id="peer-loop-objective"
          rows={3}
          value={objective}
          disabled={pending}
          placeholder="What should this run achieve?"
          onChange={(changeEvent) => setObjective(changeEvent.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Delivered word for word to the first Reviewer turn.
        </p>
        {validation.objectiveError === null ? null : (
          <p className="text-xs text-destructive">{validation.objectiveError}</p>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="peer-loop-safety">
          Safety limit (optional)
        </label>
        <Input
          id="peer-loop-safety"
          inputMode="numeric"
          value={safetyLimit}
          disabled={pending}
          placeholder="Iterations before Peer Loop stops and asks"
          onChange={(changeEvent) => setSafetyLimit(changeEvent.target.value)}
        />
        {validation.safetyLimitError === null ? null : (
          <p className="text-xs text-destructive">{validation.safetyLimitError}</p>
        )}
      </div>

      {error === null ? null : (
        <PeerLoopErrorNotice error={error}>
          <ExistingRunLink error={error} />
        </PeerLoopErrorNotice>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!validation.ok || pending || disabled}>
          {pending ? "Starting…" : "Start run"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
});

/**
 * The run a duplicate-run refusal points at.
 *
 * Peer Loop hands back the existing run id in structured detail, so the answer
 * to "this project already has an unfinished run" is a link to it rather than
 * an override that would fork the Reviewer's conversation.
 */
const ExistingRunLink = memo(function ExistingRunLink({
  error,
}: {
  readonly error: PeerLoopErrorPresentation & { readonly existingRunId?: string | null };
}) {
  const runId = error.existingRunId ?? null;
  if (runId === null) return null;
  return (
    <Link
      to="/peer-loop/$runId"
      params={{ runId }}
      className="text-xs font-medium text-primary underline underline-offset-2"
    >
      Open the run that is already going
    </Link>
  );
});

export { existingRunIdFromRefusal };
