import type {UserFromGetMe} from 'grammy/types'

export type TgCall = {method: string; payload: Record<string, unknown>}

type BotApiError = {
  error_code: number
  description: string
  retry_after?: number
}

type QueuedResponse = {type: 'success'; result: unknown} | {type: 'error'; error: BotApiError}

export type FakeTelegram = {
  url: string
  calls: TgCall[]
  of(method: string): Record<string, unknown>[]
  last(method: string): Record<string, unknown> | undefined
  reply(method: string, result: unknown): void
  fail(method: string, err: BotApiError): void
  reset(): void
  stop(): void
}

export async function startFakeTelegram(opts?: {
  botInfo?: Partial<UserFromGetMe>
}): Promise<FakeTelegram> {
  const botInfo: UserFromGetMe = {...defaultBotInfo, ...opts?.botInfo}
  const calls: TgCall[] = []
  const responses = new Map<string, QueuedResponse[]>()
  let messageId = 0
  let stopped = false

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const payload = await readPayload(request)

      // A request may already be in flight when a test disposes its world. Let it finish without
      // leaking a call into the next test's assertions.
      if (stopped) return success(true)

      const url = new URL(request.url)
      const method = url.pathname.split('/').at(-1) ?? ''
      calls.push({method, payload})

      const queued = responses.get(method)?.shift()
      if (responses.get(method)?.length === 0) responses.delete(method)
      if (queued?.type === 'success') return success(queued.result)
      if (queued?.type === 'error') return failure(queued.error)

      return success(defaultResult(method, payload, botInfo, () => ++messageId))
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    of(method) {
      return calls.filter(call => call.method === method).map(call => call.payload)
    },
    last(method) {
      for (let index = calls.length - 1; index >= 0; index--) {
        const call = calls[index]
        if (call?.method === method) return call.payload
      }
      return undefined
    },
    reply(method, result) {
      enqueue(responses, method, {type: 'success', result})
    },
    fail(method, error) {
      enqueue(responses, method, {type: 'error', error})
    },
    reset() {
      calls.length = 0
      responses.clear()
    },
    stop() {
      if (stopped) return
      stopped = true
      server.unref()
      // temp-message schedules its cleanup shortly before the world is disposed. Give that timer
      // one turn to issue its request, then close after a second turn so the request can arrive.
      setTimeout(() => {
        setTimeout(() => void server.stop(true), 25)
      }, 25)
    },
  }
}

const defaultBotInfo: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'ZapGram',
  username: 'zap_gram_bot',
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}

function enqueue(
  responses: Map<string, QueuedResponse[]>,
  method: string,
  response: QueuedResponse,
): void {
  const queue = responses.get(method) ?? []
  queue.push(response)
  responses.set(method, queue)
}

async function readPayload(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.startsWith('application/json')) return asRecord(await request.json())

  if (contentType.startsWith('multipart/form-data')) {
    const payload: Record<string, unknown> = {}
    const form = await request.formData()
    for (const [key, value] of form.entries()) {
      payload[key] = typeof value === 'string' ? parseNestedJson(value) : value
    }
    return payload
  }

  return {}
}

function parseNestedJson(value: string): unknown {
  const trimmed = value.trimStart()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function defaultResult(
  method: string,
  payload: Record<string, unknown>,
  botInfo: UserFromGetMe,
  nextMessageId: () => number,
): unknown {
  switch (method) {
    case 'getMe':
      return botInfo
    case 'sendMessage':
    case 'sendPhoto':
    case 'editMessageText':
    case 'editMessageMedia':
    case 'copyMessage':
      return message(payload, botInfo, nextMessageId())
    case 'getChatAdministrators':
      return [{status: 'creator', user: ownerUser, is_anonymous: false}]
    case 'getChat':
      return chat(payload.chat_id)
    default:
      return true
  }
}

const ownerUser = {
  id: 777,
  is_bot: false,
  first_name: 'Chat Owner',
  username: 'chat_owner',
}

function message(
  payload: Record<string, unknown>,
  botInfo: UserFromGetMe,
  messageId: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat: chat(payload.chat_id),
    from: botInfo,
  }
  if (typeof payload.text === 'string') result.text = payload.text
  if (typeof payload.caption === 'string') result.caption = payload.caption
  const media = payload.media
  if (media && typeof media === 'object' && !Array.isArray(media)) {
    const mediaCaption = Reflect.get(media, 'caption')
    if (typeof mediaCaption === 'string') result.caption = mediaCaption
  }
  return result
}

function chat(rawId: unknown): Record<string, unknown> {
  const numericId = typeof rawId === 'number' ? rawId : Number(rawId ?? 777)
  const id = Number.isFinite(numericId) ? numericId : 777
  if (id < 0) return {id, type: 'supergroup', title: 'E2E Chat'}
  return {id, type: 'private', first_name: 'E2E User', username: 'e2e_user'}
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function success(result: unknown): Response {
  return Response.json({ok: true, result})
}

function failure(error: BotApiError): Response {
  const {retry_after, ...body} = error
  return Response.json({
    ok: false,
    ...body,
    ...(retry_after === undefined ? {} : {parameters: {retry_after}}),
  })
}
