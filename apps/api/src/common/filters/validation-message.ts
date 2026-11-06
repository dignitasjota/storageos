/**
 * Texto de un error de validación para enseñárselo a quien rellena el
 * formulario: «Email: no es válido» en vez de «Validation failed». Los mensajes
 * propios de los esquemas se respetan; los que Zod trae de serie van en inglés
 * y se traducen por su código.
 */

export interface ValidationIssue {
  path: (string | number)[] | string;
  message: string;
  code?: string;
  type?: string;
  received?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
}

/** Mensajes de error genéricos de nestjs-zod y del pipe propio. */
export const GENERIC_VALIDATION_MESSAGES = new Set(['Validation failed', 'Validacion fallida']);

const FIELD_LABELS: Record<string, string> = {
  accessCurfewEnd: 'Toque de queda',
  accessCurfewStart: 'Toque de queda',
  address: 'Dirección',
  amount: 'Importe',
  basePriceMonthly: 'Precio',
  body: 'Mensaje',
  city: 'Ciudad',
  code: 'Código',
  companyName: 'Razón social',
  contactEmail: 'Email',
  contactPhone: 'Teléfono',
  country: 'País',
  defaultDepositAmount: 'Fianza',
  defaultPriceMonthly: 'Precio',
  depositAmount: 'Fianza',
  depthM: 'Fondo',
  description: 'Descripción',
  directions: 'Cómo llegar',
  documentNumber: 'Documento',
  email: 'Email',
  endDate: 'Fecha de fin',
  features: 'Características',
  firstName: 'Nombre',
  floorNumber: 'Número de planta',
  fullName: 'Nombre',
  heightM: 'Alto',
  lastName: 'Apellidos',
  latitude: 'Latitud',
  longitude: 'Longitud',
  mapsUrl: 'Enlace de Google Maps',
  message: 'Mensaje',
  name: 'Nombre',
  notes: 'Notas',
  openingExceptions: 'Días especiales',
  openingHours: 'Horario',
  password: 'Contraseña',
  phone: 'Teléfono',
  postalCode: 'Código postal',
  priceMonthly: 'Cuota',
  publicSlug: 'Dirección en tu web',
  reason: 'Motivo',
  startDate: 'Fecha de inicio',
  subject: 'Asunto',
  taxId: 'NIF',
  timezone: 'Zona horaria',
  title: 'Título',
  videoUrl: 'Vídeo',
  widthM: 'Ancho',
};

const ZOD_DEFAULT = /^(Required|Invalid|Expected|String must|Number must|Array must|Unrecognized)/;

function fieldLabel(path: ValidationIssue['path']): string | null {
  const parts = Array.isArray(path) ? path : path.split('.');
  // Del dato más concreto al más general: `openingHours.mon.close` → «Horario».
  for (const part of [...parts].reverse()) {
    const label = FIELD_LABELS[String(part)];
    if (label) return label;
  }
  return null;
}

function defaultReason(issue: ValidationIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined' || issue.received === 'null'
        ? 'es obligatorio'
        : 'no es válido';
    case 'too_small':
      if (issue.type === 'string') {
        return Number(issue.minimum) <= 1
          ? 'es obligatorio'
          : `necesita al menos ${issue.minimum} caracteres`;
      }
      return issue.type === 'array'
        ? `necesita al menos ${issue.minimum}`
        : `tiene que ser ${issue.minimum} o más`;
    case 'too_big':
      if (issue.type === 'string') return `admite como máximo ${issue.maximum} caracteres`;
      return issue.type === 'array'
        ? `admite como máximo ${issue.maximum}`
        : `tiene que ser ${issue.maximum} o menos`;
    default:
      return 'no es válido';
  }
}

export function readableValidationMessage(issues: unknown): string | null {
  if (!Array.isArray(issues)) return null;
  const issue = issues[0] as ValidationIssue | undefined;
  if (!issue || typeof issue.message !== 'string') return null;
  const label = fieldLabel(issue.path ?? []);
  if (ZOD_DEFAULT.test(issue.message)) {
    return label ? `${label}: ${defaultReason(issue)}` : 'Revisa los datos del formulario';
  }
  // «Email no válido» ya dice de qué campo habla.
  const named = !label || issue.message.toLowerCase().includes(label.toLowerCase());
  return named ? issue.message : `${label}: ${issue.message}`;
}
