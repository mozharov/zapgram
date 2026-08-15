import {expect, test} from 'bun:test'
import {effectiveCustomMessage, richCustomMessage} from './custom-message.js'

const chat = {id: -100, title: 'Community', customMessageRu: null, customMessageEn: null}

test('the default message is used when the owner set none', () => {
  expect(richCustomMessage(chat, 'en')).toContain('Community')
  expect(richCustomMessage(chat, 'en')).toBe(effectiveCustomMessage(chat, 'en'))
})

test('a spoiler stored in the classic form is rewritten for a rich message', () => {
  const stored = {...chat, customMessageEn: 'Secret: <span class="tg-spoiler">the code</span>!'}

  expect(richCustomMessage(stored, 'en')).toBe('Secret: <tg-spoiler>the code</tg-spoiler>!')
})

test('tags shared by both dialects are left alone', () => {
  const stored = {
    ...chat,
    customMessageEn: '<b>Hi</b> <i>there</i> <code>/join</code> <blockquote>quote</blockquote>',
  }

  expect(richCustomMessage(stored, 'en')).toBe(stored.customMessageEn)
})
