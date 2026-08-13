import {getAccessibleChatsCount, getPaginatedAccessibleChats} from '@modules/chats/repository.js'
import {buildChatsKeyboard} from '@modules/chats/telegram/keyboards/chats.js'
import {chatsPageRoute, staticCallback} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {showLivingMenu} from '@telegram/helpers/living-menu.js'
import {type CallbackQueryContext, InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export const chatsCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  let {page} = chatsPageRoute.parse(ctx.match)
  const limit = getRuntime().config.chatsPerPage
  const totalChats = await getAccessibleChatsCount(ctx.user.id)
  if (totalChats === 0) {
    const keyboard = new InlineKeyboard()
      .row({
        url: `https://t.me/${ctx.me.username}?startgroup=true`,
        text: ctx.t('button.add-chat'),
      })
      .row({
        callback_data: staticCallback.wallet,
        text: ctx.t('button.back'),
      })
    return showLivingMenu(ctx, () => ctx.reply(ctx.t('chats.empty'), {reply_markup: keyboard}))
  }
  if (totalChats <= (page - 1) * limit) page = Math.ceil(totalChats / limit)

  const chats = await getPaginatedAccessibleChats(ctx.user.id, page, limit)
  const hasNext = totalChats > page * limit
  return showLivingMenu(ctx, () =>
    ctx.reply(ctx.t('chats'), {
      reply_markup: buildChatsKeyboard(ctx.t, chats, page, hasNext),
    }),
  )
}
