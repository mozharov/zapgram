import type {BaseContext} from '@telegram/context.js'
import type {ChatTypeContext} from 'grammy'
import {getOrCreateUser} from '../../models/user.js'

type Context = ChatTypeContext<BaseContext, 'group' | 'supergroup' | 'channel'>

export async function getChatCreator(ctx: Context, chatId?: number) {
  const admins = await (chatId
    ? ctx.api.getChatAdministrators(chatId)
    : ctx.getChatAdministrators()
  ).catch((error: unknown) => {
    ctx.log.warn({error, chatId}, 'Could not get chat administrators')
    return []
  })
  const owner = admins.find(admin => admin.status === 'creator')
  if (owner?.status !== 'creator') return null
  return owner
}

export async function getUserFromChatCreator(ctx: Context, chatId?: number) {
  const creator = await getChatCreator(ctx, chatId)
  if (!creator) return null
  const {user} = creator
  return getOrCreateUser({
    id: user.id,
    username: user.username,
    languageCode: ctx.from?.language_code,
    firstName: user.first_name,
  })
}
