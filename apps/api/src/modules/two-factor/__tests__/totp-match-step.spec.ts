import { TOTP, Secret } from 'otpauth';

import { TotpService } from '../totp.service';

import type { Env } from '../../../config/env.schema';
import type { ConfigService } from '@nestjs/config';

describe('TotpService.matchStep (anti-replay)', () => {
  const svc = new TotpService({ get: () => 'TrasterOS' } as unknown as ConfigService<Env, true>);
  const secret = svc.generateSecret();
  const codeAt = (ms: number) =>
    new TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secret),
    }).generate({ timestamp: ms });

  it('devuelve el paso de 30 s del código (actual, anterior y siguiente)', () => {
    const now = 1_790_000_000_000;
    const step = Math.floor(now / 1000 / 30);
    expect(svc.matchStep(secret, codeAt(now), now)).toBe(step);
    expect(svc.matchStep(secret, codeAt(now - 30_000), now)).toBe(step - 1);
    expect(svc.matchStep(secret, codeAt(now + 30_000), now)).toBe(step + 1);
  });

  it('null si el código no casa o no tiene 6 dígitos', () => {
    const now = 1_790_000_000_000;
    expect(svc.matchStep(secret, codeAt(now - 120_000), now)).toBeNull();
    expect(svc.matchStep(secret, '12345', now)).toBeNull();
  });
});
