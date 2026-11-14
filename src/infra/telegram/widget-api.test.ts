import {describe, expect, test} from 'bun:test'
import {randomBytes} from 'node:crypto'
import {GrammyError} from 'grammy'
import {
  editMessageWidgetData,
  sendWidget,
  WIDGET_DATA_MAX_BYTES,
  WidgetApiError,
  type WidgetRawApi,
} from './widget-api.js'

type Handlers = {
  sendWidget?: (args: Record<string, unknown>) => Promise<unknown>
  editMessageWidgetData?: (args: Record<string, unknown>) => Promise<unknown>
}

function fakeApi(handlers: Handlers = {}): {
  api: WidgetRawApi
  calls: Array<{method: string; args: Record<string, unknown>}>
} {
  const calls: Array<{method: string; args: Record<string, unknown>}> = []
  const api: WidgetRawApi = {
    raw: {
      async sendWidget(args: Record<string, unknown>) {
        calls.push({method: 'sendWidget', args})
        return handlers.sendWidget ? handlers.sendWidget(args) : {message_id: 42, chat: {id: 7}}
      },
      async editMessageWidgetData(args: Record<string, unknown>) {
        calls.push({method: 'editMessageWidgetData', args})
        return handlers.editMessageWidgetData ? handlers.editMessageWidgetData(args) : true
      },
    },
  }
  return {api, calls}
}

describe('sendWidget', () => {
  test('forwards the payload through api.raw and returns the message', async () => {
    const {api, calls} = fakeApi()
    const sent = await sendWidget(api, {
      chat_id: 7,
      html: '<p>invoice</p>',
      chat_data: '{"s":"pending"}',
      caption: 'lnbc1',
      parse_mode: 'HTML',
      height: 300,
    })

    expect(sent).toEqual({message_id: 42, chat: {id: 7}})
    expect(calls).toEqual([
      {
        method: 'sendWidget',
        args: {
          chat_id: 7,
          html: '<p>invoice</p>',
          chat_data: '{"s":"pending"}',
          caption: 'lnbc1',
          parse_mode: 'HTML',
          height: 300,
        },
      },
    ])
  })

  test('rejects a response that is not a message', async () => {
    const {api} = fakeApi({
      async sendWidget() {
        return true
      },
    })
    await expect(sendWidget(api, {chat_id: 1, html: '<p>x</p>'})).rejects.toThrow(WidgetApiError)
  })

  test('rejects chat_data over 1024 UTF-8 bytes before calling Telegram', async () => {
    const {api, calls} = fakeApi()
    const chatData = 'я'.repeat(WIDGET_DATA_MAX_BYTES)
    await expect(
      sendWidget(api, {chat_id: 1, html: '<p>x</p>', chat_data: chatData}),
    ).rejects.toThrow(/chat_data/)
    expect(calls).toHaveLength(0)
  })

  test('rejects HTML that exceeds the zlib level 9 limit', async () => {
    const {api, calls} = fakeApi()
    const html = `<p>${randomBytes(6000).toString('base64')}</p>`
    await expect(sendWidget(api, {chat_id: 1, html})).rejects.toThrow(/zlib/)
    expect(calls).toHaveLength(0)
  })
})

describe('editMessageWidgetData', () => {
  test('forwards chat_id, message_id and chat_data', async () => {
    const {api, calls} = fakeApi()
    await expect(
      editMessageWidgetData(api, {chat_id: 7, message_id: 42, chat_data: '{"s":"paid"}'}),
    ).resolves.toBe(true)
    expect(calls[0]?.args).toEqual({chat_id: 7, message_id: 42, chat_data: '{"s":"paid"}'})
  })

  test('treats message is not modified as success', async () => {
    const notModified = new GrammyError(
      'edit failed',
      {ok: false, error_code: 400, description: 'Bad Request: message is not modified'},
      'editMessageWidgetData',
      {},
    )
    const {api} = fakeApi({
      async editMessageWidgetData() {
        throw notModified
      },
    })
    await expect(
      editMessageWidgetData(api, {chat_id: 7, message_id: 42, chat_data: '{"s":"paid"}'}),
    ).resolves.toBe(true)
  })

  test('treats a conversation-wrapped not-modified error as success', async () => {
    const notModified = new GrammyError(
      'edit failed',
      {ok: false, error_code: 400, description: 'Bad Request: message is not modified'},
      'editMessageWidgetData',
      {},
    )
    const wrapped = new Error(
      "Unknown error thrown in conversation while calling 'editMessageWidgetData'",
      {
        cause: notModified,
      },
    )
    const {api} = fakeApi({
      async editMessageWidgetData() {
        throw wrapped
      },
    })
    await expect(
      editMessageWidgetData(api, {chat_id: 7, message_id: 42, chat_data: '{"s":"paid"}'}),
    ).resolves.toBe(true)
  })

  test('rethrows other API errors', async () => {
    const {api} = fakeApi({
      async editMessageWidgetData() {
        throw new GrammyError(
          'edit failed',
          {ok: false, error_code: 400, description: 'Bad Request: message to edit not found'},
          'editMessageWidgetData',
          {},
        )
      },
    })
    await expect(
      editMessageWidgetData(api, {chat_id: 7, message_id: 42, chat_data: '{}'}),
    ).rejects.toThrow(/not found/)
  })

  test('requires a message target', async () => {
    const {api, calls} = fakeApi()
    await expect(editMessageWidgetData(api, {chat_data: '{}'})).rejects.toThrow(WidgetApiError)
    expect(calls).toHaveLength(0)
  })
})
