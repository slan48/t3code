import type { PeerLoopRecoveryChoice } from "@t3tools/contracts";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { PeerLoopDetailView } from "../components/peerLoop/PeerLoopDetailView";
import {
  forgetPeerLoopRun,
  peerLoopRunCursorAtom,
  peerLoopRunEventsAtom,
  peerLoopRunObservationAtom,
  rewindPeerLoopRun,
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
  const setCursor = useAtomSet(peerLoopRunCursorAtom(runId));

  /**
   * Restarting the stream at the cursor it is already on.
   *
   * `useAtomRefresh` on the exact environment/run/cursor subscription. Setting
   * the cursor atom to the value it already holds would do nothing at all — the
   * subscription atom is keyed by that value — so a resync at an unchanged safe
   * cursor would silently never reattach.
   */
  const refreshStream = useAtomRefresh(
    peerLoopRunEventsAtom(environmentId ?? ("" as never), runId, observation.cursor),
  );

  const ownerMessage = usePeerLoopOwnerMessage();
  const pause = usePeerLoopPause();
  const resume = usePeerLoopResume();
  const recover = usePeerLoopRecover();
  const refreshRuns = useRefreshPeerLoopRuns();

  // The view is dropped when nothing is watching this run, so a session that
  // opened twenty runs is not still holding twenty bounded activity slices.
  useEffect(() => () => forgetPeerLoopRun(runId), [runId]);

  /**
   * Observe again from the cursor this view can vouch for.
   *
   * The rewind keeps the trimmed view — its `needsResync`, its snapshot and the
   * activity at or below the safe cursor — and the refresh is what actually
   * opens a replacement stream.
   */
  const restartObservation = useCallback(() => {
    const cursor = rewindPeerLoopRun(runId);
    setCursor(cursor);
    refreshStream();
  }, [refreshStream, runId, setCursor]);

  const sendOwnerMessage = useCallback(
    (text: string) => {
      if (environmentId === null) return;
      void ownerMessage.invoke({ environmentId, input: { runId, text } }).then((result) => {
        // Observation only: the queued-message count and the run's own snapshot
        // both live in Peer Loop, and this is how they are re-read.
        if (result === null) return;
        restartObservation();
        refreshRuns();
      });
    },
    [environmentId, ownerMessage, refreshRuns, restartObservation, runId],
  );

  const doPause = useCallback(() => {
    if (environmentId === null) return;
    void pause.invoke({ environmentId, input: { runId } }).then((result) => {
      if (result === null) return;
      restartObservation();
      refreshRuns();
    });
  }, [environmentId, pause, refreshRuns, restartObservation, runId]);

  const doResume = useCallback(() => {
    if (environmentId === null) return;
    void resume.invoke({ environmentId, input: { runId } }).then((result) => {
      // A resume takes control, so the next snapshot is the one that says
      // whether recovery is now possible. Re-reading is the only way to find
      // out; nothing is inferred from the resume result alone.
      if (result === null) return;
      restartObservation();
      refreshRuns();
    });
  }, [environmentId, refreshRuns, restartObservation, resume, runId]);

  const doRecover = useCallback(
    (choice: PeerLoopRecoveryChoice) => {
      if (environmentId === null) return;
      void recover.invoke({ environmentId, input: { runId, choice } }).then((result) => {
        if (result === null) return;
        restartObservation();
        refreshRuns();
      });
    },
    [environmentId, recover, refreshRuns, restartObservation, runId],
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
        retryObservation: restartObservation,
      }}
    />
  );
}

export const Route = createFileRoute("/peer-loop/$runId")({
  component: PeerLoopRunRoute,
});
