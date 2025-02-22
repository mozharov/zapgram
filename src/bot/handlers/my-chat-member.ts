import {InlineKeyboard, Keyboard, type ChatTypeContext} from 'grammy'
import type {ChatMember, ChatMemberUpdated} from 'grammy/types'
import type {BaseContext} from '../context.js'
import {getChatCreator} from '../helpers/chat-creator.js'
import {createOrUpdateChat, getChat, updateChat} from '../../models/chat.js'
import {getOrCreateUser} from '../../models/user.js'
import {translate} from '../lib/i18n.js'
import type {User} from '../../lib/database/types.js'

type Context = ChatTypeContext<BaseContext, 'supergroup' | 'channel'> & {
  myChatMember: ChatMemberUpdated
}

/**
 * Process chat member update for paid chats.
 * If bot is removed from admins, update chat status to inactive and send message to owner.
 * If bot is added to admins, update chat status to active and send message to owner.
 */
export const myChatMemberHandler = async (ctx: Context) => {
  const {new_chat_member: newMember, old_chat_member: oldMember} = ctx.myChatMember
  ctx.log.info({newMember, oldMember, chatId: ctx.chatId}, 'my chat member updated')
  if (!hasRequiredRights(newMember)) return handleRightsRemoval(ctx)
  await handleRightsGrant(ctx)
}

async function handleRightsRemoval(ctx: Context) {
  const chat = await getChat({id: ctx.chatId})
  if (!chat) return
  if (chat.status !== 'no_access') await updateChat(chat.id, {status: 'no_access'})
  if (hasRequiredRights(ctx.myChatMember.old_chat_member)) {
    await notifyOwner(ctx, chat.owner, 'removed')
  }
}

async function handleRightsGrant(ctx: Context) {
  const chatOwner = await getChatCreator(ctx)
  if (!chatOwner) {
    ctx.log.error({chat: ctx.chat}, 'Cannot get chat creator of paid chat')
    return
  }
  const owner = await getOrCreateUser({
    id: chatOwner.user.id,
    username: chatOwner.user.username,
    languageCode: chatOwner.user.language_code,
    firstName: chatOwner.user.first_name,
  })
  const chat = await getChat({id: ctx.chatId})
  await createOrUpdateChat({
    id: ctx.chat.id,
    title: ctx.chat.title,
    username: ctx.chat.username,
    ownerId: owner.id,
    type: ctx.chat.type,
    status: chat?.status === 'active' ? 'active' : 'inactive',
  })
  if (!hasRequiredRights(ctx.myChatMember.old_chat_member)) {
    await notifyOwner(ctx, owner, 'added')
  }
}

/**
 * Check if bot has required rights to manage paid chat.
 */
function hasRequiredRights(member: ChatMember) {
  if (member.status !== 'administrator') return false
  return member.can_invite_users && member.can_restrict_members
}

async function notifyOwner(ctx: Context, user: User, type: 'added' | 'removed') {
  const keyboard = new InlineKeyboard()
  if (type === 'removed') {
    keyboard.add({
      url: `https://t.me/${ctx.me.username}?startgroup=true`,
      text: ctx.t('button.add-to-group'),
    })
  } else {
    keyboard.add({
      callback_data: `chat:${ctx.chat.id}`,
      text: ctx.t('button.chat-settings'),
    })
  }
  await ctx.api
    .sendMessage(
      user.id,
      translate(`paid-chat.bot-${type}`, user.languageCode, {
        title: ctx.chat.title,
        username: ctx.chat.username ?? 'no',
      }),
      {reply_markup: keyboard},
    )
    .catch((error: unknown) => {
      ctx.log.error({error}, 'Error sending message to chat owner')
    })
}
