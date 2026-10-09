/**
 * The deliberately permissive cost filter shared by the future Navigator
 * approval gate and its server-side classifier coordinator.
 *
 * This is not approval recognition. It only prevents empty, very large or
 * interrogative utterances from entering the semantic classification path.
 */
export const NAVIGATOR_APPROVAL_CANDIDATE_MAX_CODE_POINTS = 240;

export function isNavigatorApprovalClassificationCandidate(utterance: string): boolean {
  if (utterance.trim().length === 0) return false;
  if ([...utterance].length > NAVIGATOR_APPROVAL_CANDIDATE_MAX_CODE_POINTS) return false;
  if (utterance.includes("?") || utterance.includes("¿")) return false;
  return true;
}
