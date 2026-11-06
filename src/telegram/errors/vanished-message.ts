import {GrammyError} from 'grammy'

const VANISHED_MARKERS = [
  'message to delete not found',
  'message to edit not found',
  'message is not modified',
  "message can't be deleted",
  'message can not be deleted',
]

const DELETE_NOT_FOUND = 'message to delete not found'

/**
 * Telegram said this cleanup edit/delete cannot apply: the message is already
 * gone, or it cannot be changed. A 429, a 5xx, a network failure, or any other
 * delete error is not this — those are still failures.
 */
export function isVanishedTelegramMessageError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false
  const description = error.description.toLowerCase()
  return VANISHED_MARKERS.some(marker => description.includes(marker))
}

/**
 * The only delete failure that means the offer is already gone. "message can't
 * be deleted", rate limits, and transport failures are not this.
 */
export function isMessageToDeleteNotFound(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false
  return error.description.toLowerCase().includes(DELETE_NOT_FOUND)
}
