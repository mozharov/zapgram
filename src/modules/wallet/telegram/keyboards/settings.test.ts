import {expect, test} from 'bun:test'
import type {User} from '@infra/db/types.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {buildSettingsKeyboard} from './settings.js'

const t = ((key: string) => key) as BotContext['t']

test('settings does not expose the chats-and-groups shortcut', () => {
  const keyboard = buildSettingsKeyboard(t, {nwcUrl: null, nwcTips: false} as User)
  const buttons = keyboard.inline_keyboard.flat()

  expect(
    buttons.map(button => ('callback_data' in button ? button.callback_data : undefined)),
  ).toEqual([staticCallback.connectNwc, staticCallback.wallet])
  expect(buttons.map(button => button.text)).not.toContain('button.groups')
})
