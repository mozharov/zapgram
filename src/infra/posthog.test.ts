import {describe, expect, mock, test} from 'bun:test'
import {
  APP_ERROR_EVENT,
  captureBotError,
  captureUserEvent,
  captureUserException,
  errorProperties,
  telegramChatGroups,
  telegramUserDistinctId,
} from './posthog.js'

describe('captureUserEvent', () => {
  test('no-ops when posthog is undefined', () => {
    expect(() => captureUserEvent(undefined, 'x', 1)).not.toThrow()
  })

  test('captures with string distinct id and optional chat group', () => {
    const capture = mock(() => undefined)
    captureUserEvent({capture} as never, 'tip_sent', 42, {amount_sats: 21}, {chatId: -100})
    expect(capture).toHaveBeenCalledWith({
      event: 'tip_sent',
      distinctId: '42',
      properties: {amount_sats: 21},
      groups: telegramChatGroups(-100),
    })
  })
})

describe('errorProperties', () => {
  test('serializes Error fields', () => {
    const err = new Error('boom')
    const props = errorProperties(err)
    expect(props.error_name).toBe('Error')
    expect(props.error_message).toBe('boom')
    expect(typeof props.error_stack).toBe('string')
  })

  test('handles non-error values', () => {
    expect(String(errorProperties('nope').error_message)).toContain('nope')
    expect(errorProperties(null)).toEqual({})
  })

  test('flattens AppError code and analytics for exception captures', async () => {
    const {ToBotError} = await import('@core/errors/to-bot.js')
    const err = new ToBotError({
      analytics: {amount_sats: 21, attempted_recipient_id: 900001},
    })
    const props = errorProperties(err)
    expect(props.error_code).toBe('to_bot')
    expect(props.amount_sats).toBe(21)
    expect(props.attempted_recipient_id).toBe(900001)
  })
})

describe('captureBotError / captureUserException', () => {
  test('no-ops without client', () => {
    expect(() => captureUserException(undefined, new Error('x'), 1)).not.toThrow()
    expect(() => captureBotError(undefined, new Error('x'), 1)).not.toThrow()
  })

  test('unexpected errors go to captureException with expected:false', () => {
    let seen: {error: unknown; distinctId?: string; props?: Record<string, unknown>} | undefined
    const captureException = (
      error: unknown,
      distinctId?: string,
      props?: Record<string, unknown>,
    ) => {
      seen = {error, distinctId, props}
    }
    const err = new Error('pay failed')
    captureUserException({capture: () => undefined, captureException} as never, err, 7, {
      feature: 'donations',
      stage: 'pay_nwc',
    })
    expect(seen?.error).toBe(err)
    expect(seen?.distinctId).toBe(telegramUserDistinctId(7))
    expect(seen?.props?.expected).toBe(false)
    expect(seen?.props?.feature).toBe('donations')
    expect(seen?.props?.stage).toBe('pay_nwc')
    expect(seen?.props?.error_message).toBe('pay failed')
  })

  test('AppError becomes product event app_error, not $exception', async () => {
    const {ToBotError} = await import('@core/errors/to-bot.js')
    const capture = mock(() => undefined)
    const captureException = mock(() => undefined)
    const err = new ToBotError({
      analytics: {amount_sats: 21, attempted_recipient_id: 1},
    })
    captureBotError({capture, captureException} as never, err, 316195118)

    expect(captureException).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledTimes(1)
    const [payload] = capture.mock.calls[0] as unknown as [
      {
        event: string
        distinctId: string
        properties: Record<string, unknown>
      },
    ]
    expect(payload.event).toBe(APP_ERROR_EVENT)
    expect(payload.distinctId).toBe('316195118')
    expect(payload.properties.expected).toBe(true)
    expect(payload.properties.error_code).toBe('to_bot')
    expect(payload.properties.amount_sats).toBe(21)
    expect(payload.properties.attempted_recipient_id).toBe(1)
  })
})
