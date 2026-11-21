import type { TenantFeature } from '../features';

/** Grupos de «Cómo funciona», en el orden en que se enseñan. */
export const HELP_TOPIC_GROUPS = [
  'Día a día',
  'Cobros y facturas',
  'Clientes y ventas',
  'Tu negocio',
] as const;
export type HelpTopicGroup = (typeof HELP_TOPIC_GROUPS)[number];

export type HelpTopic = {
  /** Ancla de la guía (`/help#id`). */
  id: string;
  group: HelpTopicGroup;
  title: string;
  /** Para qué sirve, en una frase. */
  summary: string;
  steps: string[];
  links: { label: string; href: string }[];
  /** Palabras que también deben encontrar la guía. */
  keywords?: string;
  /** Función del plan que necesita lo que explica la guía (si no la tiene, se avisa). */
  feature?: TenantFeature;
};

/**
 * Guías cortas de «Cómo funciona»: qué pasa solo y qué haces tú. Son la base:
 * el panel de administración puede cambiarlas, ocultarlas o añadir otras
 * (`platform_help_topics`). Sus `id` se enlazan desde otras pantallas
 * (`/help#id`): no se cambian.
 */
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
    id: 'vencimientos',
    group: 'Día a día',
    title: 'Vencimientos y avisos',
    summary: 'Que no se te pase un seguro, una revisión o un impuesto.',
    steps: [
      'Apunta cada vencimiento de tu negocio con su fecha y cada cuánto se repite; hay plantillas con los plazos fiscales habituales para empezar.',
      'Te avisamos con antelación en el panel y por correo, a las personas del equipo que elijas y, si quieres, a correos de fuera.',
      'Al marcarlo como hecho puedes apuntar el gasto y el justificante, y pasa solo a su siguiente fecha.',
    ],
    links: [{ label: 'Vencimientos', href: '/reminders' }],
    keywords: 'recordatorio aviso plazo impuesto seguro revision itv calendario fiscal',
    feature: 'business_reminders',
  },
  {
    id: 'lista-espera',
    group: 'Día a día',
    title: 'Lista de espera',
    summary: 'Clientes que esperan un tamaño que ahora no tienes libre.',
    steps: [
      'Si no te queda el tamaño que buscan, apuntas al cliente; también se apunta él desde tu web con «Avísame».',
      'Cuando queda libre un trastero de ese tamaño, se avisa al primero de la cola y se le guarda unas horas; si no responde, pasa al siguiente.',
      'Cuando acepta, creas el contrato desde la propia lista.',
    ],
    links: [{ label: 'Lista de espera', href: '/waitlist' }],
    keywords: 'cola espera avisame agotado sin stock reservar',
  },
  {
    id: 'camaras',
    group: 'Día a día',
    title: 'Cámaras y alarma',
    summary: 'Los avisos de tus cámaras y de la alarma, en el panel.',
    steps: [
      'Añade cada cámara o central de alarma: te damos una dirección y un código para configurarlo en el equipo.',
      'Sus avisos llegan a «Últimos eventos», con foto si el equipo la manda, y las alarmas te avisan en el panel.',
      'Desde un evento creas una incidencia; si conectas el equipo, puedes pedir una captura o armar y desarmar la alarma.',
    ],
    links: [{ label: 'Cámaras', href: '/cameras' }],
    keywords: 'camara alarma videovigilancia dahua nvr evento captura',
    feature: 'cameras',
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
    id: 'caja',
    group: 'Cobros y facturas',
    title: 'Cierre de caja',
    summary: 'Cuadrar lo cobrado en el local cada día.',
    steps: [
      'En Cierre de caja ves lo cobrado en el día por forma de pago y el efectivo que debería haber.',
      'Apunta también el fondo de cambio y lo que llevas al banco, cuenta el efectivo y cierra: queda la diferencia y un PDF para firmar.',
      'Si falta algo por apuntar, reabre la caja, regístralo y vuelve a cerrarla.',
    ],
    links: [{ label: 'Cierre de caja', href: '/cash' }],
    keywords: 'caja efectivo arqueo cierre dia descuadre',
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
    id: 'verifactu',
    group: 'Cobros y facturas',
    title: 'Veri*Factu paso a paso',
    summary: 'Enviar tus facturas a la AEAT.',
    steps: [
      'Rellena la razón social, el NIF y el domicilio fiscal de tu empresa.',
      'En Veri*Factu sube tu certificado digital (archivo .p12 o .pfx) con su contraseña.',
      'El propietario lo activa: desde entonces cada factura lleva el QR de la AEAT y se envía sola. Una vez activado, sigue así hasta el 31 de diciembre.',
      'En la misma página ves los envíos y las facturas que la AEAT haya rechazado.',
    ],
    links: [
      { label: 'Datos de tu empresa', href: '/settings/company' },
      { label: 'Veri*Factu', href: '/settings/billing/verifactu' },
    ],
    keywords: 'verifactu aeat certificado digital fnmt qr hacienda envio factura',
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
      'Una promoción descuenta las cuotas (todas o las primeras); un cupón, solo el primer pago.',
      'Lo que marques «En la web» se anuncia en tu web con su código, que vale en la reserva online.',
      'Un cupón personal vale una sola vez: para un presupuesto o para quien dejó la reserva a medias.',
      'Las campañas envían un correo a quien elijas: inquilinos, contactos o antiguos clientes.',
      'Con los referidos, quien te recomienda recibe un descuento en su factura cuando su recomendado paga, y puedes premiar también al recomendado.',
    ],
    links: [
      { label: 'Promociones', href: '/promotions' },
      { label: 'Cupones', href: '/coupons' },
      { label: 'Referidos', href: '/referrals' },
      { label: 'Campañas', href: '/campaigns' },
    ],
    keywords: 'descuento oferta referidos recomendado win-back reseñas valoraciones',
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
    id: 'mensajes',
    group: 'Clientes y ventas',
    title: 'Mensajes con los inquilinos',
    summary: 'Todas las conversaciones en una bandeja.',
    steps: [
      'En Mensajes tienes lo que escriben tus inquilinos desde su área de clientes, el chat de tu web y, si lo tienes, WhatsApp.',
      'Cada conversación tiene responsable y estado; puedes dejar notas internas que el inquilino no ve y usar respuestas guardadas.',
      'Fuera de tu horario de atención puede salir sola una respuesta automática.',
    ],
    links: [
      { label: 'Mensajes', href: '/messages' },
      { label: 'Horario y respuestas', href: '/settings/messages' },
    ],
    keywords: 'chat conversacion bandeja responder nota interna respuesta guardada',
  },
  {
    id: 'whatsapp',
    group: 'Clientes y ventas',
    title: 'WhatsApp Business',
    summary: 'Atiende el WhatsApp de tu negocio desde el panel.',
    steps: [
      'Conecta el número de tu negocio en Configuración → WhatsApp y actívalo; en tu web aparece el botón de WhatsApp.',
      'Los mensajes llegan a la bandeja de WhatsApp. Si el cliente lleva más de 24 horas sin escribir, solo puedes enviarle una plantilla aprobada por Meta.',
      'Si activas el asistente automático, responde con los datos de tu web, puede preparar reservas y pasa la conversación a una persona cuando hace falta.',
    ],
    links: [
      { label: 'Bandeja de WhatsApp', href: '/whatsapp' },
      { label: 'Configurar WhatsApp', href: '/settings/whatsapp' },
    ],
    keywords: 'whatsapp meta mensaje chat plantilla asistente automatico',
    feature: 'whatsapp_business',
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
    id: 'gastos',
    group: 'Tu negocio',
    title: 'Gastos y rentabilidad',
    summary: 'Cuánto te cuesta cada local y cuánto ganas.',
    steps: [
      'Apunta cada gasto con su local, su categoría y el justificante; los que se repiten, como gastos recurrentes.',
      'La cuenta de resultados enseña lo facturado menos los gastos de cada local.',
      'Marca qué está pagado y fija un presupuesto por categoría. También puedes traerlos desde un Excel.',
    ],
    links: [
      { label: 'Gastos', href: '/expenses' },
      { label: 'Importar gastos', href: '/expenses/import' },
    ],
    keywords: 'gasto coste factura proveedor presupuesto resultado beneficio rentabilidad',
  },
  {
    id: 'informes',
    group: 'Tu negocio',
    title: 'Informes',
    summary: 'Tus datos en PDF o Excel, cuando los pidas o por correo.',
    steps: [
      'Elige un informe y su periodo y descárgalo en PDF o en Excel; cada uno se guarda 7 días.',
      'Si lo quieres cada semana o cada mes, programa su envío por correo (hasta 5 direcciones).',
    ],
    links: [{ label: 'Informes', href: '/reports' }],
    keywords: 'informe pdf excel exportar descargar correo programado',
  },
  {
    id: 'asistente',
    group: 'Tu negocio',
    title: 'Asistente IA',
    summary: 'Pregunta por tu negocio como se lo preguntarías a alguien.',
    steps: [
      'Pregúntale en lenguaje normal: ocupación, facturas vencidas, contratos que vencen, tareas abiertas…',
      'Solo ve lo que tú puedes ver: tus permisos y tus locales.',
      'Si le pides que haga algo, te lo propone y no se hace hasta que lo confirmas.',
      'Las consultas tienen un límite cada mes; en la propia página del asistente ves cuántas llevas.',
    ],
    links: [
      { label: 'Asistente IA', href: '/assistant' },
      { label: 'Ajustes del asistente', href: '/settings/ai' },
    ],
    keywords: 'ia inteligencia artificial chat preguntar asistente',
    feature: 'ai_assistant',
  },
  {
    id: 'propietarios',
    group: 'Tu negocio',
    title: 'Propietarios',
    summary: 'Si gestionas locales de otros dueños.',
    steps: [
      'Da de alta a cada propietario con su NIF, su cuenta y tus honorarios (un porcentaje de lo cobrado o una cuota fija).',
      'Asígnalo en cada local: sus contratos facturan a su nombre, con su propia serie.',
      'Cada mes sacas su liquidación (lo cobrado menos tus honorarios y los gastos de sus locales) y se la envías por correo.',
    ],
    links: [
      { label: 'Propietarios', href: '/owners' },
      { label: 'Locales', href: '/facilities' },
    ],
    keywords: 'propietario dueño administrador cartera liquidacion honorarios',
    feature: 'multi_owner',
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
