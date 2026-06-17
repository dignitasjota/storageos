interface ContractTermsInput {
  contractNumber: string;
  customerName: string;
  unitCode: string;
  facilityName: string;
  priceMonthly: number;
  depositAmount: number;
  billingCycle: string;
  startDate: string;
}

const CYCLE_LABEL: Record<string, string> = {
  monthly: 'mensual',
  weekly: 'semanal',
  daily: 'diario',
};

/**
 * Texto legible de los términos del contrato que se muestra al firmar y cuya
 * huella SHA-256 se guarda como prueba de qué se firmó. Determinista: el mismo
 * contrato produce siempre el mismo texto (y por tanto el mismo hash).
 */
export function buildContractTermsText(t: ContractTermsInput): string {
  const cycle = CYCLE_LABEL[t.billingCycle] ?? t.billingCycle;
  return [
    `Contrato de alquiler de trastero ${t.contractNumber}`,
    `Inquilino: ${t.customerName}`,
    `Trastero: ${t.unitCode} — ${t.facilityName}`,
    `Cuota ${cycle}: ${t.priceMonthly.toFixed(2)} €`,
    `Fianza: ${t.depositAmount.toFixed(2)} €`,
    `Inicio: ${t.startDate}`,
    '',
    'El firmante declara haber leído y aceptado las condiciones del contrato de',
    'arrendamiento del trastero indicado, reconociendo esta firma electrónica como',
    'expresión de su consentimiento (firma electrónica simple, art. 25 Reglamento',
    'eIDAS y Ley 6/2020).',
  ].join('\n');
}
