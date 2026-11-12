-- Blog de la web de TrasterOS (trasteros.pro/blog): guías para quien gestiona
-- o va a abrir un negocio de trasteros. Lo escribe el super admin. Tabla global
-- (sin tenant).

CREATE TABLE "platform_blog_posts" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "excerpt" TEXT,
  "content_markdown" TEXT NOT NULL,
  "cover_image_key" TEXT,
  "cover_image_alt" TEXT,
  "seo_title" TEXT,
  "seo_description" TEXT,
  "is_published" BOOLEAN NOT NULL DEFAULT false,
  "published_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_blog_posts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_blog_posts_slug_key" ON "platform_blog_posts" ("slug");
CREATE INDEX "platform_blog_posts_published_idx"
  ON "platform_blog_posts" ("is_published", "published_at" DESC);

REVOKE ALL ON platform_blog_posts FROM storageos_app;

-- Primeras guías, como borradores: no se ven en la web hasta que el super
-- admin las revise y las publique.

INSERT INTO "platform_blog_posts" ("slug", "title", "excerpt", "content_markdown", "seo_title", "seo_description")
VALUES ($md$como-montar-un-negocio-de-trasteros$md$, $md$Cómo montar un negocio de alquiler de trasteros: guía paso a paso$md$, $md$De la zona y el local a los primeros inquilinos: licencia, tamaños, precios, contrato, accesos, cobros y captación.$md$, $md$El alquiler de trasteros (self-storage) es un negocio sencillo de entender: compras o alquilas un local, lo divides en espacios cerrados de distintos tamaños y los alquilas por meses. Detrás de esa sencillez hay decisiones que marcan la rentabilidad: dónde abrir, qué tamaños ofrecer, cómo cobrar y cómo atender sin estar todo el día en el local. En esta guía repasamos los pasos, de la idea a los primeros inquilinos.

## 1. Estudia la zona antes que el local

La demanda de trasteros es muy local: la mayoría de clientes vive o trabaja a menos de 10-15 minutos. Antes de buscar nave, mira:

- **Densidad de viviendas**, sobre todo pisos pequeños sin trastero propio.
- **Competencia cercana**: cuántos centros hay, qué tamaños ofrecen y a qué precio. Llama o reserva online como si fueras cliente y apunta lo que te digan.
- **Accesos**: aparcamiento o zona de carga, calle fácil de encontrar y buena visibilidad.
- **Pequeños negocios y autónomos** de la zona (reformas, comercio online, profesionales con material): suelen alquilar trasteros grandes y durante más tiempo.

## 2. Elige el local y comprueba la licencia

Puedes empezar con un local a pie de calle, una planta baja o una nave. Antes de firmar nada:

- Pregunta en tu **ayuntamiento** si el uso de almacenaje es compatible con ese local y qué trámite piden (licencia de actividad o declaración responsable, según el municipio).
- Pide a un técnico que revise la **seguridad contra incendios**, la ventilación y la evacuación: suele ser lo que más condiciona la distribución.
- Calcula la **superficie útil alquilable**: entre pasillos, accesos y zonas comunes, no todo el local se convierte en trasteros.

## 3. Decide los tamaños y el plano

Una mezcla habitual es combinar muchos trasteros pequeños (de 1 a 4 m²), que se alquilan antes y rinden más por metro, con algunos medianos y unos pocos grandes. Dibuja el plano con los pasillos, numera cada trastero y piensa por dónde entrará la gente con carros.

Un consejo: deja hueco para cambiar. Al cabo de unos meses verás qué tamaños se agotan y cuáles se quedan vacíos, y te convendrá ajustar.

## 4. Fija los precios con datos

Parte de los precios de la competencia cercana para cada tamaño y ajústalos por lo que ofreces: acceso 24 horas, vigilancia, planta baja, acceso con vehículo… Revísalos cada pocos meses según tu ocupación: si un tamaño está casi lleno, tiene margen para subir; si lleva semanas vacío, quizá necesite una oferta.

Recuerda que el alquiler de un trastero lleva **IVA del 21 %** (salvo que sea accesorio al alquiler de una vivienda). Anuncia siempre el precio final con IVA para particulares.

Para hacerte una idea de lo que puede dar tu local, prueba nuestra [calculadora de rentabilidad de trasteros](/calculadora-rentabilidad-trasteros).

## 5. Contrato, fianza y condiciones

Prepara un contrato claro, revisado por un abogado, que recoja al menos:

- Duración, renovación y preaviso para darse de baja.
- Precio, forma de pago y qué pasa si un recibo se devuelve.
- Fianza y cuándo se devuelve.
- Objetos prohibidos (perecederos, inflamables, animales…) y que los bienes no están asegurados por el operador, salvo que ofrezcas un seguro.
- Qué ocurre en caso de impago: avisos, corte de acceso y procedimiento si la deuda no se paga.

## 6. Accesos y seguridad

El cliente de trasteros valora poder entrar cuando quiere. Lo más común hoy es un **control de accesos** con PIN, tarjeta o apertura desde el móvil, cámaras y alarma. Elige un sistema que se pueda gestionar desde un programa: así das y quitas accesos sin ir al local y puedes cortar el acceso a quien no paga.

## 7. Cobros sin perseguir a nadie

Los impagos son el gran enemigo de este negocio. Desde el primer día:

- Cobra la **primera mensualidad y la fianza al contratar**.
- Usa **domiciliación SEPA o tarjeta guardada** para las cuotas: el cobro sale solo cada mes.
- Programa **recordatorios automáticos** y define cuándo se corta el acceso.

## 8. Factura conforme a la ley

Si facturas con un programa, desde 2027 tendrá que cumplir el reglamento **Veri\*Factu** de la Agencia Tributaria. Te lo contamos en [Veri\*Factu en un negocio de trasteros](/blog/veri-factu-trasteros).

## 9. Capta los primeros clientes

- Crea tu **ficha de Google Business Profile** con fotos, horario y teléfono: es por donde llega la mayoría.
- Ten una **web con precios y reserva online**: mucha gente reserva por la noche o el fin de semana.
- Pide **reseñas** a los primeros clientes.
- Prueba carteles en el propio local y acuerdos con inmobiliarias, empresas de mudanzas y reformas.

## 10. Organízate para no estar siempre en el local

Un centro bien montado puede funcionar casi sin personal: reserva y firma online, cobros automáticos, accesos que se activan solos al pagar y avisos cuando algo necesita tu atención. Así puedes dedicar el tiempo a llenar los trasteros y no al papeleo.

TrasterOS reúne todo esto en un solo programa: plano de trasteros, contratos con firma electrónica, facturación Veri\*Factu, cobros por SEPA, tarjeta y Bizum, control de accesos y web con reserva online. Puedes [probarlo gratis 30 días](/register).$md$, $md$Cómo montar un negocio de trasteros paso a paso | TrasterOS$md$, $md$Guía para abrir un negocio de alquiler de trasteros: estudio de la zona, licencia, plano, precios, contrato, accesos, cobros y captación de clientes.$md$);

INSERT INTO "platform_blog_posts" ("slug", "title", "excerpt", "content_markdown", "seo_title", "seo_description")
VALUES ($md$veri-factu-trasteros$md$, $md$Veri*Factu en un negocio de trasteros: qué cambia y cuándo$md$, $md$Qué es Veri*Factu, a quién afecta, desde cuándo es obligatorio y qué tienes que comprobar en tu programa de facturación.$md$, $md$Si alquilas trasteros y facturas con un programa, el reglamento **Veri\*Factu** te afecta. Cambia cómo tiene que funcionar el programa con el que emites las facturas, no cómo las cobras ni lo que cobras. Te contamos qué es, a quién afecta, desde cuándo y qué tienes que comprobar en tu negocio.

> Esta guía es informativa. Para tu caso concreto, consulta con tu asesoría.

## Qué es Veri\*Factu

Es el nombre con el que se conoce el **Reglamento de requisitos de los sistemas informáticos de facturación**, que desarrolla la ley antifraude. Su objetivo es que las facturas no se puedan alterar ni borrar sin dejar rastro. Para ello, el programa de facturación tiene que:

- Generar un **registro de cada factura** en el momento de emitirla.
- **Encadenar** cada registro con el anterior mediante una huella (hash), de modo que cualquier cambio se detecte.
- Incluir en la factura un **código QR** con el que el cliente puede comprobarla en la sede de la Agencia Tributaria.
- Guardar el registro de lo que pasa (anulaciones, errores, incidencias).

## Las dos formas de cumplir

- **Modalidad VERI\*FACTU**: el programa envía cada registro a la Agencia Tributaria en el momento. La factura lleva la mención «VERI\*FACTU» o «Factura verificable en la sede electrónica de la AEAT».
- **Modalidad no verificable**: los registros se guardan firmados en el propio programa, con más requisitos de conservación y la obligación de entregarlos si Hacienda los pide.

La primera es la más sencilla para un negocio pequeño: el envío lo hace el programa y no tienes que custodiar nada aparte.

## A quién afecta

A los empresarios y profesionales que emiten facturas con un programa informático, también a los negocios de trasteros. Quedan fuera, entre otros:

- Quienes ya están en el **Suministro Inmediato de Información (SII)**.
- Los negocios de **País Vasco y Navarra**, que tienen sus propios sistemas (TicketBAI y equivalentes).
- Quien factura **a mano**, sin programa.

## Desde cuándo

Tras el aplazamiento aprobado a finales de 2025, las fechas son:

- **1 de enero de 2027** para las empresas que tributan por el Impuesto sobre Sociedades.
- **1 de julio de 2027** para el resto (autónomos y demás).

Puedes empezar antes de forma voluntaria. Ten en cuenta que, una vez que envías registros en un año, la renuncia solo puede hacerse efectiva a final de ese año.

## Qué cambia en el día a día de un negocio de trasteros

- **Las facturas mensuales** de cada trastero se emiten igual, pero cada una genera su registro y su QR.
- **No se puede borrar ni modificar** una factura emitida: si hay un error, se hace una **factura rectificativa** (por diferencias o por sustitución).
- **Anular** una factura emitida por error queda registrado como anulación.
- Si la Agencia Tributaria rechaza un registro (por ejemplo, por un NIF mal escrito), hay que **corregirlo y volver a enviarlo**.
- Las facturas simplificadas (tickets) también entran.

## Qué tienes que comprobar en tu programa

1. Que el fabricante haya presentado la **declaración responsable** de que el programa cumple el reglamento.
2. Que el QR salga en las facturas y en el PDF que mandas al cliente.
3. Que puedas hacer **rectificativas** y **anulaciones** desde el programa, sin tocar facturas emitidas.
4. Que veas qué facturas ha **aceptado** la Agencia Tributaria y cuáles hay que revisar.
5. Que tu asesoría pueda seguir recibiendo el **libro de IVA** y los datos para el 303 y el 347.

## Errores habituales que conviene evitar

- **Seguir con hojas de cálculo** o plantillas de texto para facturar. A partir de las fechas obligatorias no sirven si se usa un programa para generarlas.
- **Cambiar el NIF o el importe de una factura ya emitida.** Siempre con rectificativa.
- **Dejar las facturas sin NIF del cliente** cuando tendrían que llevarlo: en una factura completa, el destinatario tiene que estar identificado.

## Cómo lo resuelve TrasterOS

TrasterOS emite las facturas de tus trasteros conforme a Veri\*Factu: cada factura lleva su registro encadenado, su QR y se envía a la Agencia Tributaria con el certificado de tu empresa. Puedes rectificar, anular y corregir registros rechazados desde la ficha de la factura, y tu asesoría tiene el libro de IVA y los modelos 303 y 347 listos. Más detalle en [facturación Veri\*Factu para trasteros](/funcionalidades/facturacion-veri-factu).$md$, $md$Veri*Factu para negocios de trasteros: fechas y requisitos | TrasterOS$md$, $md$Qué es Veri*Factu, desde cuándo es obligatorio (2027) y qué cambia al facturar el alquiler de trasteros: registros, QR, rectificativas y anulaciones.$md$);

INSERT INTO "platform_blog_posts" ("slug", "title", "excerpt", "content_markdown", "seo_title", "seo_description")
VALUES ($md$como-reducir-impagos-trasteros$md$, $md$Cómo reducir los impagos en un negocio de trasteros$md$, $md$Cobro por adelantado, domiciliación, recordatorios, reintentos, corte de acceso y planes de pago: el proceso que evita la mayoría de impagos.$md$, $md$En un negocio de trasteros, un impago no solo es una cuota que no entra: es un trastero ocupado que no puedes alquilar a otro y horas de llamadas y correos. La buena noticia es que la mayoría de impagos se evitan con un buen proceso desde el primer día. Estas son las medidas que mejor funcionan.

> Esta guía es informativa. Las medidas sobre el acceso y los bienes del inquilino deben estar en tu contrato; revísalo con tu abogado.

## 1. Cobra por adelantado al contratar

Pide la **primera mensualidad y la fianza** antes de dar el acceso. Si el cliente reserva online, que pague en la misma reserva: así no hay trasteros «apartados» que nunca se pagan.

## 2. Domicilia o guarda la tarjeta

El recibo que sale solo es el que menos se olvida:

- **Domiciliación SEPA**: el cliente firma un mandato y cada mes cobras con una remesa o con una pasarela. Es la forma más barata.
- **Tarjeta guardada**: el cobro se hace solo cada mes.
- **Bizum** o pago con enlace para quien prefiere pagar cada mes a mano.

Lo importante es que el cliente no tenga que acordarse.

## 3. Avisa antes de que venza

Un recordatorio unos días antes del cargo, con el importe, evita sorpresas y devoluciones. Si el cobro falla, avisa al momento con un enlace para pagar.

## 4. Reintenta los cobros fallidos

Muchas devoluciones son puntuales: tarjeta caducada, falta de saldo un día concreto… Reintentar el cobro unos días después recupera buena parte de ellas sin que tengas que hacer nada.

## 5. Ten un calendario de reclamación claro

Define qué pasa y cuándo, y que el cliente lo sepa desde el contrato. Un ejemplo:

1. **Día 1**: aviso de pago pendiente con enlace para pagar.
2. **Día 7**: segundo aviso y, si lo has pactado, recargo por mora.
3. **Día 14**: se **suspende el acceso** al centro hasta que pague.
4. **Día 30 en adelante**: requerimiento por escrito y, si sigue sin pagar, el procedimiento que recoja tu contrato.

Automatizarlo es clave: si depende de que alguien se acuerde, no se hace.

## 6. Corta el acceso, no la relación

Suspender el acceso al centro mientras hay deuda es la medida más eficaz, siempre que esté pactada en el contrato. Con un control de accesos conectado al programa, el acceso se corta y se reactiva solo en cuanto el cliente paga, sin que tengas que hacer nada.

## 7. Ojo con los bienes del inquilino

En España **no hay una ley específica** que permita al operador quedarse o vender los bienes de un trastero por impago. Cualquier actuación sobre el contenido tiene que estar prevista en el contrato y seguir un procedimiento con avisos por escrito y plazos. Documenta cada paso (avisos, inventario con fotos, actas) y asesórate antes de abrir un trastero ajeno.

## 8. Ofrece un plan de pagos

Un cliente que pasa una mala racha y paga en tres plazos es mejor que un trastero bloqueado durante meses. Acordar un plan con fechas concretas suele recuperar la deuda y conservar al cliente.

## 9. Mide para mejorar

Revisa cada mes:

- Cuánta deuda tienes y desde cuándo.
- Qué porcentaje de recibos se devuelve.
- Cuántos clientes no tienen el cobro domiciliado.

Si el número de devoluciones sube, revisa a quién estás dejando entrar sin cobro automático.

## Cómo lo hace TrasterOS

TrasterOS cobra la primera cuota y la fianza al reservar, domicilia por SEPA o guarda la tarjeta, reintenta los cobros fallidos, manda los avisos y corta y reactiva el acceso automáticamente según tu calendario. Si la deuda sigue, abre un expediente de impago con los pasos y los plazos. Más información en [gestión de impagos para trasteros](/funcionalidades/gestion-de-impagos).$md$, $md$Cómo reducir los impagos en tu negocio de trasteros | TrasterOS$md$, $md$Medidas para reducir los impagos en el alquiler de trasteros: cobro por adelantado, SEPA, recordatorios, reintentos, corte de acceso y planes de pago.$md$);

INSERT INTO "platform_blog_posts" ("slug", "title", "excerpt", "content_markdown", "seo_title", "seo_description")
VALUES ($md$control-de-accesos-trasteros$md$, $md$Control de accesos para trasteros: PIN, tarjeta, QR o móvil$md$, $md$Las formas de abrir más habituales, con o sin conexión, lo que debe hacer el sistema por ti y qué preguntar al instalador.$md$, $md$El control de accesos es lo que permite que un centro de trasteros funcione sin nadie en el mostrador. Bien elegido, el cliente entra cuando quiere, tú sabes quién ha entrado y el acceso se corta solo si alguien deja de pagar. Repasamos las opciones y lo que conviene mirar antes de comprar.

## Las formas de abrir más habituales

- **PIN en un teclado**: barato y fácil de dar a distancia. Cada cliente tiene su código y lo puedes cambiar en cualquier momento.
- **Tarjeta o llavero (RFID)**: cómodo para el cliente habitual. Pide que las tarjetas vayan **cifradas**: las de fábrica se pueden copiar con un móvil.
- **Código QR**: útil para accesos de un solo uso o para visitas.
- **Apertura desde el móvil**: el cliente pulsa un botón en su área de clientes y la puerta se abre. Necesita que la puerta esté conectada.
- **Reconocimiento facial**: cómodo y sin nada que perder, aunque más caro.

Lo habitual es combinar dos: por ejemplo, PIN y móvil.

## Con conexión o sin conexión

- **Con conexión**: la puerta pregunta a tu programa en cada intento. Ves el acceso en tiempo real y los cambios se aplican al momento, pero si se cae internet hay que tener un plan B.
- **Sin conexión**: los códigos se guardan en el propio terminal, que decide solo. Sigue funcionando sin internet; los cambios se envían al terminal cuando hay conexión.

Muchos terminales de calidad permiten las dos cosas: validan solos y se sincronizan con el programa.

## Qué debe hacer el sistema por ti

1. **Dar el acceso al pagar**: el cliente que reserva y paga online recibe su código sin que tú intervengas.
2. **Cortarlo si no paga** y devolverlo en cuanto paga.
3. **Quitarlo al terminar el contrato**, incluidas las tarjetas y los códigos de familiares.
4. **Horarios**: de qué hora a qué hora se puede entrar, con excepciones para quien tenga acceso 24 horas.
5. **Registro**: quién entró, cuándo y por qué puerta, para resolver dudas o incidencias.
6. **Avisos**: intentos de entrar fuera de horario, puertas sin conexión, alguien probando códigos.

## Lo que conviene preguntar al instalador

- ¿El terminal tiene una **interfaz abierta** (API) para conectarlo a mi programa de gestión, o solo funciona con su aplicación?
- ¿Las tarjetas que me vais a dar van **cifradas**?
- ¿Qué pasa si se cae **internet** o la luz? ¿Y si alguien fuerza la puerta?
- ¿Puedo tener **una sola puerta** para todo el centro o necesito una por trastero?
- ¿Cuánto cuesta añadir puertas o terminales más adelante?

## Cerraduras en cada trastero

Algunos centros ponen cerradura electrónica en cada trastero además de la puerta de entrada. Da más seguridad y permite cortar el acceso solo a ese trastero, pero multiplica el coste. Para empezar, suele bastar con una buena puerta de entrada y que cada cliente use su propio candado.

## Cómo lo hace TrasterOS

TrasterOS gestiona PIN, tarjeta, QR y apertura desde el móvil, con horarios por local, pases nocturnos de pago y corte automático por impago. Funciona con terminales con conexión a internet y con equipos que validan sin conexión. Más información en [control de accesos para trasteros](/funcionalidades/control-de-accesos).$md$, $md$Control de accesos para trasteros: PIN, tarjeta, QR o móvil | TrasterOS$md$, $md$Cómo elegir el control de accesos de un centro de trasteros: PIN, tarjeta RFID, QR, apertura desde el móvil, horarios y corte automático por impago.$md$);
