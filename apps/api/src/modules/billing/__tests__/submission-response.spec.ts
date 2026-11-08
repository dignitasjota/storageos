import { parseSubmissionResponse } from '../aeat-client/submission-response';

/**
 * La respuesta de la AEAT a un envío de varios registros: el estado del envío,
 * el CSV, la espera que pide y una línea por registro.
 */
const A = { invoiceId: 'inv-a', invoiceNumber: 'FA/2026/00001', issueDate: '07-11-2026' };
const B = { invoiceId: 'inv-b', invoiceNumber: 'FA/2026/00002', issueDate: '08-11-2026' };

function line(args: {
  number: string;
  date: string;
  estado: string;
  ref?: string;
  code?: string;
  desc?: string;
  duplicate?: string;
}): string {
  return `<tikR:RespuestaLinea>
  <tikR:IDFactura>
    <tik:IDEmisorFactura>B12345674</tik:IDEmisorFactura>
    <tik:NumSerieFactura>${args.number}</tik:NumSerieFactura>
    <tik:FechaExpedicionFactura>${args.date}</tik:FechaExpedicionFactura>
  </tikR:IDFactura>
  <tikR:Operacion><tik:TipoOperacion>Alta</tik:TipoOperacion></tikR:Operacion>
  ${args.ref ? `<tikR:RefExterna>${args.ref}</tikR:RefExterna>` : ''}
  <tikR:EstadoRegistro>${args.estado}</tikR:EstadoRegistro>
  ${args.code ? `<tikR:CodigoErrorRegistro>${args.code}</tikR:CodigoErrorRegistro>` : ''}
  ${args.desc ? `<tikR:DescripcionErrorRegistro>${args.desc}</tikR:DescripcionErrorRegistro>` : ''}
  ${
    args.duplicate
      ? `<tikR:RegistroDuplicado>
    <tik:IdPeticionRegistroDuplicado>202611080001</tik:IdPeticionRegistroDuplicado>
    <tik:EstadoRegistroDuplicado>${args.duplicate}</tik:EstadoRegistroDuplicado>
  </tikR:RegistroDuplicado>`
      : ''
  }
</tikR:RespuestaLinea>`;
}

function response(args: { estado: string; lines: string[]; csv?: string; wait?: string }) {
  return {
    status: 200,
    body: `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body>
<tikR:RespuestaRegFactuSistemaFacturacion>
  ${args.csv ? `<tikR:CSV>${args.csv}</tikR:CSV>` : ''}
  <tikR:Cabecera><tik:ObligadoEmision><tik:NombreRazon>Demo</tik:NombreRazon><tik:NIF>B12345674</tik:NIF></tik:ObligadoEmision></tikR:Cabecera>
  ${args.wait !== undefined ? `<tikR:TiempoEsperaEnvio>${args.wait}</tikR:TiempoEsperaEnvio>` : ''}
  <tikR:EstadoEnvio>${args.estado}</tikR:EstadoEnvio>
  ${args.lines.join('\n')}
</tikR:RespuestaRegFactuSistemaFacturacion></env:Body></env:Envelope>`,
  };
}

describe('parseSubmissionResponse', () => {
  it('envío correcto: cada registro aceptado con el CSV del envío y la espera pedida', () => {
    const res = parseSubmissionResponse(
      response({
        estado: 'Correcto',
        csv: 'A-CSV',
        wait: '60',
        lines: [
          line({
            number: A.invoiceNumber,
            date: A.issueDate,
            ref: A.invoiceId,
            estado: 'Correcto',
          }),
          line({
            number: B.invoiceNumber,
            date: B.issueDate,
            ref: B.invoiceId,
            estado: 'Correcto',
          }),
        ],
      }),
      [A, B],
    );
    expect(res.outcome).toBe('sent');
    expect(res.status).toBe('accepted');
    expect(res.csv).toBe('A-CSV');
    expect(res.waitSeconds).toBe(60);
    expect(res.results['inv-a']).toMatchObject({ status: 'accepted', csv: 'A-CSV' });
    expect(res.results['inv-b']).toMatchObject({ status: 'accepted', csv: 'A-CSV' });
  });

  it('parcialmente correcto: el rechazado lleva su código y su motivo', () => {
    const res = parseSubmissionResponse(
      response({
        estado: 'ParcialmenteCorrecto',
        csv: 'P-CSV',
        wait: '120',
        lines: [
          line({
            number: A.invoiceNumber,
            date: A.issueDate,
            ref: A.invoiceId,
            estado: 'Correcto',
          }),
          line({
            number: B.invoiceNumber,
            date: B.issueDate,
            ref: B.invoiceId,
            estado: 'Incorrecto',
            code: '1105',
            desc: 'NIF &amp; nombre no identificados',
          }),
        ],
      }),
      [A, B],
    );
    expect(res.status).toBe('partially_accepted');
    expect(res.waitSeconds).toBe(120);
    expect(res.results['inv-a']?.status).toBe('accepted');
    expect(res.results['inv-b']).toMatchObject({
      status: 'rejected',
      message: '[1105] NIF & nombre no identificados',
    });
  });

  it('sin RefExterna casa la línea por número y fecha', () => {
    const res = parseSubmissionResponse(
      response({
        estado: 'ParcialmenteCorrecto',
        csv: 'X',
        lines: [
          line({ number: B.invoiceNumber, date: B.issueDate, estado: 'Incorrecto', code: '1100' }),
          line({ number: A.invoiceNumber, date: A.issueDate, estado: 'AceptadoConErrores' }),
        ],
      }),
      [A, B],
    );
    expect(res.results['inv-a']?.status).toBe('accepted_with_warnings');
    expect(res.results['inv-b']?.status).toBe('rejected');
  });

  it('un duplicado cuenta lo que la AEAT tiene guardado', () => {
    const res = parseSubmissionResponse(
      response({
        estado: 'Incorrecto',
        lines: [
          line({
            number: A.invoiceNumber,
            date: A.issueDate,
            ref: A.invoiceId,
            estado: 'Incorrecto',
            code: '3000',
            desc: 'Registro de facturación duplicado.',
            duplicate: 'Correcta',
          }),
          line({
            number: B.invoiceNumber,
            date: B.issueDate,
            ref: B.invoiceId,
            estado: 'Incorrecto',
            code: '3000',
            duplicate: 'Anulada',
          }),
        ],
      }),
      [A, B],
    );
    expect(res.results['inv-a']).toMatchObject({
      status: 'accepted',
      message: 'duplicate_already_registered',
    });
    expect(res.results['inv-b']?.status).toBe('rejected');
  });

  it('un registro sin su línea: aceptado si el envío fue correcto; si no, se repite', () => {
    const ok = parseSubmissionResponse(response({ estado: 'Correcto', csv: 'C', lines: [] }), [A]);
    expect(ok.results['inv-a']).toMatchObject({ status: 'accepted', csv: 'C' });

    const unknown = parseSubmissionResponse(response({ estado: 'Incorrecto', lines: [] }), [A]);
    expect(unknown.results['inv-a']).toEqual({ status: 'error', message: 'aeat_line_missing' });
  });

  it('sin TiempoEsperaEnvio válido se esperan 60 segundos', () => {
    const res = parseSubmissionResponse(response({ estado: 'Correcto', wait: 'xx', lines: [] }), [
      A,
    ]);
    expect(res.waitSeconds).toBe(60);
  });

  it('un SoapFault es un envío que no se procesó: se repite, nada se rechaza', () => {
    const res = parseSubmissionResponse(
      {
        status: 500,
        body: `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><env:Fault>
  <faultcode>env:Client</faultcode>
  <faultstring>Codigo[4102].El XML no cumple el esquema.</faultstring>
</env:Fault></env:Body></env:Envelope>`,
      },
      [A, B],
    );
    expect(res.outcome).toBe('failed');
    expect(res.message).toContain('4102');
    expect(res.results['inv-a']?.status).toBe('error');
    expect(res.results['inv-b']?.status).toBe('error');
  });

  it('error del servidor o respuesta que no se entiende: se repite', () => {
    expect(parseSubmissionResponse({ status: 503, body: '<html/>' }, [A]).outcome).toBe('failed');
    const odd = parseSubmissionResponse({ status: 200, body: '<x>nada</x>' }, [A]);
    expect(odd).toMatchObject({ outcome: 'failed', message: 'unrecognized_aeat_response' });
  });
});
