import {CallbackQueryContext} from 'grammy'
import {BotContext} from '../../context.js'
import {getChat, updateChat} from '../../../models/chat.js'
import {buildChatKeyboard} from '../../helpers/keyboards/chat.js'

export const chatCallback = async (ctx: CallbackQueryContext<BotContext>) => {
  const {id} = parseMatch(ctx.match)
  const chat = await getChat({id})
  if (!chat || chat.status === 'no_access') {
    await ctx.editMessageText(ctx.t('chat.not-found'))
    return
  }

  const tgChat = await ctx.api.getChat(chat.id).catch((error: unknown) => {
    ctx.log.error({error, chatId: chat.id}, 'Error getting chat from Telegram')
    return null
  })
  if (tgChat) {
    const updatedChat = await updateChat(chat.id, {title: tgChat.title!, username: tgChat.username})
    chat.title = updatedChat.title
    chat.username = updatedChat.username
  }

  await ctx.editMessageText(
    ctx.t('chat', {
      title: chat.title,
      username: chat.username ?? 'no',
      status: chat.status,
      price: chat.price,
      paymentType: chat.paymentType,
    }),
    {reply_markup: buildChatKeyboard(ctx.t, chat)},
  )
}

function parseMatch(match: string | RegExpMatchArray) {
  const [, strId] = match
  const id = parseInt(strId!)
  return {id}
}
