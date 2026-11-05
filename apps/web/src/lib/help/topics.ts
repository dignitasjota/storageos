export type HelpTopic = {
  /** Ancla de la guía (`/help#id`). */
  id: string;
  group: 'Día a día' | 'Cobros y facturas' | 'Clientes y ventas' | 'Tu negocio';
  title: string;
  /** Para qué sirve, en una frase. */
  summary: string;
  steps: string[];
  links: { label: string; href: string }[];
  /** Palabras que también deben encontrar la guía. */
  keywords?: string;
};

/** Guías cortas: qué pasa solo y qué haces tú. */
export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'alquilar',
    group: 'Día a día',
    title: 'Alquilar un trastero',
    summary: 'De la reserva al acceso del inquilino.',
    steps: [
      'El cliente reserva en tu web (o lo das de alta tú en el panel con «Nuevo contrato»).',
      'Firma el contrato desde el móvil o en el local, en tu tablet.',
      'Paga la primera factura (alquiler y fianza) y recibe solo su código de acceso.',
    ],
    links: [
      { label: 'Nuevo contrato', href: '/contracts/new' },
      { label: 'Reservas', href: '/reservations' },
    ],
    keywords: 'contrato reserva firma inquilino alta',
  },
  {
    id: 'bajas',
    group: 'Día a día',
    title: 'Bajas y fianzas',
    summary: 'Cómo termina un contrato y qué pasa con la fianza.',
    steps: [
      'El inquilino pide la baja desde su área de clientes con el preaviso de su contrato.',
      'Llegada la fecha, el contrato termina solo (puedes desactivarlo) y el trastero queda libre.',
      'Desde la ficha del contrato liquidas la fianza: la devuelves entera o retienes lo que corresponda.',
    ],
    links: [{ label: 'Contratos', href: '/contracts' }],
    keywords: 'baja fianza devolver fin de contrato',
  },
  {
    id: 'accesos',
    group: 'Día a día',
    title: 'Accesos al local',
    summary: 'Códigos, tarjetas y puertas.',
    steps: [
      'Cada inquilino recibe su código al pagar; lo ve también en su área de clientes.',
      'Conectas tus puertas en Accesos → Dispositivos y ves quién entra en el registro.',
      'Si alguien no paga, el escalado de impagos puede suspender su código; al pagar vuelve solo.',
    ],
    links: [
      { label: 'Accesos', href: '/access' },
      { label: 'Puerta', href: '/access/door' },
    ],
    keywords: 'pin qr puerta cerradura credencial dispositivo pase nocturno',
  },
  {
    id: 'tareas',
    group: 'Día a día',
    title: 'Tareas, incidencias y mantenimiento',
    summary: 'Lo que tu equipo tiene que hacer y lo que se rompe.',
    steps: [
      'En «Hoy» ves lo que toca: entradas, salidas, cobros, firmas y tareas.',
      'Las incidencias las abre tu equipo o el propio inquilino desde su área de clientes.',
      'Los planes de mantenimiento crean solos las tareas que se repiten, con su lista de comprobación.',
    ],
    links: [
      { label: 'Hoy', href: '/today' },
      { label: 'Tareas', href: '/tasks' },
      { label: 'Incidencias', href: '/incidents' },
    ],
    keywords: 'equipo averia ronda checklist',
  },
  {
    id: 'cobrar',
    group: 'Cobros y facturas',
    title: 'Cobrar cada mes',
    summary: 'Cómo salen las facturas y cómo se cobran.',
    steps: [
      'Cada mes se preparan las facturas de los contratos activos (en borrador o emitidas, según tus ajustes).',
      'Si el inquilino tiene tarjeta o domiciliación y el cobro automático está activo, se cobran solas; si falla, se reintenta.',
      'Si cobras por remesa SEPA, la generas en Cobros por banco y subes el fichero a tu banco.',
    ],
    links: [
      { label: 'Facturas', href: '/invoices' },
      { label: 'Cobros del mes', href: '/collections-month' },
      { label: 'Ajustes de cobro', href: '/settings/payments' },
    ],
    keywords: 'factura recurrente tarjeta bizum redsys stripe cobro automatico',
  },
  {
    id: 'impagos',
    group: 'Cobros y facturas',
    title: 'Si alguien no paga',
    summary: 'Recordatorios, recargos y planes de pago.',
    steps: [
      'Al vencer una factura, el inquilino recibe un recordatorio y, a la semana, un segundo aviso.',
      'Según tus ajustes se añade un recargo y, más adelante, se suspende su código de acceso.',
      'Al pagar, el acceso vuelve solo. Puedes ofrecer un plan de pagos desde Deudores.',
    ],
    links: [
      { label: 'Deudores', href: '/arrears' },
      { label: 'Hoy', href: '/today' },
    ],
    keywords: 'moroso deuda dunning recargo plan de pagos',
  },
  {
    id: 'domiciliacion',
    group: 'Cobros y facturas',
    title: 'Domiciliación y banco',
    summary: 'Remesas SEPA y conciliación del extracto.',
    steps: [
      'El inquilino firma su mandato con un enlace y queda listo para domiciliar.',
      'Generas la remesa, descargas el fichero y lo subes a tu banco; al confirmarla, las facturas quedan cobradas.',
      'Si subes el extracto en Norma 43, se casan los ingresos con sus facturas y se ven las devoluciones.',
    ],
    links: [
      { label: 'Remesas SEPA', href: '/sepa-remittances' },
      { label: 'Conciliación', href: '/bank-reconciliation' },
    ],
    keywords: 'sepa remesa mandato iban n43 extracto devolucion gocardless',
  },
  {
    id: 'fiscal',
    group: 'Cobros y facturas',
    title: 'Impuestos y gestoría',
    summary: 'Veri*Factu, libro de IVA y lo que necesita tu asesoría.',
    steps: [
      'Con tu certificado digital, cada factura se registra sola en la AEAT.',
      'En Fiscalidad tienes el libro de IVA y los modelos 303 y 347.',
      'Tu asesoría puede descargar las facturas, los cobros y las fianzas en Excel o CSV.',
    ],
    links: [
      { label: 'Fiscalidad', href: '/fiscal' },
      { label: 'Veri*Factu', href: '/settings/billing/verifactu' },
    ],
    keywords: 'aeat iva 303 347 certificado asesoria holded',
  },
  {
    id: 'web',
    group: 'Clientes y ventas',
    title: 'Tu web y los nuevos clientes',
    summary: 'Cómo llegan los clientes y de dónde vienen.',
    steps: [
      'Tu web pública muestra tus locales, tamaños y precios, y permite reservar online.',
      'Los formularios y reservas a medias quedan como contactos para que les escribas.',
      'Con enlaces por canal (Instagram, un flyer, Google Ads) sabes de dónde llega cada cliente.',
    ],
    links: [
      { label: 'Contactos', href: '/leads' },
      { label: 'Tu web', href: '/settings/web' },
      { label: 'Resumen de marketing', href: '/marketing/summary' },
    ],
    keywords: 'leads reservas online seo canales campañas',
  },
  {
    id: 'promociones',
    group: 'Clientes y ventas',
    title: 'Promociones, cupones y campañas',
    summary: 'Atraer clientes y recuperar a los que se fueron.',
    steps: [
      'Una promoción descuenta todas las cuotas; un cupón, solo el primer pago.',
      'Las campañas envían un correo a quien elijas: inquilinos, contactos o antiguos clientes.',
      'Con los referidos, quien te recomienda recibe un descuento en su factura.',
    ],
    links: [
      { label: 'Promociones', href: '/promotions' },
      { label: 'Cupones', href: '/coupons' },
      { label: 'Campañas', href: '/campaigns' },
    ],
    keywords: 'descuento oferta referidos win-back reseñas',
  },
  {
    id: 'area-clientes',
    group: 'Clientes y ventas',
    title: 'El área de clientes',
    summary: 'Lo que ve y puede hacer cada inquilino.',
    steps: [
      'Cada inquilino ve sus contratos, facturas y código de acceso, y puede pagar y escribirte.',
      'Le llega el acceso por correo al darlo de alta; también puedes copiar un enlace desde su ficha.',
    ],
    links: [{ label: 'Inquilinos', href: '/customers' }],
    keywords: 'portal inquilino app',
  },
  {
    id: 'seguros',
    group: 'Clientes y ventas',
    title: 'Seguros y productos',
    summary: 'Ingresos además del alquiler.',
    steps: [
      'Un plan de protección se suma a la factura mensual del contrato.',
      'Los productos (candados, cajas) se venden en mostrador o desde el área de clientes.',
    ],
    links: [
      { label: 'Seguros', href: '/insurance-plans' },
      { label: 'Productos', href: '/products' },
    ],
    keywords: 'proteccion candado tienda accesorios',
  },
  {
    id: 'precios',
    group: 'Tu negocio',
    title: 'Precios y ocupación',
    summary: 'Cuánto cobrar según tu demanda y tu competencia.',
    steps: [
      'En Analítica → Precios ves una sugerencia por tamaño y por trastero, con sus motivos.',
      'Nada cambia solo: tú decides qué aplicar.',
      'Para subir la cuota a los inquilinos actuales, usa Subidas de precio, con preaviso.',
    ],
    links: [
      { label: 'Analítica', href: '/analytics' },
      { label: 'Competencia', href: '/competitors' },
      { label: 'Subidas de precio', href: '/rent-increases' },
    ],
    keywords: 'pricing competencia ecri ipc',
  },
  {
    id: 'importar',
    group: 'Tu negocio',
    title: 'Traer tus datos de otro programa',
    summary: 'Inquilinos, trasteros, contratos y mandatos desde un Excel.',
    steps: [
      'Importa en este orden: trasteros, inquilinos y contratos.',
      'Revisa la vista previa antes de confirmar: te dice qué entra y qué falla.',
      'Activa los contratos en bloque indicando desde cuándo se factura.',
    ],
    links: [
      { label: 'Trasteros', href: '/units/import' },
      { label: 'Inquilinos', href: '/customers/import' },
      { label: 'Contratos', href: '/contracts/import' },
    ],
    keywords: 'migrar csv excel importacion',
  },
  {
    id: 'equipo',
    group: 'Tu negocio',
    title: 'Tu equipo y sus permisos',
    summary: 'Quién entra y qué puede hacer.',
    steps: [
      'Invita a cada persona con su email y elige su rol.',
      'Puedes limitar a alguien a unos locales, o crear roles a medida.',
      'En Registro de actividad queda quién hizo qué.',
    ],
    links: [
      { label: 'Usuarios', href: '/settings/users' },
      { label: 'Roles', href: '/settings/roles' },
    ],
    keywords: 'usuario rol permiso invitar local',
  },
];
