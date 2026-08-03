export type PaidAttemptOutcome = 'winner' | 'already_won_refund' | 'already_processed'

/**
 * Decide how to handle a paid invoice attempt without performing any writes or transfers.
 *
 * A winner that has not finished processing remains `winner` on retry. This is what lets settlement
 * resume after a crash without granting access or paying the owner twice. A different attempt may
 * only be refunded after a winner has been claimed.
 */
export function classifyPaidAttempt(args: {
  attemptId: string
  winnerAttemptId: string | null
  attemptProcessed: boolean
}): PaidAttemptOutcome {
  if (args.attemptProcessed) return 'already_processed'
  if (args.winnerAttemptId === null || args.winnerAttemptId === args.attemptId) return 'winner'
  return 'already_won_refund'
}
