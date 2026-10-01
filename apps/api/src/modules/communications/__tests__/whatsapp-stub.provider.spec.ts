import { WHATSAPP_NOT_CONFIGURED } from '../providers/whatsapp-provider';
import { WhatsAppStubProvider } from '../providers/whatsapp-stub.provider';

import type { ConfigService } from '@nestjs/config';

const configWith = (nodeEnv: string) =>
  ({ get: () => nodeEnv }) as unknown as ConfigService<never, true>;

describe('WhatsAppStubProvider', () => {
  it('en desarrollo/tests simula el envío', async () => {
    const stub = new WhatsAppStubProvider(configWith('test') as never);
    expect(stub.available).toBe(true);
    const res = await stub.send({ to: '+34600000000', body: 'hola' });
    expect(res.providerMessageId).toMatch(/^stub-/);
    expect(res.skipped).toBeUndefined();
  });

  it('en producción no finge: el envío queda omitido', async () => {
    const stub = new WhatsAppStubProvider(configWith('production') as never);
    expect(stub.available).toBe(false);
    const res = await stub.send({ to: '+34600000000', body: 'hola' });
    expect(res).toEqual({ providerMessageId: null, skipped: WHATSAPP_NOT_CONFIGURED });
  });
});
