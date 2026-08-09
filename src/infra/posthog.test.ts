import {describe, expect, mock, test} from 'bun:test'
import {
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
})

describe('captureUserException', () => {
  test('no-ops without client', () => {
    expect(() => captureUserException(undefined, new Error('x'), 1)).not.toThrow()
  })

  test('forwards distinct id and merges error props', () => {
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
    expect(seen?.props?.feature).toBe('donations')
    expect(seen?.props?.stage).toBe('pay_nwc')
    expect(seen?.props?.error_message).toBe('pay failed')
  })
})
