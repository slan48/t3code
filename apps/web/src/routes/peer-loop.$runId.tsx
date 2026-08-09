import type { PeerLoopRecoveryChoice } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { PeerLoopDetailView } from "../components/peerLoop/PeerLoopDetailView";
import { forgetPeerLoopRun, peerLoopRunViewAtom, reattachPeerLoopRunAtom } from "../state/peerLoop";
import {
  usePeerLoopOwnerMessage,
  usePeerLoopPause,
  usePeerLoopRecover,
  usePeerLoopResume,
} from "../state/peerLoopCommands";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";

/**
 * One run.
 *
 * A single subscription carries the attach snapshot, the backlog and the live
 * tail, so this page never issues a second `run.attach` — asking again would
 * make Peer Loop replay for it and serialise behind the replay already running.
 *
 * Nothing here acts on its own. Reattaching after a resync restores observation
 * and only that: no run is resumed, recovered or started because a view came
 * back, and no failed command is retried.
 */
function PeerLoopRunRoute() {
  const { runId } = Route.useParams();
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const view = useAtomValue(peerLoopRunViewAtom(runId));
  const reattach = useAtomSet(reattachPeerLoopRunAtom(runId));

  const ownerMessage = usePeerLoopOwnerMessage();
  const pause = usePeerLoopPause();
  const resume = usePeerLoopResume();
  const recover = usePeerLoopRecover();

  // The view is dropped when nothing is watching this run, so a session that
  // opened twenty runs is not still holding twenty bounded activity slices.
  useEffect(() => () => forgetPeerLoopRun(runId), [runId]);

  const sendOwnerMessage = useCallback(
    (text: string) => {
      if (environmentId === null) return;
      void ownerMessage.invoke({ environmentId, input: { runId, text } });
    },
    [environmentId, ownerMessage, runId],
  );

  const doPause = useCallback(() => {
    if (environmentId === null) return;
    void pause.invoke({ environmentId, input: { runId } });
  }, [environmentId, pause, runId]);

  const doResume = useCallback(() => {
    if (environmentId === null) return;
    void resume.invoke({ environmentId, input: { runId } });
  }, [environmentId, resume, runId]);

  const doRecover = useCallback(
    (choice: PeerLoopRecoveryChoice) => {
      if (environmentId === null) return;
      void recover.invoke({ environmentId, input: { runId, choice } });
    },
    [environmentId, recover, runId],
  );

  const doReattach = useCallback(() => reattach(null), [reattach]);

  return (
    <PeerLoopDetailView
      view={view}
      ownerMessage={ownerMessage.state}
      pauseState={pause.state}
      resumeState={resume.state}
      recoverState={recover.state}
      actions={{
        sendOwnerMessage,
        pause: doPause,
        resume: doResume,
        recover: doRecover,
        reattach: doReattach,
      }}
    />
  );
}

export const Route = createFileRoute("/peer-loop/$runId")({
  component: PeerLoopRunRoute,
});
