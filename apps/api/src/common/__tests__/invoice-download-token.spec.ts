import {
  buildInvoiceDownloadToken,
  invoiceDownloadKey,
  invoiceDownloadUrl,
  invoiceIdFromDownloadToken,
  verifyInvoiceDownloadToken,
} from '../invoice-download-token';

const KEY = invoiceDownloadKey('0'.repeat(64));
const TENANT = '0190a8e6-0000-7000-8000-000000000001';
const OTHER_TENANT = '0190a8e6-0000-7000-8000-000000000002';
const INVOICE = '0190a8e6-0000-7000-8000-0000000000aa';

describe('Enlace firmado para descargar una factura', () => {
  it('vale para su factura y su negocio', () => {
    const token = buildInvoiceDownloadToken(KEY, TENANT, INVOICE);
    expect(invoiceIdFromDownloadToken(token)).toBe(INVOICE);
    expect(verifyInvoiceDownloadToken(KEY, token, TENANT)).toBe(true);
  });

  it('no vale para otro negocio, con otra clave ni cambiando la factura', () => {
    const token = buildInvoiceDownloadToken(KEY, TENANT, INVOICE);
    expect(verifyInvoiceDownloadToken(KEY, token, OTHER_TENANT)).toBe(false);
    expect(verifyInvoiceDownloadToken(invoiceDownloadKey('1'.repeat(64)), token, TENANT)).toBe(
      false,
    );
    const other = token.replace(INVOICE, '0190a8e6-0000-7000-8000-0000000000bb');
    expect(verifyInvoiceDownloadToken(KEY, other, TENANT)).toBe(false);
  });

  it('rechaza lo que no tiene forma de enlace', () => {
    expect(invoiceIdFromDownloadToken('nada')).toBeNull();
    expect(invoiceIdFromDownloadToken(`${INVOICE}.`)).toBeNull();
    expect(invoiceIdFromDownloadToken(`no-es-un-id.firma`)).toBeNull();
    expect(invoiceIdFromDownloadToken(`${INVOICE}.a.b`)).toBeNull();
    expect(verifyInvoiceDownloadToken(KEY, `${INVOICE}.corta`, TENANT)).toBe(false);
  });

  it('la dirección cuelga del API, bajo /v1/public/invoices', () => {
    const url = invoiceDownloadUrl('https://api.trasteros.pro/', KEY, TENANT, INVOICE);
    expect(url.startsWith(`https://api.trasteros.pro/v1/public/invoices/${INVOICE}.`)).toBe(true);
    expect(url.endsWith('/pdf')).toBe(true);
  });
});
