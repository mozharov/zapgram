import {updateUser} from '@modules/users/repository.js'
import {buildSettingsKeyboard} from '@modules/wallet/telegram/keyboards/settings.js'
import {mergePersonProperties, personPropertiesFromTelegram} from '@telegram/analytics.js'
import type {BotContext} from '@telegram/context.js'
import {showLivingMenu} from '@telegram/helpers/living-menu.js'
import {getRuntime} from '../../../../runtime.js'

export const nwcTipsCallback = async (ctx: BotContext) => {
  const user = await updateUser(ctx.user.id, {nwcTips: !ctx.user.nwcTips})
  ctx.user.nwcTips = user.nwcTips
  ctx.log.info({nwcTips: user.nwcTips}, 'NWC tips setting toggled')
  // Merge with Telegram person fields so a local $set does not drop name / $name.
  getRuntime().posthog?.capture({
    event: 'nwc_tips_toggled',
    properties: {
      nwc_tips_enabled: user.nwcTips,
      ...mergePersonProperties(ctx.from ? personPropertiesFromTelegram(ctx.from) : undefined, {
        $set: {nwc_tips_enabled: user.nwcTips},
      }),
    },
  })
  await ctx.answerCallbackQuery({
    text: ctx.t(
      ctx.user.nwcTips ? 'callback-answer.nwc-tip-enabled' : 'callback-answer.nwc-tip-disabled',
    ),
  })
  return showLivingMenu(ctx, () =>
    ctx.reply(ctx.t('settings'), {
      reply_markup: buildSettingsKeyboard(ctx.t, user),
    }),
  )
}
