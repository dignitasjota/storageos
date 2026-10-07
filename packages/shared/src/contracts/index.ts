import { z } from 'zod';

/**
 * Variables permitidas en las cláusulas del contrato editables por el tenant.
 * Se sustituyen con `{{clave}}` al renderizar (firma + PDF). Whitelist estricta:
 * cualquier otra `{{...}}` se deja literal para que el operador vea el error.
 */
export const CONTRACT_TEMPLATE_VARIABLES = [
  { key: 'contractNumber', label: 'Nº de contrato', example: 'C-2026-0001' },
  { key: 'customerName', label: 'Nombre del inquilino', example: 'Ana Ruiz' },
  { key: 'unitCode', label: 'Código del trastero', example: 'A-12' },
  { key: 'facilityName', label: 'Local', example: 'Trasteros Centro' },
  { key: 'priceMonthly', label: 'Cuota mensual (€)', example: '75,00 €' },
  { key: 'depositAmount', label: 'Fianza (€)', example: '150,00 €' },
  { key: 'startDate', label: 'Fecha de inicio', example: '2026-01-15' },
  { key: 'cancellationNoticeDays', label: 'Preaviso de baja (días)', example: '15' },
  { key: 'tenantName', label: 'Nombre de la empresa', example: 'Mi Self-Storage SL' },
] as const;

export type ContractTemplateVariableKey = (typeof CONTRACT_TEMPLATE_VARIABLES)[number]['key'];

const ALLOWED_KEYS = new Set(CONTRACT_TEMPLATE_VARIABLES.map((v) => v.key));

/**
 * Renderiza una plantilla de cláusulas sustituyendo `{{clave}}` (con espacios
 * opcionales) por su valor SOLO si la clave está en la whitelist. Función pura y
 * determinista (mismo input → mismo texto), reutilizada en backend (firma/PDF) y
 * en el preview del frontend. Las claves desconocidas se dejan tal cual.
 */
export function renderContractClauses(
  template: string,
  vars: Partial<Record<ContractTemplateVariableKey, string>>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, rawKey: string) => {
    if (!ALLOWED_KEYS.has(rawKey as ContractTemplateVariableKey)) return match;
    return vars[rawKey as ContractTemplateVariableKey] ?? '';
  });
}

export const UpdateContractTemplateSchema = z.object({
  /** Cláusulas particulares (texto/Markdown con variables). '' = volver a la plantilla por defecto. */
  clauses: z.string().max(20000).optional().or(z.literal('')),
  /** Cláusulas de vivienda (extra «Viviendas»). '' = volver a la base LAU. */
  housingClauses: z.string().max(20000).optional().or(z.literal('')),
});
export type UpdateContractTemplateInput = z.infer<typeof UpdateContractTemplateSchema>;

export interface ContractTemplateDto {
  /** Cláusulas personalizadas del tenant; null = plantilla por defecto. */
  clauses: string | null;
  /** Cláusulas de vivienda del tenant; null = base LAU (`DEFAULT_HOUSING_CLAUSES`). */
  housingClauses: string | null;
}

/**
 * Cláusulas base de un contrato de arrendamiento de vivienda (Ley 29/1994 de
 * Arrendamientos Urbanos). Punto de partida orientativo: cada propietario debe
 * revisarlas con su asesor y adaptarlas (p. ej. plazos de prórroga, gastos).
 */
export const DEFAULT_HOUSING_CLAUSES = `PRIMERA. Objeto. El arrendador cede al arrendatario el uso de la vivienda {{unitCode}} ({{facilityName}}) como vivienda habitual y permanente del arrendatario y de su familia, sin que pueda destinarla a otro uso.

SEGUNDA. Duración. El contrato empieza el {{startDate}}. Llegado su vencimiento, se prorrogará por plazos anuales hasta los mínimos del artículo 9 de la LAU, salvo que el arrendatario comunique con treinta días de antelación su voluntad de no renovarlo.

TERCERA. Desistimiento. Transcurridos seis meses, el arrendatario podrá desistir del contrato avisando con al menos treinta días de antelación (artículo 11 de la LAU).

CUARTA. Renta. La renta es de {{priceMonthly}} al mes, que el arrendatario pagará dentro de los siete primeros días de cada mes por el medio acordado. El alquiler de vivienda está exento de IVA (artículo 20.Uno.23.º de la Ley del IVA).

QUINTA. Actualización. La renta se actualizará cada año, en la fecha en que se cumpla cada año de vigencia, conforme al índice o porcentaje pactado y con los límites legales vigentes.

SEXTA. Fianza. El arrendatario entrega en este acto {{depositAmount}} en concepto de fianza legal (artículo 36 de la LAU), que el arrendador depositará en el organismo competente de la comunidad autónoma. Se devolverá al terminar el contrato, descontando, en su caso, los daños o cantidades pendientes.

SÉPTIMA. Gastos y suministros. Los suministros con contador individual (agua, luz, gas, telecomunicaciones) corren por cuenta del arrendatario.

OCTAVA. Conservación y obras. El arrendador realizará las reparaciones necesarias para conservar la vivienda en condiciones de habitabilidad; las pequeñas reparaciones por el desgaste del uso ordinario corren a cargo del arrendatario. El arrendatario no podrá hacer obras sin el consentimiento escrito del arrendador.

NOVENA. Cesión y subarriendo. El arrendatario no podrá ceder el contrato ni subarrendar la vivienda, total o parcialmente, sin el consentimiento escrito del arrendador.

DÉCIMA. Entrega. Al terminar el contrato, el arrendatario devolverá la vivienda y las llaves en el mismo estado en que la recibió, salvo el desgaste normal por el uso.

UNDÉCIMA. Legislación. En lo no previsto se aplicará la Ley 29/1994, de 24 de noviembre, de Arrendamientos Urbanos, y supletoriamente el Código Civil.

Arrendador: {{tenantName}} · Arrendatario: {{customerName}} · Contrato {{contractNumber}}`;

/**
 * Plantilla de cláusulas que corresponde a un contrato. Una vivienda usa
 * SIEMPRE su plantilla de vivienda (la del tenant o, si no la tiene, la base
 * LAU), nunca las condiciones de trastero. Un trastero usa la del tenant o
 * `null` (= condiciones estándar de trastero).
 */
export function contractClausesTemplate(args: {
  propertyKind: string | null | undefined;
  clauses: string | null | undefined;
  housingClauses: string | null | undefined;
}): string | null {
  if (args.propertyKind === 'housing') {
    return args.housingClauses?.trim() ? args.housingClauses : DEFAULT_HOUSING_CLAUSES;
  }
  return args.clauses?.trim() ? args.clauses : null;
}
