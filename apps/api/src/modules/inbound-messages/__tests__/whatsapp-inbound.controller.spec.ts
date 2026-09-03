import { createHmac } from 'node:crypto';

import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { WhatsAppInboundController } from '../whatsapp-inbound.controller';

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

  beforeEach(() => {
    (inboundStub.record as jest.Mock).mockClear();
  });

  it('sin secret configurado + provider stub + no-produccion → tolera el bypass (dev/test)', async () => {
    const controller = new WhatsAppInboundController(
      inboundStub,
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
    const controller = new WhatsAppInboundController(inboundStub, config);
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
    const controller = new WhatsAppInboundController(inboundStub, config);
    await expect(controller.receive(makeReq({ entry: [] }))).rejects.toThrow(BadRequestException);
    expect(inboundStub.record).not.toHaveBeenCalled();
  });

  it('con secret configurado, firma de otro secret → 400 invalid_signature', async () => {
    const config = fakeConfig({
      WHATSAPP_APP_SECRET: 'el-secreto-real',
      WHATSAPP_PROVIDER: 'meta_waba',
    });
    const controller = new WhatsAppInboundController(inboundStub, config);
    const payload = { entry: [] };
    const raw = Buffer.from(JSON.stringify(payload));
    const forgedSig = createHmac('sha256', 'secreto-adivinado-por-el-atacante')
      .update(raw)
      .digest('hex');
    await expect(
      controller.receive(makeReq(payload, { 'x-hub-signature-256': `sha256=${forgedSig}` })),
    ).rejects.toThrow(BadRequestException);
  });
});
