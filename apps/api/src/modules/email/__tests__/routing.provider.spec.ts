import { PlatformEmailSettingsService } from '../platform-email-settings.service';
import { RoutingEmailProvider } from '../providers/routing.provider';

import type { Env } from '../../../config/env.schema';
import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { BrevoEmailProvider } from '../providers/brevo.provider';
import type { EmailProvider } from '../providers/email-provider';
import type { ResendEmailProvider } from '../providers/resend.provider';
import type { SmtpEmailProvider } from '../providers/smtp.provider';
import type { ConfigService } from '@nestjs/config';

function settingsWith(
  env: Partial<Record<keyof Env, unknown>>,
  row: { provider: string | null; fallbackEnabled: boolean } | null,
): PlatformEmailSettingsService {
  const config = {
    get: (k: keyof Env) =>
      ({ EMAIL_PROVIDER: 'smtp', BREVO_API_KEY: '', RESEND_API_KEY: '', ...env })[k],
  } as unknown as ConfigService<Env, true>;
  const admin = {
    platformEmailSettings: { findFirst: jest.fn().mockResolvedValue(row) },
  } as unknown as PrismaAdminService;
  return new PlatformEmailSettingsService(admin, config);
}

const BOTH = { BREVO_API_KEY: 'b', RESEND_API_KEY: 'r' };

describe('Orden de proveedores de correo', () => {
  it('sin claves de API manda la variable (Mailpit en dev/test)', async () => {
    const s = settingsWith({}, { provider: 'brevo', fallbackEnabled: true });
    expect(await s.sendOrder()).toEqual(['smtp']);
  });

  it('el panel elige el principal y el otro queda de respaldo', async () => {
    const s = settingsWith(
      { ...BOTH, EMAIL_PROVIDER: 'brevo' },
      { provider: 'resend', fallbackEnabled: true },
    );
    expect(await s.sendOrder()).toEqual(['resend', 'brevo']);
  });

  it('sin respaldo solo se intenta el principal', async () => {
    const s = settingsWith(BOTH, { provider: 'brevo', fallbackEnabled: false });
    expect(await s.sendOrder()).toEqual(['brevo']);
  });

  it('sin elección en el panel usa la variable; si el elegido no tiene clave, el otro', async () => {
    const env = settingsWith({ ...BOTH, EMAIL_PROVIDER: 'resend' }, null);
    expect(await env.sendOrder()).toEqual(['resend', 'brevo']);
    const onlyBrevo = settingsWith(
      { BREVO_API_KEY: 'b', EMAIL_PROVIDER: 'resend' },
      { provider: 'resend', fallbackEnabled: true },
    );
    expect(await onlyBrevo.sendOrder()).toEqual(['brevo']);
  });
});

describe('RoutingEmailProvider', () => {
  const args = { to: 'a@x.com', subject: 's', html: 'h', text: 't' };
  const provider = (send: jest.Mock) => ({ send }) as unknown as EmailProvider;

  function router(order: string[], brevo: jest.Mock, resend: jest.Mock) {
    const settings = { sendOrder: jest.fn().mockResolvedValue(order) };
    return new RoutingEmailProvider(
      settings as unknown as PlatformEmailSettingsService,
      provider(jest.fn()) as unknown as SmtpEmailProvider,
      provider(brevo) as unknown as BrevoEmailProvider,
      provider(resend) as unknown as ResendEmailProvider,
    );
  }

  it('si el principal falla, entrega por el respaldo e indica cuál', async () => {
    const brevo = jest.fn().mockRejectedValue(new Error('daily limit reached'));
    const resend = jest.fn().mockResolvedValue({ providerMessageId: 'r1' });
    const res = await router(['brevo', 'resend'], brevo, resend).send(args);
    expect(res).toEqual({ providerMessageId: 'r1', provider: 'resend' });
    expect(brevo).toHaveBeenCalledTimes(1);
  });

  it('si fallan todos, propaga el último error', async () => {
    const brevo = jest.fn().mockRejectedValue(new Error('uno'));
    const resend = jest.fn().mockRejectedValue(new Error('dos'));
    await expect(router(['brevo', 'resend'], brevo, resend).send(args)).rejects.toThrow('dos');
  });

  it('con el principal bien no toca el respaldo', async () => {
    const brevo = jest.fn().mockResolvedValue({ providerMessageId: 'b1' });
    const resend = jest.fn();
    const res = await router(['brevo', 'resend'], brevo, resend).send(args);
    expect(res.provider).toBe('brevo');
    expect(resend).not.toHaveBeenCalled();
  });
});
