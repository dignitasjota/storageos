/** Domicilio del acreedor de la plataforma (sale en el mandato que firma el tenant). */
export const PLATFORM_CREDITOR_ADDRESS = {
  creditorAddress: 'Calle Mayor 1',
  creditorPostalCode: '28001',
  creditorCity: 'Madrid',
};

/** Cuerpo del alta del mandato de la plataforma: IBAN y firma de la orden. */
export function platformMandateBody(iban: string, bic?: string) {
  return {
    iban,
    ...(bic ? { bic } : {}),
    signerName: 'Empresa de Prueba SL',
    address: 'Calle Falsa 123',
    postalCode: '28002',
    city: 'Madrid',
    country: 'ES',
    place: 'Madrid',
    method: 'typed',
    typedSignature: 'Empresa de Prueba SL',
    accept: true,
  };
}

/** Fecha de cobro dentro de `days` días (respeta el preaviso de 5 días). */
export function futureCollectionDate(days = 10): string {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
}
