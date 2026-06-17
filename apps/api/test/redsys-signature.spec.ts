import {
  encodeMerchantParameters,
  signRequest,
  verifyNotification,
} from '../src/modules/payments/redsys/redsys-signature';

// Clave de pruebas pública de Redsys (entorno de test).
const TEST_KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

describe('Redsys signature', () => {
  const params = {
    Ds_Merchant_Amount: '1500',
    Ds_Merchant_Order: '000012345678',
    Ds_Merchant_MerchantCode: '999008881',
    Ds_Merchant_Currency: '978',
    Ds_Merchant_TransactionType: '0',
    Ds_Merchant_Terminal: '1',
  };

  it('firma de petición es determinista para los mismos datos', () => {
    const mp = encodeMerchantParameters(params);
    const a = signRequest(mp, params.Ds_Merchant_Order, TEST_KEY);
    const b = signRequest(mp, params.Ds_Merchant_Order, TEST_KEY);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it('la notificación verifica con la firma generada por el mismo algoritmo', () => {
    // Simula una notificación: mismos params + firma calculada por Redsys.
    const notifParams = { Ds_Order: '000012345678', Ds_Response: '0000', Ds_Amount: '1500' };
    const mp = encodeMerchantParameters(notifParams);
    const signature = signRequest(mp, notifParams.Ds_Order, TEST_KEY);

    const res = verifyNotification(mp, signature, TEST_KEY);
    expect(res.valid).toBe(true);
    expect(res.params.Ds_Response).toBe('0000');
  });

  it('rechaza una firma manipulada', () => {
    const notifParams = { Ds_Order: '000012345678', Ds_Response: '0000' };
    const mp = encodeMerchantParameters(notifParams);
    const res = verifyNotification(mp, 'firmaFalsa==', TEST_KEY);
    expect(res.valid).toBe(false);
  });

  it('rechaza si manipulan los parámetros (firma deja de cuadrar)', () => {
    const notifParams = { Ds_Order: '000012345678', Ds_Response: '0000' };
    const mp = encodeMerchantParameters(notifParams);
    const signature = signRequest(mp, notifParams.Ds_Order, TEST_KEY);
    // Cambiamos los params pero mantenemos la firma vieja.
    const tampered = encodeMerchantParameters({ ...notifParams, Ds_Response: '0190' });
    const res = verifyNotification(tampered, signature, TEST_KEY);
    expect(res.valid).toBe(false);
  });

  it('acepta firma en base64url (como envía Redsys)', () => {
    const notifParams = { Ds_Order: '000099887766', Ds_Response: '0099' };
    const mp = encodeMerchantParameters(notifParams);
    const std = signRequest(mp, notifParams.Ds_Order, TEST_KEY);
    const urlSafe = std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const res = verifyNotification(mp, urlSafe, TEST_KEY);
    expect(res.valid).toBe(true);
  });
});
