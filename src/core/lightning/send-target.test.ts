import {describe, expect, test} from 'bun:test'
import {classifySendTarget} from './send-target.js'

const BOLT11 = 'lnbc1pabcdef'
const LNURL = 'lnurl1dp68gurn8ghj7cts'

type Person = {id: number; username: string | null}

function deps(opts: {
  self?: string | null
  users?: Person[]
  telegram?: Record<number, string | null>
  onFind?: (username: string) => void
}) {
  return {
    selfUsername: opts.self,
    findUser: async (username: string) => {
      opts.onFind?.(username)
      return opts.users?.find(user => user.username === username) ?? null
    },
    telegramUsername: async (userId: number) => opts.telegram?.[userId],
  }
}

describe('classifySendTarget', () => {
  test('a lightning address is not a username, including prefixes and case', async () => {
    const lookup = deps({self: 'alice', users: [{id: 2, username: 'alice'}]})
    expect(await classifySendTarget('alice@getalby.com', lookup)).toEqual({
      kind: 'lightning-address',
      value: 'alice@getalby.com',
    })
    expect(await classifySendTarget('  Lightning:Alice@GetAlby.COM ', lookup)).toEqual({
      kind: 'lightning-address',
      value: 'alice@getalby.com',
    })
    expect(await classifySendTarget('satoshi@localhost', lookup)).toEqual({
      kind: 'lightning-address',
      value: 'satoshi@localhost',
    })
    expect(await classifySendTarget('@alice', lookup)).toEqual({kind: 'self'})
    expect(await classifySendTarget('@getalby.com', lookup)).toEqual({kind: 'invalid'})
  })

  test('BOLT11 and LNURL prefixes stay payment requests, including withdraw URLs', async () => {
    expect(await classifySendTarget(`lightning:${BOLT11.toUpperCase()}`, deps({}))).toEqual({
      kind: 'bolt11',
      value: BOLT11,
    })
    expect(await classifySendTarget(`LIGHTNING:${LNURL.toUpperCase()}`, deps({}))).toEqual({
      kind: 'lnurl',
      value: LNURL,
    })
    expect(await classifySendTarget(`lnurlp://${LNURL}`, deps({}))).toEqual({
      kind: 'lnurl',
      value: `lnurlp://${LNURL}`,
    })
    expect(await classifySendTarget('lnurlw://alice@example.com', deps({}))).toEqual({
      kind: 'lnurl',
      value: 'lnurlw://alice@example.com',
    })
  })

  test('invalid input is not a user and does not look anyone up', async () => {
    let finds = 0
    const lookup = deps({
      onFind: () => {
        finds += 1
      },
    })
    for (const text of ['', '   ', 'hello', 'user_b', '1000', `pay ${BOLT11}`, 'user@', '@']) {
      expect(await classifySendTarget(text, lookup)).toEqual({kind: 'invalid'})
    }
    expect(finds).toBe(0)
  })

  test('self is refused before any lookup, unknown users are not created', async () => {
    let finds = 0
    const lookup = deps({
      self: 'Alice',
      users: [{id: 7, username: 'bob'}],
      telegram: {7: 'bob', 8: 'old_name'},
      onFind: () => {
        finds += 1
      },
    })
    expect(await classifySendTarget('@alice', lookup)).toEqual({kind: 'self'})
    expect(finds).toBe(0)

    expect(await classifySendTarget('@missing', lookup)).toEqual({kind: 'unknown'})
    expect(await classifySendTarget('@bob', lookup)).toEqual({
      kind: 'user',
      user: {id: 7, username: 'bob'},
    })

    const renamed = deps({
      self: 'alice',
      users: [{id: 8, username: 'carol'}],
      telegram: {8: 'not_carol'},
    })
    expect(await classifySendTarget('@carol', renamed)).toEqual({kind: 'unknown'})
    expect(await classifySendTarget('@carol', deps({self: 'alice', users: []}))).toEqual({
      kind: 'unknown',
    })
  })
})
