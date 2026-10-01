import { PlatformEmailSettingsService } from '../platform-email-settings.service';

import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { ConfigService } from '@nestjs/config';

function build(senders: unknown) {
  const admin = {
    platformEmailSettings: {
      findFirst: jest.fn().mockResolvedValue({ provider: null, fallbackEnabled: true, senders }),
    },
  } as unknown as PrismaAdminService;
  const env: Record<string, string> = {
    EMAIL_FROM_NAME: 'TrasterOS',
    EMAIL_FROM_ADDRESS: 'no-reply@trasteros.pro',
    EMAIL_PROVIDER: 'smtp',
    BREVO_API_KEY: '',
    RESEND_API_KEY: '',
  };
  const config = { get: (k: string) => env[k] } as unknown as ConfigService<never, true>;
  return new PlatformEmailSettingsService(admin, config as never);
}

describe('PlatformEmailSettingsService.platformSender', () => {
  const OLD = process.env.NODE_ENV;
  beforeAll(() => {
    process.env.NODE_ENV = 'test';
  });
  afterAll(() => {
    process.env.NODE_ENV = OLD;
  });

  it('sin nada configurado usa las variables y sin respuesta', async () => {
    const s = await build({}).platformSender('billing');
    expect(s).toEqual({ from: { name: 'TrasterOS', email: 'no-reply@trasteros.pro' } });
  });

  it('el tipo hereda campo a campo del común', async () => {
    const svc = build({
      default: { name: 'TrasterOS', email: 'hola@trasteros.pro', replyTo: 'soporte@trasteros.pro' },
      billing: { email: 'facturacion@trasteros.pro' },
      admin_messages: { replyTo: 'jota@trasteros.pro' },
    });
    expect(await svc.platformSender('billing')).toEqual({
      from: { name: 'TrasterOS', email: 'facturacion@trasteros.pro' },
      replyTo: { name: 'TrasterOS', email: 'soporte@trasteros.pro' },
    });
    expect((await svc.platformSender('admin_messages')).replyTo?.email).toBe('jota@trasteros.pro');
    expect((await svc.platformSender('account')).from.email).toBe('hola@trasteros.pro');
    expect((await svc.platformSender()).from.email).toBe('hola@trasteros.pro');
  });

  it('el resumen muestra lo guardado y lo efectivo', async () => {
    const dto = await build({ staff_notices: { name: 'Avisos TrasterOS' } }).getSenders();
    expect(dto.categories.staff_notices.name).toBe('Avisos TrasterOS');
    expect(dto.effective.staff_notices).toEqual({
      name: 'Avisos TrasterOS',
      email: 'no-reply@trasteros.pro',
      replyTo: null,
    });
    expect(dto.default).toEqual({ name: null, email: null, replyTo: null });
  });
});
