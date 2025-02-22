import {InlineKeyboard, type CallbackQueryContext} from 'grammy'
import {getAccessibleChatsCount, getPaginatedAccessibleChats} from '../../../models/chat.js'
import type {BotContext} from '../../context.js'
import {buildChatsKeyboard} from '../../helpers/keyboards/chats.js'
import {config} from '../../../config.js'

export const chatsCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  let {page} = parseMatch(ctx.match)
  const limit = config.chatsPerPage
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

function parseMatch(match: string | RegExpMatchArray) {
  const [, strPage] = match
  const page = parseInt(strPage!)
  if (isNaN(page) || page <= 0) return {page: 1}
  return {page}
}
