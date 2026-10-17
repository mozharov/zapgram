import {serializeError} from 'serialize-error'

const WEBHOOK_PATH = /\/webhook\/[^/]+/gi
const URL_IN_TEXT = /https?:\/\/[^\s)]+/g

type HttpOptions = {
  method?: unknown
  url?: unknown
  headers?: unknown
}

type HttpClientError = Error & {
  code?: unknown
  options?: HttpOptions
  response?: {statusCode?: unknown; body?: unknown}
}

export function loggedHttpError(error: unknown): Record<string, unknown> | undefined {
  if (
    isHttpClientError(error) ||
    (error instanceof Error && containsHttpClientError(error.cause))
  ) {
    const logged = redactLoggedError(error)
    return logged && typeof logged === 'object' ? (logged as Record<string, unknown>) : undefined
  }
  return undefined
}

export function redactLoggedError(error: unknown): unknown {
  if (isHttpClientError(error)) return toSafeHttpError(error)
  if (error instanceof Error) {
    const serialized = serializeError(error) as Record<string, unknown>
    if (error.cause !== undefined) serialized.cause = redactLoggedError(error.cause)
    return serialized
  }
  return error
}

export function scrubCaptureError(error: unknown): unknown {
  if (isHttpClientError(error)) {
    const safe = toSafeHttpError(error)
    const scrubbed = new Error(safe.message ?? 'HTTP request failed')
    scrubbed.name = safe.name ?? 'HTTPError'
    if (safe.stack) scrubbed.stack = safe.stack
    return scrubbed
  }
  if (error instanceof Error && containsHttpClientError(error.cause)) {
    const scrubbed = new Error(redactText(error.message))
    scrubbed.name = error.name
    if (error.stack) scrubbed.stack = redactText(error.stack)
    Object.defineProperty(scrubbed, 'cause', {value: scrubCaptureError(error.cause)})
    return scrubbed
  }
  return error
}

function containsHttpClientError(error: unknown): boolean {
  if (isHttpClientError(error)) return true
  if (error instanceof Error) return containsHttpClientError(error.cause)
  return false
}

function isHttpClientError(error: unknown): error is HttpClientError {
  if (!(error instanceof Error)) return false
  const options = (error as {options?: unknown}).options
  if (!options || typeof options !== 'object') return false
  return 'headers' in options || 'url' in options
}

type SafeHttpError = {
  name: string
  message: string
  code?: string
  method?: string
  url?: string
  statusCode?: number
  responseBody?: unknown
  stack?: string
  cause?: unknown
}

function toSafeHttpError(error: HttpClientError): SafeHttpError {
  const statusCode = error.response?.statusCode
  const safe: SafeHttpError = {
    name: error.name,
    message: redactText(error.message),
  }
  if (typeof error.code === 'string') safe.code = error.code
  if (typeof error.options?.method === 'string') safe.method = error.options.method
  const url = redactUrlValue(error.options?.url)
  if (url) safe.url = url
  if (typeof statusCode === 'number') safe.statusCode = statusCode
  if (error.response && 'body' in error.response) safe.responseBody = error.response.body
  if (error.stack) safe.stack = redactText(error.stack)
  if (isHttpClientError(error.cause) || error.cause instanceof Error) {
    safe.cause = redactLoggedError(error.cause)
  }
  return safe
}

export function redactUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw.replace(WEBHOOK_PATH, '/webhook/[REDACTED]')
  }
  url.username = ''
  url.password = ''
  const pathname = url.pathname.replace(WEBHOOK_PATH, '/webhook/[REDACTED]')
  const query = [...url.searchParams.keys()].map(key => `${encodeURIComponent(key)}=[REDACTED]`)
  const search = query.length > 0 ? `?${query.join('&')}` : ''
  return `${url.origin}${pathname}${search}`
}

function redactUrlValue(url: unknown): string | undefined {
  if (typeof url === 'string') return redactUrl(url)
  if (url instanceof URL) return redactUrl(url.toString())
  if (url && typeof url === 'object' && 'href' in url && typeof url.href === 'string') {
    return redactUrl(url.href)
  }
  return undefined
}

function redactText(text: string): string {
  return text.replace(URL_IN_TEXT, match => {
    const trimmed = match.replace(/[.,;]+$/, '')
    return `${redactUrl(trimmed)}${match.slice(trimmed.length)}`
  })
}
