import { Injectable } from '@nestjs/common';

import { type CredentialSyncProvider } from './credential-sync-provider';
import { DahuaSyncProvider } from './dahua-sync.provider';
import { StubSyncProvider } from './stub-sync.provider';

/**
 * Resuelve el provider de SINCRONIZACIÓN de credenciales (Patrón B) por
 * dispositivo. Solo los terminales autónomos sincronizan; los de Patrón A puro
 * (http/mqtt) devuelven `null` → no se sincroniza nada para ellos.
 */
@Injectable()
export class SyncProviderRegistry {
  constructor(
    private readonly dahua: DahuaSyncProvider,
    private readonly stub: StubSyncProvider,
  ) {}

  resolve(provider?: string | null): CredentialSyncProvider | null {
    if (provider === 'dahua') return this.dahua;
    if (provider === 'stub') return this.stub;
    return null;
  }

  /** ¿Es un provider de Patrón B (sincroniza credenciales)? */
  isSyncable(provider?: string | null): boolean {
    return this.resolve(provider) !== null;
  }
}
