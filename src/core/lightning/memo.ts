export function buildInvoiceMemo(memo: string, footer: string) {
  return `${memo}\n\n${footer}`.trim()
}

export function sanitizeMemo(memo: string, footer: string) {
  return memo.replace(footer, '').trim()
}
