import { humanizeScope } from '../../automations/automations.service';
import { renderTemplate, renderText } from '../template-engine';

describe('template-engine', () => {
  const scope = { tenant: { name: 'García & Hijos' }, portal: { url: 'https://x/login?slug=a' } };

  it('el texto plano y el asunto no escapan HTML', () => {
    expect(renderText('{{tenant.name}} {{portal.url}}', scope)).toBe(
      'García & Hijos https://x/login?slug=a',
    );
  });

  it('el HTML sí escapa', () => {
    expect(renderTemplate('<p>{{tenant.name}}</p>', scope)).toBe('<p>García &amp; Hijos</p>');
  });
});

describe('humanizeScope', () => {
  it('importes y fechas legibles; el resto intacto', () => {
    const out = humanizeScope({
      contract: { priceMonthly: '45.50', startDate: '2026-10-01', number: 'C-1' },
      invoice: { total: 121, dueDate: new Date('2026-10-05T10:00:00Z'), number: 'F-1' },
      reservation: { validFrom: '2026-10-02T00:00:00.000Z' },
    }) as Record<string, Record<string, string>>;
    expect(out.contract!.priceMonthly!.replace(/\s/g, ' ')).toBe('45,50 €');
    expect(out.contract!.startDate).toBe('1 de octubre de 2026');
    expect(out.contract!.number).toBe('C-1');
    expect(out.invoice!.total!.replace(/\s/g, ' ')).toBe('121,00 €');
    expect(out.invoice!.dueDate).toBe('5 de octubre de 2026');
    expect(out.reservation!.validFrom).toBe('2 de octubre de 2026');
  });
});
