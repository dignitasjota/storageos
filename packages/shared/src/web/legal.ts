import { z } from 'zod';

/**
 * Textos legales de la web pública del tenant (aviso legal, privacidad y
 * cookies). La LSSI (art. 10) exige identificar al titular de la web y el
 * RGPD (art. 13) informar de quién trata los datos del formulario y la
 * reserva. Se generan con los datos de facturación del tenant y cada uno se
 * puede sustituir por un texto propio (Markdown).
 */
export const TENANT_LEGAL_DOCS = [
  'aviso-legal',
  'privacidad',
  'cookies',
  'condiciones-contratacion',
] as const;
export type TenantLegalDoc = (typeof TENANT_LEGAL_DOCS)[number];

export function isTenantLegalDoc(v: string): v is TenantLegalDoc {
  return (TENANT_LEGAL_DOCS as readonly string[]).includes(v);
}

export const TENANT_LEGAL_TITLES: Record<TenantLegalDoc, string> = {
  'aviso-legal': 'Aviso legal',
  privacidad: 'Política de privacidad',
  cookies: 'Política de cookies',
  'condiciones-contratacion': 'Condiciones Generales de Contratación',
};

/** Campo del jsonb `web_legal` de cada documento. */
export const TENANT_LEGAL_FIELD = {
  'aviso-legal': 'legalNotice',
  privacidad: 'privacy',
  cookies: 'cookies',
  'condiciones-contratacion': 'terms',
} as const satisfies Record<TenantLegalDoc, string>;

const legalText = z.string().trim().max(30_000).optional();

/** Textos propios (`''` = volver al generado). */
export const UpdateWebLegalSchema = z
  .object({ legalNotice: legalText, privacy: legalText, cookies: legalText, terms: legalText })
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'Debes enviar al menos un campo',
  });
export type UpdateWebLegalInput = z.infer<typeof UpdateWebLegalSchema>;
export type WebLegalTexts = {
  legalNotice?: string;
  privacy?: string;
  cookies?: string;
  terms?: string;
};

/** Parseo defensivo del jsonb `web_legal`; los vacíos se quitan. */
export function parseWebLegal(raw: unknown): WebLegalTexts {
  const out: WebLegalTexts = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ['legalNotice', 'privacy', 'cookies', 'terms'] as const) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}

/** Titular de la web: los datos de facturación del tenant. */
export interface TenantLegalHolder {
  name: string;
  taxId: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
}

export interface TenantLegalContext {
  holder: TenantLegalHolder;
  /** Dirección de la web (`https://dominio` o la de la plataforma). */
  websiteUrl: string;
  /** Tiene Google Analytics configurado. */
  analytics: boolean;
  /** Tiene el botón o el asistente de WhatsApp Business. */
  whatsapp: boolean;
  /** Tiene el chat con IA en la web. */
  webChat?: boolean;
  /** Nombre comercial (el nombre del negocio en la plataforma). */
  tradeName?: string;
  /** Dirección de cada local activo. */
  facilities?: string[];
  /** La baja surte efecto a final de mes (por defecto, sí). */
  moveOutEndOfMonth?: boolean;
  /** Días máximos para devolver la fianza (por defecto, 15). */
  depositReturnDays?: number;
  /** Días que se guardan los registros del control de accesos (por defecto, 180). */
  accessLogDays?: number;
}

/** Las imágenes de videovigilancia se borran como máximo al mes (art. 22.3 LOPDGDD). */
export const VIDEO_SURVEILLANCE_RETENTION_DAYS = 30;

/** Datos del titular que faltan para que el aviso legal esté completo. */
export function missingLegalHolderData(h: TenantLegalHolder): string[] {
  const missing: string[] = [];
  if (!h.taxId) missing.push('NIF');
  if (!h.address) missing.push('domicilio');
  if (!h.email) missing.push('email de contacto');
  return missing;
}

function holderLines(h: TenantLegalHolder): string {
  return [
    `- **Titular:** ${h.name}`,
    h.taxId ? `- **NIF:** ${h.taxId}` : null,
    h.address ? `- **Domicilio:** ${h.address}` : null,
    h.email ? `- **Email:** ${h.email}` : null,
    h.phone ? `- **Teléfono:** ${h.phone}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Texto generado (Markdown) de un documento legal. */
export function buildTenantLegalDoc(doc: TenantLegalDoc, ctx: TenantLegalContext): string {
  const h = ctx.holder;
  if (doc === 'condiciones-contratacion') return buildTermsDoc(ctx);
  const contact = h.email
    ? `escribiendo a ${h.email}`
    : 'a través de los datos de contacto de esta web';
  if (doc === 'aviso-legal') {
    return `## Datos identificativos

En cumplimiento de la Ley 34/2002, de servicios de la sociedad de la información y de comercio electrónico (LSSI), se informa de que esta web (${ctx.websiteUrl}) es de:

${holderLines(h)}

## Objeto

Esta web informa sobre el alquiler de trasteros y espacios de almacenaje de ${h.name}, permite consultar precios y disponibilidad, reservar online y contactar con nosotros.

## Condiciones de uso

El uso de la web implica la aceptación de este aviso legal. Te comprometes a usarla de forma lícita y a no introducir datos falsos o de terceros sin su autorización. Los precios y la disponibilidad que se muestran son orientativos hasta que se confirma la reserva; las condiciones del alquiler son las del contrato que se firma.

## Propiedad intelectual

Los textos, imágenes, logotipos y demás contenidos de la web son de ${h.name} o se usan con autorización. No se pueden reproducir sin permiso.

## Responsabilidad

${h.name} no se hace responsable de los daños derivados de un uso indebido de la web ni de los contenidos de webs de terceros enlazadas desde ella.

## Datos personales y cookies

El tratamiento de los datos personales se explica en la [política de privacidad](./privacidad) y el uso de cookies en la [política de cookies](./cookies).

## Legislación aplicable

Este aviso legal se rige por la legislación española.
`;
  }
  if (doc === 'privacidad') {
    return `## Responsable del tratamiento

${holderLines(h)}

## Qué datos tratamos y para qué

- **Formulario de contacto:** nombre, email, teléfono y mensaje, para responder a tu consulta. Si marcas la casilla, también para enviarte ofertas.
- **Reserva y contrato:** datos identificativos, de contacto y de pago, para gestionar la reserva, el contrato de alquiler, la facturación y el acceso al trastero.
- **Área de clientes:** los datos de tu cuenta, para que consultes tus contratos, facturas y accesos.
- **Control de accesos:** cuando entras o sales del local con tu código, tu tarjeta o el móvil, registramos la fecha, la hora y el acceso utilizado, para la seguridad del local y para gestionar tu contrato.
- **Videovigilancia:** si el local tiene cámaras, siempre señalizadas con carteles, sus imágenes se usan para proteger a las personas, los bienes y las instalaciones.${
      ctx.whatsapp
        ? `
- **WhatsApp:** los mensajes que nos envíes por WhatsApp, para atenderte. Puede responderte un asistente automático y, si lo pides, una persona.`
        : ''
    }${
      ctx.webChat
        ? `
- **Chat de la web:** lo que escribes en el chat, para responderte. Te responde un asistente automático con inteligencia artificial que solo usa la información pública de esta web. La conversación se guarda en tu navegador con un identificador aleatorio y se borra pasados 90 días sin mensajes. Si nos dejas tu nombre, email o teléfono para que te contactemos, los guardamos como consulta junto con la dirección IP y el navegador desde los que escribiste.`
        : ''
    }

## Base legal

- La ejecución del contrato o de las medidas precontractuales que nos pidas (reserva y alquiler).
- El cumplimiento de obligaciones legales (facturación y contabilidad).
- Tu consentimiento, para las comunicaciones comerciales y la analítica de la web. Puedes retirarlo en cualquier momento.
- El interés público en la seguridad de las personas, los bienes y las instalaciones, para la videovigilancia (artículo 22 de la Ley Orgánica 3/2018, de protección de datos).

## Cuánto tiempo los guardamos

Mientras dure la relación y, después, el tiempo que exige la ley (por ejemplo, seis años para la documentación contable y fiscal). Las consultas que no terminan en alquiler se borran pasado un año. Los registros del control de accesos se borran a los ${
      ctx.accessLogDays ?? 180
    } días y las imágenes de videovigilancia, como máximo al mes, salvo que deban conservarse para acreditar hechos ante una autoridad.

## A quién se comunican

No vendemos tus datos. Los tratan por cuenta nuestra los proveedores que necesitamos para dar el servicio: la plataforma de gestión TrasterOS (alojamiento y gestión de reservas, contratos y facturas), las entidades de pago y el banco para cobrar, el proveedor de correo electrónico${
      ctx.analytics ? ' y Google (analítica de la web, solo si la aceptas)' : ''
    }${ctx.whatsapp ? ' y Meta (WhatsApp)' : ''}${
      ctx.webChat
        ? ', y el proveedor de inteligencia artificial que responde en el chat de la web (Anthropic)'
        : ''
    }. También a las administraciones públicas cuando lo exige la ley (por ejemplo, la Agencia Tributaria) y, si hace falta, las imágenes de videovigilancia a las fuerzas y cuerpos de seguridad o a los juzgados.

## Tus derechos

Puedes pedir acceso, rectificación, supresión, oposición, limitación del tratamiento y portabilidad de tus datos ${contact}. Si crees que no hemos atendido bien tu solicitud, puedes reclamar ante la Agencia Española de Protección de Datos (www.aepd.es).
`;
  }
  return `## Qué son las cookies

Las cookies son pequeños archivos que la web guarda en tu navegador para funcionar o para saber cómo se usa.

## Cookies que usamos

- **Necesarias:** permiten que la web funcione (por ejemplo, recordar tu sesión en el área de clientes o tu elección sobre las cookies). No necesitan tu consentimiento.${
    ctx.analytics
      ? `
- **Analítica (Google Analytics):** nos dicen cuántas personas visitan la web y qué páginas ven, de forma agregada. Solo se activan si las aceptas en el aviso de cookies. Proveedor: Google Ireland Ltd.`
      : ''
  }

${
  ctx.analytics
    ? 'Puedes cambiar tu elección en cualquier momento con el enlace «Configurar cookies» del pie de la web.'
    : 'Esta web no usa cookies de analítica ni de publicidad.'
}

## Cómo desactivarlas

También puedes borrar o bloquear las cookies desde la configuración de tu navegador. Si bloqueas las necesarias, algunas partes de la web pueden no funcionar.

## Contacto

Si tienes dudas sobre las cookies, puedes contactar con ${h.name} ${contact}.
`;
}

/**
 * Condiciones generales de contratación (reserva y alquiler online). Revisables
 * por el tenant con su asesoría: el texto propio sustituye a este.
 */
function buildTermsDoc(ctx: TenantLegalContext): string {
  const h = ctx.holder;
  const brand = ctx.tradeName?.trim() || h.name;
  const places = (ctx.facilities ?? []).filter((f) => f.trim());
  const holder = [
    `- **Razón social:** ${h.name}`,
    brand !== h.name ? `- **Nombre comercial:** ${brand}` : null,
    h.taxId ? `- **NIF:** ${h.taxId}` : null,
    h.address ? `- **Domicilio social:** ${h.address}` : null,
    places.length === 1 ? `- **Establecimiento:** ${places[0]}` : null,
    places.length > 1
      ? `- **Establecimientos:**\n${places.map((p) => `  - ${p}`).join('\n')}`
      : null,
    h.email ? `- **Correo electrónico:** ${h.email}` : null,
    h.phone ? `- **Teléfono:** ${h.phone}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const contactList = [
    h.email ? `- **Correo electrónico:** ${h.email}` : null,
    h.phone ? `- **Teléfono:** ${h.phone}` : null,
    `- **Sitio web:** ${ctx.websiteUrl}`,
  ]
    .filter(Boolean)
    .join('\n');
  const withdrawTo = h.email
    ? `enviada a ${h.email}`
    : 'enviada a través de los datos de contacto de esta web';

  return `## 1. Identificación del titular

Las presentes Condiciones Generales de Contratación regulan las reservas y contrataciones de espacios de almacenamiento realizadas a través del sitio web ${ctx.websiteUrl}, bajo el nombre comercial **${brand}**.

El titular del servicio es:

${holder}

En adelante, ${brand}.

## 2. Objeto del servicio

${brand} ofrece el alquiler de trasteros, taquillas y espacios individuales de almacenamiento, destinados principalmente al depósito y custodia por parte del cliente de bienes y objetos de su propiedad o sobre los que disponga de autorización legítima.

El servicio consiste en la puesta a disposición de un espacio delimitado para almacenamiento, en las condiciones establecidas en el correspondiente contrato de alquiler.

Salvo pacto expreso en contrario, ${brand} no realiza servicios de transporte, manipulación, inventario ni custodia individualizada de los objetos depositados.

La contratación del servicio implica la aceptación de las presentes condiciones y de las condiciones particulares del contrato de alquiler correspondiente.

## 3. Requisitos para contratar

Para contratar los servicios de ${brand}, el cliente deberá:

- Ser mayor de 18 años y disponer de capacidad legal para contratar.
- Facilitar datos personales y de contacto veraces y actualizados.
- Proporcionar la información necesaria para formalizar el contrato y emitir los justificantes de pago o facturas correspondientes.
- Aceptar las presentes condiciones y el contrato de alquiler aplicable.
- Realizar los pagos correspondientes mediante los medios habilitados.

El cliente será responsable de mantener actualizada su información de contacto y de custodiar sus credenciales de acceso.

## 4. Proceso de reserva y contratación online

La contratación a través de la web se realizará mediante los siguientes pasos:

1. **Selección del espacio:** el cliente seleccionará el trastero o espacio disponible según sus dimensiones, características y precio.
2. **Identificación:** el cliente introducirá los datos necesarios para tramitar la reserva o contratación.
3. **Revisión:** antes del pago, podrá comprobar los datos introducidos, el espacio seleccionado, la fecha de inicio, el importe y las condiciones aplicables, así como corregir posibles errores.
4. **Aceptación:** el cliente deberá aceptar expresamente las presentes condiciones y, cuando corresponda, el contrato de alquiler.
5. **Pago:** el cliente realizará el pago mediante alguno de los medios habilitados en la plataforma.
6. **Confirmación:** una vez validada la operación y cumplidos los requisitos aplicables, ${brand} enviará una confirmación al correo electrónico facilitado.

La confirmación indicará el espacio reservado o contratado, los importes abonados y la fecha prevista de inicio del servicio.

Cuando la operación constituya una reserva anticipada, esta no supondrá la disponibilidad inmediata del trastero, sino el compromiso de asignación para la fecha indicada, conforme a las condiciones específicas comunicadas durante la reserva.

Los contratos se formalizarán en español y se facilitará al cliente una copia en formato electrónico que pueda conservar.

El cliente podrá solicitar una copia de su documentación contractual a través de los canales de contacto de ${brand}.

## 5. Precios e impuestos

Los precios de los trasteros se mostrarán en euros y se informará claramente de los impuestos aplicables antes de confirmar cualquier pago.

El importe final de la contratación, incluidos los impuestos y cualquier otro gasto obligatorio, se mostrará antes de realizar el pago.

El precio dependerá de las dimensiones, características y condiciones particulares del espacio seleccionado.

Los posibles descuentos, promociones o tarifas especiales estarán sujetos a las condiciones específicas indicadas en cada oferta.

${brand} podrá modificar los precios publicados para futuras contrataciones. Estas modificaciones no afectarán retroactivamente a los importes ya devengados ni a las condiciones contractuales vigentes, salvo en los supuestos legal o contractualmente previstos.

## 6. Pagos y facturación

Los pagos online se procesarán mediante una pasarela de pago segura proporcionada por la entidad financiera correspondiente.

${brand} no almacena los datos completos de las tarjetas bancarias utilizadas por sus clientes.

En el proceso de contratación se indicarán claramente:

- El importe correspondiente al alquiler.
- La periodicidad de los pagos.
- La fianza o garantía exigida, cuando proceda.
- Las posibles promociones o descuentos.
- El importe total que se abonará en ese momento.

Las renovaciones, vencimientos, medios de pago posteriores y consecuencias del impago se regirán por el contrato de alquiler suscrito.

Si el cliente guarda una tarjeta o domicilia los pagos en su cuenta, autoriza a ${brand} a cobrar en ella cada cuota y las demás cantidades del contrato cuando venzan. Puede cambiar la tarjeta o la cuenta, o pasar a pagar por otro medio, desde el área de clientes.

Por un pago atrasado, devuelto o rechazado solo se aplicarán el recargo y los gastos de gestión que figuren en el contrato de alquiler, que no superarán el coste de gestionarlo.

La cuota podrá actualizarse una vez al año conforme a la variación del Índice de Precios al Consumo (IPC) publicado por el Instituto Nacional de Estadística, o el índice que lo sustituya, avisando al cliente con al menos 30 días de antelación. Si no está de acuerdo, el cliente podrá darse de baja antes de esa fecha sin penalización.

En caso de impago, ${brand} avisará al cliente para que lo regularice y, si sigue sin pagarse, podrá suspender sus entradas al establecimiento hasta que lo haga; aun así, el cliente podrá pedir cita para retirar sus pertenencias. Si el impago continúa, ${brand} le requerirá por escrito, por un medio que deje constancia, que pague en un plazo no inferior a 15 días, advirtiéndole de que, si no lo hace, el contrato quedará resuelto. Resuelto el contrato, el cliente deberá retirar sus bienes; si no lo hace, ${brand} podrá trasladarlos a otro espacio para guardarlos, con inventario y fotografías, y el cliente podrá recuperarlos cuando lo pida, pagando los gastos razonables y justificados del traslado y la custodia que se le reclamen. ${brand} solo venderá, destruirá o dispondrá de otro modo de los bienes por los cauces que permita la ley.

Cualquier cargo recurrente o posterior deberá contar con la autorización correspondiente y ajustarse a las condiciones comunicadas al cliente.

El cliente podrá solicitar su factura o justificante mediante los canales habilitados, sin perjuicio de las obligaciones legales de facturación de ${brand}.

## 7. Fianza o garantía

Cuando la contratación requiera una fianza o garantía, su importe se comunicará antes de completar la operación.

La finalidad de dicha garantía será responder de las obligaciones del cliente en los términos establecidos en el contrato de alquiler y en la normativa aplicable.

La fianza no tendrá la consideración de una mensualidad de alquiler abonada por adelantado, salvo que se establezca expresamente lo contrario.

Se devolverá en un plazo máximo de ${
    ctx.depositReturnDays ?? 15
  } días desde que el cliente entregue el espacio vacío, una vez comprobado su estado y las cantidades pendientes.

Cualquier descuento o retención deberá responder a conceptos justificados y legalmente exigibles, y se comunicará al cliente con su detalle.

## 8. Reservas anticipadas

${brand} podrá permitir la reserva de trasteros antes de su fecha efectiva de disponibilidad, incluida la apertura de nuevos establecimientos.

En estos casos, el cliente será informado de:

- La fecha prevista de disponibilidad del espacio.
- El importe necesario para formalizar la reserva.
- Las cantidades correspondientes al alquiler y a la fianza.
- Las condiciones aplicables a la cancelación.
- Las promociones asociadas a la reserva, cuando existan.

Las cantidades abonadas serán imputadas a los conceptos expresamente indicados en el justificante de reserva.

Si ${brand} no pudiera poner a disposición del cliente el espacio reservado en la fecha comprometida, informará de dicha circunstancia y ofrecerá una nueva fecha de disponibilidad o una alternativa equivalente, que el cliente podrá aceptar o rechazar.

En caso de rechazo, el cliente tendrá derecho a solicitar la devolución íntegra de las cantidades abonadas por el servicio no prestado, sin perjuicio de los demás derechos que legalmente le correspondan.

## 9. Cancelación y derecho de desistimiento

Los clientes que tengan la condición legal de consumidores y celebren contratos a distancia dispondrán, con carácter general, de un plazo de **14 días naturales para ejercer el derecho de desistimiento**, salvo que resulte aplicable alguna excepción legal.

Cuando proceda este derecho, su plazo se contará desde la celebración del contrato de servicios.

El cliente podrá comunicar su decisión de desistir mediante una declaración inequívoca ${withdrawTo}, indicando sus datos identificativos y la referencia de la contratación, o desde el área de clientes («Desistir del contrato»). Puede usar este modelo de formulario, aunque no es obligatorio:

> **Modelo de formulario de desistimiento** (solo debe cumplimentarlo y enviarlo si desea desistir del contrato)
>
> A la atención de ${h.name}${h.address ? `, ${h.address}` : ''}${h.email ? `, ${h.email}` : ''}:
>
> Por la presente le comunico que desisto de mi contrato de prestación del siguiente servicio: alquiler del trastero ________ (contrato ________).
>
> Celebrado el: ________
>
> Nombre del consumidor: ________
>
> Domicilio del consumidor: ________
>
> Firma del consumidor (solo si el presente formulario se presenta en papel): ________
>
> Fecha: ________

No será necesario justificar su decisión.

Si el cliente solicita expresamente que el servicio comience durante el periodo de desistimiento (lo hace con una casilla al firmar el contrato) y posteriormente ejerce dicho derecho dentro del plazo legal, ${brand} podrá exigir el importe proporcional al servicio efectivamente prestado hasta la comunicación del desistimiento, cuando legalmente corresponda. Sin esa solicitud, el cliente no paga nada por el tiempo que haya tenido el espacio.

La pérdida del derecho de desistimiento por ejecución completa del servicio únicamente se producirá cuando concurran los requisitos legales aplicables.

Los reembolsos derivados del ejercicio válido del derecho de desistimiento se realizarán en los plazos y condiciones legalmente establecidos, utilizando, como regla general, el mismo medio de pago empleado inicialmente.

Una vez finalizado el plazo de desistimiento, las bajas, cancelaciones y terminación del alquiler se regirán por las condiciones particulares del contrato y por la normativa aplicable.

Estas condiciones no limitarán los derechos irrenunciables de los consumidores.

## 10. Duración del alquiler y renovaciones

La duración inicial del alquiler, su fecha de comienzo, su periodicidad y, en su caso, las condiciones de renovación se especificarán en el contrato particular de cada cliente.

Las condiciones de preaviso, baja y terminación serán las expresamente aceptadas en dicho contrato, respetando la legislación aplicable.

La contratación online no implica necesariamente una permanencia mínima distinta de la indicada expresamente antes del pago.

La baja del servicio deberá comunicarse por escrito, al correo electrónico de ${brand} o desde el área de clientes, indicando el nombre del cliente y el espacio alquilado, con la antelación prevista en el contrato. ${
    ctx.moveOutEndOfMonth === false
      ? 'Surte efecto el día que indique el cliente, respetando esa antelación.'
      : 'Surte efecto el último día del mes en que se cumpla esa antelación, y ese mes se paga completo.'
  } Dejar el espacio vacío antes no adelanta la baja ni exime del pago de las cantidades devengadas hasta su fecha efectiva.

Si el cliente pagó varios meses por adelantado y se da de baja antes de usarlos todos, se le devuelven los meses enteros que no llegue a usar; los meses usados se cobran a la cuota mensual del contrato, sin el descuento ni los meses gratis que tuviera ese pago.

## 11. Acceso a las instalaciones

El acceso al establecimiento se realizará mediante los sistemas habilitados por ${brand}, que podrán incluir códigos personales, dispositivos electrónicos u otros mecanismos de identificación.

El horario de acceso disponible para el cliente será el indicado en las características del centro y en su contrato.

Las credenciales de acceso serán personales y deberán utilizarse conforme a las normas de seguridad del establecimiento.

El cliente responde de las personas a las que dé acceso (acompañantes, transportistas o personas autorizadas), y deberá comunicar cualquier pérdida, uso indebido o incidencia relacionada con sus credenciales.

Si el sistema de acceso falla y el cliente no puede entrar, podrá comunicarlo por los canales de contacto y ${brand} le atenderá lo antes posible y le dará otra forma de acceder.

Por motivos de seguridad, mantenimiento, emergencia o causas legalmente justificadas, podrán producirse restricciones temporales de acceso, que se gestionarán procurando minimizar las molestias al cliente.

## 12. Normas de utilización

Los espacios alquilados deberán utilizarse exclusivamente para los fines de almacenamiento autorizados en el contrato.

El cliente declara que es el legítimo poseedor de los bienes que guarda, que su procedencia es lícita y que no están embargados ni sujetos a ningún procedimiento de ejecución o reclamación.

Queda prohibido, salvo que la normativa y el contrato permitan expresamente otra cosa:

- Guardar alimentos, bebidas, piensos o cualquier producto perecedero.
- Almacenar productos químicos, tóxicos, corrosivos, inflamables o explosivos, bombonas de gas o combustibles.
- Guardar vehículos, motores o maquinaria con combustible o con la batería conectada.
- Guardar baterías de litio dañadas, hinchadas o manipuladas.
- Guardar armas, municiones o explosivos.
- Guardar objetos o sustancias prohibidos por la ley o de procedencia ilícita.
- Introducir animales, vivos o muertos, o plantas.
- Guardar basura, residuos o materiales que puedan descomponerse, generar humedad, olores o plagas, o dañar el espacio, los de alrededor o los bienes de otros clientes.
- Cargar baterías, enchufar o hacer funcionar aparatos eléctricos dentro del espacio, o hacer en él nada que produzca calor, llama o humo.
- Instalar otras cerraduras o sistemas de cierre, o hacer obras o modificaciones en el espacio, sin autorización escrita de ${brand}.
- Utilizar los trasteros como vivienda, oficina de atención al público o lugar de residencia.
- Realizar actividades comerciales o industriales dentro de los espacios que no estén expresamente autorizadas.
- Manipular las instalaciones eléctricas, de seguridad o de protección contra incendios.
- Superar la carga máxima indicada en el espacio o en el módulo, o colgar o apoyar peso en sus paredes, puertas o estructura.
- Dejar objetos fuera del espacio u ocupar pasillos, salidas de emergencia o el acceso a los medios contra incendios.
- Fumar en el establecimiento.

El cliente será responsable de utilizar el espacio de forma diligente, respetando las instalaciones, las zonas comunes y los derechos de los demás usuarios, y de los daños que causen los bienes guardados incumpliendo estas normas.

${brand} solo abrirá el espacio por una emergencia, por requerimiento de una autoridad, por obras imprescindibles en el establecimiento o en los casos de impago previstos en el contrato. Salvo urgencia o requerimiento legal, avisará antes al cliente del motivo, y el cliente podrá estar presente; si lo abre sin él, levantará acta con la fecha, el motivo, las personas que intervienen y lo que se haga, con fotografías, y se la enviará. Si por un motivo justificado hubiera que trasladar los bienes a otro espacio de características equivalentes, se avisará al cliente con antelación, salvo urgencia, para que pueda hacerlo por sí mismo; si no, lo hará ${brand} sin coste para él y con el cuidado debido.

## 13. Seguridad y responsabilidad

${brand} podrá disponer de sistemas de videovigilancia, señalizados con carteles, control de accesos, alarmas y otras medidas de seguridad destinadas a la protección de las personas, los bienes y las instalaciones. Las imágenes de videovigilancia se conservan como máximo un mes, salvo que deban guardarse para acreditar hechos ante una autoridad.

La existencia de estas medidas no constituye una garantía absoluta frente a robos, daños u otras incidencias.

El cliente será responsable de la correcta utilización y cierre de su espacio, así como de cumplir las condiciones de almacenamiento acordadas.

La responsabilidad de ${brand} por daños, pérdidas o incumplimientos se determinará conforme al contrato y a la normativa aplicable, sin excluir ni limitar los derechos legalmente reconocidos al cliente.

${brand} no asegura los bienes que guarda el cliente, salvo la protección de contenido que figure en su contrato, con la cobertura y los límites de su plan. Se recomienda al cliente asegurarlos por su cuenta (muchas pólizas de hogar los cubren fuera de la vivienda).

Se desaconseja guardar dinero en efectivo, joyas, obras de arte, antigüedades, documentos al portador u objetos de valor sentimental. ${brand} no responde de un valor especial o sentimental que no se le haya comunicado ni de los daños por caso fortuito, fuerza mayor, el paso del tiempo o los defectos propios de los objetos.

El cliente debe comunicar por escrito cualquier daño, robo o pérdida en cuanto lo descubra y, si es un robo, denunciarlo.

El cliente debe mantener actualizados sus datos de contacto y de pago.

## 14. Incidencias, reclamaciones y atención al cliente

Para cualquier consulta, incidencia o reclamación relacionada con una reserva, pago o contratación, el cliente podrá contactar con ${brand} mediante:

${contactList}

${brand} atenderá las reclamaciones recibidas y facilitará una respuesta dentro de los plazos legalmente exigibles.

Los consumidores podrán acudir a los organismos públicos de consumo competentes y ejercer los mecanismos de reclamación y resolución de conflictos que les reconozca la normativa aplicable.

## 15. Protección de datos personales

Los datos personales facilitados durante el proceso de reserva y contratación, y los que se generen al usar el establecimiento (registros del control de accesos e imágenes de videovigilancia, cuando existan), serán tratados conforme a la normativa vigente de protección de datos.

La información relativa a los responsables del tratamiento, finalidades, bases jurídicas, plazos de conservación y ejercicio de derechos se encuentra disponible en la [política de privacidad](./privacidad).

## 16. Modificaciones de las condiciones

${brand} podrá actualizar las presentes condiciones para adaptarlas a cambios normativos, técnicos o comerciales.

Las modificaciones se publicarán en esta página, indicando su fecha de actualización.

Las condiciones aplicables a cada contratación serán las aceptadas por el cliente en el momento de formalizarla, sin perjuicio de las modificaciones válidamente pactadas o legalmente exigibles.

## 17. Legislación aplicable y resolución de conflictos

Las presentes condiciones se regirán por la legislación española.

Cualquier controversia relacionada con la contratación se resolverá conforme a la normativa aplicable y ante los juzgados y tribunales que resulten legalmente competentes.

Cuando el cliente tenga la condición de consumidor, se respetarán las normas imperativas de protección de consumidores y usuarios, incluidas las relativas a competencia judicial.

## 18. Aceptación de las condiciones

La realización de una reserva o contratación mediante la web requerirá la aceptación expresa de las presentes Condiciones Generales de Contratación.

Antes de confirmar la operación, el cliente podrá acceder a ellas para su lectura, descarga y conservación.

La aceptación de estas condiciones no sustituye la aceptación del contrato particular de alquiler ni de aquellas cláusulas que legalmente requieran consentimiento específico.
`;
}

/** Documento legal de la web pública (`GET /public/landing/:slug/legal/:doc`). */
export interface PublicLegalDocDto {
  tenantName: string;
  tenantSlug: string;
  brandColor: string | null;
  logoUrl: string | null;
  customDomain: string | null;
  googleAnalyticsId: string | null;
  doc: TenantLegalDoc;
  title: string;
  markdown: string;
}

/** Ajustes de los textos legales (Configuración → Textos legales). */
export interface WebLegalSettingsDto {
  /** Textos propios guardados (sin los vacíos). */
  texts: WebLegalTexts;
  /** Lo que se publica si no hay texto propio. */
  generated: Record<TenantLegalDoc, string>;
  holder: TenantLegalHolder;
  /** Datos del titular que faltan (se completan en Suscripción → Datos de facturación). */
  missing: string[];
}
