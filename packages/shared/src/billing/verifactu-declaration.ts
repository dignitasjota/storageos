import { VERIFACTU_SYSTEM } from './verifactu';

/**
 * Declaración responsable del sistema informático de facturación (art. 13 del
 * RD 1007/2023 y art. 15 de la Orden HAC/1177/2024). La firma el productor, una
 * por cada versión del sistema, y tiene que poder leerse dentro del propio
 * sistema y entregarse al cliente.
 */
export const VERIFACTU_DECLARATION_TITLE =
  'DECLARACIÓN RESPONSABLE DEL SISTEMA INFORMÁTICO DE FACTURACIÓN';

/** Datos de contacto del productor (letra j y contenido recomendado del apdo. 2). */
export const VERIFACTU_PRODUCER = {
  name: VERIFACTU_SYSTEM.producerName,
  taxId: VERIFACTU_SYSTEM.producerTaxId,
  address: 'C/ Regatxo, 10, 46920 Mislata (Valencia), España',
  email: 'info@trasteros.pro',
  web: 'https://trasteros.pro',
} as const;

/** Cuándo y dónde se firmó la declaración de una versión del sistema. */
export interface VerifactuDeclarationSignature {
  version: string;
  /** AAAA-MM-DD: el día en que se publica esa versión. */
  signedOn: string;
  place: string;
  country: string;
}

/** Una por versión, la más reciente al final. La de la versión en uso es la vigente. */
export const VERIFACTU_DECLARATIONS: readonly VerifactuDeclarationSignature[] = [
  { version: '1.0', signedOn: '2026-11-11', place: 'Mislata', country: 'España' },
];

export interface VerifactuDeclarationItem {
  /** Letra del apartado 1 del art. 15 (o `extra` para el contenido recomendado). */
  key: string;
  label: string;
  /** Los párrafos van separados por una línea en blanco. */
  value: string;
}

export interface VerifactuDeclarationDto {
  title: string;
  version: string;
  signedOn: string;
  /** La de la versión que está en uso. */
  current: boolean;
  items: VerifactuDeclarationItem[];
  /** Otras formas de contacto (contenido recomendado). */
  contact: VerifactuDeclarationItem[];
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** «11 de noviembre de 2026» (sin depender de la configuración regional). */
export function verifactuDeclarationDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${d} de ${MONTHS[(m ?? 1) - 1]} de ${y}`;
}

const COMPONENTS = [
  'TrasterOS es una aplicación en la nube (software como servicio).',
  'Software: la aplicación web TrasterOS, a la que se accede con un navegador (el panel de gestión del negocio y el área de clientes de sus inquilinos), y el servidor de aplicaciones que emite las facturas, genera sus registros de facturación y los remite a la Agencia Estatal de Administración Tributaria. Las facturas y sus registros se conservan en una base de datos PostgreSQL y los PDF de las facturas en un almacenamiento de ficheros.',
  'Hardware: los servidores del productor, contratados a un proveedor de alojamiento. El cliente solo necesita un dispositivo con navegador y conexión a Internet.',
  'Funciones principales: gestión de locales de trasteros (trasteros, inquilinos, contratos, cobros y accesos) y su facturación. Emite facturas completas, simplificadas y rectificativas; por cada factura genera su registro de facturación de alta y, cuando hace falta, el de subsanación o el de anulación, encadenados mediante su huella; añade a la factura el código QR tributario; remite los registros a la Agencia Tributaria respetando el control de flujo y conserva sus respuestas con el código seguro de verificación.',
].join('\n\n');

const MULTIPLE_TAXPAYERS =
  'Sí. Lo usan varios obligados tributarios, cada uno con sus propias facturas y su propia cadena de registros, y un mismo usuario puede facturar en nombre de varios (por ejemplo, un administrador en nombre de cada propietario de los locales que gestiona).';

function compliance(version: string): string {
  return `${VERIFACTU_PRODUCER.name} declara, bajo su responsabilidad, que el sistema informático de facturación ${VERIFACTU_SYSTEM.name}, en la versión ${version}, cumple lo dispuesto en el artículo 29.2.j) de la Ley 58/2003, de 17 de diciembre, General Tributaria; en el Reglamento que establece los requisitos que deben adoptar los sistemas y programas informáticos o electrónicos que soporten los procesos de facturación de empresarios y profesionales, y la estandarización de formatos de los registros de facturación, aprobado por el Real Decreto 1007/2023, de 5 de diciembre; en la Orden HAC/1177/2024, de 17 de octubre, y en las especificaciones publicadas en la sede electrónica de la Agencia Estatal de Administración Tributaria que la completan.`;
}

/**
 * La declaración de una versión del sistema (por defecto, la que está en uso),
 * con sus datos en el orden del art. 15.1 y cada uno con el texto que lo
 * describe. Null si esa versión no tiene declaración.
 */
export function verifactuDeclaration(
  version: string = VERIFACTU_SYSTEM.version,
): VerifactuDeclarationDto | null {
  const signature = VERIFACTU_DECLARATIONS.find((d) => d.version === version);
  if (!signature) return null;
  return {
    title: VERIFACTU_DECLARATION_TITLE,
    version,
    signedOn: signature.signedOn,
    current: version === VERIFACTU_SYSTEM.version,
    items: [
      { key: 'a', label: 'Nombre del sistema informático', value: VERIFACTU_SYSTEM.name },
      {
        key: 'b',
        label: 'Código identificador del sistema informático',
        value: VERIFACTU_SYSTEM.id,
      },
      { key: 'c', label: 'Identificador completo de la versión', value: version },
      {
        key: 'd',
        label: 'Componentes de hardware y software, y principales funcionalidades',
        value: COMPONENTS,
      },
      {
        key: 'f',
        label: 'Uso por varios obligados tributarios o por un mismo usuario para varios',
        value: MULTIPLE_TAXPAYERS,
      },
      { key: 'h', label: 'Razón social de la entidad productora', value: VERIFACTU_PRODUCER.name },
      { key: 'i', label: 'NIF de la entidad productora', value: VERIFACTU_PRODUCER.taxId },
      {
        key: 'j',
        label: 'Dirección postal de contacto de la entidad productora',
        value: VERIFACTU_PRODUCER.address,
      },
      { key: 'k', label: 'Declaración de cumplimiento', value: compliance(version) },
      {
        key: 'l',
        label: 'Fecha y lugar de la firma',
        value: `${signature.place} (${signature.country}), ${verifactuDeclarationDate(signature.signedOn)}`,
      },
    ],
    contact: [
      { key: 'extra', label: 'Correo electrónico de contacto', value: VERIFACTU_PRODUCER.email },
      { key: 'extra', label: 'Dirección de Internet', value: VERIFACTU_PRODUCER.web },
    ],
  };
}

/** Las versiones con declaración, la más reciente primero. */
export function verifactuDeclarationVersions(): VerifactuDeclarationSignature[] {
  return [...VERIFACTU_DECLARATIONS].reverse();
}
