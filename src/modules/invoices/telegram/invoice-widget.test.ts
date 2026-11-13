import {describe, expect, test} from 'bun:test'
import {randomBytes} from 'node:crypto'
import {deflateSync} from 'node:zlib'
import {WIDGET_DATA_MAX_BYTES, widgetHtmlCompressedBytes} from '@infra/telegram/widget-api.js'
import {encode, sign, type TagData} from 'bolt11'
import jsQR from 'jsqr'
import {
  buildInvoiceWidgetChatData,
  buildInvoiceWidgetDocument,
  invoiceWidgetNeedsNewMessage,
  widgetQrModules,
} from './invoice-widget.js'

const readQr = jsQR as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => {data: string} | null

function mintBolt11(description = 'coffee'): string {
  const tags: Array<{tagName: string; data: TagData}> = [
    {tagName: 'payment_hash', data: randomBytes(32).toString('hex')},
    {tagName: 'description', data: description},
    {tagName: 'expire_time', data: 86_400},
    {tagName: 'min_final_cltv_expiry', data: 18},
  ]
  const encoded = encode({satoshis: 1000, timestamp: 1_700_000_000, tags})
  const paymentRequest = sign(encoded, '11'.repeat(32)).paymentRequest
  if (!paymentRequest) throw new Error('bolt11 did not encode')
  return paymentRequest
}

function decodeModules(text: string): string | null {
  const code = widgetQrModules(text)
  const quiet = 4
  const scale = 4
  const side = (code.size + quiet * 2) * scale
  const pixels = new Uint8ClampedArray(side * side * 4)
  pixels.fill(255)
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.dark(x, y)) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const offset = ((y + quiet) * scale + dy) * side * 4 + ((x + quiet) * scale + dx) * 4
          pixels[offset] = 0
          pixels[offset + 1] = 0
          pixels[offset + 2] = 0
        }
      }
    }
  }
  return readQr(pixels, side, side)?.data ?? null
}

describe('invoice widget document', () => {
  test('draws a QR from the BOLT11 that scans back to the same string', () => {
    const bolt11 = mintBolt11()
    expect(decodeModules(bolt11)).toBe(bolt11)
  })

  test('puts a typical BOLT11 in chat_data and keeps the HTML under the zlib limit', () => {
    const bolt11 = mintBolt11('coffee')
    const doc = buildInvoiceWidgetDocument({
      status: 'pending',
      amountSats: 1000,
      locale: 'en',
      label: 'Waiting for payment',
      bolt11,
    })

    expect(doc.bolt11InData).toBe(true)
    expect(JSON.parse(doc.chatData)).toMatchObject({
      s: 'pending',
      a: 1000,
      l: 'en',
      t: 'Waiting for payment',
      b: bolt11,
    })
    expect(doc.html).not.toContain('data:image')
    expect(doc.html).not.toContain(bolt11)
    expect(doc.compressedBytes).toBeLessThanOrEqual(4096)
    expect(doc.compressedBytes).toBe(widgetHtmlCompressedBytes(doc.html))
  })

  test('leaves an oversized BOLT11 out of chat_data and embeds it for the QR', () => {
    const bolt11 = `lnbc1${'p'.repeat(1100)}`
    expect(Buffer.byteLength(bolt11)).toBeGreaterThan(WIDGET_DATA_MAX_BYTES)
    const packed = buildInvoiceWidgetChatData({
      status: 'pending',
      amountSats: 21,
      locale: 'ru',
      label: 'Ждёт оплаты',
      bolt11,
    })
    expect(packed.bolt11InData).toBe(false)
    expect(Buffer.byteLength(packed.chatData)).toBeLessThanOrEqual(WIDGET_DATA_MAX_BYTES)
    expect(JSON.parse(packed.chatData)).toEqual({
      s: 'pending',
      a: 21,
      l: 'ru',
      t: 'Ждёт оплаты',
    })

    const doc = buildInvoiceWidgetDocument({
      status: 'pending',
      amountSats: 21,
      locale: 'ru',
      label: 'Ждёт оплаты',
      bolt11,
    })
    expect(doc.html).toContain(bolt11)
    expect(doc.compressedBytes).toBeLessThanOrEqual(4096)
  })

  test('the same oversized invoice stays on its message; only a new one needs another widget', () => {
    const previous = `lnbc1${'p'.repeat(1100)}`
    const next = `lnbc1${'q'.repeat(1100)}`
    expect(invoiceWidgetNeedsNewMessage(false, previous, previous)).toBe(false)
    expect(invoiceWidgetNeedsNewMessage(false, previous, next)).toBe(true)
    expect(invoiceWidgetNeedsNewMessage(true, previous, next)).toBe(false)
  })

  test('a status edit keeps the BOLT11 when it was stored in chat_data', () => {
    const bolt11 = mintBolt11('')
    const pending = buildInvoiceWidgetChatData({
      status: 'pending',
      amountSats: 1000,
      locale: 'en',
      label: 'Waiting for payment',
      bolt11,
    })
    const paid = buildInvoiceWidgetChatData({
      status: 'paid',
      amountSats: 1000,
      locale: 'en',
      label: 'Paid',
      bolt11,
    })
    expect(pending.bolt11InData).toBe(true)
    expect(JSON.parse(paid.chatData)).toMatchObject({s: 'paid', t: 'Paid', b: bolt11})
  })

  test('node zlib matches python zlib.compress for the widget HTML', async () => {
    const python = Bun.which('python3')
    if (!python) return
    const doc = buildInvoiceWidgetDocument({
      status: 'pending',
      amountSats: 1000,
      locale: 'en',
      label: 'Waiting for payment',
      bolt11: mintBolt11('route'),
    })
    const proc = Bun.spawn(
      [python, '-c', 'import sys,zlib; print(len(zlib.compress(sys.stdin.buffer.read(), 9)))'],
      {
        stdin: Buffer.from(doc.html),
        stdout: 'pipe',
      },
    )
    const pythonBytes = Number((await new Response(proc.stdout).text()).trim())
    await proc.exited
    expect(proc.exitCode).toBe(0)
    expect(pythonBytes).toBeLessThanOrEqual(4096)
    expect(
      Math.abs(deflateSync(Buffer.from(doc.html), {level: 9}).length - pythonBytes),
    ).toBeLessThanOrEqual(48)
  })
})
