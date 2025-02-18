import {updateUser} from '../../../models/user.js'
import type {BotContext} from '../../context.js'
import {buildSettingsKeyboard} from '../../helpers/keyboards/settings.js'

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
