import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminTodayService } from './admin-today.service';

import type { Env } from '../../config/env.schema';
import type {
  AdminTodayDto,
  ChatAlertSendResultDto,
  ChatAlertSettingsDto,
  ChatChannelResult,
  UpdateChatAlertSettingsInput,
} from '@storageos/shared';

const AAD_TELEGRAM = 'platform-chat-telegram';
const AAD_SLACK = 'platform-chat-slack';
const SLACK_PREFIX = 'https://hooks.slack.com/services/';
const TIMEOUT_MS = 8_000;

/**
 * Avisos del panel admin por chat: cada mañana lo urgente del «Hoy» y los
 * lunes el resumen semanal, por Telegram (bot) y/o Slack (webhook entrante).
 *
 * Solo se llama a `api.telegram.org` y a `hooks.slack.com` (validado al
 * guardar y al enviar). Con `NODE_ENV=test` no sale nada: los mensajes se
 * guardan en `sentForTests`.
 */
@Injectable()
export class ChatAlertsService {
  private readonly logger = new Logger(ChatAlertsService.name);
  /** Mensajes «enviados» en tests (no hay red). */
  readonly sentForTests: { channel: 'telegram' | 'slack'; text: string }[] = [];
  private readonly stub: boolean;
  private readonly webBase: string;

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    private readonly today: AdminTodayService,
    config: ConfigService<Env, true>,
  ) {
    this.stub = config.get('NODE_ENV', { infer: true }) === 'test';
    this.webBase = config.get('WEB_BASE_URL', { infer: true });
  }

  private async row() {
    return (
      (await this.admin.platformAlertSettings.findFirst()) ??
      (await this.admin.platformAlertSettings.create({ data: {} }))
    );
  }

  async getSettings(): Promise<ChatAlertSettingsDto> {
    const r = await this.row();
    return {
      telegramConfigured: Boolean(r.telegramBotTokenEncrypted && r.telegramChatId),
      telegramChatId: r.telegramChatId,
      slackConfigured: Boolean(r.slackWebhookUrlEncrypted),
      dailyEnabled: r.chatDailyEnabled,
      weeklyEnabled: r.chatWeeklyEnabled,
    };
  }

  async updateSettings(input: UpdateChatAlertSettingsInput): Promise<ChatAlertSettingsDto> {
    const r = await this.row();
    const data: Record<string, unknown> = {};
    if (input.telegramBotToken !== undefined) {
      data.telegramBotTokenEncrypted = input.telegramBotToken
        ? this.crypto.encryptString(input.telegramBotToken, AAD_TELEGRAM)
        : null;
    }
    if (input.telegramChatId !== undefined) data.telegramChatId = input.telegramChatId || null;
    if (input.slackWebhookUrl !== undefined) {
      data.slackWebhookUrlEncrypted = input.slackWebhookUrl
        ? this.crypto.encryptString(input.slackWebhookUrl, AAD_SLACK)
        : null;
    }
    if (input.dailyEnabled !== undefined) data.chatDailyEnabled = input.dailyEnabled;
    if (input.weeklyEnabled !== undefined) data.chatWeeklyEnabled = input.weeklyEnabled;
    await this.admin.platformAlertSettings.update({ where: { id: r.id }, data });
    return this.getSettings();
  }

  /** Envía un texto a los canales configurados. */
  async send(text: string): Promise<ChatAlertSendResultDto> {
    const r = await this.row();
    const telegramToken = r.telegramBotTokenEncrypted
      ? this.crypto.decryptString(r.telegramBotTokenEncrypted, AAD_TELEGRAM)
      : null;
    const slackUrl = r.slackWebhookUrlEncrypted
      ? this.crypto.decryptString(r.slackWebhookUrlEncrypted, AAD_SLACK)
      : null;
    if (!(telegramToken && r.telegramChatId) && !slackUrl) {
      return { sent: false, telegram: 'off', slack: 'off', reason: 'no_channel' };
    }
    const [telegram, slack] = await Promise.all([
      telegramToken && r.telegramChatId
        ? this.sendTelegram(telegramToken, r.telegramChatId, text)
        : Promise.resolve<ChatChannelResult>('off'),
      slackUrl ? this.sendSlack(slackUrl, text) : Promise.resolve<ChatChannelResult>('off'),
    ]);
    return { sent: telegram === 'sent' || slack === 'sent', telegram, slack, reason: null };
  }

  /** Mensaje de prueba. */
  sendTest(): Promise<ChatAlertSendResultDto> {
    return this.send('✅ TrasterOS: los avisos del panel admin llegan a este chat.');
  }

  /**
   * Lo urgente del «Hoy». `force` lo manda aunque esté apagado (botón «Enviar
   * ahora»); si no hay nada urgente no manda nada.
   */
  async sendDaily(force = false): Promise<ChatAlertSendResultDto> {
    const r = await this.row();
    if (!force && !r.chatDailyEnabled) {
      return { sent: false, telegram: 'off', slack: 'off', reason: 'disabled' };
    }
    const today = await this.today.getToday();
    if (today.urgentCount === 0) {
      return { sent: false, telegram: 'off', slack: 'off', reason: 'nothing_urgent' };
    }
    return this.send(this.dailyText(today));
  }

  /** Texto del aviso diario (se exporta para tests). */
  dailyText(t: AdminTodayDto): string {
    const lines: [number, string][] = [
      [t.openTickets.length, 'tickets sin responder'],
      [t.pastDue.length, 'tenants con pago pendiente'],
      [t.addonCharges.length, 'cobros de extras por registrar'],
      [t.manualRenewalsDue.length, 'renovaciones manuales por vencer'],
      [t.followupsDue.length, 'seguimientos para hoy'],
      [t.aeatIssues.length, 'tenants con facturas con problemas en Veri*Factu'],
      [t.certificatesExpiring.length, 'certificados de la AEAT que caducan'],
      [t.holdedReview.length, 'tenants con envíos de Holded por revisar'],
      [t.devicesOffline.length, 'tenants con dispositivos de acceso sin conexión'],
      [t.overdueCrons.length, 'tareas programadas atrasadas'],
      [t.failedWebhooks.length, 'tenants con webhooks fallidos'],
      [t.failedJobs, 'jobs fallidos en las colas'],
      [t.trialsExpiring.length, 'pruebas que terminan pronto'],
    ];
    const body = lines.filter(([n]) => n > 0).map(([n, label]) => `• ${n} ${label}`);
    return [
      `TrasterOS · Hoy: ${t.urgentCount} cosa(s) urgente(s)`,
      ...body,
      `${this.webBase}/admin/today`,
    ].join('\n');
  }

  /** ¿Va el resumen semanal por chat? (lo usa el resumen semanal). */
  async weeklyEnabled(): Promise<boolean> {
    return (await this.row()).chatWeeklyEnabled;
  }

  private async sendTelegram(
    token: string,
    chatId: string,
    text: string,
  ): Promise<ChatChannelResult> {
    if (this.stub) {
      this.sentForTests.push({ channel: 'telegram', text });
      return 'sent';
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`Telegram respondió ${res.status}`);
        return 'failed';
      }
      return 'sent';
    } catch (err) {
      this.logger.warn(`Telegram: ${(err as Error).message}`);
      return 'failed';
    }
  }

  private async sendSlack(url: string, text: string): Promise<ChatChannelResult> {
    if (!url.startsWith(SLACK_PREFIX)) return 'failed';
    if (this.stub) {
      this.sentForTests.push({ channel: 'slack', text });
      return 'sent';
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`Slack respondió ${res.status}`);
        return 'failed';
      }
      return 'sent';
    } catch (err) {
      this.logger.warn(`Slack: ${(err as Error).message}`);
      return 'failed';
    }
  }
}
