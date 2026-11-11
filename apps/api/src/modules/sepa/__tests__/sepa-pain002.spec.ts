import { isRejectedStatus, parsePain002 } from '../sepa-pain002';

const PARTIAL = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.03">
  <CstmrPmtStsRpt>
    <GrpHdr><MsgId>BBVA-STS-1</MsgId><CreDtTm>2026-11-20T09:00:00</CreDtTm></GrpHdr>
    <OrgnlGrpInfAndSts>
      <OrgnlMsgId>REM-ABC123-XYZ</OrgnlMsgId>
      <OrgnlMsgNmId>pain.008.001.02</OrgnlMsgNmId>
      <GrpSts>PART</GrpSts>
    </OrgnlGrpInfAndSts>
    <OrgnlPmtInfAndSts>
      <OrgnlPmtInfId>REM-ABC123-XYZ-RCUR</OrgnlPmtInfId>
      <PmtInfSts>PART</PmtInfSts>
      <TxInfAndSts>
        <OrgnlEndToEndId>E2E-FA2026000010-AB12</OrgnlEndToEndId>
        <TxSts>RJCT</TxSts>
        <StsRsnInf>
          <Rsn><Cd>am04</Cd></Rsn>
          <AddtlInf>Saldo insuficiente &amp; sin descubierto</AddtlInf>
        </StsRsnInf>
        <OrgnlTxRef><Amt><InstdAmt Ccy="EUR">121.00</InstdAmt></Amt></OrgnlTxRef>
      </TxInfAndSts>
      <TxInfAndSts>
        <OrgnlEndToEndId>E2E-FA2026000011-CD34</OrgnlEndToEndId>
        <TxSts>ACSC</TxSts>
        <OrgnlTxRef><Amt><InstdAmt Ccy="EUR">60.50</InstdAmt></Amt></OrgnlTxRef>
      </TxInfAndSts>
    </OrgnlPmtInfAndSts>
  </CstmrPmtStsRpt>
</Document>`;

describe('respuesta del banco a una remesa (pain.002)', () => {
  it('lee el estado y el motivo de cada adeudo', () => {
    const r = parsePain002(PARTIAL)!;
    expect(r.originalMessageId).toBe('REM-ABC123-XYZ');
    expect(r.groupStatus).toBe('PART');
    expect(r.paymentInfos).toEqual([
      { id: 'REM-ABC123-XYZ-RCUR', status: 'PART', reasonCode: null },
    ]);
    expect(r.transactions).toEqual([
      {
        endToEndId: 'E2E-FA2026000010-AB12',
        status: 'RJCT',
        reasonCode: 'AM04',
        reasonText: 'Saldo insuficiente & sin descubierto',
        amountCents: 12100,
      },
      {
        endToEndId: 'E2E-FA2026000011-CD34',
        status: 'ACSC',
        reasonCode: null,
        reasonText: null,
        amountCents: 6050,
      },
    ]);
    expect(isRejectedStatus('RJCT')).toBe(true);
    expect(isRejectedStatus('ACSC')).toBe(false);
  });

  it('con prefijos de espacio de nombres y el motivo solo en el bloque', () => {
    const xml = `<n1:Document xmlns:n1="urn:iso:std:iso:20022:tech:xsd:pain.002.001.10">
      <n1:CstmrPmtStsRpt>
        <n1:OrgnlGrpInfAndSts><n1:OrgnlMsgId>REM-1</n1:OrgnlMsgId><n1:GrpSts>RJCT</n1:GrpSts>
          <n1:StsRsnInf><n1:Rsn><n1:Cd>FF01</n1:Cd></n1:Rsn></n1:StsRsnInf>
        </n1:OrgnlGrpInfAndSts>
        <n1:OrgnlPmtInfAndSts>
          <n1:OrgnlPmtInfId>REM-1-FRST</n1:OrgnlPmtInfId>
          <n1:PmtInfSts>RJCT</n1:PmtInfSts>
          <n1:StsRsnInf><n1:Rsn><n1:Cd>MD01</n1:Cd></n1:Rsn></n1:StsRsnInf>
          <n1:TxInfAndSts><n1:OrgnlEndToEndId>E2E-X</n1:OrgnlEndToEndId></n1:TxInfAndSts>
        </n1:OrgnlPmtInfAndSts>
      </n1:CstmrPmtStsRpt>
    </n1:Document>`;
    const r = parsePain002(xml)!;
    expect(r.groupStatus).toBe('RJCT');
    expect(r.groupReasonCode).toBe('FF01');
    expect(r.paymentInfos[0]).toEqual({ id: 'REM-1-FRST', status: 'RJCT', reasonCode: 'MD01' });
    // El adeudo sin estado propio toma el del bloque y su motivo.
    expect(r.transactions[0]).toEqual(
      expect.objectContaining({ endToEndId: 'E2E-X', status: 'RJCT', reasonCode: 'MD01' }),
    );
  });

  it('otro fichero no es una respuesta del banco', () => {
    expect(parsePain002('<Document><CstmrDrctDbtInitn/></Document>')).toBeNull();
    expect(parsePain002('11NORMA43')).toBeNull();
  });
});
