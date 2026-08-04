import {describe, expect, test} from 'bun:test'
import {captureUserEvent, telegramChatGroups, telegramUserDistinctId} from './posthog.js'

describe('captureUserEvent', () => {
  test('no-ops when posthog is undefined', () => {
    expect(() => captureUserEvent(undefined, 'subscription_expired', 1)).not.toThrow()
  })

  test('captures with string distinct id and optional chat group', () => {
    const calls: unknown[] = []
    captureUserEvent(
      {
        capture: args => {
          calls.push(args)
        },
      },
      'subscription_settled',
      42,
      {amount_sats: 1000},
      {chatId: -100},
    )

    expect(calls).toEqual([
      {
        event: 'subscription_settled',
        distinctId: telegramUserDistinctId(42),
        properties: {amount_sats: 1000},
        groups: telegramChatGroups(-100),
      },
    ])
  })
})
