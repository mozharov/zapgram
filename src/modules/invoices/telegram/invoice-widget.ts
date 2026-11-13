import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import type {AppLocale} from '@core/i18n/locale.js'
import {
  assertWidgetHtml,
  utf8Bytes,
  WIDGET_DATA_MAX_BYTES,
  widgetHtmlCompressedBytes,
} from '@infra/telegram/widget-api.js'

/**
 * Live invoice widget. The HTML is fixed at send time; only `chat_data` changes later.
 * The QR is drawn in the widget from the BOLT11 string (lean-qr, canvas). No PNG.
 *
 * BOLT11 goes in `chat_data` when the JSON fits in 1024 UTF-8 bytes, so a later edit can
 * redraw the QR. When it does not, the string is embedded in the HTML and `chat_data` carries
 * only the status. The caption always keeps the full BOLT11, because a widget cannot be forwarded.
 */

export type InvoiceWidgetStatus = 'pending' | 'paid' | 'expired' | 'cancelled'

export type InvoiceWidgetState = {
  status: InvoiceWidgetStatus
  amountSats: number
  locale: AppLocale
  /** Already translated status line. The widget prints it as text. */
  label: string
  bolt11: string
}

export type InvoiceWidgetDocument = {
  html: string
  chatData: string
  /** True when `chatData` includes the BOLT11, so a later edit can change the QR. */
  bolt11InData: boolean
  compressedBytes: number
}

const LABELS_SCRIPT = `const UNITS={en:"sats",ru:"сат"};`

let leanQrSource: string | undefined

function widgetQrSource(): string {
  leanQrSource ??= readFileSync(
    join(import.meta.dirname, 'vendor/lean-qr-nano.js'),
    'utf8',
  ).replace(/^\/\*[\s\S]*?\*\/\s*/, '')
  return leanQrSource
}

type QrCode = {size: number; get: (x: number, y: number) => boolean}

type QrGenerate = (text: string, options: {minCorrectionLevel: number}) => QrCode

let generateQr: QrGenerate | undefined

/** Same encoder the widget HTML runs. Tests decode this matrix back to the BOLT11. */
export function widgetQrModules(text: string): {
  size: number
  dark: (x: number, y: number) => boolean
} {
  generateQr ??= new Function(`${widgetQrSource()}\nreturn m`)() as QrGenerate
  const code = generateQr(text, {minCorrectionLevel: 0})
  return {size: code.size, dark: (x, y) => Boolean(code.get(x, y))}
}

/**
 * A second widget is only for a new BOLT11 that cannot live in `chat_data`.
 * The HTML already contains the current request, so finalizing that same invoice
 * (cancel, interrupt, leftover text) must edit the message in place.
 */
export function invoiceWidgetNeedsNewMessage(
  bolt11InData: boolean,
  previousPaymentRequest: string,
  paymentRequest: string,
): boolean {
  return !bolt11InData && previousPaymentRequest !== paymentRequest
}

export function buildInvoiceWidgetChatData(state: InvoiceWidgetState): {
  chatData: string
  bolt11InData: boolean
} {
  const base = {
    s: state.status,
    a: state.amountSats,
    l: state.locale,
    t: state.label,
  }
  const withBolt11 = JSON.stringify({...base, b: state.bolt11})
  if (utf8Bytes(withBolt11) <= WIDGET_DATA_MAX_BYTES) {
    return {chatData: withBolt11, bolt11InData: true}
  }
  return {chatData: JSON.stringify(base), bolt11InData: false}
}

export function buildInvoiceWidgetDocument(state: InvoiceWidgetState): InvoiceWidgetDocument {
  const {chatData, bolt11InData} = buildInvoiceWidgetChatData(state)
  const embedded = bolt11InData ? '' : state.bolt11
  const html = renderWidgetHtml(embedded)
  assertWidgetHtml(html)
  return {html, chatData, bolt11InData, compressedBytes: widgetHtmlCompressedBytes(html)}
}

function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function renderWidgetHtml(embeddedBolt11: string): string {
  return `<!DOCTYPE html>
<meta charset="utf-8">
<style>
html,body{margin:0;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#111);font:600 15px sans-serif;text-align:center}
#amt{padding:10px 10px 0}
#st{padding:4px 10px 10px}
canvas{background:#fff;image-rendering:pixelated;width:86%;max-width:260px;height:auto}
</style>
<div id="amt"></div>
<canvas id="qr" width="228" height="228"></canvas>
<div id="st"></div>
<script>
${widgetQrSource()}
${LABELS_SCRIPT}
const EMBEDDED=${jsString(embeddedBolt11)};
function read(){let d={};try{d=JSON.parse((window.TelegramWidget&&TelegramWidget.chatData)||"{}")}catch(e){}return d}
function paint(code){const c=document.getElementById("qr");const n=code.size,q=4,scale=Math.max(1,Math.floor(228/(n+q*2)));const side=(n+q*2)*scale;c.width=side;c.height=side;const g=c.getContext("2d");g.fillStyle="#fff";g.fillRect(0,0,side,side);g.fillStyle="#000";for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(code.get(x,y))g.fillRect((x+q)*scale,(y+q)*scale,scale,scale)}
function draw(){const d=read();const pack=d.l==="ru"?"ru":"en";document.getElementById("amt").textContent=(d.a??"")+" "+UNITS[pack];document.getElementById("st").textContent=d.t||"";const bolt=d.b||EMBEDDED;if(bolt)paint(m(bolt,{minCorrectionLevel:0}))}
const W=window.TelegramWidget;if(W){W.onEvent("chatDataChanged",draw);draw();if(typeof W.ready==="function")W.ready()}
</script>`
}
