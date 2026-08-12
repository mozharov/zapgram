/** Bot API `CopyTextButton.text` limit. Official docs: 1-256 characters. */
export const COPY_TEXT_MAX_LENGTH = 256

/** Returns the text when a `copy_text` button can carry it; otherwise `undefined`. */
export function copyableText(text: string): string | undefined {
  return text.length >= 1 && text.length <= COPY_TEXT_MAX_LENGTH ? text : undefined
}
