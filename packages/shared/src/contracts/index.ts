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
  { key: 'startDate', label: 'Fecha de inicio', example: '15/01/2026' },
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
  /** Finalizar solo los contratos en baja el día después de su fecha de fin. */
  autoEndContracts: z.boolean().optional(),
});
export type UpdateContractTemplateInput = z.infer<typeof UpdateContractTemplateSchema>;

export interface ContractTemplateDto {
  /** Cláusulas personalizadas del tenant; null = plantilla por defecto. */
  clauses: string | null;
  /** Cláusulas de vivienda del tenant; null = base LAU (`DEFAULT_HOUSING_CLAUSES`). */
  housingClauses: string | null;
  /** Los contratos en baja se finalizan solos el día después de su fecha de fin. */
  autoEndContracts: boolean;
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
 * Condiciones generales de un trastero cuando el tenant no ha escrito las
 * suyas. Forman parte del texto que firma el inquilino (y de su huella).
 */
export const DEFAULT_STORAGE_CLAUSES = `1. Objeto. El trastero {{unitCode}} de {{facilityName}} se cede solo para guardar enseres. No se puede vivir en él, desarrollar una actividad ni cederlo o subarrendarlo a otra persona.

2. Duración y baja. El contrato empieza el {{startDate}} y se renueva cada periodo de facturación. Cualquiera de las partes puede darlo por terminado avisando con {{cancellationNoticeDays}} días de antelación, por escrito al correo electrónico del arrendador o desde el área de clientes, indicando el nombre del inquilino y el trastero.

3. Pago. Las cuotas se pagan por adelantado al inicio de cada periodo y se cobran por la forma de pago elegida. Si una cuota no se paga a su vencimiento, el arrendador podrá suspender el acceso al local y al trastero hasta que se regularice el pago y aplicar los recargos que tenga publicados. Cada recibo devuelto o pago con tarjeta rechazado podrá generar unos gastos de gestión por el importe que el arrendador tenga publicado, que no superará el coste que le supone gestionar la devolución.

4. Revisión de la cuota. La cuota podrá actualizarse una vez al año conforme a la variación del Índice de Precios al Consumo (IPC) que publique el Instituto Nacional de Estadística, o el índice que lo sustituya. El arrendador lo comunicará con al menos 30 días de antelación al cobro con la cuota nueva; si el inquilino no está de acuerdo, podrá darse de baja antes de esa fecha sin penalización.

5. Contenido. El inquilino es el único responsable de lo que guarda y declara que es su legítimo poseedor, que su procedencia es lícita y que no está embargado ni sujeto a ningún procedimiento de ejecución o reclamación. Está prohibido guardar:
- Alimentos, bebidas, piensos y cualquier producto perecedero.
- Productos químicos, tóxicos, corrosivos, inflamables o explosivos, bombonas de gas y combustibles.
- Vehículos, motores o maquinaria con combustible o con baterías que no estén desconectadas.
- Armas, municiones y explosivos.
- Objetos o sustancias prohibidos por la ley o de procedencia ilícita.
- Animales, vivos o muertos, y plantas.
- Materiales que puedan descomponerse, generar humedad, olores o plagas, o dañar el trastero, los de alrededor o los bienes de otros clientes.
- Cualquier otro objeto que razonablemente no deba guardarse en un trastero.
Los daños que cause lo guardado incumpliendo esta condición corren por cuenta del inquilino.

6. Objetos de valor. Se desaconseja guardar dinero en efectivo, joyas, obras de arte, antigüedades, documentos al portador u objetos de valor sentimental. El arrendador no responde de su valor especial o sentimental ni de los daños por caso fortuito, fuerza mayor, el paso del tiempo, la polilla o los defectos propios de los objetos; sí responde de los daños que cause por su culpa o negligencia.

7. Acceso y cierre. Los códigos o tarjetas de acceso son personales e intransferibles. El inquilino entra en el horario del local y cierra el trastero con un solo candado de su propiedad. No puede instalar otras cerraduras ni sistemas de cierre sin permiso escrito del arrendador.

8. Obras. No se pueden hacer obras ni modificaciones en el trastero. Para colocar estanterías u otros elementos fijos hace falta autorización previa por escrito.

9. Inspección y reubicación. Por seguridad, por una emergencia (fuga, olor, plaga…), por requerimiento de una autoridad o por obras en el local, el arrendador podrá abrir el trastero avisando antes al inquilino, salvo urgencia, y dejando constancia de lo que haga. Si por un motivo justificado hubiera que trasladar los enseres a otro trastero de características similares, se avisará al inquilino, que podrá hacerlo por sí mismo; si no, lo hará el arrendador sin coste para él.

10. Impago. Si el inquilino deja de pagar, el arrendador podrá resolver el contrato y requerirle por escrito que pague lo debido o retire sus enseres en un plazo no inferior a 15 días. Resuelto el contrato, podrá trasladar los enseres a otro espacio para dejar libre el trastero; el coste del traslado corre por cuenta del inquilino y el arrendador responde de los daños que cause por su culpa. Si pasadas ocho (8) semanas desde el impago el inquilino no ha pagado ni retirado sus enseres pese al requerimiento, se considerarán abandonados y el arrendador podrá disponer de ellos: lo que obtenga se aplicará a la deuda y el sobrante quedará a disposición del inquilino.

11. Fianza. La fianza de {{depositAmount}} garantiza el cumplimiento del contrato. Se devuelve al terminar, descontando los daños o las cantidades pendientes.

12. Entrega. Al terminar, el inquilino retira todos sus enseres y deja el trastero vacío, limpio y en el estado en que lo recibió.

13. Comunicaciones y datos. Las comunicaciones entre las partes se harán por escrito, al correo electrónico de cada una o desde el área de clientes. El inquilino debe mantener actualizados sus datos de contacto y de pago.

Arrendador: {{tenantName}} · Inquilino: {{customerName}} · Contrato {{contractNumber}}`;

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

// ------------------------------------------------ renta: aniversario

export const AnniversaryUpdateScopeEnum = z.enum(['housing', 'all']);

export const UpdateAnniversarySettingsSchema = z.object({
  enabled: z.boolean(),
  /** % de actualización (índice pactado). Puede ser negativo. */
  pct: z.number().min(-20).max(30),
  /** `housing` = solo viviendas; `all` = también trasteros. */
  scope: AnniversaryUpdateScopeEnum,
});
export type UpdateAnniversarySettingsInput = z.infer<typeof UpdateAnniversarySettingsSchema>;
export type AnniversarySettingsDto = UpdateAnniversarySettingsInput;

export interface AnniversaryUpdateDto {
  contractId: string;
  contractNumber: string;
  customerId: string;
  customerName: string;
  unitCode: string;
  propertyKind: 'storage' | 'housing';
  /** Fecha del aniversario (YYYY-MM-DD). */
  anniversary: string;
  currentPrice: number;
  newPrice: number;
}

export const ApplyAnniversaryUpdatesSchema = z.object({
  contractIds: z.array(z.string().uuid()).min(1).max(500),
  /** `apply` = cambia la renta; `skip` = no actualizar este año. */
  action: z.enum(['apply', 'skip']).default('apply'),
});
export type ApplyAnniversaryUpdatesInput = z.infer<typeof ApplyAnniversaryUpdatesSchema>;

export interface ApplyAnniversaryUpdatesResultDto {
  applied: number;
  skipped: number;
  failed: { contractId: string; error: string }[];
}
export * from './pre-opening';
