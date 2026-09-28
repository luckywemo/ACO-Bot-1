import { nullLogger, type Logger } from "@aco/config";

export interface NotifyEvent {
  title: string;
  lines: string[];
  /** Discord embed color. */
  color?: number;
}

export interface Notifier {
  send(event: NotifyEvent): Promise<void>;
}

export const nullNotifier: Notifier = { send: async () => {} };

export class CompositeNotifier implements Notifier {
  constructor(private readonly targets: Notifier[]) {}
  async send(event: NotifyEvent): Promise<void> {
    await Promise.allSettled(this.targets.map((t) => t.send(event)));
  }
}

/** Discord incoming-webhook notifier (no bot token required). */
export class DiscordNotifier implements Notifier {
  constructor(
    private readonly webhookUrl: string,
    private readonly logger: Logger = nullLogger,
  ) {}

  async send(event: NotifyEvent): Promise<void> {
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          embeds: [
            {
              title: event.title,
              description: event.lines.join("\n"),
              color: event.color ?? 0x2081e2,
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status }, "discord webhook failed");
      }
    } catch (err) {
      this.logger.warn({ err }, "discord webhook error");
    }
  }
}

/** Telegram Bot API notifier. */
export class TelegramNotifier implements Notifier {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly logger: Logger = nullLogger,
  ) {}

  async send(event: NotifyEvent): Promise<void> {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: this.chatId,
            text: `${event.title}\n\n${event.lines.join("\n")}`,
            disable_web_page_preview: true,
          }),
        },
      );
      if (!res.ok) {
        this.logger.warn({ status: res.status }, "telegram sendMessage failed");
      }
    } catch (err) {
      this.logger.warn({ err }, "telegram error");
    }
  }
}

export function buildNotifier(
  opts: {
    discordWebhookUrl?: string;
    telegramBotToken?: string;
    telegramChatId?: string;
  },
  logger: Logger = nullLogger,
): Notifier {
  const targets: Notifier[] = [];
  if (opts.discordWebhookUrl)
    targets.push(new DiscordNotifier(opts.discordWebhookUrl, logger));
  if (opts.telegramBotToken && opts.telegramChatId)
    targets.push(
      new TelegramNotifier(opts.telegramBotToken, opts.telegramChatId, logger),
    );
  return targets.length ? new CompositeNotifier(targets) : nullNotifier;
}
