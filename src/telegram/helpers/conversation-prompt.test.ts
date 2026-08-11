import {describe, expect, test} from 'bun:test'
import {translate} from '@telegram/i18n/i18n.js'
import {
  cancelledPromptState,
  classifyPromptUpdate,
  createActivePrompt,
  inactivePromptState,
  isCallbackFromPrompt,
  renderPromptEndState,
} from './conversation-prompt.js'

const prompt = createActivePrompt(
  {chat: {id: 42}, message_id: 73},
  {
    kind: 'text',
    html: '💸 <b>Enter an amount:</b>',
    actionLabel: 'entering an amount',
  },
)

describe('conversation prompt identity', () => {
  test('keeps the original HTML and outbound message identity', () => {
    expect(prompt).toEqual({
      kind: 'text',
      chatId: 42,
      messageId: 73,
      html: '💸 <b>Enter an amount:</b>',
      actionLabel: 'entering an amount',
    })
  })

  test('accepts a callback only from the active prompt in the same chat', () => {
    expect(
      isCallbackFromPrompt({callbackQuery: {message: {chat: {id: 42}, message_id: 73}}}, prompt),
    ).toBe(true)
    expect(
      isCallbackFromPrompt({callbackQuery: {message: {chat: {id: 42}, message_id: 74}}}, prompt),
    ).toBe(false)
    expect(
      isCallbackFromPrompt({callbackQuery: {message: {chat: {id: 41}, message_id: 73}}}, prompt),
    ).toBe(false)
    expect(isCallbackFromPrompt({}, prompt)).toBe(false)
  })

  test('classifies only the current cancel button as a local cancel', () => {
    expect(
      classifyPromptUpdate(
        {
          callbackQuery: {
            data: 'cancel',
            message: {chat: {id: 42}, message_id: 73},
          },
        },
        prompt,
        'cancel',
      ),
    ).toBe('cancel')
    expect(
      classifyPromptUpdate(
        {
          callbackQuery: {
            data: 'cancel',
            message: {chat: {id: 42}, message_id: 72},
          },
        },
        prompt,
        'cancel',
      ),
    ).toBe('interrupt')
    expect(
      classifyPromptUpdate(
        {
          callbackQuery: {
            data: 'wallet',
            message: {chat: {id: 42}, message_id: 73},
          },
        },
        prompt,
        'cancel',
      ),
    ).toBe('interrupt')
  })

  test('classifies commands and system updates as interrupts, but ordinary messages as input', () => {
    expect(
      classifyPromptUpdate(
        {message: {entities: [{type: 'bot_command', offset: 0}]}},
        prompt,
        'cancel',
      ),
    ).toBe('interrupt')
    expect(classifyPromptUpdate({}, prompt, 'cancel')).toBe('interrupt')
    expect(classifyPromptUpdate({message: {}}, prompt, 'cancel')).toBe('input')
  })
})

describe('conversation prompt end state', () => {
  test('appends status without escaping the original HTML', () => {
    expect(renderPromptEndState(`${prompt.html}\n`, '<i>Action canceled.</i>')).toBe(
      '💸 <b>Enter an amount:</b>\n\n<i>Action canceled.</i>',
    )
  })

  test('does not append the same status twice', () => {
    const rendered = renderPromptEndState(prompt.html, '<i>Action canceled.</i>')
    expect(renderPromptEndState(rendered, '<i>Action canceled.</i>')).toBe(rendered)
  })

  test.each([
    ['en', '<i>Action canceled.</i>', '<i>This step is no longer active.</i>'],
    ['ru', '<i>Действие отменено.</i>', '<i>Этот шаг больше не активен.</i>'],
  ])('resolves lifecycle states in %s', (language, cancelled, inactive) => {
    expect(translate('conversation-state.cancelled', language)).toBe(cancelled)
    expect(translate('conversation-state.inactive', language)).toBe(inactive)
    expect(
      translate('conversation-state.interrupted-fallback', language, {action: 'test action'}),
    ).toContain('test action')
    expect(translate('conversation-state.invoice-memo-inactive', language)).not.toContain(
      'conversation-state',
    )
  })

  test('builds a localized cancellation state with the prompt action', () => {
    const ctx = {
      t: (key: string, variables?: Record<string, unknown>) =>
        key === 'conversation-state.cancelled'
          ? '<i>Action canceled.</i>'
          : `Previous action canceled: ${String(variables?.action)}`,
    }
    expect(cancelledPromptState(ctx as never, prompt)).toEqual({
      kind: 'cancelled',
      statusHtml: '<i>Action canceled.</i>',
      fallbackText: 'Previous action canceled: entering an amount',
    })
  })

  test('builds a localized inactive state with a custom status', () => {
    const ctx = {
      t: (key: string, variables?: Record<string, unknown>) =>
        key === 'conversation-state.inactive-fallback'
          ? `Previous step is no longer active: ${String(variables?.action)}`
          : key,
    }
    expect(inactivePromptState(ctx as never, prompt, '<i>Memo is no longer active.</i>')).toEqual({
      kind: 'inactive',
      statusHtml: '<i>Memo is no longer active.</i>',
      fallbackText: 'Previous step is no longer active: entering an amount',
    })
  })
})
