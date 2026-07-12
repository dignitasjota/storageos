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
});
export type UpdateContractTemplateInput = z.infer<typeof UpdateContractTemplateSchema>;

export interface ContractTemplateDto {
  /** Cláusulas personalizadas del tenant; null = plantilla por defecto. */
  clauses: string | null;
}
