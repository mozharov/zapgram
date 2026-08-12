# ZapGram

**[English](README.md)** · **[Русский](README.ru.md)**

**Bitcoin Lightning wallet inside Telegram** — send, receive, tip, and monetize chats with sats.

<div align="center">

[![Open in Telegram](https://img.shields.io/badge/Open-@zap__gram__bot-26A5E4?logo=telegram&style=for-the-badge)](https://t.me/zap_gram_bot)
[![Website](https://img.shields.io/badge/Website-zapgram.mozharov.me-111111?style=for-the-badge)](https://zapgram.mozharov.me/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

[![Alby](https://img.shields.io/badge/Alby-FFDF6F?style=for-the-badge&logo=alby&logoColor=000000)](https://getalby.com/invited-by/mozharov)
[![NWC](docs/assets/badge-nwc.svg)](https://nwc.dev/)
[![LNbits](docs/assets/badge-lnbits.svg)](https://lnbits.com/)

</div>

---

ZapGram turns Telegram into a Lightning payment app: instant tips in groups, invoices with QR codes, transfers between users at message speed, and paid access to private communities.

---

## Used by

**Partner: [21ideas](https://21ideas.org/en/)** — community with Bitcoin learning materials.

In the 21ideas community ZapGram is used for:

- **Tips** in chat
- **Paid access** to the community

Telegram channel: [**@bitcoin21ideas**](https://t.me/bitcoin21ideas)  
ZapGram guide from 21ideas: [21ideas.org/zapgram/](https://21ideas.org/zapgram/)

---

## Why ZapGram?

| | |
|---|---|
| **Lightning-native** | Built for satoshis and BOLT11 invoices — not fiat wrappers. |
| **Zero-fee inside Telegram** | Transfers between ZapGram wallets are free and as fast as a message. |
| **Your keys, optional** | Keep sats in the built-in wallet, or connect any wallet that supports NWC. |
| **Chats that earn** | Monetize private groups and channels with one-time or monthly Lightning access. |
| **Native to Telegram** | Tips with `/tip`, invoices in DM, join requests that pay themselves. |
| **Optional support** | Voluntary % on payments, one-shot and monthly donations via `/donate`. |
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

### Support the project (optional donations)

ZapGram is free to use. You can optionally support the bot author:

- **Voluntary % on top of payments** — new accounts default to **5% on tips only**. Change percent, scope (**tips only** / **all payments**), or turn off in `/settings` → Support the project.
- **Auto-% never blocks your payment** — the main tip or invoice pay settles first; the support tip is best-effort. Success is silent (totals update on `/donate`); failure only notifies you in private chat.
- **`/donate` hub** — your personal stats, **community totals** (all-time + last 30 days), one-shot amounts (**21 · 100 · 1 000 · 10 000 · 100 000** or custom), and in-bot **monthly** auto-donate (charges every 30 days; first charge when you enable).
- **Outside the bot** — Lightning address `zapgram@getalby.com`.

This is separate from the small **platform fee** on paid-chat Lightning subscriptions (`SUBSCRIPTION_FEE_PERCENT`).

### Invoices: pay and get paid

- **Create** — amount in sats, optional memo → QR photo + copyable invoice
- **Pay** — paste or forward a `lnbc…` invoice → review amount, memo, fee, expiry → confirm
- Foreign invoices show the Lightning fee reserve; already-paid and expired invoices are handled safely
- Incoming payments notify you and update your balance automatically

### Paid access to private chats

Turn a private group or channel into a sat-gated community — **Lightning and/or on-chain Bitcoin**.

**For owners**

1. Add `@zap_gram_bot` with **invite users** and **ban users** rights
2. Open `/chats` → enable paid access
3. Set price (sats), payment type (**one-time** permanent access or **monthly**), optional custom join message (RU + EN)
4. Optional: **Enable on-chain pay** and paste an account-level **zpub / xpub** (receive account). Members can then pay on-chain; funds go to addresses derived from your key. Platform Lightning fee does **not** apply to the on-chain rail.

**For members**

1. Request to join the chat
2. Receive a Lightning invoice (and one-tap pay if your ZapGram or NWC balance covers it), and optionally **Pay on-chain** when the owner enabled it
3. Pay either rail → access is granted (on-chain usually after the tx appears on the network)

**Subscriptions**

- Monthly renewals auto-debit the ZapGram wallet first, then NWC if connected and the internal balance is short
- Manage auto-renew and status via `/subscriptions`
- Manual renewal invoices when auto-renew is off or both wallets cannot pay
- Lightning joins: owners are paid automatically (minus a small platform fee); duplicate payments are refunded safely
- On-chain joins: sats go straight to the owner’s wallet (xpub); no Lightning fee split

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
| `/settings` | NWC, tips source, group help, optional support % |
| `/donate` | One-shot / monthly support, your stats, community totals |
| `/feature` | Request a feature; optionally attach sats as a priority tip |
| `/chats` | Paid groups & channels you own |
| `/subscriptions` | Your paid-chat subscriptions |
| `/help` | Bitcoin, Lightning, supported wallets |

---

## Who is it for?

- **Lightning users** who live in Telegram and want tips and invoices without extra apps
- **Community owners** who want sat-gated groups and channels without fiat billing
- **Creators & channels** who collect tips under posts
- **Self-custody fans** who still want Telegram UX via NWC
- **Supporters** who want to keep open Lightning tools alive with optional sats

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

**Feature requests (`/feature`):** set `ADMIN_TELEGRAM_IDS` (comma-separated Telegram user ids) so new requests are DMed to you. Optional sats tips use the same rails as `/donate`. Events land in PostHog as `feature_requested` (filter Activity / build an insight). Without admin ids, requests still capture analytics only.

### On-chain pay (self-host / ops)

Requires LNbits extensions **Watch Only** + **SatsPay** on the same instance as `LNBITS_URL`.

| Setting | Notes |
|---|---|
| SatsPay `webhook_method` | **POST** (default GET breaks ZapGram) |
| SatsPay / Watch Only network | Match `LNBITS_ONCHAIN_NETWORK` (`Mainnet` or `Testnet`) |
| Mempool URL | Mainnet: `https://mempool.space` · Testnet: `https://mempool.space/testnet` |
| `HOST` | Public HTTPS origin of the bot (SatsPay POSTs `${HOST}/satspay/webhook/${BOT_WEBHOOK_SECRET}`) |
| `LNBITS_ADMIN_KEY` | Bot wallet admin key (creates WO wallets under that user) |

Compose passes `LNBITS_ONCHAIN_NETWORK` (default `Mainnet`). After enabling on-chain in `/chats`, smoke: paste account zpub → member join → Pay on-chain → pay ≥ price → grant.

---

## Links

- **Bot:** [t.me/zap_gram_bot](https://t.me/zap_gram_bot)
- **Source:** [github.com/mozharov/zapgram](https://github.com/mozharov/zapgram)
- **Architecture:** [docs/architecture.md](./docs/architecture.md)
- **Partner:** [21ideas](https://21ideas.org/en/) · channel [@bitcoin21ideas](https://t.me/bitcoin21ideas) · [ZapGram guide from 21ideas](https://21ideas.org/zapgram/)
- **Contact:** [@vmozharov](https://t.me/vmozharov)

---

## License

[MIT](LICENSE) — free to use, modify, and distribute, including commercially.

---

<p align="center">
  <i>Welcome to the world of free payments.</i><br>
  ⚡ ZapGram
</p>
