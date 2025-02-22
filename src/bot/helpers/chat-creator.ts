import type {ChatTypeContext} from 'grammy'
import type {BaseContext} from '../context.js'
import {getOrCreateUser} from '../../models/user.js'

type Context = ChatTypeContext<BaseContext, 'group' | 'supergroup' | 'channel'>

export async function getChatCreator(ctx: Context) {
  const admins = await ctx.getChatAdministrators().catch((error: unknown) => {
    ctx.log.warn({error}, 'Could not get chat administrators')
    return []
  })
  const owner = admins.find(admin => admin.status === 'creator')
  if (!owner || owner.status !== 'creator') return null
  return owner
}

export async function getUserFromChatCreator(ctx: Context) {
  const creator = await getChatCreator(ctx)
  if (!creator) return null
  const {user} = creator
  return getOrCreateUser({
    id: user.id,
    username: user.username,
    languageCode: ctx.from?.language_code,
    firstName: user.first_name,
  })
}
