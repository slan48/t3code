import { type ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  /**
   * Whether this conversation may approve.
   *
   * A Navigator conversation may not: an accepted approval is the one answer
   * that lets a read-only thread act, and the server refuses it. Declining and
   * cancelling stay, because clearing a pending request is explicitly allowed —
   * without them a Navigator conversation would be stuck on a question it could
   * never answer.
   */
  canAcceptApprovals?: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  canAcceptApprovals = true,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "cancel")}
      >
        Cancel turn
      </Button>
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "decline")}
      >
        Decline
      </Button>
      {canAcceptApprovals ? (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={isResponding}
            onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
          >
            Always allow this session
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={isResponding}
            onClick={() => void onRespondToApproval(requestId, "accept")}
          >
            Approve once
          </Button>
        </>
      ) : null}
    </>
  );
});
