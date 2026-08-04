import {updateUser} from '@modules/users/repository.js'
import {buildSettingsKeyboard} from '@modules/wallet/telegram/keyboards/settings.js'
import type {BotContext} from '@telegram/context.js'
import {getRuntime} from '../../../../runtime.js'

export const nwcTipsCallback = async (ctx: BotContext) => {
  const user = await updateUser(ctx.user.id, {nwcTips: !ctx.user.nwcTips})
  ctx.user.nwcTips = user.nwcTips
  getRuntime().posthog?.capture({
    event: 'nwc_tips_toggled',
    properties: {
      nwc_tips_enabled: user.nwcTips,
      $set: {nwc_tips_enabled: user.nwcTips},
    },
  })
  await ctx.answerCallbackQuery({
    text: ctx.t(
      ctx.user.nwcTips ? 'callback-answer.nwc-tip-enabled' : 'callback-answer.nwc-tip-disabled',
    ),
  })
  return ctx.editMessageText(ctx.t('settings'), {
    reply_markup: buildSettingsKeyboard(ctx.t, user),
  })
}
