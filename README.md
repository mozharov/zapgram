# ZapGram

**[English](README.md)** · **[Русский](README.ru.md)**

**Bitcoin Lightning wallet inside Telegram** — send, receive, tip, and monetize chats with sats.

<div align="center">

[![Open in Telegram](https://img.shields.io/badge/Open-@zap__gram__bot-26A5E4?logo=telegram&style=for-the-badge)](https://t.me/zap_gram_bot)
[![Website](https://img.shields.io/badge/Website-zapgram.mozharov.me-111111?style=for-the-badge)](https://zapgram.mozharov.me/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

</div>

---

ZapGram turns Telegram into a Lightning payment app: instant tips in groups, invoices with QR codes, transfers between users at message speed, and paid access to private communities.

No bank. No borders. Just sats.

---

## Why ZapGram?

| | |
|---|---|
| **Lightning-native** | Built for satoshis and BOLT11 invoices — not fiat wrappers. |
| **Zero-fee inside Telegram** | Transfers between ZapGram wallets are free and as fast as a message. |
| **Your keys, optional** | Keep sats in the built-in wallet, or connect any wallet that supports NWC. |
| **Chats that earn** | Monetize private groups and channels with one-time or monthly Lightning access. |
| **Native to Telegram** | Tips with `/tip`, invoices in DM, join requests that pay themselves. |
| **Open source** | Inspect the code, self-host, or contribute. |

---

## Features

### Lightning wallet

Every user gets a Lightning wallet the moment they open the bot.

- Live balance in sats
- **Receive** — create an invoice (amount + optional memo), share the QR / BOLT11 string
- **Send** — pay any Lightning invoice, or send sats to a Telegram `@username`
- Automatic notifications when you get paid or receive a tip

Internal transfers between ZapGram users settle instantly and without network fees — money moves like a DM.

### External wallet via NWC

Prefer self-custody? Connect **any** Lightning wallet that supports [Nostr Wallet Connect](https://nwc.dev/) — for example [Alby](https://getalby.com/invited-by/mozharov) or [Coinos](https://coinos.io).

- Link with a `nostr+walletconnect://…` URL
- See **both** balances (ZapGram + NWC) on the wallet screen
- Choose which wallet pays tips in groups
- Pay subscription invoices from NWC when the balance is enough
- Disconnect anytime

Your external wallet stays under your control; ZapGram only acts within the permissions you grant.

### Tips in groups and channels

Add the bot to a chat and tip with `/tip`:

| Command | What it does |
|---|---|
| `/tip` | 21 sats to the group owner (or channel creator on a post) |
| `/tip 100` | Custom amount to the owner |
| Reply + `/tip` | Tip the author of that message |
| Reply + `/tip 1000` | Tip the author with a custom amount |
| `/tip @user` | Tip a specific user (default 21 sats) |
| `/tip 50 @user` | Tip a user with a custom amount |

Make the bot an admin (delete messages is enough) so owner-bound tips work cleanly and technical messages stay out of the way. In channels, tip replies to posts go to the channel creator.

### Invoices: pay and get paid

- **Create** — amount in sats, optional memo → QR photo + copyable invoice
- **Pay** — paste or forward a `lnbc…` invoice → review amount, memo, fee, expiry → confirm
- Foreign invoices show the Lightning fee reserve; already-paid and expired invoices are handled safely
- Incoming payments notify you and update your balance automatically

### Paid access to private chats

Turn a private group or channel into a Lightning-gated community.

**For owners**

1. Add `@zap_gram_bot` with **invite users** and **ban users** rights
2. Open `/chats` → enable paid access
3. Set price (sats), payment type (**one-time** permanent access or **monthly**), optional custom join message (RU + EN)

**For members**

1. Request to join the chat
2. Receive a Lightning invoice (and a one-tap pay option if your ZapGram or NWC balance covers it)
3. Pay → access is granted immediately

**Subscriptions**

- Monthly renewals can auto-debit from the ZapGram wallet
- Manage auto-renew and status via `/subscriptions`
- Manual renewal invoices when auto-renew is off or the balance is short
- Owners are paid automatically (minus a small platform fee); duplicate payments are refunded safely

### Language

UI follows your Telegram language: **Russian** or **English** (everything else falls back to English).

---

## Quick start (as a user)

1. Open **[@zap_gram_bot](https://t.me/zap_gram_bot)** → `/start`
2. Fund the wallet: **Receive** → create an invoice → pay it from any Lightning wallet
3. Tip a friend in a group: `/tip 21 @username`
4. Or send privately: **Send** → user / invoice

Useful commands:

| Command | |
|---|---|
| `/wallet` | Balance, receive, send |
| `/settings` | NWC, tips source, group help |
| `/chats` | Paid groups & channels you own |
| `/subscriptions` | Your paid-chat subscriptions |
| `/help` | Bitcoin, Lightning, supported wallets |

---

## Who is it for?

- **Lightning users** who live in Telegram and want tips and invoices without extra apps
- **Community owners** who want sat-gated groups and channels without fiat billing
- **Creators & channels** who collect tips under posts
- **Self-custody fans** who still want Telegram UX via NWC

---

## Architecture (developers)

Layered design + vertical feature slices. Full write-up: **[docs/architecture.md](./docs/architecture.md)**.

```
core → infra → modules → telegram / http / jobs
                ↑
            bootstrap (composition root)
```

Entry: `src/main.ts` → `createContainer()` → `createApp()` → start / graceful shutdown.

### Stack

Bun, TypeScript, grammY, Elysia, Drizzle (SQLite), LNbits, Nostr Wallet Connect, pino, Biome.

**Lightning backend:** [Alby](https://getalby.com/invited-by/mozharov)

### Local development

```bash
# install
bun install

# typecheck + lint + tests
bun run ci

# local bot (needs .env; HOST must be a public HTTPS URL)
bun run start:dev
```

---

## Links

- **Bot:** [t.me/zap_gram_bot](https://t.me/zap_gram_bot)
- **Source:** [github.com/mozharov/zapgram](https://github.com/mozharov/zapgram)
- **Architecture:** [docs/architecture.md](./docs/architecture.md)
- **Contact:** [@vmozharov](https://t.me/vmozharov)

---

## License

[MIT](LICENSE) — free to use, modify, and distribute, including commercially.

---

<p align="center">
  <i>Welcome to the world of free payments.</i><br>
  ⚡ ZapGram
</p>
