import { DahuaSyncProvider } from '../dahua-sync.provider';

/**
 * Unit del adapter de sync Dahua: sin credenciales/URL no rompe (best-effort) y
 * el CardNo es determinista por credencial (para poder actualizar/borrar luego).
 */
describe('DahuaSyncProvider', () => {
  const provider = new DahuaSyncProvider();
  const noDevice = { id: 'd', hardwareId: 'hw', channel: 1, controlUrl: null, controlSecret: null };

  it('sin controlUrl/creds → push devuelve un ref determinista sin lanzar', async () => {
    const spec = {
      credentialId: 'cred-abc',
      customerId: 'cust',
      method: 'pin' as const,
      secret: '1234',
      label: null,
      state: 'active' as const,
    };
    const r1 = await provider.pushCredential(noDevice, spec);
    const r2 = await provider.pushCredential(noDevice, spec);
    expect(r1.ref).toBe(r2.ref); // determinista por credentialId
    expect(r1.ref).toMatch(/^\d+$/);
  });

  it('setState/remove/pullEvents no lanzan sin device configurado', async () => {
    await expect(provider.setState(noDevice, '1', 'suspended')).resolves.toBeUndefined();
    await expect(provider.remove(noDevice, '1')).resolves.toBeUndefined();
    await expect(provider.pullEvents(noDevice, null)).resolves.toEqual([]);
  });
});
