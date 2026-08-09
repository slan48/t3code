import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { PeerLoopIndexView } from "../components/peerLoop/PeerLoopIndexView";
import {
  PeerLoopStartRun,
  type StartRunProject,
  type StartRunSubmission,
} from "../components/peerLoop/PeerLoopStartRun";
import { existingRunIdFromRefusal } from "~/peerLoopPresentation";
import { peerLoopRunsAtom, peerLoopStatusAtom } from "../state/peerLoop";
import { usePeerLoopStartRun } from "../state/peerLoopCommands";
import { environmentProjects } from "../state/projects";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";

/**
 * The Peer Loop index.
 *
 * Reading the status atom here — and only inside this route — is what starts
 * the bridge. Nothing that mounts on ordinary startup touches it, so an install
 * that never opens this page never spawns `peer-loop`.
 */
function PeerLoopIndexRoute() {
  const navigate = useNavigate();
  const status = useAtomValue(peerLoopStatusAtom);
  const runs = useAtomValue(peerLoopRunsAtom);
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const shells = useAtomValue(
    environmentProjects.environmentProjectsAtom(environmentId ?? ("" as never)),
  );
  const start = usePeerLoopStartRun();
  const [refusalRunId, setRefusalRunId] = useState<string | null>(null);

  const projects = useMemo<readonly StartRunProject[]>(
    () =>
      shells.map((shell) => ({
        id: shell.id,
        title: shell.title,
        // The project's own environment-local root. Never a path typed here.
        workspaceRoot: shell.workspaceRoot,
      })),
    [shells],
  );

  const onSubmit = useCallback(
    (submission: StartRunSubmission) => {
      if (environmentId === null) return;
      setRefusalRunId(null);
      void start
        .invoke({
          environmentId,
          input: {
            projectPath: submission.projectPath,
            objective: submission.objective,
            ...(submission.safetyLimit === undefined
              ? {}
              : { safetyLimit: submission.safetyLimit }),
          },
        })
        .then((result) => {
          if (result !== null) {
            void navigate({ to: "/peer-loop/$runId", params: { runId: result.runId } });
          }
        });
    },
    [environmentId, navigate, start],
  );

  // A duplicate-run refusal names the run that already exists, which is a far
  // better answer than an override that would fork the Reviewer's conversation.
  const startError = start.state.error;
  const existingRunId = useMemo(() => refusalRunId, [refusalRunId]);

  return (
    <PeerLoopIndexView
      status={status}
      runs={runs}
      startRun={
        <PeerLoopStartRun
          projects={projects}
          pending={start.state.pending}
          error={
            startError === null
              ? null
              : { ...startError, ...(existingRunId === null ? {} : { existingRunId }) }
          }
          disabled={environmentId === null || !status.configured}
          disabledReason={
            environmentId === null
              ? "Connect to the machine running Peer Loop first."
              : status.configured
                ? null
                : "Peer Loop is not available on this machine."
          }
          onSubmit={onSubmit}
        />
      }
    />
  );
}

export const Route = createFileRoute("/peer-loop/")({
  component: PeerLoopIndexRoute,
});

export { existingRunIdFromRefusal };
