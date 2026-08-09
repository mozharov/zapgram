import type {BaseContext} from '@telegram/context.js'
import type {ChatTypeContext} from 'grammy'
import type {ChatMemberUpdated} from 'grammy/types'
import {getRuntime} from '../../../../runtime.js'

type Context = ChatTypeContext<BaseContext, 'private'> & {
  myChatMember: ChatMemberUpdated
}

/**
 * Track private block/unblock so broadcasts skip unreachable users.
 * Telegram: member → kicked = blocked; kicked → member = unblocked.
 */
export async function privateMyChatMemberHandler(ctx: Context) {
  const userId = ctx.chat.id
  const oldStatus = ctx.myChatMember.old_chat_member.status
  const newStatus = ctx.myChatMember.new_chat_member.status

  const becameBlocked = oldStatus !== 'kicked' && newStatus === 'kicked'
  const becameUnblocked = oldStatus === 'kicked' && newStatus === 'member'

  if (!becameBlocked && !becameUnblocked) return

  const {users, log} = getRuntime()
  try {
    // Ensure row exists so a block before any other interaction is still recorded.
    const existing = await users.findById(userId)
    if (!existing) {
      await users.getOrCreate({
        id: userId,
        languageCode: ctx.from?.language_code,
        username: ctx.from?.username,
        firstName: ctx.from?.first_name,
      })
    }
    await users.setBotBlocked(userId, becameBlocked)
    log.info({userId, botBlocked: becameBlocked}, 'Private chat member status updated')
  } catch (error) {
    log.error({error, userId}, 'Failed to update botBlocked from my_chat_member')
  }
}
