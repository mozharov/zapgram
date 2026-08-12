import {sleep} from '@core/utils/sleep.js'
import type {User} from '@infra/db/types.js'
import {createOrUpdateChat, getChat, updateChat} from '@modules/chats/repository.js'
import {getOrCreateUser} from '@modules/users/repository.js'
import {captureBotEvent, setTelegramChatGroup} from '@telegram/analytics.js'
import {chatRoute} from '@telegram/callback-data.js'
import type {BaseContext} from '@telegram/context.js'
import {getChatCreator} from '@telegram/helpers/chat-creator.js'
import {translate} from '@telegram/i18n/i18n.js'
import {type ChatTypeContext, InlineKeyboard} from 'grammy'
import type {ChatMember, ChatMemberUpdated} from 'grammy/types'
import {getRuntime} from '../../../../runtime.js'

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
  const updated =
    chat.status !== 'no_access' ? await updateChat(chat.id, {status: 'no_access'}) : chat
  const {posthog} = getRuntime()
  if (posthog) setTelegramChatGroup(posthog, updated, String(chat.ownerId))
  if (hasRequiredRights(ctx.myChatMember.old_chat_member)) {
    captureBotEvent(
      posthog,
      'bot_removed_from_chat',
      {
        chat_title: updated.title,
        chat_type: updated.type,
        member_status_new: ctx.myChatMember.new_chat_member.status,
      },
      {chatId: updated.id, distinctId: String(chat.ownerId)},
    )
    await notifyOwner(ctx, chat.owner, 'removed')
  }
}

async function handleRightsGrant(ctx: Context) {
  // Sometimes we need to wait for the new permissions to take effect, especially for channels.
  await sleep(getRuntime().config.CHAT_RIGHTS_DELAY_MS)
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
  const saved = await createOrUpdateChat({
    id: ctx.chat.id,
    title: ctx.chat.title,
    ownerId: owner.id,
    type: ctx.chat.type,
    status: chat?.status === 'active' ? 'active' : 'inactive',
  })
  const {posthog} = getRuntime()
  if (posthog) setTelegramChatGroup(posthog, saved, String(owner.id))
  if (!hasRequiredRights(ctx.myChatMember.old_chat_member)) {
    captureBotEvent(
      posthog,
      'bot_added_to_chat',
      {
        chat_title: saved.title,
        chat_type: saved.type,
        paid_access_status: saved.status,
        member_status_new: ctx.myChatMember.new_chat_member.status,
      },
      {chatId: saved.id, distinctId: String(owner.id)},
    )
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
      callback_data: chatRoute.build({chatId: ctx.chat.id}),
      text: ctx.t('button.chat-settings'),
    })
  }
  await getRuntime()
    .notifier.send(
      user.id,
      translate(`paid-chat.bot-${type}`, user.languageCode, {
        title: ctx.chat.title,
        username: ctx.chat.username ?? 'no',
      }),
      {reply_markup: keyboard},
    )
    .then(sent => {
      if (!sent) ctx.log.error('Error sending message to chat owner')
    })
}
