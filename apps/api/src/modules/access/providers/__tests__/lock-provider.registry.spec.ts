import { LockProviderRegistry } from '../lock-provider.registry';

import type { DahuaLockProvider } from '../dahua-lock.provider';
import type { HttpLockProvider } from '../http-lock.provider';
import type { MqttLockProvider } from '../mqtt-lock.provider';
import type { StubLockProvider } from '../stub-lock.provider';
import type { ConfigService } from '@nestjs/config';

/** Provider mínimo identificable por su `name`. */
const fake = (n: string) => ({ name: n }) as unknown;

function makeRegistry(envDefault: string): LockProviderRegistry {
  const config = { get: () => envDefault } as unknown as ConfigService<never, true>;
  return new LockProviderRegistry(
    config,
    fake('stub') as StubLockProvider,
    fake('mqtt') as MqttLockProvider,
    fake('http') as HttpLockProvider,
    fake('dahua') as DahuaLockProvider,
  );
}

describe('LockProviderRegistry', () => {
  it('resuelve por device.provider cuando está declarado', () => {
    const reg = makeRegistry('stub');
    expect(reg.resolve('dahua').name).toBe('dahua');
    expect(reg.resolve('http').name).toBe('http');
    expect(reg.resolve('mqtt').name).toBe('mqtt');
  });

  it('sin provider en el device → cae al default global (env)', () => {
    expect(makeRegistry('http').resolve(null).name).toBe('http');
    expect(makeRegistry('stub').resolve(undefined).name).toBe('stub');
  });

  it('provider desconocido → cae al default global', () => {
    expect(makeRegistry('http').resolve('inexistente').name).toBe('http');
  });

  it('default global desconocido → último recurso stub', () => {
    expect(makeRegistry('raro').resolve(null).name).toBe('stub');
  });
});
