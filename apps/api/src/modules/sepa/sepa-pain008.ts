import { sepaId, sepaText } from '@storageos/shared';

/**
 * Generador del fichero SEPA de adeudos directos **pain.008.001.02** (esquema
 * CORE, cuaderno AEB 19.14). El operador lo descarga y lo sube a su banco.
 *
 * Agrupa las transacciones en bloques `PmtInf` por tipo de secuencia
 * (FRST/RCUR), como exige el estándar (una primera presentación de un mandato
 * va como FRST; las siguientes como RCUR).
 *
 * Cuaderno AEB 19-14: el presentador se identifica en `InitgPty/Id` con el
 * identificador del acreedor; los textos van en el juego de caracteres SEPA
 * (sin acentos ni ñ) y recortados (nombres 70, concepto 140, identificadores 35).
 */

export interface Pain008Creditor {
  name: string;
  /** Identificador del acreedor SEPA (CdtrSchmeId). */
  creditorId: string;
  iban: string;
  bic?: string | null;
}

export interface Pain008Transaction {
  endToEndId: string;
  /** Importe en céntimos enteros. */
  amountCents: number;
  mandateReference: string;
  /** Fecha de firma del mandato (YYYY-MM-DD). */
  mandateSignedDate: string;
  sequenceType: 'FRST' | 'RCUR';
  debtorName: string;
  debtorIban: string;
  debtorBic?: string | null;
  /** Texto en RmtInf/Ustrd (p.ej. número de factura). */
  remittanceInfo: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Nombre (máx. 70) en caracteres SEPA, escapado para el XML. */
function nm(s: string): string {
  return esc(sepaText(s, 70) || 'NOTPROVIDED');
}

/** Identificador (máx. 35) en caracteres SEPA, escapado para el XML. */
function id(s: string): string {
  return esc(sepaId(s));
}

function amount(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** `<FinInstnId>` con BIC si lo hay, o `NOTPROVIDED` (permitido en SEPA). */
function finInstn(bic?: string | null): string {
  return bic
    ? `<FinInstnId><BIC>${esc(bic)}</BIC></FinInstnId>`
    : `<FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId>`;
}

export function buildPain008(args: {
  messageId: string;
  creationDateTime?: Date;
  creditor: Pain008Creditor;
  /** Fecha de cobro (YYYY-MM-DD). */
  collectionDate: string;
  transactions: Pain008Transaction[];
}): string {
  const { messageId, creditor, collectionDate, transactions } = args;
  const creDtTm = (args.creationDateTime ?? new Date()).toISOString().replace(/\.\d{3}Z$/, '');
  const totalTxs = transactions.length;
  const totalCents = transactions.reduce((s, t) => s + t.amountCents, 0);

  const bySeq: Record<'FRST' | 'RCUR', Pain008Transaction[]> = { FRST: [], RCUR: [] };
  for (const t of transactions) bySeq[t.sequenceType].push(t);

  const pmtInfBlocks = (['FRST', 'RCUR'] as const)
    .filter((seq) => bySeq[seq].length > 0)
    .map((seq) => {
      const txs = bySeq[seq];
      const seqCents = txs.reduce((s, t) => s + t.amountCents, 0);
      const txBlocks = txs
        .map(
          (t) => `
      <DrctDbtTxInf>
        <PmtId><EndToEndId>${id(t.endToEndId)}</EndToEndId></PmtId>
        <InstdAmt Ccy="EUR">${amount(t.amountCents)}</InstdAmt>
        <DrctDbtTx><MndtRltdInf><MndtId>${id(t.mandateReference)}</MndtId><DtOfSgntr>${t.mandateSignedDate}</DtOfSgntr></MndtRltdInf></DrctDbtTx>
        <DbtrAgt>${finInstn(t.debtorBic)}</DbtrAgt>
        <Dbtr><Nm>${nm(t.debtorName)}</Nm></Dbtr>
        <DbtrAcct><Id><IBAN>${esc(t.debtorIban)}</IBAN></Id></DbtrAcct>
        <RmtInf><Ustrd>${esc(sepaText(t.remittanceInfo, 140))}</Ustrd></RmtInf>
      </DrctDbtTxInf>`,
        )
        .join('');
      return `
    <PmtInf>
      <PmtInfId>${esc(sepaId(`${sepaId(messageId, 30)}-${seq}`))}</PmtInfId>
      <PmtMtd>DD</PmtMtd>
      <NbOfTxs>${txs.length}</NbOfTxs>
      <CtrlSum>${amount(seqCents)}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><LclInstrm><Cd>CORE</Cd></LclInstrm><SeqTp>${seq}</SeqTp></PmtTpInf>
      <ReqdColltnDt>${collectionDate}</ReqdColltnDt>
      <Cdtr><Nm>${nm(creditor.name)}</Nm></Cdtr>
      <CdtrAcct><Id><IBAN>${esc(creditor.iban)}</IBAN></Id></CdtrAcct>
      <CdtrAgt>${finInstn(creditor.bic)}</CdtrAgt>
      <ChrgBr>SLEV</ChrgBr>
      <CdtrSchmeId><Id><PrvtId><Othr><Id>${id(creditor.creditorId)}</Id><SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id></CdtrSchmeId>${txBlocks}
    </PmtInf>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrDrctDbtInitn>
    <GrpHdr>
      <MsgId>${id(messageId)}</MsgId>
      <CreDtTm>${creDtTm}</CreDtTm>
      <NbOfTxs>${totalTxs}</NbOfTxs>
      <CtrlSum>${amount(totalCents)}</CtrlSum>
      <InitgPty><Nm>${nm(creditor.name)}</Nm><Id><OrgId><Othr><Id>${id(creditor.creditorId)}</Id></Othr></OrgId></Id></InitgPty>
    </GrpHdr>${pmtInfBlocks}
  </CstmrDrctDbtInitn>
</Document>`;
}
