import { randomBytes } from 'node:crypto';

import { CryptoService } from '../crypto/crypto.service';

import type { ConfigService } from '@nestjs/config';

function makeCrypto(): CryptoService {
  const key = randomBytes(32).toString('base64');
  const config = { get: () => key } as unknown as ConfigService;
  return new CryptoService(config as never);
}

describe('CryptoService — AAD atado a tenant/fila', () => {
  it('cifra y descifra sin AAD (comportamiento previo intacto)', () => {
    const crypto = makeCrypto();
    const envelope = crypto.encryptString('secreto-sin-contexto');
    expect(crypto.decryptString(envelope)).toBe('secreto-sin-contexto');
  });

  it('cifra y descifra con el mismo AAD', () => {
    const crypto = makeCrypto();
    const envelope = crypto.encryptString('secreto-tenant-a', 'tenant-a');
    expect(crypto.decryptString(envelope, 'tenant-a')).toBe('secreto-tenant-a');
  });

  it('descifrar con OTRO AAD falla (protege contra pegar el ciphertext en otra fila/tenant)', () => {
    const crypto = makeCrypto();
    const envelope = crypto.encryptString('secreto-tenant-a', 'tenant-a');
    expect(() => crypto.decryptString(envelope, 'tenant-b')).toThrow();
    // Tampoco decodifica sin AAD — el fallback retrocompatible solo cubre
    // envelopes que se cifraron SIN AAD, no un downgrade de uno que sí lo tenía.
    expect(() => crypto.decryptString(envelope)).toThrow();
  });

  it('retrocompatible: un envelope preexistente (cifrado sin AAD) se descifra igual pidiendo AAD', () => {
    const crypto = makeCrypto();
    // Simula un secreto guardado en BD antes de este fix.
    const legacyEnvelope = crypto.encryptString('secreto-legacy');
    expect(crypto.decryptString(legacyEnvelope, 'tenant-cualquiera')).toBe('secreto-legacy');
  });

  it('el auth tag sigue detectando manipulación del ciphertext (con o sin AAD)', () => {
    const crypto = makeCrypto();
    const envelope = crypto.encryptString('secreto', 'tenant-a');
    const [iv, tag, ct] = envelope.split('.');
    const tampered = [iv, tag, Buffer.from(`${ct}x`, 'base64url').toString('base64url')].join('.');
    expect(() => crypto.decryptString(tampered, 'tenant-a')).toThrow();
  });
});
