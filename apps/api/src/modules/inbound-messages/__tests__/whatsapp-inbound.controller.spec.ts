import { createHmac } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';

import { WhatsAppInboundController } from '../whatsapp-inbound.controller';

import type { WhatsappInboxService } from '../../whatsapp-business/whatsapp-inbox.service';
import type { InboundMessagesService } from '../inbound-messages.service';

/** Fake mínimo de `ConfigService<Env,true>`: solo lo que el controller pide. */
function fakeConfig(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] } as never;
}

function makeReq(
  body: unknown,
  headers: Record<string, string> = {},
): Parameters<WhatsAppInboundController['receive']>[0] {
  return {
    body: Buffer.from(JSON.stringify(body)),
    headers,
  } as unknown as Parameters<WhatsAppInboundController['receive']>[0];
}

describe('WhatsAppInboundController.receive (verificación de firma)', () => {
  const inboundStub = {
    record: jest.fn().mockResolvedValue(true),
  } as unknown as InboundMessagesService;
  // Ningún número de tenant: todo va al flujo del número de la plataforma.
  const inboxStub = {
    handleInbound: jest.fn().mockResolvedValue(false),
    handleStatus: jest.fn().mockResolvedValue(undefined),
    // El número 111 es de un tenant con su propia app de Meta.
    appSecretForPhoneNumberIds: jest.fn(async (ids: string[]) =>
      ids.length > 0 && ids.every((id) => id === '111') ? 'secreto-de-la-app-del-tenant' : null,
    ),
    isTenantVerifyToken: jest.fn(async (t: string) => t === 'wa_token_del_tenant'),
  } as unknown as WhatsappInboxService;

  beforeEach(() => {
    (inboundStub.record as jest.Mock).mockClear();
  });

  it('sin secret configurado + provider stub + no-produccion → tolera el bypass (dev/test)', async () => {
    const controller = new WhatsAppInboundController(
      inboundStub,
      inboxStub,
      fakeConfig({
        WHATSAPP_APP_SECRET: '',
        WHATSAPP_PROVIDER: 'stub',
        NODE_ENV: 'test',
      }),
    );
    const res = await controller.receive(makeReq({ entry: [] }));
    expect(res).toEqual({ received: true });
  });

  it('sin secret configurado + provider meta_waba → falla cerrado (403), aunque no sea produccion', async () => {
    const controller = new WhatsAppInboundController(
      inboundStub,
      inboxStub,
      fakeConfig({
        WHATSAPP_APP_SECRET: '',
        WHATSAPP_PROVIDER: 'meta_waba',
        NODE_ENV: 'development',
      }),
    );
    await expect(controller.receive(makeReq({ entry: [] }))).rejects.toThrow(ForbiddenException);
    expect(inboundStub.record).not.toHaveBeenCalled();
  });

  it('sin secret configurado + NODE_ENV=production (aunque el provider fuera stub) → falla cerrado', async () => {
    const controller = new WhatsAppInboundController(
      inboundStub,
      inboxStub,
      fakeConfig({
        WHATSAPP_APP_SECRET: '',
        WHATSAPP_PROVIDER: 'stub',
        NODE_ENV: 'production',
      }),
    );
    await expect(controller.receive(makeReq({ entry: [] }))).rejects.toThrow(ForbiddenException);
  });

  it('con secret configurado, firma valida → acepta y procesa', async () => {
    const secret = 's3cr3t-de-meta-32-caracteres-min';
    const config = fakeConfig({ WHATSAPP_APP_SECRET: secret, WHATSAPP_PROVIDER: 'meta_waba' });
    const controller = new WhatsAppInboundController(inboundStub, inboxStub, config);
    const payload = { entry: [] };
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = createHmac('sha256', secret).update(raw).digest('hex');
    const res = await controller.receive(
      makeReq(payload, { 'x-hub-signature-256': `sha256=${sig}` }),
    );
    expect(res).toEqual({ received: true });
  });

  it('con secret configurado, sin firma → 400 invalid_signature (NUNCA hace bypass)', async () => {
    const config = fakeConfig({
      WHATSAPP_APP_SECRET: 'a-real-secret',
      WHATSAPP_PROVIDER: 'meta_waba',
    });
    const controller = new WhatsAppInboundController(inboundStub, inboxStub, config);
    await expect(controller.receive(makeReq({ entry: [] }))).rejects.toThrow(BadRequestException);
    expect(inboundStub.record).not.toHaveBeenCalled();
  });

  it('con secret configurado, firma de otro secret → 400 invalid_signature', async () => {
    const config = fakeConfig({
      WHATSAPP_APP_SECRET: 'el-secreto-real',
      WHATSAPP_PROVIDER: 'meta_waba',
    });
    const controller = new WhatsAppInboundController(inboundStub, inboxStub, config);
    const payload = { entry: [] };
    const raw = Buffer.from(JSON.stringify(payload));
    const forgedSig = createHmac('sha256', 'secreto-adivinado-por-el-atacante')
      .update(raw)
      .digest('hex');
    await expect(
      controller.receive(makeReq(payload, { 'x-hub-signature-256': `sha256=${forgedSig}` })),
    ).rejects.toThrow(BadRequestException);
  });

  it('aviso firmado con la app propia del tenant dueño del número → acepta', async () => {
    const config = fakeConfig({
      WHATSAPP_APP_SECRET: 'el-secreto-real',
      WHATSAPP_PROVIDER: 'meta_waba',
    });
    const controller = new WhatsAppInboundController(inboundStub, inboxStub, config);
    const payload = { entry: [{ changes: [{ value: { metadata: { phone_number_id: '111' } } }] }] };
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = createHmac('sha256', 'secreto-de-la-app-del-tenant').update(raw).digest('hex');
    await expect(
      controller.receive(makeReq(payload, { 'x-hub-signature-256': `sha256=${sig}` })),
    ).resolves.toEqual({ received: true });
    // El mismo secreto no vale para el número de otro tenant.
    const other = { entry: [{ changes: [{ value: { metadata: { phone_number_id: '222' } } }] }] };
    const rawOther = Buffer.from(JSON.stringify(other));
    const sigOther = createHmac('sha256', 'secreto-de-la-app-del-tenant')
      .update(rawOther)
      .digest('hex');
    await expect(
      controller.receive(makeReq(other, { 'x-hub-signature-256': `sha256=${sigOther}` })),
    ).rejects.toThrow(BadRequestException);
  });

  it('si no se puede guardar un mensaje → 500 para que Meta lo reenvíe', async () => {
    const failing = {
      ...inboxStub,
      handleInbound: jest.fn().mockRejectedValue(new Error('BD caída')),
    } as unknown as WhatsappInboxService;
    const controller = new WhatsAppInboundController(
      inboundStub,
      failing,
      fakeConfig({ WHATSAPP_APP_SECRET: '', WHATSAPP_PROVIDER: 'stub', NODE_ENV: 'test' }),
    );
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '111' },
                messages: [{ id: 'w1', from: '34600111222', type: 'text', text: { body: 'Hola' } }],
              },
            },
          ],
        },
      ],
    };
    await expect(controller.receive(makeReq(payload))).rejects.toThrow(
      InternalServerErrorException,
    );
  });
});

describe('WhatsAppInboundController.verify', () => {
  const inboxStub = {
    isTenantVerifyToken: jest.fn(async (t: string) => t === 'wa_token_del_tenant'),
  } as unknown as WhatsappInboxService;
  const controller = new WhatsAppInboundController(
    {} as InboundMessagesService,
    inboxStub,
    fakeConfig({ WHATSAPP_VERIFY_TOKEN: 'token-de-la-plataforma' }),
  );

  it('acepta el token de la plataforma y el de un tenant', async () => {
    await expect(controller.verify('subscribe', 'token-de-la-plataforma', 'c1')).resolves.toBe(
      'c1',
    );
    await expect(controller.verify('subscribe', 'wa_token_del_tenant', 'c2')).resolves.toBe('c2');
    await expect(controller.verify('subscribe', 'otro', 'c3')).rejects.toThrow(ForbiddenException);
  });
});
