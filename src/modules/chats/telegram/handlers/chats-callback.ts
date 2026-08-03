import {getAccessibleChatsCount, getPaginatedAccessibleChats} from '@modules/chats/repository.js'
import {buildChatsKeyboard} from '@modules/chats/telegram/keyboards/chats.js'
import {chatsPageRoute} from '@telegram/callback-data.js'
import type {BotContext} from '@telegram/context.js'
import {type CallbackQueryContext, InlineKeyboard} from 'grammy'
import {getRuntime} from '../../../../runtime.js'

export const chatsCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  let {page} = chatsPageRoute.parse(ctx.match)
  const limit = getRuntime().config.chatsPerPage
  const totalChats = await getAccessibleChatsCount(ctx.user.id)
  if (totalChats === 0) {
    const keyboard = new InlineKeyboard().add({
      url: `https://t.me/${ctx.me.username}?startgroup=true`,
      text: ctx.t('button.add-chat'),
    })
    return ctx.editMessageText(ctx.t('chats.empty'), {reply_markup: keyboard})
  }
  if (totalChats <= (page - 1) * limit) page = Math.ceil(totalChats / limit)

  const chats = await getPaginatedAccessibleChats(ctx.user.id, page, limit)
  const hasNext = totalChats > page * limit
  return ctx.editMessageText(ctx.t('chats'), {
    reply_markup: buildChatsKeyboard(ctx.t, chats, page, hasNext),
  })
}
