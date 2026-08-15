import {GrammyError} from 'grammy'

const CLEANUP_METHODS = new Set([
  'deleteMessage',
  'deleteMessages',
  'deleteEphemeralMessage',
  'editMessageReplyMarkup',
])

const VANISHED_MARKERS = [
  'message to delete not found',
  'message to edit not found',
  'message is not modified',
  "message can't be deleted",
  'message can not be deleted',
]

/**
 * Telegram refused a cleanup edit/delete because the message is already gone
 * (user wiped the chat) or cannot be changed. Never a user-facing error.
 */
export function isVanishedTelegramMessageError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false
  if (CLEANUP_METHODS.has(error.method)) return true
  const description = error.description.toLowerCase()
  return VANISHED_MARKERS.some(marker => description.includes(marker))
}
