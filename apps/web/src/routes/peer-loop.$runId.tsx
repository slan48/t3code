import type { PeerLoopRecoveryChoice } from "@t3tools/contracts";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useContext, useEffect } from "react";

import { PeerLoopDetailView } from "../components/peerLoop/PeerLoopDetailView";
import {
  disposePeerLoopRun,
  peerLoopObservationAtoms,
  peerLoopRunObservationAtom,
  restartPeerLoopObservation,
} from "../state/peerLoop";
import {
  usePeerLoopOwnerMessage,
  usePeerLoopPause,
  usePeerLoopRecover,
  usePeerLoopResume,
  useRefreshPeerLoopRuns,
} from "../state/peerLoopCommands";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";

/**
 * One run.
 *
 * A single subscription carries the attach snapshot, the backlog and the live
 * tail, so this page never issues a second `run.attach` — asking again would
 * make Peer Loop replay for it and serialise behind the replay already running.
 *
 * Nothing here acts on its own. Restarting observation after a resync, or after
 * a command whose effect the snapshot has to reflect, reads again and only
 * that: no run is resumed, recovered or started because a view came back, and
 * no failed command is retried.
 */
function PeerLoopRunRoute() {
  const { runId } = Route.useParams();
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const observation = useAtomValue(peerLoopRunObservationAtom(runId));
  const registry = useContext(RegistryContext);

  const ownerMessage = usePeerLoopOwnerMessage();
  const pause = usePeerLoopPause();
  const resume = usePeerLoopResume();
  const recover = usePeerLoopRecover();
  const refreshRuns = useRefreshPeerLoopRuns();

  /**
   * Stop observing exactly the pair this effect was for.
   *
   * KEYED BY THE PAIR, NOT HELD IN A REF. A ref that tracked the latest value
   * pointed at whichever environment was current at unmount, so switching
   * primary environment A → B while the route stayed open disposed B and left A
   * retained — a machine nobody is observing, still holding its view and its
   * cursor. An effect keyed by both members runs its cleanup the moment either
   * changes, which is precisely when that pair stopped being observed.
   */
  useEffect(() => {
    if (environmentId === null) return;
    const key = { environmentId, runId };
    return () => disposePeerLoopRun(registry, peerLoopObservationAtoms, key);
  }, [environmentId, registry, runId]);

  /**
   * Observe again from the cursor this view can vouch for.
   *
   * The current cursor is read from the registry inside the callback, not
   * captured from a render, so a resync that moved the safe cursor cannot
   * refresh the subscription it just left behind.
   */
  const restartObservation = useCallback(() => {
    if (environmentId === null) return;
    restartPeerLoopObservation(registry, peerLoopObservationAtoms, { environmentId, runId });
  }, [environmentId, registry, runId]);

  /** Re-read the run and the list after a command. Observation only. */
  const reconcile = useCallback(() => {
    restartObservation();
    refreshRuns();
  }, [refreshRuns, restartObservation]);

  const sendOwnerMessage = useCallback(
    (text: string) => {
      if (environmentId === null) return;
      void ownerMessage.invoke({ environmentId, input: { runId, text } }).then((result) => {
        // Observation only: the queued-message count and the run's own snapshot
        // both live in Peer Loop, and this is how they are re-read.
        if (result === null) return;
        reconcile();
      });
    },
    [environmentId, ownerMessage, reconcile, runId],
  );

  const doPause = useCallback(() => {
    if (environmentId === null) return;
    void pause.invoke({ environmentId, input: { runId } }).then((result) => {
      if (result === null) return;
      reconcile();
    });
  }, [environmentId, pause, reconcile, runId]);

  const doResume = useCallback(() => {
    if (environmentId === null) return;
    void resume.invoke({ environmentId, input: { runId } }).then((result) => {
      // A resume takes control, so the next snapshot is the one that says
      // whether recovery is now possible. Re-reading is the only way to find
      // out; nothing is inferred from the resume result alone.
      if (result === null) return;
      reconcile();
    });
  }, [environmentId, reconcile, resume, runId]);

  const doRecover = useCallback(
    (choice: PeerLoopRecoveryChoice) => {
      if (environmentId === null) return;
      void recover.invoke({ environmentId, input: { runId, choice } }).then((result) => {
        if (result === null) return;
        reconcile();
      });
    },
    [environmentId, recover, reconcile, runId],
  );

  return (
    <PeerLoopDetailView
      view={observation.view}
      observation={{
        waiting: observation.waiting,
        error: observation.error,
        empty: observation.empty,
      }}
      ownerMessage={ownerMessage.state}
      pauseState={pause.state}
      resumeState={resume.state}
      recoverState={recover.state}
      actions={{
        sendOwnerMessage,
        pause: doPause,
        resume: doResume,
        recover: doRecover,
        reattach: restartObservation,
        // Disabled when there is no environment: there is nothing to retry and
        // certainly no invented id to subscribe with.
        retryObservation: observation.observable ? restartObservation : NO_RETRY,
      }}
    />
  );
}

const NO_RETRY = (): void => undefined;

export const Route = createFileRoute("/peer-loop/$runId")({
  component: PeerLoopRunRoute,
});
