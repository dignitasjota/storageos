import { buildReminderSummary, remindersOfInvoice } from '../reminder-summary';

const today = new Date('2026-11-10T00:00:00Z');
/** Intl separa el importe y el € con un espacio duro. */
const plain = (s: string): string => s.replace(/\u00a0/g, ' ');

describe('Recordatorio de varias facturas en un correo', () => {
  it('lista cada factura con lo que falta y suma el total', () => {
    const built = buildReminderSummary({
      tenantName: 'Trasteros García',
      customerName: 'Ana',
      locale: 'es',
      invoices: [
        { number: 'FA/2026/00001', pending: 60.5, dueDate: new Date('2026-11-01T00:00:00Z') },
        { number: 'FA/2026/00002', pending: 30.25, dueDate: new Date('2026-11-20T00:00:00Z') },
      ],
      portalUrl: 'https://garcia.test/portal/login',
      today,
    });
    const subject = built.subject;
    const text = plain(built.text);
    expect(subject).toBe('Tienes 2 facturas pendientes de pago');
    expect(text).toContain('Hola Ana,');
    expect(text).toContain('por un total de 90,75 €');
    expect(text).toContain('· FA/2026/00001: 60,50 € (venció el 1 de noviembre de 2026)');
    expect(text).toContain('· FA/2026/00002: 30,25 € (vence el 20 de noviembre de 2026)');
    expect(text).toContain('https://garcia.test/portal/login');
    expect(text).toContain('Si ya las has pagado');
    expect(text.endsWith('Un saludo,\nTrasteros García')).toBe(true);
  });

  it('el último aviso lo dice y avisa del corte del acceso; en inglés también', () => {
    const built = buildReminderSummary({
      tenantName: 'Garcia Storage',
      customerName: '',
      locale: 'en',
      invoices: [
        { number: 'A1', pending: 10, dueDate: null },
        { number: 'A2', pending: 20, dueDate: null },
      ],
      portalUrl: 'https://x.test',
      final: true,
      today,
    });
    const subject = built.subject;
    const text = plain(built.text);
    expect(subject).toBe('Final notice: 2 invoices pending payment');
    expect(text.startsWith('Hello,')).toBe(true);
    expect(text).toContain('€30.00');
    expect(text).toContain('access to your storage unit may be suspended');
  });

  it('busca los recordatorios propios y los resúmenes que incluyen la factura', () => {
    const where = remindersOfInvoice('inv-1');
    expect(where.status).toEqual({ notIn: ['failed', 'skipped'] });
    expect(where.OR).toHaveLength(2);
  });
});
