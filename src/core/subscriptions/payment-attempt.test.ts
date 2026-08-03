import {describe, expect, test} from 'bun:test'
import {classifyPaidAttempt} from './payment-attempt.js'

describe('classifyPaidAttempt', () => {
  test('an unprocessed attempt wins an unclaimed intent', () => {
    expect(
      classifyPaidAttempt({
        attemptId: 'attempt-a',
        winnerAttemptId: null,
        attemptProcessed: false,
      }),
    ).toBe('winner')
  })

  test('the claimed winner resumes winner processing after a crash', () => {
    expect(
      classifyPaidAttempt({
        attemptId: 'attempt-a',
        winnerAttemptId: 'attempt-a',
        attemptProcessed: false,
      }),
    ).toBe('winner')
  })

  test('another paid attempt is refunded after a winner was claimed', () => {
    expect(
      classifyPaidAttempt({
        attemptId: 'attempt-b',
        winnerAttemptId: 'attempt-a',
        attemptProcessed: false,
      }),
    ).toBe('already_won_refund')
  })

  test('a completed winner is already processed', () => {
    expect(
      classifyPaidAttempt({
        attemptId: 'attempt-a',
        winnerAttemptId: 'attempt-a',
        attemptProcessed: true,
      }),
    ).toBe('already_processed')
  })

  test('a completed refund is already processed', () => {
    expect(
      classifyPaidAttempt({
        attemptId: 'attempt-b',
        winnerAttemptId: 'attempt-a',
        attemptProcessed: true,
      }),
    ).toBe('already_processed')
  })
})
