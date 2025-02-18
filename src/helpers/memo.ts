import {config} from '../config.js'

export function buildInvoiceMemo(memo: string) {
  return `${memo}\n\n${config.memoFooter}`.trim()
}

export function sanitizeMemo(memo: string) {
  return memo.replace(config.memoFooter, '').trim()
}
