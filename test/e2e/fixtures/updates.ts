import type {ChatMember, Message, Update, User} from 'grammy/types'
import {CHAT_CHANNEL, CHAT_GROUP, USER_A} from './ids.js'

export type TestUpdate = Update & {reqId: string}

type FromOverrides = Partial<Omit<User, 'language_code'>> & {language_code?: string}
type CommonOptions = {
  from?: FromOverrides
  chat?: Record<string, unknown>
  updateId?: number
  reqId?: string
  messageId?: number
}
type CallbackOptions = CommonOptions & {callbackId?: string}

let nextUpdateId = 1
let nextMessageId = 1

export function privateText(text: string, opts: CommonOptions = {}): TestUpdate {
  const meta = nextMeta(opts)
  const from = privateUser(opts.from)
  return asUpdate({
    update_id: meta.updateId,
    reqId: meta.reqId,
    message: {
      message_id: meta.messageId,
      date: now(),
      text,
      from,
      chat: privateChat(from, opts.chat),
    },
  })
}

export function privateCommand(text: string, opts: CommonOptions = {}): TestUpdate {
  const update = privateText(text, opts)
  if (!update.message) throw new Error('privateCommand did not create a message')
  // Entity covers only the command token so grammY can put the rest in ctx.match.
  const commandLength = text.split(/\s/, 1)[0]?.length ?? text.length
  update.message.entities = [{type: 'bot_command', offset: 0, length: commandLength}]
  return update
}

export function privateCallback(data: string, opts: CallbackOptions = {}): TestUpdate {
  const meta = nextMeta(opts)
  const from = privateUser(opts.from)
  return asUpdate({
    update_id: meta.updateId,
    reqId: meta.reqId,
    callback_query: {
      id: opts.callbackId ?? `callback-${meta.updateId}`,
      chat_instance: `chat-instance-${from.id}`,
      from,
      data,
      message: {
        message_id: meta.messageId,
        date: now(),
        text: 'E2E callback message',
        from: botUser,
        chat: privateChat(from, opts.chat),
      },
    },
  })
}

export function privatePhotoCaptionCallback(
  data: string,
  opts: CallbackOptions & {caption?: string} = {},
): TestUpdate {
  const update = privateCallback(data, opts)
  const message = update.callback_query?.message
  if (!message) throw new Error('privatePhotoCaptionCallback did not create a message')
  Reflect.deleteProperty(message, 'text')
  Object.assign(message, {
    caption: opts.caption ?? 'E2E invoice',
    photo: [
      {file_id: 'photo-small', file_unique_id: 'photo-small-unique', width: 90, height: 90},
      {file_id: 'photo-large', file_unique_id: 'photo-large-unique', width: 320, height: 320},
    ],
  })
  return update
}

export function groupText(text: string, opts: CommonOptions = {}): TestUpdate {
  const meta = nextMeta(opts)
  const from = privateUser(opts.from)
  return asUpdate({
    update_id: meta.updateId,
    reqId: meta.reqId,
    message: {
      message_id: meta.messageId,
      date: now(),
      text,
      from,
      chat: groupChat('supergroup', opts.chat),
    },
  })
}

/**
 * A command declared with `is_ephemeral`: the group never saw it, so Telegram sends `message_id: 0`
 * plus an `ephemeral_message_id`. Deleted via `deleteEphemeralMessage`, not `deleteMessage`.
 */
export function groupEphemeralCommand(text: string, opts: CommonOptions = {}): TestUpdate {
  const update = groupText(text, opts)
  const message = update.message
  if (!message) throw new Error('groupEphemeralCommand did not create a message')
  message.ephemeral_message_id = message.message_id
  message.message_id = 0
  return update
}

export function groupReply(
  text: string,
  replyTo: Message | {text: string; from?: FromOverrides},
  opts: CommonOptions = {},
): TestUpdate {
  const update = groupText(text, opts)
  const message = update.message
  if (!message) throw new Error('groupReply did not create a message')
  message.reply_to_message = isMessage(replyTo)
    ? {...replyTo, reply_to_message: undefined}
    : replyMessage(replyTo.text, privateUser(replyTo.from), message.chat)
  return update
}

export function groupReplyToChannel(text: string, opts: CommonOptions = {}): TestUpdate {
  const update = groupText(text, opts)
  const message = update.message
  if (!message) throw new Error('groupReplyToChannel did not create a message')
  message.reply_to_message = {
    message_id: nextMessageId++,
    date: now(),
    text: 'Channel post',
    sender_chat: groupChat('channel'),
    chat: message.chat,
    reply_to_message: undefined,
  }
  return update
}

/**
 * Group message sent on behalf of a channel (`send_as` / linked channel identity).
 * Real human id is not available — only `sender_chat` + a fake `from` for Bot API BC.
 */
export function groupTextAsChannel(text: string, opts: CommonOptions = {}): TestUpdate {
  const update = groupText(text, opts)
  const message = update.message
  if (!message) throw new Error('groupTextAsChannel did not create a message')
  const channel = groupChat('channel')
  message.sender_chat = channel
  // Fake sender user (Telegram BC): not a bot, but not a debitable human wallet either.
  message.from = {
    id: channel.id,
    is_bot: false,
    first_name: channel.title ?? 'Channel',
  }
  return update
}

/**
 * Group message from an anonymous admin (Group Anonymous Bot + sender_chat = this group).
 */
export function groupTextAsAnonymousAdmin(text: string, opts: CommonOptions = {}): TestUpdate {
  const update = groupText(text, opts)
  const message = update.message
  if (!message) throw new Error('groupTextAsAnonymousAdmin did not create a message')
  message.sender_chat = message.chat
  message.from = {
    id: 1087968824,
    is_bot: true,
    first_name: 'Group',
    username: 'GroupAnonymousBot',
  }
  return update
}

export function myChatMember(
  chatType: 'supergroup' | 'channel',
  rights: boolean | ChatMember,
  opts: CommonOptions = {},
): TestUpdate {
  const meta = nextMeta(opts)
  const from = privateUser(opts.from)
  const granted = typeof rights === 'boolean' ? rights : hasRequiredRights(rights)
  return asUpdate({
    update_id: meta.updateId,
    reqId: meta.reqId,
    my_chat_member: {
      date: now(),
      from,
      chat: groupChat(chatType, opts.chat),
      old_chat_member: granted ? member('left') : member('administrator'),
      new_chat_member:
        typeof rights === 'boolean' ? member(granted ? 'administrator' : 'left') : rights,
    },
  })
}

/** Private block/unblock: member↔kicked. */
export function privateMyChatMember(blocked: boolean, opts: CommonOptions = {}): TestUpdate {
  const meta = nextMeta(opts)
  const from = privateUser(opts.from)
  return asUpdate({
    update_id: meta.updateId,
    reqId: meta.reqId,
    my_chat_member: {
      date: now(),
      from,
      chat: privateChat(from, opts.chat),
      old_chat_member: blocked ? member('member') : member('kicked'),
      new_chat_member: blocked ? member('kicked') : member('member'),
    },
  })
}

export function chatJoinRequest(
  chatType: 'supergroup' | 'channel',
  opts: CommonOptions = {},
): TestUpdate {
  const meta = nextMeta(opts)
  const from = privateUser(opts.from)
  return asUpdate({
    update_id: meta.updateId,
    reqId: meta.reqId,
    chat_join_request: {
      date: now(),
      from,
      user_chat_id: from.id,
      chat: groupChat(chatType, opts.chat),
    },
  })
}

/** Update types the bot registers no handler for. */
export const unhandledUpdateTypes = [
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'poll',
  'poll_answer',
  'chat_member',
  'inline_query',
  'chosen_inline_result',
  'shipping_query',
  'pre_checkout_query',
  'message_reaction',
] as const

export type UnhandledUpdateType = (typeof unhandledUpdateTypes)[number]

/**
 * A realistic payload for an update type nothing handles.
 *
 * Realistic is the whole point: an update the bot drops because the payload is malformed would
 * prove nothing about the update *type* being ignored.
 */
export function unhandledUpdate(type: UnhandledUpdateType, opts: CommonOptions = {}): TestUpdate {
  const meta = nextMeta(opts)
  const from = privateUser(opts.from)
  return asUpdate({
    update_id: meta.updateId,
    reqId: meta.reqId,
    [type]: unhandledPayload(type, from, meta.messageId),
  })
}

function unhandledPayload(
  type: UnhandledUpdateType,
  from: User,
  messageId: number,
): Record<string, unknown> {
  const editedAt = now()
  switch (type) {
    case 'edited_message':
      return {
        message_id: messageId,
        date: editedAt - 60,
        edit_date: editedAt,
        text: 'edited text',
        from,
        chat: privateChat(from),
      }
    case 'channel_post':
    case 'edited_channel_post': {
      const chat = groupChat('channel')
      return {
        message_id: messageId,
        date: editedAt - 60,
        ...(type === 'edited_channel_post' ? {edit_date: editedAt} : {}),
        text: 'Channel post',
        chat,
        sender_chat: chat,
      }
    }
    case 'poll':
      return {
        id: `poll-${messageId}`,
        question: 'Paid access?',
        options: [{text: 'yes', voter_count: 0}],
        total_voter_count: 0,
        is_closed: false,
        is_anonymous: true,
        type: 'regular',
        allows_multiple_answers: false,
      }
    case 'poll_answer':
      return {poll_id: `poll-${messageId}`, user: from, option_ids: [0]}
    case 'chat_member':
      return {
        chat: groupChat('supergroup'),
        from,
        date: editedAt,
        old_chat_member: {status: 'left', user: from},
        new_chat_member: {status: 'member', user: from},
      }
    case 'inline_query':
      return {id: `inline-${messageId}`, from, query: '21', offset: '', chat_type: 'private'}
    case 'chosen_inline_result':
      return {result_id: `result-${messageId}`, from, query: '21'}
    case 'shipping_query':
      return {
        id: `shipping-${messageId}`,
        from,
        invoice_payload: 'subscription',
        shipping_address: {
          country_code: 'DE',
          state: '',
          city: 'Berlin',
          street_line1: 'Somestr. 1',
          street_line2: '',
          post_code: '10115',
        },
      }
    case 'pre_checkout_query':
      return {
        id: `checkout-${messageId}`,
        from,
        currency: 'XTR',
        total_amount: 100,
        invoice_payload: 'subscription',
      }
    case 'message_reaction':
      return {
        chat: privateChat(from),
        message_id: messageId,
        user: from,
        date: editedAt,
        old_reaction: [],
        new_reaction: [{type: 'emoji', emoji: '⚡'}],
      }
  }
}

export function newChatTitle(title: string, opts: CommonOptions = {}): TestUpdate {
  const update = groupText('', opts)
  const message = update.message
  if (!message) throw new Error('newChatTitle did not create a message')
  Reflect.deleteProperty(message, 'text')
  message.new_chat_title = title
  Object.assign(message.chat, {title})
  return update
}

function nextMeta(opts: CommonOptions) {
  const updateId = opts.updateId ?? nextUpdateId++
  return {
    updateId,
    reqId: opts.reqId ?? `e2e-${updateId}`,
    messageId: opts.messageId ?? nextMessageId++,
  }
}

function privateUser(overrides: FromOverrides = {}): User {
  return {
    id: USER_A,
    is_bot: false,
    first_name: 'User A',
    username: 'user_a',
    language_code: 'en',
    ...overrides,
  }
}

function privateChat(from: User, overrides: Record<string, unknown> = {}) {
  return {
    id: from.id,
    type: 'private' as const,
    first_name: from.first_name,
    username: from.username,
    ...overrides,
  }
}

function groupChat(type: 'supergroup' | 'channel', overrides: Record<string, unknown> = {}) {
  return {
    id: type === 'channel' ? CHAT_CHANNEL : CHAT_GROUP,
    type,
    title: type === 'channel' ? 'E2E Channel' : 'E2E Group',
    ...overrides,
  }
}

function replyMessage(
  text: string,
  from: User,
  chat: Message['chat'],
): NonNullable<Message['reply_to_message']> {
  return {
    message_id: nextMessageId++,
    date: now(),
    text,
    from,
    chat,
    reply_to_message: undefined,
  }
}

function isMessage(value: Message | {text: string; from?: FromOverrides}): value is Message {
  return 'message_id' in value
}

function member(status: 'left' | 'administrator' | 'member' | 'kicked'): ChatMember {
  if (status === 'left') return {status: 'left', user: botUser}
  if (status === 'member') return {status: 'member', user: botUser}
  if (status === 'kicked') return {status: 'kicked', user: botUser, until_date: 0}
  return {
    status: 'administrator',
    user: botUser,
    can_be_edited: false,
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: true,
    can_manage_video_chats: true,
    can_restrict_members: true,
    can_promote_members: false,
    can_change_info: true,
    can_invite_users: true,
    can_post_stories: true,
    can_edit_stories: true,
    can_delete_stories: true,
  }
}

function hasRequiredRights(memberValue: ChatMember): boolean {
  return (
    memberValue.status === 'administrator' &&
    memberValue.can_invite_users &&
    memberValue.can_restrict_members
  )
}

function asUpdate(value: Record<string, unknown>): TestUpdate {
  return value as unknown as TestUpdate
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}

const botUser: User = {
  id: 1,
  is_bot: true,
  first_name: 'ZapGram',
  username: 'zap_gram_bot',
}
