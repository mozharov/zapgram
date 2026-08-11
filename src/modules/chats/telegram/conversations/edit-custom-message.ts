import {getAccessibleChatForOwner, updateChat} from '@modules/chats/repository.js'
import {replyWithChat} from '@modules/chats/telegram/messages/chat.js'
import {staticCallback} from '@telegram/callback-data.js'
import type {BotConversation, ConversationContext} from '@telegram/context.js'
import {
  cancelledPromptState,
  classifyPromptUpdate,
  clearPromptControls,
  createActivePrompt,
  deactivatePrompt,
  interruptConversation,
} from '@telegram/helpers/conversation-prompt.js'
import {InlineKeyboard} from 'grammy'
import type {MessageEntity} from 'grammy/types'

const MAX_MESSAGE_LENGTH = 1000

export async function editCustomMessage(
  conversation: BotConversation,
  ctx: ConversationContext,
  {chatId}: {chatId: number},
) {
  const chat = await getAccessibleChatForOwner(chatId, ctx.user.id)
  if (!chat) {
    await ctx.reply(ctx.t('chat.not-found'))
    return conversation.halt()
  }

  const ruHtmlMessage = await waitForCustomMessage(conversation, ctx, {
    promptKey: 'edit-custom-message.enter-russian',
    actionKey: 'conversation-action.edit-message-ru',
  })
  const enHtmlMessage = await waitForCustomMessage(conversation, ctx, {
    promptKey: 'edit-custom-message.enter-english',
    actionKey: 'conversation-action.edit-message-en',
  })

  // Update chat with new custom messages
  const updatedChat = await updateChat(chatId, {
    customMessageRu: ruHtmlMessage,
    customMessageEn: enHtmlMessage,
  })

  await ctx.reply(ctx.t('edit-custom-message.completed'))
  await replyWithChat(ctx, updatedChat)
}

async function waitForCustomMessage(
  conversation: BotConversation,
  ctx: ConversationContext,
  keys: {promptKey: string; actionKey: string},
): Promise<string> {
  const html = ctx.t(keys.promptKey)
  const message = await ctx.reply(html, {
    reply_markup: new InlineKeyboard().add({
      callback_data: staticCallback.cancel,
      text: ctx.t('button.cancel'),
    }),
  })
  const prompt = createActivePrompt(message, {
    kind: 'text',
    html,
    actionLabel: ctx.t(keys.actionKey),
  })
  const cancelled = cancelledPromptState(ctx, prompt)

  for (;;) {
    const next = await conversation.wait()
    const kind = classifyPromptUpdate(next, prompt, staticCallback.cancel)

    if (kind === 'cancel') {
      await next.answerCallbackQuery()
      await deactivatePrompt(conversation, prompt, cancelled)
      return conversation.halt()
    }
    if (kind === 'interrupt') {
      return interruptConversation(conversation, prompt, cancelled)
    }

    const text = next.message?.text?.trim()
    if (!text) {
      await next.reply(next.t('edit-custom-message.invalid'))
      continue
    }

    const entities = next.message?.entities ?? []
    const htmlMessage = entities.length > 0 ? convertToHtml(text, entities) : text
    if (htmlMessage.length > MAX_MESSAGE_LENGTH) {
      await next.reply(next.t('edit-custom-message.too-long'))
      continue
    }

    await clearPromptControls(conversation, prompt)
    return htmlMessage
  }
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
