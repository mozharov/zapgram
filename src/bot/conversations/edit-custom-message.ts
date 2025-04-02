import type {BotConversation, ConversationContext} from '../context.js'
import {InlineKeyboard} from 'grammy'
import {getAccessibleChat, updateChat} from '../../models/chat.js'
import {removeInlineKeyboard} from '../helpers/keyboard.js'
import {replyWithChat} from '../helpers/messages/chat.js'
import type {MessageEntity} from 'grammy/types'

const MAX_MESSAGE_LENGTH = 1000

export async function editCustomMessage(
  conversation: BotConversation,
  ctx: ConversationContext,
  {chatId}: {chatId: number},
) {
  const chat = await getAccessibleChat(chatId)
  if (!chat) {
    await ctx.reply(ctx.t('chat.not-found'))
    return conversation.halt()
  }

  // Get Russian message
  const ruMessage = await ctx.reply(ctx.t('edit-custom-message.enter-russian'), {
    reply_markup: new InlineKeyboard().add({
      callback_data: 'cancel',
      text: ctx.t('button.cancel'),
    }),
  })

  const ruContext = await conversation.waitFor(':text', {
    otherwise: async ctx => {
      await removeInlineKeyboard(ruMessage)
      if (ctx.callbackQuery?.data === 'cancel') {
        await ctx.reply(ctx.t('canceled'))
        return conversation.halt({next: true})
      }
      await ctx.reply(ctx.t('edit-custom-message.invalid'))
      await ctx.reply(ctx.t('canceled'))
      return conversation.halt()
    },
  })

  await conversation.external(() => removeInlineKeyboard(ruMessage))

  // Get the text with HTML entities preserved
  const ruMessageText = ruContext.message?.text.trim() || ''
  const ruMessageEntities = ruContext.message?.entities || []

  // Convert to HTML format if entities present
  const ruHtmlMessage =
    ruMessageEntities.length > 0 ? convertToHtml(ruMessageText, ruMessageEntities) : ruMessageText

  if (!ruHtmlMessage || ruHtmlMessage.length > MAX_MESSAGE_LENGTH) {
    await ctx.reply(ctx.t('edit-custom-message.too-long'))
    await ctx.reply(ctx.t('canceled'))
    return conversation.halt()
  }

  // Get English message
  const enMessage = await ctx.reply(ctx.t('edit-custom-message.enter-english'), {
    reply_markup: new InlineKeyboard().add({
      callback_data: 'cancel',
      text: ctx.t('button.cancel'),
    }),
  })

  const enContext = await conversation.waitFor(':text', {
    otherwise: async ctx => {
      await removeInlineKeyboard(enMessage)
      if (ctx.callbackQuery?.data === 'cancel') {
        await ctx.reply(ctx.t('canceled'))
        return conversation.halt({next: true})
      }
      await ctx.reply(ctx.t('edit-custom-message.invalid'))
      await ctx.reply(ctx.t('canceled'))
      return conversation.halt()
    },
  })

  await conversation.external(() => removeInlineKeyboard(enMessage))

  // Get the text with HTML entities preserved
  const enMessageText = enContext.message?.text.trim() || ''
  const enMessageEntities = enContext.message?.entities || []

  // Convert to HTML format if entities present
  const enHtmlMessage =
    enMessageEntities.length > 0 ? convertToHtml(enMessageText, enMessageEntities) : enMessageText

  if (!enHtmlMessage || enHtmlMessage.length > MAX_MESSAGE_LENGTH) {
    await ctx.reply(ctx.t('edit-custom-message.too-long'))
    await ctx.reply(ctx.t('canceled'))
    return conversation.halt()
  }

  // Update chat with new custom messages
  const updatedChat = await updateChat(chatId, {
    customMessageRu: ruHtmlMessage,
    customMessageEn: enHtmlMessage,
  })

  await ctx.reply(ctx.t('edit-custom-message.completed'))
  await replyWithChat(ctx, updatedChat)
}

// Helper function to convert text with entities to HTML format
function convertToHtml(text: string, entities: MessageEntity[]): string {
  // Sort entities by offset in ascending order and then by length in descending order
  // This ensures parent entities come before child entities
  const sortedEntities = [...entities].sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset
    return b.length - a.length
  })

  // Create a map of character positions to opening and closing tags
  const tagMap: Record<number, string[]> = {}

  for (const entity of sortedEntities) {
    const start = entity.offset
    const end = entity.offset + entity.length

    // Initialize arrays for positions if they don't exist
    if (!tagMap[start]) tagMap[start] = []
    if (!tagMap[end]) tagMap[end] = []

    // Add opening and closing tags to the appropriate positions
    let openTag = ''
    let closeTag = ''

    switch (entity.type) {
      case 'bold':
        openTag = '<b>'
        closeTag = '</b>'
        break
      case 'italic':
        openTag = '<i>'
        closeTag = '</i>'
        break
      case 'underline':
        openTag = '<u>'
        closeTag = '</u>'
        break
      case 'strikethrough':
        openTag = '<s>'
        closeTag = '</s>'
        break
      case 'code':
        openTag = '<code>'
        closeTag = '</code>'
        break
      case 'pre':
        openTag = '<pre>'
        closeTag = '</pre>'
        break
      case 'text_link':
        openTag = `<a href="${entity.url || ''}">`
        closeTag = '</a>'
        break
      case 'spoiler':
        openTag = '<span class="tg-spoiler">'
        closeTag = '</span>'
        break
      case 'blockquote':
        openTag = '<blockquote>'
        closeTag = '</blockquote>'
        break
      default:
        continue // Skip unsupported entity types
    }

    tagMap[start].push(openTag)
    tagMap[end].unshift(closeTag) // Prepend closing tags so they close in reverse order
  }

  // Build the HTML string
  let result = ''
  for (let i = 0; i < text.length; i++) {
    // Add opening tags if they exist at this position
    const openTags = tagMap[i]
    if (openTags && openTags.length > 0) {
      result += openTags.join('')
    }

    // Add the character
    result += text.charAt(i)
  }

  // Add any closing tags at the end of the text
  const closingTags = tagMap[text.length]
  if (closingTags && closingTags.length > 0) {
    result += closingTags.join('')
  }

  return result
}
