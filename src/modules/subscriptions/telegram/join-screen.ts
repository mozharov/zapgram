import type {AppLogger} from '@infra/logger.js'
import type {BotContext} from '@telegram/context.js'
import {type InlineKeyboard, InputFile} from 'grammy'
import type {InputRichMessage} from 'grammy/types'
import QRCode from 'qrcode'

/** The id the html below refers to with `tg://photo?id=…`; scoped to the one message we build. */
const QR_MEDIA_ID = 'qr'

/**
 * Repaint the join screen a member is standing on with a rich message and a QR of what they have to
 * pay.
 *
 * A join-request applicant usually never pressed /start, so the bot may only write inside the
 * contact window and the whole wizard lives on the single message the chooser created. That rules
 * out a separate photo message for the QR — an embedded rich media block is what makes it possible
 * at all, and it is why every join screen edits rather than sends.
 *
 * The QR is a bonus, never the payload: if rendering fails, or Telegram refuses the media block,
 * the same screen goes out as plain rich text. The invoice or address is in the message either way,
 * so a missing QR costs nothing while a failed edit would strand the member.
 */
export async function editJoinScreen(
  ctx: BotContext,
  options: {html: string; qrPayload: string; keyboard: InlineKeyboard; log: AppLogger},
): Promise<void> {
  const {html, qrPayload, keyboard, log} = options
  const media = await qrMedia(qrPayload, log)
  if (media) {
    try {
      await editRich(
        ctx,
        {html: `${html}\n\n<img src="tg://photo?id=${QR_MEDIA_ID}"/>`, media},
        keyboard,
      )
      return
    } catch (error) {
      log.warn({error}, 'Join screen QR was refused; retrying without it')
    }
  }
  await editRich(ctx, {html}, keyboard)
}

function editRich(
  ctx: BotContext,
  rich: InputRichMessage,
  keyboard: InlineKeyboard,
): Promise<unknown> {
  return ctx.editMessageText(rich, {
    reply_markup: keyboard,
    link_preview_options: {is_disabled: true},
  })
}

async function qrMedia(
  payload: string,
  log: AppLogger,
): Promise<InputRichMessage['media'] | undefined> {
  try {
    const buffer = await QRCode.toBuffer(payload)
    return [{id: QR_MEDIA_ID, media: {type: 'photo', media: new InputFile(buffer)}}]
  } catch (error) {
    log.warn({error}, 'Could not render the join screen QR')
    return undefined
  }
}
