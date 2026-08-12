import {describe, expect, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {TG_TIME_FORMAT_PATTERN, tgTime, tgTimeFluentFunction} from './tg-time.js'

const AT = Date.UTC(2026, 4, 1, 12, 5, 9) // 2026-05-01T12:05:09Z

describe('tgTime', () => {
  test('emits a date_time entity carrying the Unix time in seconds', () => {
    expect(tgTime(AT, 'Dt')).toBe(
      `<tg-time unix="${AT / 1000}" format="Dt">2026-05-01 12:05 UTC</tg-time>`,
    )
  })

  test.each([
    ['D', '2026-05-01'],
    ['d', '2026-05-01'],
    ['w', '2026-05-01'],
    ['t', '12:05 UTC'],
    ['T', '12:05:09 UTC'],
    ['DT', '2026-05-01 12:05:09 UTC'],
    ['r', '2026-05-01 12:05 UTC'],
  ] as const)('the %s fallback body stays readable and explicitly UTC', (format, expected) => {
    expect(tgTime(AT, format)).toContain(`>${expected}</tg-time>`)
  })

  test('drops a non-finite timestamp instead of sending unix="NaN"', () => {
    expect(tgTime(Number.NaN, 'Dt')).toBe('')
  })
})

describe('the TGTIME Fluent function', () => {
  // Fluent resolves variables before calling a function, so a Date arrives wrapped.
  const wrapped = {value: AT}

  test('accepts the FluentDateTime wrapper Fluent passes in', () => {
    expect(tgTimeFluentFunction([wrapped], {format: 'D'})).toBe(tgTime(AT, 'D'))
  })

  test('accepts a bare Date and a bare epoch', () => {
    expect(tgTimeFluentFunction([new Date(AT)], {})).toBe(tgTime(AT, 'Dt'))
    expect(tgTimeFluentFunction([AT], {})).toBe(tgTime(AT, 'Dt'))
  })

  test('falls back to date and time when the format is missing or malformed', () => {
    expect(tgTimeFluentFunction([wrapped], {})).toBe(tgTime(AT, 'Dt'))
    expect(tgTimeFluentFunction([wrapped], {format: 'nope'})).toBe(tgTime(AT, 'Dt'))
  })

  test('renders nothing for a value that is not a date', () => {
    expect(tgTimeFluentFunction(['no'], {format: 'D'})).toBe('')
    expect(tgTimeFluentFunction([undefined], {format: 'D'})).toBe('')
  })
})

describe('locale files', () => {
  const locales = ['en', 'ru']
  const read = (locale: string) =>
    readFileSync(path.resolve(import.meta.dirname, `./locales/${locale}.ftl`), 'utf8')

  test.each(locales)('%s spells every TGTIME format the way Telegram parses it', locale => {
    const formats = [...read(locale).matchAll(/TGTIME\([^)]*format:\s*"([^"]*)"/g)].map(m => m[1])
    expect(formats.length).toBeGreaterThan(0)
    for (const format of formats) {
      // An empty format is legal for Telegram but means "leave the text alone", which defeats
      // the point of the entity.
      expect(format).not.toBe('')
      expect(format).toMatch(TG_TIME_FORMAT_PATTERN)
    }
  })

  // DATETIME renders a timezone we pick, so it can only ever show the wrong local time.
  test.each(locales)('%s shows no self-formatted timestamps', locale => {
    expect(read(locale)).not.toContain('DATETIME(')
  })
})
