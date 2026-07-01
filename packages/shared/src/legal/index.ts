import { z } from 'zod';

/** Slugs de los documentos legales de la plataforma. */
export const LEGAL_SLUGS = ['terms', 'privacy', 'cookies'] as const;
export const LegalSlugEnum = z.enum(LEGAL_SLUGS);
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

export interface LegalDocumentDto {
  slug: LegalSlug;
  title: string;
  /** Contenido en Markdown. */
  content: string;
  /** ISO; null si aún no se ha guardado en BD (se sirve el contenido por defecto). */
  updatedAt: string | null;
}

/** Actualización de un documento legal desde el panel super admin. */
export const UpdateLegalDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().max(100_000),
});
export type UpdateLegalDocumentInput = z.infer<typeof UpdateLegalDocumentSchema>;

const TERMS_MD = `## 1. Información del prestador

El servicio es prestado por:

- Titular: **[Razón social del prestador]**
- NIF/CIF: **[NIF]**
- Domicilio: **[Domicilio social]**
- Contacto: **[correo@dominio]**

Esta información se facilita en cumplimiento de la Ley 34/2002 de servicios de la sociedad de la información y de comercio electrónico (LSSI-CE).

## 2. Objeto y descripción del servicio

StorageOS es una plataforma en la nube (SaaS) para la gestión integral de locales de self-storage: trasteros, contratos, inquilinos, facturación, control de accesos y operativa diaria. El servicio se presta bajo la modalidad de suscripción y se dirige a empresas y profesionales; no está destinado a consumidores.

## 3. Cuenta y registro

- Para usar el servicio debes crear una cuenta con información veraz, completa y actualizada.
- Eres responsable de la confidencialidad de tus credenciales y de toda la actividad que se realice desde tu cuenta. Recomendamos activar la autenticación en dos pasos.
- Debes notificarnos sin demora cualquier uso no autorizado o brecha de seguridad de la que tengas conocimiento.

## 4. Planes, precios y facturación

- El servicio se ofrece en distintos planes de suscripción, con las funcionalidades y límites que se indiquen en cada momento.
- Los precios y la periodicidad de cobro son los vigentes en la contratación. Salvo indicación en contrario, los importes se expresan sin IVA, que se añadirá cuando proceda.
- La suscripción se renueva automáticamente por periodos iguales salvo cancelación antes de la renovación.
- El impago habilita al prestador a suspender o cancelar el acceso al servicio, previo aviso, conforme a la política de gestión de cobros.

## 5. Periodo de prueba

Si se ofrece un periodo de prueba, el servicio se presta durante dicho periodo sin coste y «tal cual». Al finalizar, la suscripción pasará al plan contratado salvo que canceles antes de que termine.

## 6. Uso aceptable y obligaciones del cliente

Te comprometes a utilizar el servicio conforme a la ley y a estas condiciones, y a no:

- Usar el servicio para fines ilícitos o que vulneren derechos de terceros.
- Introducir datos de terceros sin base jurídica para ello, o sin haber informado a los interesados cuando corresponda.
- Intentar acceder de forma no autorizada a la plataforma, a las cuentas de otros clientes o a su infraestructura.
- Realizar ingeniería inversa, revender o explotar el servicio más allá de lo permitido, salvo autorización expresa.
- Introducir código malicioso o comprometer la seguridad o disponibilidad del servicio.

## 7. Datos de tus inquilinos y protección de datos

Respecto de los datos personales que introduces en la plataforma sobre tus inquilinos, contratos o accesos, tú actúas como responsable del tratamiento y StorageOS como encargado, tratándolos únicamente para prestarte el servicio y siguiendo tus instrucciones, conforme al art. 28 RGPD y al acuerdo de tratamiento de datos aplicable. Eres responsable de disponer de base jurídica y de informar a tus inquilinos. El tratamiento de tus propios datos como cliente se rige por nuestra [Política de Privacidad](/privacidad).

## 8. Propiedad intelectual

El software, la marca, el diseño y demás elementos de la plataforma son titularidad del prestador o de sus licenciantes y están protegidos por la normativa de propiedad intelectual e industrial. La suscripción te concede un derecho de uso limitado, no exclusivo e intransferible, mientras esté vigente. Los datos y contenidos que introduces siguen siendo tuyos.

## 9. Disponibilidad, soporte y modificaciones del servicio

Nos esforzamos por mantener el servicio disponible y seguro, pero puede haber interrupciones por mantenimiento, causas técnicas o de fuerza mayor. Podemos evolucionar, mejorar o modificar funcionalidades del servicio; si un cambio fuera sustancial y te perjudicara, te lo comunicaremos con antelación razonable.

## 10. Limitación de responsabilidad

En la máxima medida permitida por la ley, el prestador no responde de los daños indirectos, lucro cesante, pérdida de datos derivada de un uso indebido o interrupciones ajenas a su control. Nada en estas condiciones excluye la responsabilidad que no pueda limitarse legalmente (como el dolo o la negligencia grave). El servicio se presta con diligencia profesional, pero no se garantiza que esté libre de errores ni que resulte apto para un fin particular no acordado.

## 11. Duración, cancelación y suspensión

- Puedes cancelar tu suscripción en cualquier momento; surtirá efecto al final del periodo de facturación en curso, sin derecho a reembolso de importes ya devengados salvo que la ley disponga otra cosa.
- Podemos suspender o cancelar el servicio en caso de incumplimiento grave de estas condiciones, impago o uso que ponga en riesgo la seguridad o a terceros.
- Tras la baja podrás solicitar la exportación de tus datos durante un plazo razonable, tras el cual podrán suprimirse conforme a nuestra Política de Privacidad y a la ley.

## 12. Modificación de las condiciones

Podemos actualizar estas condiciones. Publicaremos la versión vigente en esta página con su fecha de actualización y, si los cambios fueran relevantes, te avisaremos. El uso continuado del servicio tras la entrada en vigor implica su aceptación.

## 13. Ley aplicable y jurisdicción

Estas condiciones se rigen por la legislación española. Para la resolución de cualquier controversia, las partes se someten a los Juzgados y Tribunales de **[localidad]**, salvo que una norma imperativa disponga otro fuero.

## 14. Contacto

Para cualquier duda sobre estas condiciones, escríbenos a **[correo@dominio]**.`;

const PRIVACY_MD = `En StorageOS nos tomamos en serio la protección de tus datos. Esta política explica qué datos personales tratamos, con qué finalidad y base jurídica, con quién los compartimos y qué derechos te asisten, conforme al Reglamento (UE) 2016/679 (RGPD) y a la Ley Orgánica 3/2018 (LOPDGDD). Los campos entre corchetes deben completarse con los datos del prestador antes de publicar.

## 1. Responsable del tratamiento

- Titular: **[Razón social del prestador]**
- NIF/CIF: **[NIF]**
- Domicilio: **[Domicilio social]**
- Correo de contacto: **[correo@dominio]**
- Delegado de Protección de Datos (DPD), si aplica: **[correo del DPD]**

En adelante, «StorageOS», «nosotros» o «el prestador». StorageOS es una plataforma de gestión de trasteros (self-storage) que se ofrece como servicio (SaaS) a empresas.

## 2. Doble rol: responsable y encargado del tratamiento

Es importante distinguir dos situaciones, porque nuestro papel cambia en cada una:

- **Como responsable.** Respecto de los datos de las empresas clientes y de los usuarios de su equipo (quien contrata y administra la cuenta), StorageOS decide los fines y medios del tratamiento y actúa como responsable. Esta política regula ese tratamiento.
- **Como encargado.** Respecto de los datos que la empresa cliente introduce en la plataforma sobre sus propios inquilinos, contratos, facturas o accesos, la empresa cliente es la responsable y StorageOS actúa como *encargado del tratamiento*, tratando esos datos únicamente siguiendo sus instrucciones y para prestarle el servicio. Las condiciones de ese encargo se regulan en el correspondiente acuerdo de tratamiento de datos (DPA), conforme al art. 28 RGPD.

## 3. Datos que tratamos

- **Datos de registro y cuenta:** nombre y apellidos, correo electrónico, teléfono (si se aporta), contraseña (almacenada cifrada mediante hash) y datos de la empresa (denominación, NIF, dirección de facturación).
- **Datos de uso y técnicos:** registros de acceso, dirección IP, tipo de dispositivo y navegador, y actividad dentro de la plataforma, con fines de seguridad y funcionamiento.
- **Datos de facturación de la suscripción:** los necesarios para gestionar el cobro del servicio. Los datos de la tarjeta o cuenta bancaria los tratan directamente los proveedores de pago; nosotros no almacenamos el número completo de la tarjeta.
- **Comunicaciones:** los datos que nos facilitas al contactar con soporte o por correo electrónico.

## 4. Finalidades y base jurídica

- **Prestar y gestionar el servicio** (alta, autenticación, soporte y funcionamiento de la plataforma). Base: ejecución del contrato (art. 6.1.b RGPD).
- **Facturación y obligaciones contables y fiscales.** Base: cumplimiento de una obligación legal (art. 6.1.c RGPD).
- **Seguridad de la plataforma** y prevención del fraude o de accesos no autorizados. Base: interés legítimo (art. 6.1.f RGPD).
- **Comunicaciones sobre el servicio** (avisos operativos, cambios, incidencias). Base: ejecución del contrato e interés legítimo.
- **Comunicaciones comerciales** sobre nuestros productos, cuando proceda. Base: consentimiento o interés legítimo, con posibilidad de oposición en cualquier momento.

## 5. Plazo de conservación

Conservamos los datos mientras la cuenta esté activa y la relación contractual vigente. Una vez finalizada, los bloquearemos y conservaremos solo durante los plazos legalmente exigibles (por ejemplo, la normativa mercantil y tributaria obliga a conservar la facturación), tras lo cual se suprimirán o anonimizarán. Los datos que tratamos como encargado se devuelven o suprimen al terminar el encargo, según lo pactado con la empresa cliente.

## 6. Destinatarios y encargados del tratamiento

No vendemos tus datos. Para prestar el servicio nos apoyamos en proveedores que actúan como encargados del tratamiento, con los que suscribimos los contratos exigidos por el art. 28 RGPD. Según la configuración del servicio, pueden incluir:

- Proveedor de alojamiento e infraestructura del servidor.
- Almacenamiento de archivos (documentos y ficheros subidos).
- Proveedor de correo electrónico transaccional.
- Pasarelas y proveedores de pago (por ejemplo, para tarjeta y domiciliación SEPA).
- Herramientas de monitorización de errores y disponibilidad.

También podremos comunicar datos a las Administraciones públicas y organismos competentes (por ejemplo, la Agencia Tributaria) cuando exista una obligación legal.

## 7. Transferencias internacionales

Priorizamos proveedores dentro del Espacio Económico Europeo. Si algún proveedor tratara datos fuera del EEE, la transferencia se ampararía en una decisión de adecuación de la Comisión Europea o en garantías adecuadas (como las Cláusulas Contractuales Tipo), conforme al Capítulo V del RGPD.

## 8. Tus derechos

Puedes ejercer en cualquier momento los siguientes derechos:

- Acceso a tus datos personales.
- Rectificación de datos inexactos.
- Supresión («derecho al olvido»).
- Limitación del tratamiento.
- Oposición al tratamiento.
- Portabilidad de los datos.
- Retirar el consentimiento prestado, sin efecto retroactivo.

Para ejercerlos, escríbenos a **[correo@dominio]** indicando el derecho que deseas ejercer. Si tus datos los trata una empresa cliente (como responsable) y nosotros solo actuamos como encargado, te redirigiremos a dicha empresa. Tienes además derecho a presentar una reclamación ante la Agencia Española de Protección de Datos ([www.aepd.es](https://www.aepd.es)) si consideras que el tratamiento no se ajusta a la normativa.

## 9. Seguridad

Aplicamos medidas técnicas y organizativas apropiadas para proteger los datos, como el cifrado de datos sensibles, el hash de las contraseñas, el aislamiento de la información entre clientes, el control de accesos por roles, la autenticación en dos pasos y registros de auditoría. Ningún sistema es infalible, pero trabajamos para minimizar los riesgos y reaccionar con diligencia ante cualquier incidente.

## 10. Cookies

Utilizamos las cookies y tecnologías equivalentes estrictamente necesarias para el funcionamiento y la seguridad de la plataforma (por ejemplo, para mantener la sesión). Si en el futuro empleáramos cookies analíticas o de terceros no necesarias, se recabaría tu consentimiento previo mediante el correspondiente aviso.

## 11. Menores

El servicio se dirige a empresas y profesionales; no está destinado a menores de edad y no recabamos deliberadamente sus datos.

## 12. Cambios en esta política

Podemos actualizar esta política para adaptarla a cambios normativos o del servicio. Publicaremos la versión vigente en esta misma página, indicando la fecha de última actualización, y te informaremos si los cambios fueran sustanciales.

## 13. Contacto

Para cualquier cuestión relativa a esta política o al tratamiento de tus datos, contacta con nosotros en **[correo@dominio]**.`;

const COOKIES_MD = `Esta política explica qué son las cookies y tecnologías similares, cuáles utiliza StorageOS y cómo puedes gestionarlas.

## 1. ¿Qué son las cookies?

Una cookie es un pequeño fichero de texto que un sitio web almacena en tu navegador cuando lo visitas. Sirve, entre otras cosas, para que la web recuerde tu sesión y funcione correctamente. Junto a las cookies existen tecnologías equivalentes (como el almacenamiento local del navegador) que tratamos de forma análoga en esta política.

## 2. Cookies que utilizamos

StorageOS utiliza únicamente las cookies y el almacenamiento **estrictamente necesarios** para el funcionamiento y la seguridad de la plataforma. En particular:

- **Sesión y autenticación:** para mantener tu sesión iniciada de forma segura y proteger frente a accesos no autorizados. Sin ellas no es posible usar el panel ni el portal.
- **Preferencias:** para recordar ajustes como el tema (claro/oscuro) o el idioma.

No utilizamos cookies de **publicidad** ni de **seguimiento de terceros**. Si en el futuro incorporáramos cookies **analíticas** o de terceros no necesarias, se recabaría tu consentimiento previo mediante el correspondiente aviso, y podrías aceptarlas o rechazarlas.

## 3. Base jurídica

Las cookies estrictamente necesarias no requieren consentimiento, conforme al artículo 22.2 de la LSSI-CE y a las directrices de la Agencia Española de Protección de Datos. Cualquier otra categoría de cookies se instalaría solo con tu consentimiento.

## 4. Cómo gestionar o eliminar las cookies

Puedes configurar tu navegador para bloquear o eliminar las cookies. Ten en cuenta que, si bloqueas las cookies estrictamente necesarias, es posible que la plataforma no funcione correctamente. Consulta la ayuda de tu navegador (Chrome, Firefox, Safari, Edge…) para más información sobre cómo hacerlo.

## 5. Cambios en esta política

Podemos actualizar esta política de cookies para adaptarla a cambios legales o técnicos. Publicaremos la versión vigente en esta misma página con su fecha de actualización.

## 6. Contacto

Para cualquier duda sobre el uso de cookies, escríbenos a **[correo@dominio]**. Puedes consultar también nuestra [Política de Privacidad](/privacidad).`;

/** Contenido por defecto (seed + fallback si la BD está vacía). */
export const DEFAULT_LEGAL_DOCUMENTS: Record<LegalSlug, { title: string; content: string }> = {
  terms: { title: 'Términos y Condiciones de Uso', content: TERMS_MD },
  privacy: { title: 'Política de Privacidad', content: PRIVACY_MD },
  cookies: { title: 'Política de Cookies', content: COOKIES_MD },
};
