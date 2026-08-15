import {describe, expect, test} from 'bun:test'
import {joinWizardHtml, promptMessageFromHost} from './conversation-host.js'

describe('joinWizardHtml', () => {
  test('joins non-empty sections with a blank line', () => {
    expect(joinWizardHtml('<b>Title</b>', '<b>Next</b>')).toBe('<b>Title</b>\n\n<b>Next</b>')
  })

  test('drops missing and blank sections', () => {
    expect(joinWizardHtml('<b>Title</b>', undefined, '   ', '<b>Next</b>')).toBe(
      '<b>Title</b>\n\n<b>Next</b>',
    )
  })
})

describe('promptMessageFromHost', () => {
  test('shapes a host as the prompt identity conversation helpers expect', () => {
    expect(promptMessageFromHost({chatId: 7, messageId: 19})).toEqual({
      chat: {id: 7},
      message_id: 19,
    })
  })
})
