import {describe, expect, test} from 'bun:test'
import {translate} from '@telegram/i18n/i18n.js'
import {
  createActivePrompt,
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
})
