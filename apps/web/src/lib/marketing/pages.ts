/**
 * Páginas de la web de TrasterOS que captan búsquedas concretas: una por
 * funcionalidad (`/funcionalidades/<slug>`) y una por tipo de cliente
 * (`/soluciones/<slug>`). Solo español (la web de la plataforma no tiene otro
 * idioma). Cada página tiene su título y descripción para Google, sus preguntas
 * (también como datos estructurados) y enlaces a las relacionadas.
 */

export type ScreenshotKey = 'dashboard' | 'plan' | 'invoice' | 'portal' | 'booking';

export interface MarketingSection {
  title: string;
  text: string;
  points?: string[];
}

export interface MarketingPage {
  slug: string;
  kind: 'feature' | 'solution';
  /** Nombre corto para menús y tarjetas. */
  navTitle: string;
  /** Una frase para tarjetas y enlaces. */
  summary: string;
  /** Título para Google (≈60 caracteres). */
  metaTitle: string;
  /** Descripción para Google (≤155 caracteres). */
  metaDescription: string;
  h1: string;
  lead: string;
  highlights: string[];
  sections: MarketingSection[];
  steps?: { title: string; text: string }[];
  faqs: { q: string; a: string }[];
  related: string[];
  shot?: ScreenshotKey;
}

export const FEATURE_PAGES: MarketingPage[] = [
  {
    slug: 'facturacion-veri-factu',
    kind: 'feature',
    navTitle: 'Facturación Veri*Factu',
    summary: 'Facturas mensuales automáticas, conformes a Veri*Factu y listas para tu asesoría.',
    metaTitle: 'Facturación Veri*Factu para trasteros | TrasterOS',
    metaDescription:
      'Programa de facturación para trasteros conforme a Veri*Factu: facturas recurrentes, QR, envío a la AEAT, rectificativas, libro de IVA y modelos 303 y 347.',
    h1: 'Facturación Veri*Factu para negocios de trasteros',
    lead: 'Las facturas de cada trastero se emiten solas cada mes, con su registro encadenado, su código QR y el envío a la Agencia Tributaria. Tú solo revisas lo que necesita atención.',
    highlights: [
      'Registro de cada factura con huella encadenada y QR',
      'Envío a la AEAT con el certificado de tu empresa',
      'Rectificativas, anulaciones y corrección de rechazos',
      'Libro de IVA, modelos 303 y 347 y exportación para la asesoría',
    ],
    sections: [
      {
        title: 'Facturas recurrentes sin hojas de cálculo',
        text: 'Cada contrato genera su factura del mes con el alquiler, el seguro si lo tiene y los descuentos o meses gratis pactados. La primera factura se prorratea según el día de entrada y los pagos de varios meses por adelantado se facturan de una vez.',
        points: [
          'Emisión automática el día que elijas, o revisión previa de los borradores',
          'Series de facturación propias y numeración correlativa por año',
          'Facturas simplificadas para ventas en el mostrador',
          'Recargo por mora pactado como factura aparte',
        ],
      },
      {
        title: 'Conforme a Veri*Factu desde el primer día',
        text: 'Cada factura emitida genera un registro de facturación con su huella encadenada a la anterior y un código QR que tu cliente puede comprobar en la sede de la Agencia Tributaria. Los registros se envían a la AEAT respetando los tiempos de espera que marca, y si alguno se rechaza lo ves en el panel con el motivo.',
        points: [
          'Envío en lotes con el certificado electrónico de tu empresa',
          'Rectificativas por diferencias o por sustitución, sin tocar la factura original',
          'Anulación de facturas emitidas por error, que queda registrada',
          'Corrección y nuevo envío de los registros que la AEAT rechaza',
        ],
      },
      {
        title: 'Todo lo que pide tu asesoría',
        text: 'El libro registro de facturas expedidas, los modelos 303 y 347 y una exportación en Excel o CSV con facturas, cobros y fianzas por separado. También puedes copiar las facturas a Holded si tu asesoría trabaja con él.',
        points: [
          'IVA por tipo, operaciones exentas y no sujetas bien declaradas',
          'Retención de IRPF cuando el inquilino es una empresa que la practica',
          'Fianzas fuera de los ingresos, con su justificante',
        ],
      },
    ],
    faqs: [
      {
        q: '¿Desde cuándo es obligatorio Veri*Factu?',
        a: 'Desde el 1 de enero de 2027 para las empresas que tributan por el Impuesto sobre Sociedades y desde el 1 de julio de 2027 para el resto. Puedes activarlo antes de forma voluntaria en tu cuenta.',
      },
      {
        q: '¿Necesito un certificado electrónico?',
        a: 'Sí, el de tu empresa (o el de un representante apoderado). Lo subes una vez en la configuración y TrasterOS lo usa para enviar los registros a la Agencia Tributaria.',
      },
      {
        q: '¿Qué pasa si me equivoco en una factura?',
        a: 'Una factura emitida no se modifica: se hace una factura rectificativa desde su ficha, por diferencias o sustituyéndola, y queda enlazada a la original. Si se emitió por error, puedes anularla.',
      },
      {
        q: '¿Puedo seguir usando mi programa de contabilidad?',
        a: 'Sí. Tu asesoría recibe el libro de IVA y una exportación en Excel o CSV, y si usáis Holded las facturas se copian solas.',
      },
    ],
    related: ['cobros-sepa-tarjeta-bizum', 'gestion-de-impagos', 'contratos-firma-electronica'],
    shot: 'invoice',
  },
  {
    slug: 'cobros-sepa-tarjeta-bizum',
    kind: 'feature',
    navTitle: 'Cobros: SEPA, tarjeta y Bizum',
    summary: 'Cobra las cuotas solas por domiciliación, tarjeta guardada o Bizum.',
    metaTitle: 'Cobros de trasteros por SEPA, tarjeta y Bizum | TrasterOS',
    metaDescription:
      'Cobra las cuotas de tus trasteros de forma automática: domiciliación SEPA, tarjeta guardada, Bizum, reintentos de cobro y conciliación bancaria Norma 43.',
    h1: 'Cobros automáticos para tus trasteros: domiciliación SEPA, tarjeta y Bizum',
    lead: 'El recibo que sale solo es el que no se olvida. Elige cómo cobrar a cada inquilino y deja que el sistema cobre, reintente y te avise solo cuando algo falla.',
    highlights: [
      'Remesas SEPA para tu banco o domiciliación con GoCardless',
      'Tarjeta guardada con tu TPV Redsys o tu cuenta de Stripe',
      'Bizum y pago con enlace desde el área de clientes',
      'Conciliación bancaria con el extracto Norma 43',
    ],
    sections: [
      {
        title: 'Domiciliación SEPA sin comisiones de pasarela',
        text: 'El inquilino firma el mandato SEPA online y cada mes generas la remesa en el formato que admite tu banco (pain.008). Si prefieres no gestionar remesas, puedes domiciliar con GoCardless. Los recibos devueltos se marcan solos y vuelven al circuito de cobro.',
        points: [
          'Mandato firmado online con su constancia',
          'Preaviso al inquilino antes de cada cargo',
          'Remesa automática si lo activas',
        ],
      },
      {
        title: 'Tarjeta y Bizum',
        text: 'Con tu TPV de Redsys (o tu propia cuenta de Stripe), el inquilino paga la primera cuota con tarjeta y la tarjeta queda guardada para cobrar las siguientes de forma automática. Bizum está disponible si tu banco lo tiene activado en el TPV.',
      },
      {
        title: 'Reintentos, recargos y caja',
        text: 'Si un cobro falla, el sistema lo reintenta los días que configures antes de pasar al calendario de reclamación. Puedes aplicar recargos por mora, registrar pagos en efectivo o transferencia y cerrar la caja del día.',
        points: [
          'Reintentos automáticos con espera entre intentos',
          'Cierre de caja diario por local',
          'Recibos devueltos y contracargos en un solo listado',
        ],
      },
      {
        title: 'Conciliación bancaria',
        text: 'Sube el extracto Norma 43 de tu banco y los ingresos se casan con sus facturas. Los que tienen el número de factura en el concepto se pueden conciliar solos.',
      },
    ],
    faqs: [
      {
        q: '¿Qué formas de pago puede usar el inquilino?',
        a: 'Domiciliación SEPA, tarjeta, Bizum, transferencia o pago en el local. Tú decides cuáles ofreces.',
      },
      {
        q: '¿Necesito un TPV?',
        a: 'Para cobrar con tarjeta y Bizum puedes usar el TPV virtual de Redsys de tu banco o tu propia cuenta de Stripe. Para domiciliar no hace falta TPV: basta con tu cuenta bancaria y el identificador de acreedor SEPA.',
      },
      {
        q: '¿Qué pasa cuando se devuelve un recibo?',
        a: 'La factura vuelve a estar pendiente, se avisa al inquilino y entra en los reintentos y el calendario de reclamación que hayas configurado.',
      },
    ],
    related: ['gestion-de-impagos', 'facturacion-veri-factu', 'portal-del-inquilino'],
  },
  {
    slug: 'control-de-accesos',
    kind: 'feature',
    navTitle: 'Control de accesos',
    summary: 'PIN, tarjeta, QR o móvil, con horarios y corte automático por impago.',
    metaTitle: 'Control de accesos para trasteros: PIN, QR y móvil | TrasterOS',
    metaDescription:
      'Control de accesos para centros de trasteros: PIN, tarjeta RFID, QR y apertura desde el móvil, horarios por local, pases nocturnos y corte automático por impago.',
    h1: 'Control de accesos para centros de trasteros',
    lead: 'Tus inquilinos entran cuando quieren y tú sabes quién ha entrado. El acceso se da al pagar, se corta si dejan de pagar y se quita al terminar el contrato, sin ir al local.',
    highlights: [
      'PIN, tarjeta RFID, QR y apertura desde el móvil',
      'Horario por local, acceso 24 horas y pases nocturnos de pago',
      'Corte automático por impago y reactivación al pagar',
      'Registro de cada acceso y avisos de intentos sospechosos',
    ],
    sections: [
      {
        title: 'Las formas de abrir que prefieras',
        text: 'Cada inquilino recibe su código al pagar la primera cuota y lo tiene siempre en su área de clientes, con su código QR. Puedes darle tarjetas o llaveros, accesos extra para familiares o empleados y códigos de un solo uso para visitas.',
        points: [
          'Apertura desde el móvil del inquilino',
          'Reconocimiento facial como extra',
          'Códigos de visita que caducan el mismo día',
        ],
      },
      {
        title: 'Horarios y pases nocturnos',
        text: 'Fija de qué hora a qué hora se puede entrar en cada local. Quien necesite entrar fuera de horario puede comprar un pase nocturno desde su área de clientes, y al personal le das acceso 24 horas.',
      },
      {
        title: 'Impagos: el acceso se corta y vuelve solo',
        text: 'Si lo pactas en el contrato, el acceso se suspende el día que marque tu calendario de reclamación y se reactiva en cuanto el inquilino paga. Al terminar el contrato se retiran todas sus credenciales, también las de las tarjetas.',
      },
      {
        title: 'Con conexión o sin ella',
        text: 'TrasterOS funciona con terminales que consultan en cada intento y con equipos que guardan los códigos y validan solos aunque se caiga internet. Los cambios se envían al terminal en cuanto hay conexión.',
        points: [
          'Terminales Dahua y Akuvox, y cualquier controlador por HTTP o MQTT',
          'Avisos de puertas sin conexión e intentos fuera de horario',
          'Cámaras y alarma con sus eventos en el panel',
        ],
      },
    ],
    faqs: [
      {
        q: '¿Qué equipos de acceso son compatibles?',
        a: 'Controladoras y terminales Dahua, Akuvox y cualquier controlador que se pueda abrir por HTTP o MQTT. Si ya tienes un sistema instalado, cuéntanos cuál es y te decimos cómo conectarlo.',
      },
      {
        q: '¿Qué pasa si se cae internet?',
        a: 'Con terminales que guardan los códigos, la puerta sigue funcionando y los accesos se registran cuando vuelve la conexión.',
      },
      {
        q: '¿Puedo cortar el acceso a quien no paga?',
        a: 'Sí, si lo recoge tu contrato. El corte se hace el día que marques en el calendario de reclamación y el acceso vuelve en cuanto paga.',
      },
    ],
    related: ['gestion-de-impagos', 'portal-del-inquilino', 'reserva-online'],
  },
  {
    slug: 'reserva-online',
    kind: 'feature',
    navTitle: 'Reserva y contratación online',
    summary: 'El cliente elige su trastero, firma y paga online, sin que intervengas.',
    metaTitle: 'Reserva online de trasteros con pago y firma | TrasterOS',
    metaDescription:
      'Página de reserva online para tu negocio de trasteros: disponibilidad real, precio con IVA, firma del contrato y pago de la primera cuota y la fianza.',
    h1: 'Reserva y contratación online de trasteros',
    lead: 'Mucha gente busca trastero por la noche o el fin de semana. Con la reserva online elige el local y el tamaño, firma el contrato desde el móvil, paga y recibe su acceso, aunque estés cerrado.',
    highlights: [
      'Disponibilidad y precio con IVA de cada tamaño, en tiempo real',
      'Firma del contrato y pago de la primera cuota y la fianza',
      'Acceso al centro en cuanto paga',
      'Cupones, pago de varios meses y lista de espera',
    ],
    sections: [
      {
        title: 'De la búsqueda al trastero, sin llamadas',
        text: 'El cliente elige local, tamaño y fecha de entrada, ve el precio con IVA y deja sus datos. Firma el contrato desde el móvil, paga con tarjeta o Bizum y recibe su código de acceso. El trastero queda guardado mientras completa la reserva y se libera solo si no la termina.',
        points: [
          'Recordatorio a quien empieza la reserva y no la termina',
          'Transferencia, pago en el local o domiciliación si las activas',
          'Reserva anticipada en locales que aún no han abierto',
        ],
      },
      {
        title: 'Cupones y pago por adelantado',
        text: 'Crea cupones de descuento o de meses gratis con sus condiciones, y deja que el cliente pague 3, 6 o 12 meses por adelantado. El resumen le muestra exactamente lo que pagará antes de firmar.',
      },
      {
        title: 'Lista de espera para los tamaños agotados',
        text: 'Si un tamaño está lleno, el cliente se apunta a la lista de espera y recibe un aviso cuando queda uno libre, con el trastero guardado unas horas para él.',
      },
    ],
    faqs: [
      {
        q: '¿Dónde se pone la página de reserva?',
        a: 'En tu web de TrasterOS y, si tienes dominio propio, en tu dominio. También puedes enlazarla desde tu web actual, tus redes o Google Business Profile.',
      },
      {
        q: '¿El cliente tiene que pagar al reservar?',
        a: 'Sí: la primera cuota y la fianza. Así no hay trasteros apartados que nunca se pagan. Si activas otras formas de pago, puede elegir pagar en el local o por transferencia.',
      },
      {
        q: '¿Qué pasa si el cliente ya existe?',
        a: 'Por seguridad, el enlace de firma se le envía a su correo en lugar de mostrarse en pantalla.',
      },
    ],
    related: ['web-y-seo-local', 'contratos-firma-electronica', 'cobros-sepa-tarjeta-bizum'],
    shot: 'booking',
  },
  {
    slug: 'contratos-firma-electronica',
    kind: 'feature',
    navTitle: 'Contratos y firma electrónica',
    summary: 'Contratos con tus condiciones, firmados por enlace o en el local.',
    metaTitle: 'Contratos de trasteros con firma electrónica | TrasterOS',
    metaDescription:
      'Contratos de alquiler de trasteros con firma electrónica por enlace o en el local, con huella del documento, condiciones propias, fianza, renovaciones y bajas.',
    h1: 'Contratos de alquiler de trasteros con firma electrónica',
    lead: 'Prepara el contrato con tus condiciones y envíalo para firmar desde el móvil o fírmalo en el local en una tablet. Queda guardado con su huella, la fecha y la IP de quien firma.',
    highlights: [
      'Firma por enlace o en el local, dibujada o escrita',
      'Huella del documento, fecha, IP y navegador de quien firma',
      'Tus condiciones con variables (precio, trastero, fechas…)',
      'Fianza, renovaciones, traslados y bajas',
    ],
    sections: [
      {
        title: 'El contrato con tus condiciones',
        text: 'Escribe tus condiciones particulares con variables que se rellenan solas (nombre del inquilino, trastero, precio, fecha de inicio, preaviso…). Si no tienes las tuyas, parte de unas condiciones generales completas. Cada contrato firmado guarda el texto tal como se firmó.',
      },
      {
        title: 'Firma con valor probatorio',
        text: 'La firma queda registrada con la huella SHA-256 del documento, la fecha y hora, la IP, el navegador y el canal. El PDF del contrato incluye la firma y esa constancia, y si el contrato cambió mientras el cliente lo leía, se le pide volver a revisarlo.',
      },
      {
        title: 'Todo lo que pasa después',
        text: 'La fianza se guarda y se liquida al terminar, con lo que se devuelve o se retiene y el motivo. Las renovaciones, las subidas de precio con preaviso, los traslados de trastero y las bajas quedan en el historial del contrato.',
        points: [
          'Baja solicitada desde el área de clientes con el preaviso pactado',
          'Subida anual de cuotas con aviso a cada inquilino',
          'Desistimiento a distancia con su formulario',
        ],
      },
    ],
    faqs: [
      {
        q: '¿Es válida la firma electrónica de un contrato de trastero?',
        a: 'Sí. Es una firma electrónica simple, válida para un contrato de alquiler de trastero, y queda acompañada de la huella del documento y los datos de quien firma para poder probarla.',
      },
      {
        q: '¿Puedo usar mi propio modelo de contrato?',
        a: 'Sí. Pegas tus condiciones con las variables que necesites y la plataforma las rellena en cada contrato.',
      },
      {
        q: '¿Puedo importar los contratos que ya tengo?',
        a: 'Sí, desde un CSV o un Excel, y activarlos de una vez indicando desde cuándo los factura TrasterOS.',
      },
    ],
    related: ['reserva-online', 'facturacion-veri-factu', 'portal-del-inquilino'],
  },
  {
    slug: 'gestion-de-impagos',
    kind: 'feature',
    navTitle: 'Gestión de impagos',
    summary: 'Avisos, reintentos, corte de acceso y expedientes, con un calendario claro.',
    metaTitle: 'Gestión de impagos en trasteros | TrasterOS',
    metaDescription:
      'Reduce los impagos de tus trasteros: recordatorios automáticos, reintentos de cobro, recargo por mora, corte de acceso, planes de pago y expedientes de impago.',
    h1: 'Gestión de impagos para negocios de trasteros',
    lead: 'Cada deuda sigue el mismo camino, sin depender de que alguien se acuerde: avisos al inquilino, reintentos, corte del acceso si lo has pactado y, si no paga, el expediente con sus pasos y plazos.',
    highlights: [
      'Calendario de reclamación configurable',
      'Corte automático del acceso y reactivación al pagar',
      'Planes de pago con sus plazos',
      'Expedientes de impago con requerimiento en PDF',
    ],
    sections: [
      {
        title: 'Un calendario que se cumple solo',
        text: 'Decides qué pasa cada día desde el vencimiento: el primer aviso, el segundo con recargo, el corte del acceso y el aviso legal. El sistema lo ejecuta y deja constancia de cada paso, y lo detiene si hay un cobro en curso o un plan de pagos al día.',
      },
      {
        title: 'Deudores de un vistazo',
        text: 'La pantalla de deudores muestra cuánto debe cada inquilino, desde cuándo y en qué paso está. Puedes registrar el pago, mandar un recordatorio o pactar un plan de pagos sin salir de la lista.',
      },
      {
        title: 'Expedientes cuando la deuda sigue',
        text: 'Si la deuda continúa, abres un expediente con los pasos que recoja tu contrato: requerimiento por escrito con su plazo, candado en el trastero, resolución del contrato y, solo por el cauce legal, lo que ocurre con los bienes. Cada paso guarda sus fechas y documentos.',
      },
    ],
    faqs: [
      {
        q: '¿Puedo cortar el acceso a un inquilino que no paga?',
        a: 'Sí, si lo recoge tu contrato. El corte lo hace el sistema el día que marques y el acceso vuelve en cuanto paga.',
      },
      {
        q: '¿Puedo vender o retirar las cosas de un trastero impagado?',
        a: 'En España no hay una ley específica para ello: depende de tu contrato y de seguir un procedimiento con avisos y plazos. TrasterOS te ayuda a documentar cada paso; consulta con tu abogado antes de actuar sobre los bienes.',
      },
      {
        q: '¿Qué pasa si el inquilino paga a mitad del proceso?',
        a: 'El proceso se detiene, el acceso se reactiva y el expediente se cierra como pagado.',
      },
    ],
    related: ['cobros-sepa-tarjeta-bizum', 'control-de-accesos', 'contratos-firma-electronica'],
  },
  {
    slug: 'web-y-seo-local',
    kind: 'feature',
    navTitle: 'Web y SEO local',
    summary: 'Una web para tu negocio con una página optimizada por local y ciudad.',
    metaTitle: 'Web para negocios de trasteros con SEO local | TrasterOS',
    metaDescription:
      'Web para tu negocio de trasteros con página por local y por ciudad, precios y disponibilidad reales, reserva online, datos estructurados y dominio propio.',
    h1: 'Web para tu negocio de trasteros, con SEO local',
    lead: 'Que te encuentren cuando alguien busca «trasteros en» tu ciudad. Tu web muestra tus locales, tamaños y precios reales, y cada local tiene su propia página preparada para Google.',
    highlights: [
      'Página por local y por ciudad, con datos estructurados',
      'Precios y disponibilidad reales, con reserva online',
      'Plantillas de diseño y tu dominio propio',
      'Blog, landings de promoción y chat',
    ],
    sections: [
      {
        title: 'Una página por local y por ciudad',
        text: 'Cada local tiene su página con dirección, horario, mapa, fotos, tamaños y precios, y la información que Google usa para los negocios locales. Si tienes varios locales en una ciudad, se crea la página de esa ciudad, y puedes añadir textos propios para las zonas cercanas.',
        points: [
          'Título, descripción y preguntas frecuentes con la localidad',
          'Mapa del sitio y datos estructurados automáticos',
          'Versión en inglés',
        ],
      },
      {
        title: 'Tu marca y tu dominio',
        text: 'Elige una plantilla, sube tu logo y tus fotos y publica la web bajo tu propio dominio. Si ya tienes una web, enlaza la reserva online desde ella o inserta el formulario de contacto.',
      },
      {
        title: 'Para captar más',
        text: 'Escribe entradas en el blog, crea landings para tus promociones con su cupón y mide de dónde llega cada visita y cada reserva. Un asistente en la web responde las dudas de tus visitantes con tus datos.',
      },
    ],
    faqs: [
      {
        q: '¿Necesito saber de diseño o de SEO?',
        a: 'No. La web se crea con tus locales, tamaños y precios, y los títulos, descripciones y datos estructurados se generan solos. Si quieres, puedes escribir los tuyos.',
      },
      {
        q: '¿Puedo usar mi dominio?',
        a: 'Sí, con el plan que lo incluye. Solo tienes que apuntar el dominio a TrasterOS.',
      },
      {
        q: '¿Y si ya tengo web?',
        a: 'Puedes mantenerla y enlazar la reserva online, o usar la de TrasterOS bajo tu dominio.',
      },
    ],
    related: ['reserva-online', 'plano-de-trasteros', 'portal-del-inquilino'],
  },
  {
    slug: 'portal-del-inquilino',
    kind: 'feature',
    navTitle: 'Área de clientes (app)',
    summary: 'Tus inquilinos pagan, abren la puerta y hacen gestiones desde el móvil.',
    metaTitle: 'Área de clientes y app para inquilinos de trasteros | TrasterOS',
    metaDescription:
      'Área de clientes para los inquilinos de tus trasteros: facturas y pagos, código de acceso, apertura de puerta, incidencias, cambios de trastero y bajas desde el móvil.',
    h1: 'Área de clientes y app para los inquilinos de tus trasteros',
    lead: 'Menos llamadas y correos: tus inquilinos ven sus facturas y pagan, tienen su código de acceso, abren la puerta y hacen sus gestiones desde el móvil, con tu marca.',
    highlights: [
      'Facturas, pagos y forma de pago',
      'Código de acceso, QR y apertura de puerta',
      'Incidencias, cambios de trastero y bajas',
      'App instalable con tu logo y tus colores',
    ],
    sections: [
      {
        title: 'Todo lo de su trastero en un sitio',
        text: 'El inquilino entra con un enlace a su correo o con contraseña y ve sus contratos, sus facturas y cuánto debe. Puede pagar con tarjeta o Bizum, cambiar su tarjeta o domiciliar el pago, y descargar sus facturas del año.',
      },
      {
        title: 'Acceso al centro desde el móvil',
        text: 'Tiene siempre su PIN y su código QR, incluso sin conexión, puede abrir la puerta con un botón si está conectada y comprar un pase nocturno o crear accesos para familiares.',
      },
      {
        title: 'Gestiones sin llamarte',
        text: 'Reporta incidencias con fotos, pide otro trastero o uno más grande, contrata un trastero adicional, cambia sus datos, pide la baja con el preaviso pactado y te escribe por el chat.',
        points: [
          'Avisos al móvil cuando hay una factura o un pago',
          'En español y en inglés',
          'Con tu logo y tu color',
        ],
      },
    ],
    faqs: [
      {
        q: '¿Los inquilinos tienen que descargar una app?',
        a: 'No hace falta: el área de clientes funciona en el navegador y se puede instalar en el móvil como una app, con tu nombre y tu logo.',
      },
      {
        q: '¿Cómo entran por primera vez?',
        a: 'Con un enlace que les llega por correo al contratar. También puedes mandarles el enlace por WhatsApp desde su ficha.',
      },
    ],
    related: ['control-de-accesos', 'cobros-sepa-tarjeta-bizum', 'reserva-online'],
    shot: 'portal',
  },
  {
    slug: 'plano-de-trasteros',
    kind: 'feature',
    navTitle: 'Plano y ocupación',
    summary: 'Tus locales en un plano interactivo con el estado y el precio de cada trastero.',
    metaTitle: 'Plano de trasteros y control de ocupación | TrasterOS',
    metaDescription:
      'Dibuja el plano de tus locales y ve el estado, el precio y el inquilino de cada trastero. Ocupación, ingresos, precios sugeridos con datos del mercado y analítica.',
    h1: 'Plano de trasteros y control de la ocupación',
    lead: 'Ve tu local como es: cada trastero en su sitio, con su estado, su precio y quién lo tiene. Y decide los precios con datos de tu ocupación y del mercado.',
    highlights: [
      'Editor visual del plano por planta',
      'Estado, precio e inquilino de cada trastero',
      'Ocupación, ingresos y previsión',
      'Precios sugeridos con datos de la competencia',
    ],
    sections: [
      {
        title: 'El plano de cada planta',
        text: 'Sube el plano de cada planta y coloca los trasteros encima. Los colores muestran cuáles están libres, alquilados, reservados o en mantenimiento, y al pulsar uno ves su ficha, su inquilino y lo que debe.',
      },
      {
        title: 'Ocupación e ingresos',
        text: 'El resumen muestra la ocupación física y económica, los ingresos del mes, lo pendiente de cobro, las altas y bajas y la previsión. Puedes compararlo por local y por tamaño.',
      },
      {
        title: 'Precios con datos',
        text: 'Ficha los precios de tu competencia y el sistema te sugiere el precio de cada tamaño según el mercado, tu ocupación y la demanda. Tú decides si lo aplicas: nunca cambia un precio solo.',
      },
    ],
    faqs: [
      {
        q: '¿Puedo importar mis trasteros?',
        a: 'Sí, desde CSV o Excel, o crear varios de una vez con su numeración.',
      },
      {
        q: '¿Puedo tener varios locales?',
        a: 'Sí, cada uno con sus plantas, tamaños y precios, y usuarios que solo ven los locales que les asignes.',
      },
    ],
    related: ['web-y-seo-local', 'facturacion-veri-factu', 'reserva-online'],
    shot: 'plan',
  },
];

export const SOLUTION_PAGES: MarketingPage[] = [
  {
    slug: 'operadores-self-storage',
    kind: 'solution',
    navTitle: 'Operadores de self-storage',
    summary: 'Uno o varios locales propios, con cobros y accesos automáticos.',
    metaTitle: 'Software para operadores de self-storage | TrasterOS',
    metaDescription:
      'Programa de gestión para operadores de self-storage con uno o varios locales: plano, reserva online, contratos, cobros automáticos, Veri*Factu y control de accesos.',
    h1: 'Software para operadores de self-storage',
    lead: 'Tanto si abres tu primer local como si tienes varios, TrasterOS se encarga del día a día: la reserva, el contrato, el cobro, el acceso y la factura, para que tú te dediques a llenar los trasteros.',
    highlights: [
      'Funciona sin personal en el local',
      'Uno o varios locales en la misma cuenta',
      'Usuarios con permisos por local',
      'Migración desde tu programa actual',
    ],
    sections: [
      {
        title: 'Un centro que funciona solo',
        text: 'El cliente reserva y paga online, firma el contrato y recibe su código de acceso. Cada mes se emite su factura y se cobra sola. Tú recibes un aviso cuando algo necesita tu atención: un cobro que falla, una incidencia, una baja.',
      },
      {
        title: 'Varios locales, un solo panel',
        text: 'Cada local con su plano, sus precios, su horario y su equipo. Compara la ocupación y los ingresos de cada uno, y da a cada empleado acceso solo a los locales que lleva.',
      },
      {
        title: 'Empieza sin perder lo que tienes',
        text: 'Importa inquilinos, trasteros, contratos y mandatos SEPA desde CSV o Excel y activa en bloque los contratos que ya facturabas, indicando desde cuándo los factura TrasterOS.',
      },
    ],
    faqs: [
      {
        q: '¿Cuánto cuesta?',
        a: 'Hay un plan gratuito para empezar y planes según el número de trasteros y locales. Todos se prueban 30 días gratis, sin tarjeta.',
      },
      {
        q: '¿Me ayudáis a migrar?',
        a: 'Sí. Puedes importar tus datos tú mismo o pedirnos ayuda con la migración.',
      },
    ],
    related: ['reserva-online', 'control-de-accesos', 'cobros-sepa-tarjeta-bizum'],
    shot: 'dashboard',
  },
  {
    slug: 'administradores-de-trasteros',
    kind: 'solution',
    navTitle: 'Administradores de cartera',
    summary: 'Locales de varios propietarios, con su facturación y su liquidación.',
    metaTitle: 'Software para administrar trasteros de varios propietarios | TrasterOS',
    metaDescription:
      'Gestiona trasteros y locales de varios propietarios: facturas a nombre de cada propietario con Veri*Factu, liquidaciones mensuales con honorarios y fiscalidad por emisor.',
    h1: 'Software para administradores de trasteros de varios propietarios',
    lead: 'Si gestionas locales que no son tuyos, cada propietario necesita sus facturas, su IVA y su liquidación. TrasterOS lo separa por propietario sin que tengas que llevar varias cuentas.',
    highlights: [
      'Facturas emitidas a nombre de cada propietario',
      'Serie y Veri*Factu propios de cada emisor',
      'Liquidación mensual con honorarios y gastos',
      'Libro de IVA, 303 y 347 por propietario',
    ],
    sections: [
      {
        title: 'Cada local, de su propietario',
        text: 'Asigna cada local a su propietario y sus contratos facturan a su nombre, con su NIF, su serie y su cadena de Veri*Factu. Puedes enviar como representante con tu certificado o con el del propietario.',
      },
      {
        title: 'Liquidaciones en un clic',
        text: 'Al final del mes, la liquidación de cada propietario recoge lo cobrado, lo devuelto, tus honorarios (porcentaje o cuota fija, con su IVA) y los gastos de sus locales. Se envía por correo con tu marca.',
      },
      {
        title: 'Fiscalidad por emisor',
        text: 'El libro de IVA, los modelos 303 y 347 y la exportación para la asesoría se sacan por propietario o para tu propia empresa.',
      },
    ],
    faqs: [
      {
        q: '¿Puedo gestionar también viviendas?',
        a: 'Sí, con el extra de viviendas: contrato de vivienda, IVA exento, depósito de la fianza y actualización anual de la renta.',
      },
      {
        q: '¿Cómo se envían las facturas a la AEAT?',
        a: 'Con el certificado del propietario o con el tuyo como representante apoderado. Cada propietario tiene su propia cadena de registros.',
      },
    ],
    related: ['facturacion-veri-factu', 'trasteros-y-viviendas', 'cobros-sepa-tarjeta-bizum'],
  },
  {
    slug: 'trasteros-y-viviendas',
    kind: 'solution',
    navTitle: 'Trasteros y viviendas',
    summary: 'Alquila viviendas junto a tus trasteros, con su contrato y su fianza.',
    metaTitle: 'Gestión de alquiler de trasteros y viviendas | TrasterOS',
    metaDescription:
      'Gestiona viviendas en alquiler junto a tus trasteros: contrato de vivienda, IVA exento, depósito de la fianza, actualización anual de la renta y retención de IRPF.',
    h1: 'Gestión de alquiler de trasteros y viviendas en un solo programa',
    lead: 'Si además de trasteros alquilas viviendas, no necesitas otro programa. Cada vivienda lleva su contrato, su IVA y sus obligaciones, con los mismos cobros y la misma área de clientes.',
    highlights: [
      'Contrato de vivienda con su plantilla',
      'Facturas exentas de IVA bien declaradas',
      'Depósito de la fianza en el organismo de tu comunidad',
      'Actualización anual de la renta con aviso',
    ],
    sections: [
      {
        title: 'Cada inmueble con sus reglas',
        text: 'Marca un tipo como vivienda y sus facturas salen exentas de IVA con su mención legal, con su propia plantilla de contrato. Los trasteros siguen con su IVA y sus condiciones.',
      },
      {
        title: 'Las obligaciones de la vivienda',
        text: 'Lleva el control del depósito de la fianza (fecha, referencia y justificante) y propón la actualización anual de la renta a los contratos que la cumplen. Si el inquilino es una empresa que retiene IRPF, la factura lo refleja.',
      },
      {
        title: 'El mismo día a día',
        text: 'Domiciliación, recordatorios, área de clientes, incidencias y documentos funcionan igual que con los trasteros.',
      },
    ],
    faqs: [
      {
        q: '¿Tengo que contratar algo aparte?',
        a: 'Las viviendas son un extra que se añade a tu plan.',
      },
      {
        q: '¿Sirve para administradores de fincas?',
        a: 'Sí, combinado con el plan para administradores, cada vivienda puede facturar a nombre de su propietario.',
      },
    ],
    related: [
      'administradores-de-trasteros',
      'contratos-firma-electronica',
      'facturacion-veri-factu',
    ],
  },
];

export const ALL_MARKETING_PAGES = [...FEATURE_PAGES, ...SOLUTION_PAGES];

export function marketingPageHref(page: Pick<MarketingPage, 'kind' | 'slug'>): string {
  return `/${page.kind === 'feature' ? 'funcionalidades' : 'soluciones'}/${page.slug}`;
}

export function findMarketingPage(kind: MarketingPage['kind'], slug: string): MarketingPage | null {
  return ALL_MARKETING_PAGES.find((p) => p.kind === kind && p.slug === slug) ?? null;
}

export function relatedPages(page: MarketingPage): MarketingPage[] {
  return page.related
    .map((slug) => ALL_MARKETING_PAGES.find((p) => p.slug === slug))
    .filter((p): p is MarketingPage => !!p);
}

/** Capturas del producto (en `public/screens`), con su texto alternativo. */
export const SCREENSHOTS: Record<ScreenshotKey, { src: string; alt: string; mobile?: boolean }> = {
  dashboard: {
    src: '/screens/resumen.png',
    alt: 'Resumen del panel de TrasterOS con la ocupación, los ingresos y los cobros del mes',
  },
  plan: {
    src: '/screens/plano.png',
    alt: 'Plano de un local de trasteros con el estado de cada trastero por colores',
  },
  invoice: {
    src: '/screens/factura.png',
    alt: 'Ficha de una factura de alquiler de trastero con su registro Veri*Factu',
  },
  portal: {
    src: '/screens/area-clientes.png',
    alt: 'Área de clientes en el móvil con el código de acceso y las facturas del inquilino',
    mobile: true,
  },
  booking: {
    src: '/screens/reserva.png',
    alt: 'Reserva online de un trastero en el móvil con el tamaño, el precio y el pago',
    mobile: true,
  },
};
