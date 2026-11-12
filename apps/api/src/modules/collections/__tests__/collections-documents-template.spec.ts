import {
  renderCustodyActHtml,
  renderDossierHtml,
  renderMonitorioHtml,
  type CaseDocData,
} from '../collections-documents-template';

const base = (over: Partial<CaseDocData> = {}): CaseDocData => ({
  issuer: {
    name: 'Trasteros García SL',
    taxId: 'B12345674',
    address: 'C/ Mayor 1, 46001 Valencia',
    managedBy: null,
  },
  customer: {
    name: 'Ana <b>Pérez</b>',
    document: 'DNI 12345678Z',
    address: 'C/ Luna 3',
    city: '46920 Mislata',
    email: 'ana@example.com',
    phone: '600000000',
  },
  unitCode: 'A-12',
  facility: { name: 'Local Centro', address: 'C/ Mayor 1', city: 'Valencia' },
  contract: { number: 'C-2026-0007', signedAt: '3 de marzo de 2026', signedBy: 'Ana Pérez' },
  invoices: [
    {
      number: 'FA/2026/00010',
      issueDate: '2026-08-01',
      dueDate: '2026-08-16',
      totalCents: 12100,
      pendingCents: 12100,
    },
    {
      number: 'FA/2026/00020',
      issueDate: '2026-09-01',
      dueDate: '2026-09-16',
      totalCents: 12100,
      pendingCents: 6050,
    },
  ],
  debtCents: 18150,
  notice: {
    sentAt: '1 de octubre de 2026',
    tracking: 'BX123',
    receivedAt: '3 de octubre de 2026',
    deadline: '18 de octubre de 2026',
  },
  today: '11 de noviembre de 2026',
  place: 'Valencia',
  ...over,
});

describe('documentos del expediente de impago', () => {
  it('acta del traslado: inventario numerado, testigos y fecha del abandono', () => {
    const html = renderCustodyActHtml({
      ...base(),
      items: ['Sofá de tres plazas', '5 cajas <frágil>'],
      witnesses: 'Luis Gómez',
      custodyLocation: 'Nave 2, Polígono Sur',
      movedAt: '20 de octubre de 2026',
      contractResolvedAt: '19 de octubre de 2026',
      abandonmentFrom: '15 de diciembre de 2026',
    });
    expect(html).toContain('Acta de traslado y custodia de bienes');
    expect(html).toContain('Sofá de tres plazas');
    expect(html).toContain('5 cajas &lt;frágil&gt;');
    expect(html).not.toContain('<frágil>');
    expect(html).toContain('Nave 2, Polígono Sur');
    expect(html).toContain('Luis Gómez');
    expect(html).toContain('15 de diciembre de 2026');
    expect(html).toContain('Ana &lt;b&gt;Pérez&lt;/b&gt;');
  });

  it('dossier: deuda, requerimiento, historial y las fotos incrustadas', () => {
    const html = renderDossierHtml({
      ...base(),
      statusLabel: 'Bienes en custodia',
      openedAt: '20 de septiembre de 2026',
      timeline: [
        {
          date: '1 de octubre de 2026',
          label: 'Requerimiento enviado',
          by: 'Jota',
          detail: 'Envío BX123',
        },
      ],
      communications: [
        {
          date: '17 de agosto de 2026',
          channel: 'Correo',
          subject: 'Factura vencida',
          status: 'Entregado',
        },
      ],
      payments: [
        {
          date: '20 de septiembre de 2026',
          invoiceNumber: 'FA/2026/00020',
          amount: 60.5,
          method: 'Efectivo',
          status: 'Cobrado',
        },
      ],
      files: [
        {
          label: 'Foto',
          date: '20 de octubre de 2026',
          imageDataUri: 'data:image/png;base64,AAAA',
        },
        { label: 'Justificante del burofax', date: '3 de octubre de 2026', imageDataUri: null },
      ],
    });
    expect(html).toContain('Dossier del expediente de impago');
    expect(html).toContain('181,50 €');
    expect(html).toContain('Envío BX123');
    expect(html).toContain('recibido el 3 de octubre de 2026');
    expect(html).toContain('<img src="data:image/png;base64,AAAA"');
    expect(html).toContain('Justificante del burofax');
    expect(html).toContain('Factura vencida');
    expect(html).toContain('60,50 €');
  });

  it('monitorio: borrador, juzgado del domicilio del deudor y la cantidad', () => {
    const html = renderMonitorioHtml(base());
    expect(html).toContain('Borrador.');
    expect(html).toContain('JUZGADO DE PRIMERA INSTANCIA DE 46920 MISLATA');
    expect(html).toContain('PETICIÓN INICIAL DE PROCEDIMIENTO MONITORIO');
    expect(html).toContain('181,50 €');
    expect(html).toContain('art. 813 LEC');
    expect(html).toContain('FA/2026/00010');
    expect(html).toContain('el requerimiento de pago enviado el 1 de octubre de 2026');
  });

  it('monitorio sin requerimiento: lo dice y no lo pone como documento', () => {
    const html = renderMonitorioHtml(
      base({ notice: { sentAt: null, tracking: null, receivedAt: null, deadline: null } }),
    );
    expect(html).toContain('Se le ha reclamado el pago sin resultado.');
    expect(html).not.toContain('Documento 3');
  });
});
