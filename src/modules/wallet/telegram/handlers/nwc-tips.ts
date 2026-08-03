import {updateUser} from '@modules/users/repository.js'
import {buildSettingsKeyboard} from '@modules/wallet/telegram/keyboards/settings.js'
import type {BotContext} from '@telegram/context.js'

export const nwcTipsCallback = async (ctx: BotContext) => {
  const user = await updateUser(ctx.user.id, {nwcTips: !ctx.user.nwcTips})
  await ctx.answerCallbackQuery({
    text: ctx.t(
      ctx.user.nwcTips ? 'callback-answer.nwc-tip-disabled' : 'callback-answer.nwc-tip-enabled',
    ),
  })
  return ctx.editMessageText(ctx.t('settings'), {
    reply_markup: buildSettingsKeyboard(ctx.t, user),
  })
}
