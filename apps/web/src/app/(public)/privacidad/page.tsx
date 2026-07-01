import type { Metadata } from 'next';

import { Fill, LegalList, LegalPage, LegalSection } from '@/components/public/legal-ui';

export const metadata: Metadata = {
  title: 'Política de Privacidad · StorageOS',
  description:
    'Cómo StorageOS trata los datos personales conforme al RGPD y la LOPDGDD: responsable, finalidades, base jurídica, encargados, derechos y contacto.',
};

const LAST_UPDATED = '2 de julio de 2026';

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Política de Privacidad"
      lastUpdated={LAST_UPDATED}
      intro={
        <p>
          En StorageOS nos tomamos en serio la protección de tus datos. Esta política explica qué
          datos personales tratamos, con qué finalidad y base jurídica, con quién los compartimos y
          qué derechos te asisten, conforme al Reglamento (UE) 2016/679 (RGPD) y a la Ley Orgánica
          3/2018 (LOPDGDD). Los campos resaltados deben completarse con los datos del prestador
          antes de publicar.
        </p>
      }
    >
      <LegalSection n={1} title="Responsable del tratamiento">
        <LegalList
          items={[
            <>
              Titular: <Fill>[Razón social del prestador]</Fill>
            </>,
            <>
              NIF/CIF: <Fill>[NIF]</Fill>
            </>,
            <>
              Domicilio: <Fill>[Domicilio social]</Fill>
            </>,
            <>
              Correo de contacto: <Fill>[correo@dominio]</Fill>
            </>,
            <>
              Delegado de Protección de Datos (DPD), si aplica: <Fill>[correo del DPD]</Fill>
            </>,
          ]}
        />
        <p>
          En adelante, «StorageOS», «nosotros» o «el prestador». StorageOS es una plataforma de
          gestión de trasteros (self-storage) que se ofrece como servicio (SaaS) a empresas.
        </p>
      </LegalSection>

      <LegalSection n={2} title="Doble rol: responsable y encargado del tratamiento">
        <p>Es importante distinguir dos situaciones, porque nuestro papel cambia en cada una:</p>
        <LegalList
          items={[
            <>
              <strong>Como responsable.</strong> Respecto de los datos de las empresas clientes y de
              los usuarios de su equipo (quien contrata y administra la cuenta), StorageOS decide
              los fines y medios del tratamiento y actúa como responsable. Esta política regula ese
              tratamiento.
            </>,
            <>
              <strong>Como encargado.</strong> Respecto de los datos que la empresa cliente
              introduce en la plataforma sobre sus propios inquilinos, contratos, facturas o
              accesos, la empresa cliente es la responsable y StorageOS actúa como{' '}
              <em>encargado del tratamiento</em>, tratando esos datos únicamente siguiendo sus
              instrucciones y para prestarle el servicio. Las condiciones de ese encargo se regulan
              en el correspondiente acuerdo de tratamiento de datos (DPA), conforme al art. 28 RGPD.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection n={3} title="Datos que tratamos">
        <LegalList
          items={[
            <>
              <strong>Datos de registro y cuenta:</strong> nombre y apellidos, correo electrónico,
              teléfono (si se aporta), contraseña (almacenada cifrada mediante hash) y datos de la
              empresa (denominación, NIF, dirección de facturación).
            </>,
            <>
              <strong>Datos de uso y técnicos:</strong> registros de acceso, dirección IP, tipo de
              dispositivo y navegador, y actividad dentro de la plataforma, con fines de seguridad y
              funcionamiento.
            </>,
            <>
              <strong>Datos de facturación de la suscripción:</strong> los necesarios para gestionar
              el cobro del servicio. Los datos de la tarjeta o cuenta bancaria los tratan
              directamente los proveedores de pago; nosotros no almacenamos el número completo de la
              tarjeta.
            </>,
            <>
              <strong>Comunicaciones:</strong> los datos que nos facilitas al contactar con soporte
              o por correo electrónico.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection n={4} title="Finalidades y base jurídica">
        <LegalList
          items={[
            <>
              <strong>Prestar y gestionar el servicio</strong> (alta, autenticación, soporte y
              funcionamiento de la plataforma). Base: ejecución del contrato (art. 6.1.b RGPD).
            </>,
            <>
              <strong>Facturación y obligaciones contables y fiscales.</strong> Base: cumplimiento
              de una obligación legal (art. 6.1.c RGPD).
            </>,
            <>
              <strong>Seguridad de la plataforma</strong> y prevención del fraude o de accesos no
              autorizados. Base: interés legítimo (art. 6.1.f RGPD).
            </>,
            <>
              <strong>Comunicaciones sobre el servicio</strong> (avisos operativos, cambios,
              incidencias). Base: ejecución del contrato e interés legítimo.
            </>,
            <>
              <strong>Comunicaciones comerciales</strong> sobre nuestros productos, cuando proceda.
              Base: consentimiento o interés legítimo, con posibilidad de oposición en cualquier
              momento.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection n={5} title="Plazo de conservación">
        <p>
          Conservamos los datos mientras la cuenta esté activa y la relación contractual vigente.
          Una vez finalizada, los bloquearemos y conservaremos solo durante los plazos legalmente
          exigibles (por ejemplo, la normativa mercantil y tributaria obliga a conservar la
          facturación), tras lo cual se suprimirán o anonimizarán. Los datos que tratamos como
          encargado se devuelven o suprimen al terminar el encargo, según lo pactado con la empresa
          cliente.
        </p>
      </LegalSection>

      <LegalSection n={6} title="Destinatarios y encargados del tratamiento">
        <p>
          No vendemos tus datos. Para prestar el servicio nos apoyamos en proveedores que actúan
          como encargados del tratamiento, con los que suscribimos los contratos exigidos por el
          art. 28 RGPD. Según la configuración del servicio, pueden incluir:
        </p>
        <LegalList
          items={[
            <>Proveedor de alojamiento e infraestructura del servidor.</>,
            <>Almacenamiento de archivos (documentos y ficheros subidos).</>,
            <>Proveedor de correo electrónico transaccional.</>,
            <>Pasarelas y proveedores de pago (por ejemplo, para tarjeta y domiciliación SEPA).</>,
            <>Herramientas de monitorización de errores y disponibilidad.</>,
          ]}
        />
        <p>
          También podremos comunicar datos a las Administraciones públicas y organismos competentes
          (por ejemplo, la Agencia Tributaria) cuando exista una obligación legal.
        </p>
      </LegalSection>

      <LegalSection n={7} title="Transferencias internacionales">
        <p>
          Priorizamos proveedores dentro del Espacio Económico Europeo. Si algún proveedor tratara
          datos fuera del EEE, la transferencia se ampararía en una decisión de adecuación de la
          Comisión Europea o en garantías adecuadas (como las Cláusulas Contractuales Tipo),
          conforme al Capítulo V del RGPD.
        </p>
      </LegalSection>

      <LegalSection n={8} title="Tus derechos">
        <p>Puedes ejercer en cualquier momento los siguientes derechos:</p>
        <LegalList
          items={[
            <>Acceso a tus datos personales.</>,
            <>Rectificación de datos inexactos.</>,
            <>Supresión («derecho al olvido»).</>,
            <>Limitación del tratamiento.</>,
            <>Oposición al tratamiento.</>,
            <>Portabilidad de los datos.</>,
            <>Retirar el consentimiento prestado, sin efecto retroactivo.</>,
          ]}
        />
        <p>
          Para ejercerlos, escríbenos a <Fill>[correo@dominio]</Fill> indicando el derecho que
          deseas ejercer. Si tus datos los trata una empresa cliente (como responsable) y nosotros
          solo actuamos como encargado, te redirigiremos a dicha empresa. Tienes además derecho a
          presentar una reclamación ante la Agencia Española de Protección de Datos (
          <a
            href="https://www.aepd.es"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            www.aepd.es
          </a>
          ) si consideras que el tratamiento no se ajusta a la normativa.
        </p>
      </LegalSection>

      <LegalSection n={9} title="Seguridad">
        <p>
          Aplicamos medidas técnicas y organizativas apropiadas para proteger los datos, como el
          cifrado de datos sensibles, el hash de las contraseñas, el aislamiento de la información
          entre clientes, el control de accesos por roles, la autenticación en dos pasos y registros
          de auditoría. Ningún sistema es infalible, pero trabajamos para minimizar los riesgos y
          reaccionar con diligencia ante cualquier incidente.
        </p>
      </LegalSection>

      <LegalSection n={10} title="Cookies">
        <p>
          Utilizamos las cookies y tecnologías equivalentes estrictamente necesarias para el
          funcionamiento y la seguridad de la plataforma (por ejemplo, para mantener la sesión). Si
          en el futuro empleáramos cookies analíticas o de terceros no necesarias, se recabaría tu
          consentimiento previo mediante el correspondiente aviso.
        </p>
      </LegalSection>

      <LegalSection n={11} title="Menores">
        <p>
          El servicio se dirige a empresas y profesionales; no está destinado a menores de edad y no
          recabamos deliberadamente sus datos.
        </p>
      </LegalSection>

      <LegalSection n={12} title="Cambios en esta política">
        <p>
          Podemos actualizar esta política para adaptarla a cambios normativos o del servicio.
          Publicaremos la versión vigente en esta misma página, indicando la fecha de última
          actualización, y te informaremos si los cambios fueran sustanciales.
        </p>
      </LegalSection>

      <LegalSection n={13} title="Contacto">
        <p>
          Para cualquier cuestión relativa a esta política o al tratamiento de tus datos, contacta
          con nosotros en <Fill>[correo@dominio]</Fill>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
