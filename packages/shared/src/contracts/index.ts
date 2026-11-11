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
  {
    key: 'moveOutRule',
    label: 'Cuándo surte efecto la baja',
    example:
      'La baja surte efecto el último día del mes en que se cumple ese plazo, y ese mes se paga completo.',
  },
  { key: 'depositReturnDays', label: 'Días para devolver la fianza', example: '15' },
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
  /** La baja surte efecto a final de mes (false = el día que elija el inquilino). */
  moveOutEndOfMonth: z.boolean().optional(),
  /** Días máximos para devolver la fianza desde la entrega del trastero. */
  depositReturnDays: z.number().int().min(1).max(60).optional(),
  /** Gastos por recibo devuelto o pago rechazado (sin IVA); null o 0 = ninguno. */
  returnedPaymentFee: z.number().min(0).max(100).nullable().optional(),
});
export type UpdateContractTemplateInput = z.infer<typeof UpdateContractTemplateSchema>;

export interface ContractTemplateDto {
  /** Cláusulas personalizadas del tenant; null = plantilla por defecto. */
  clauses: string | null;
  /** Cláusulas de vivienda del tenant; null = base LAU (`DEFAULT_HOUSING_CLAUSES`). */
  housingClauses: string | null;
  /** Los contratos en baja se finalizan solos el día después de su fecha de fin. */
  autoEndContracts: boolean;
  /** La baja surte efecto el último día del mes en que se cumple el preaviso. */
  moveOutEndOfMonth: boolean;
  /** Días máximos para devolver la fianza desde la entrega del trastero. */
  depositReturnDays: number;
  /** Gastos por recibo devuelto o pago rechazado (sin IVA); null = ninguno. */
  returnedPaymentFee: number | null;
}

// ------------------------------------------------ baja

function parseYmd(ymd: string): Date {
  return new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Último día del mes de una fecha (`YYYY-MM-DD`). */
export function monthEndOf(ymd: string): string {
  const d = parseYmd(ymd);
  return toYmd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

/** Primer día en que puede terminar una baja pedida hoy (`YYYY-MM-DD`). */
export function earliestMoveOutDate(args: {
  today: string;
  noticeDays: number;
  endOfMonth: boolean;
}): string {
  const d = parseYmd(args.today);
  d.setUTCDate(d.getUTCDate() + args.noticeDays);
  return args.endOfMonth ? monthEndOf(toYmd(d)) : toYmd(d);
}

/** Día en que termina de verdad una baja pedida para `requested`. */
export function effectiveMoveOutDate(requested: string, endOfMonth: boolean): string {
  return endOfMonth ? monthEndOf(requested) : requested.slice(0, 10);
}

/** Los `count` finales de mes a partir del de `from` (para elegir la fecha de baja). */
export function monthEndsFrom(from: string, count: number): string[] {
  const d = parseYmd(from);
  return Array.from({ length: count }, (_, i) =>
    toYmd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i + 1, 0))),
  );
}

/** Frase de la condición de baja según cómo la tenga el negocio. */
export function moveOutRuleText(endOfMonth: boolean): string {
  return endOfMonth
    ? 'La baja surte efecto el último día del mes en que se cumple ese plazo, y ese mes se paga completo.'
    : 'La baja surte efecto el día que indique el inquilino, respetando ese plazo; el último mes se paga hasta ese día y lo ya pagado del mes en curso no se devuelve.';
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
export const DEFAULT_STORAGE_CLAUSES = `1. Objeto. El trastero {{unitCode}} de {{facilityName}} se cede solo para guardar enseres. No se puede vivir en él, desarrollar en él una actividad profesional, comercial o industrial, ni cederlo o subarrendarlo a otra persona. Es un alquiler de espacio: el inquilino cierra el trastero con su propio candado y el arrendador no recibe en depósito ni custodia lo que guarda.

2. Duración y baja. El contrato empieza el {{startDate}} y se renueva en cada periodo de facturación. El inquilino puede darse de baja cuando quiera, avisando por escrito (al correo electrónico del arrendador o desde el área de clientes) con al menos {{cancellationNoticeDays}} días de antelación. {{moveOutRule}} Dejar el trastero vacío antes no adelanta la baja ni reduce lo que hay que pagar. Si pagó varios meses por adelantado y se da de baja antes de usarlos todos, se le devuelven los meses enteros que no llegue a usar (un mes empezado cuenta como usado); los meses usados se cobran a la cuota mensual del contrato, sin el descuento ni los meses gratis que tuviera ese pago. El arrendador también puede terminar el contrato avisando por escrito con al menos un mes de antelación, además de en los casos de impago de la condición 12. Todo ello sin perjuicio del derecho de desistimiento que la ley reconozca al inquilino.

3. Precio y pago. La cuota, el IVA y las demás cantidades del contrato figuran en sus datos, al principio de este documento. Las cuotas se pagan por adelantado al principio de cada periodo de facturación, por la forma de pago que elija el inquilino entre las que ofrece el arrendador. Si el inquilino guarda una tarjeta o domicilia los pagos en su cuenta, autoriza al arrendador a cobrar en ella cada cuota y las demás cantidades de este contrato cuando venzan; puede cambiar la tarjeta o la cuenta, o pasar a pagar por otro medio, desde el área de clientes. Por un pago atrasado, devuelto o rechazado solo se aplicarán el recargo y los gastos que figuran en los datos del contrato; los gastos no superarán el coste que le supone al arrendador gestionarlo.

4. Revisión de la cuota. La cuota podrá actualizarse una vez al año conforme a la variación del Índice de Precios al Consumo (IPC) que publique el Instituto Nacional de Estadística, o el índice que lo sustituya. El arrendador lo comunicará con al menos 30 días de antelación al cobro con la cuota nueva; si el inquilino no está de acuerdo, podrá darse de baja antes de esa fecha, sin preaviso ni penalización.

5. Contenido. El inquilino es el único responsable de lo que guarda y declara que es su legítimo poseedor, que su procedencia es lícita y que no está embargado ni sujeto a ningún procedimiento de ejecución o reclamación. Está prohibido guardar:
- Alimentos, bebidas, piensos y cualquier producto perecedero.
- Productos químicos, tóxicos, corrosivos, inflamables o explosivos, bombonas de gas y combustibles.
- Vehículos, motores y maquinaria con combustible o con la batería conectada.
- Baterías de litio dañadas, hinchadas o manipuladas.
- Armas, municiones y explosivos.
- Objetos o sustancias prohibidos por la ley o de procedencia ilícita.
- Animales, vivos o muertos, y plantas.
- Basura, residuos y materiales que puedan descomponerse, generar humedad, olores o plagas, o dañar el trastero, los de alrededor o los bienes de otros clientes.
Tampoco se puede:
- Cargar baterías ni enchufar o hacer funcionar aparatos eléctricos en el trastero.
- Hacer en él nada que produzca calor, llama o humo.
- Superar la carga máxima indicada en el trastero o en el módulo, ni colgar o apoyar peso en sus paredes, puertas o estructura; en los módulos apilados hay que respetar la carga indicada para cada uno.
- Dejar objetos fuera del trastero ni ocupar pasillos, salidas de emergencia o el acceso a los extintores y demás medios contra incendios.
Los daños que causen lo guardado o el uso del trastero incumpliendo esta condición corren por cuenta del inquilino.

6. Seguro y responsabilidad. El arrendador no asegura los bienes que guarda el inquilino, salvo que figure en los datos del contrato una protección de contenido, que cubre lo que indique su plan y con sus límites. Se recomienda al inquilino asegurarlos por su cuenta (muchas pólizas de hogar los cubren fuera de la vivienda). El arrendador responde, conforme a la ley, de los daños que causen su culpa o negligencia o las de su personal; no responde de los debidos a caso fortuito o fuerza mayor, al paso del tiempo o a los defectos propios de los objetos, ni de un valor especial o sentimental que no se le haya comunicado. Se desaconseja guardar dinero en efectivo, joyas, obras de arte, antigüedades, documentos al portador u objetos de valor sentimental. El inquilino debe comunicar por escrito cualquier daño, robo o pérdida en cuanto lo descubra y, si es un robo, denunciarlo.

7. Acceso y cierre. El inquilino entra en el horario de acceso que figura en los datos del contrato. Los códigos, tarjetas y demás medios de acceso son personales e intransferibles: el inquilino responde de las personas a las que dé acceso (acompañantes, transportistas o personas autorizadas), que deben cumplir estas condiciones. Cierra el trastero con un solo candado de su propiedad y no puede instalar otras cerraduras ni sistemas de cierre sin permiso escrito del arrendador.

8. Averías e incidencias. El inquilino debe comunicar al arrendador cuanto antes cualquier avería, desperfecto o incidencia, también la pérdida o el mal uso de sus medios de acceso, por teléfono, por correo o desde el área de clientes. Si el sistema de acceso falla y no puede entrar, el arrendador le atenderá lo antes posible y le dará otra forma de acceder. El acceso puede interrumpirse temporalmente por mantenimiento, averías, emergencias o causas ajenas al arrendador; se avisará con antelación cuando sea posible y se procurará que las molestias sean las mínimas.

9. Obras. No se pueden hacer obras ni modificaciones en el trastero. Para colocar estanterías u otros elementos fijos hace falta autorización previa por escrito.

10. Normas del local. En el local no se puede fumar, dejar basura ni objetos en las zonas comunes, ni manipular las cámaras, la instalación eléctrica, los equipos de acceso o los medios contra incendios. Los carros y demás medios del local se usan con cuidado y se dejan en su sitio. El inquilino respetará también las normas de seguridad y convivencia que el arrendador publique en el local.

11. Apertura y traslado del trastero. El arrendador solo abrirá el trastero por una emergencia (fuga, incendio, olor, plaga…), por requerimiento de una autoridad, por obras imprescindibles en el local o en los casos de impago de la condición 12. Salvo urgencia o requerimiento legal, avisará antes al inquilino del motivo, y el inquilino podrá estar presente. Si lo abre sin él, levantará acta con la fecha, el motivo, las personas que intervienen y lo que se haga, con fotografías, y se la enviará. Si por un motivo justificado hubiera que trasladar los enseres a otro trastero de características equivalentes, se avisará al inquilino con antelación, salvo urgencia, para que pueda hacerlo él; si no, lo hará el arrendador, sin coste para él y con el cuidado debido.

12. Impago. Si una cuota no se paga a su vencimiento, el arrendador avisará al inquilino para que la pague. Si sigue sin pagarse, podrá suspender sus entradas al local hasta que lo regularice; aun así, el inquilino podrá pedir cita para retirar sus pertenencias y el arrendador le facilitará el acceso para hacerlo. Si el impago continúa, el arrendador le requerirá por escrito, por un medio que deje constancia, que pague lo debido en un plazo no inferior a 15 días, advirtiéndole de que, si no lo hace, el contrato quedará resuelto. Resuelto el contrato, el inquilino deberá retirar sus bienes y dejar libre el trastero en el plazo que se le indique. Si no lo hace, el arrendador podrá trasladar los bienes a otro espacio para guardarlos, con inventario y fotografías; el inquilino podrá recuperarlos cuando lo pida, y se le reclamarán la deuda y los gastos razonables y justificados del traslado y la custodia. El arrendador solo venderá, destruirá o dispondrá de otro modo de los bienes por los cauces que permita la ley, aplicando lo que obtenga a la deuda y dejando el sobrante a disposición del inquilino.

13. Fianza. La fianza de {{depositAmount}} garantiza el cumplimiento del contrato y no es una cuota pagada por adelantado. Se devuelve en un plazo máximo de {{depositReturnDays}} días desde que el inquilino entrega el trastero vacío, descontando, con su detalle y su justificación, los daños o las cantidades pendientes.

14. Entrega. Al terminar, el inquilino retira todos sus enseres y su candado y deja el trastero vacío, limpio y en el estado en que lo recibió, salvo el desgaste normal. Si quedan bienes, el arrendador se lo comunicará y le dará un plazo para retirarlos; pasado ese plazo, podrá trasladarlos y guardarlos como prevé la condición 12.

15. Promociones. Las promociones, los descuentos y los cupones aplicados figuran en los datos del contrato. No obligan a una permanencia mínima; si el inquilino se da de baja antes de terminar un periodo pagado por adelantado, se aplica lo previsto en la condición 2.

16. Videovigilancia, accesos y datos personales. El local puede contar con cámaras de videovigilancia, señalizadas con carteles, y con un control de accesos que registra cada entrada y salida, para proteger a las personas, los bienes y las instalaciones. Las imágenes se conservan como máximo un mes, salvo que deban guardarse para acreditar hechos ante una autoridad. Los datos del inquilino se usan para gestionar este contrato, los cobros y el acceso; la información completa sobre su tratamiento y sobre cómo ejercer sus derechos está en la política de privacidad del arrendador, publicada en su web.

17. Comunicaciones. Las comunicaciones entre las partes se harán por escrito, al correo electrónico de cada una o desde el área de clientes; las que deban dejar constancia, como el requerimiento por impago, por un medio que la acredite. El inquilino debe mantener actualizados sus datos de contacto y de pago.

18. Contratación electrónica. El contrato se acepta y se firma por medios electrónicos. Se guardan el texto firmado, su huella digital y la fecha y la hora de la firma, y el inquilino puede descargar una copia en cualquier momento desde el área de clientes.

19. Desistimiento. Si el inquilino es un consumidor y ha contratado a distancia (por internet o con un enlace, sin estar en el local), puede desistir del contrato en los 14 días naturales siguientes a la firma, sin dar explicaciones: desde el área de clientes, con el formulario que figura al final o con cualquier otro escrito. Se le devuelve lo pagado, también la fianza, en un plazo máximo de 14 días y por el mismo medio de pago. Si pidió empezar a usar el trastero antes de que acabara ese plazo, se le descuenta la parte proporcional de los días que lo haya tenido.

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
export * from './withdrawal';
