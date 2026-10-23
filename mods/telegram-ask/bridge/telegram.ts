import type { Button } from './format'
import { htmlToPlain } from './markdown'

export type ChatId = number | string

export type Update = {
  update_id: number
  message?: { message_id: number; chat: { id: ChatId }; text?: string }
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: ChatId } } }
}

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
  ) {
    super(`telegram ${method} failed: ${status} ${description}`)
    this.name = 'TelegramError'
  }
}

export type Telegram = {
  sendMessage(chatId: ChatId, text: string, keyboard: Button[][]): Promise<{ message_id: number }>
  editMessageText(chatId: ChatId, messageId: number, text: string, keyboard?: Button[][]): Promise<void>
  answerCallbackQuery(id: string, text?: string): Promise<void>
  getUpdates(offset: number, timeoutS: number): Promise<Update[]>
}

export function createTelegram(opts: { token: string; base?: string; fetch?: typeof fetch }): Telegram {
  const base = opts.base ?? 'https://api.telegram.org'
  const doFetch = opts.fetch ?? globalThis.fetch
  const scrub = (s: string) => s.split(opts.token).join('<token>')

  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    let res: Response
    try {
      res = await doFetch(`${base}/bot${opts.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (e) {
      // Fetch errors carry the full request URL (with the token) in their fields,
      // so a fresh error is thrown instead of the original.
      const code = (e as { code?: string }).code ?? (e as Error).name ?? 'error'
      throw new TelegramError(method, 0, scrub(`network ${code}`))
    }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error_code?: number; description?: string }
    if (!data.ok) throw new TelegramError(method, data.error_code ?? res.status, scrub(data.description ?? 'no description'))
    return data.result as T
  }

  const markup = (keyboard?: Button[][]) => (keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})

  // Text is Telegram HTML. If Telegram still refuses to parse it, the same
  // message goes again as plain text, so a question is never lost to markup.
  async function withHtml<T>(method: string, body: Record<string, unknown>, text: string): Promise<T> {
    try {
      return await call<T>(method, { ...body, text, parse_mode: 'HTML' })
    } catch (e) {
      if (!(e instanceof TelegramError) || e.status !== 400 || !/can't parse entities/i.test(e.description)) throw e
      return call<T>(method, { ...body, text: htmlToPlain(text) })
    }
  }

  return {
    async sendMessage(chatId, text, keyboard) {
      const r = await withHtml<{ message_id: number }>(
        'sendMessage',
        { chat_id: chatId, ...markup(keyboard), link_preview_options: { is_disabled: true } },
        text,
      )
      return { message_id: r.message_id }
    },
    async editMessageText(chatId, messageId, text, keyboard) {
      await withHtml(
        'editMessageText',
        { chat_id: chatId, message_id: messageId, ...markup(keyboard), link_preview_options: { is_disabled: true } },
        text,
      )
    },
    async answerCallbackQuery(id, text) {
      await call('answerCallbackQuery', text === undefined ? { callback_query_id: id } : { callback_query_id: id, text })
    },
    async getUpdates(offset, timeoutS) {
      return call<Update[]>('getUpdates', { offset, timeout: timeoutS, allowed_updates: ['message', 'callback_query'] })
    },
  }
}
