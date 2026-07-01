import type { Metadata } from 'next';

import { Fill, LegalList, LegalPage, LegalSection } from '@/components/public/legal-ui';

export const metadata: Metadata = {
  title: 'Términos y Condiciones · StorageOS',
  description:
    'Condiciones de uso del servicio StorageOS: objeto, cuenta, planes y pagos, obligaciones, responsabilidad, cancelación, protección de datos y ley aplicable.',
};

const LAST_UPDATED = '2 de julio de 2026';

export default function TermsPage() {
  return (
    <LegalPage
      title="Términos y Condiciones de Uso"
      lastUpdated={LAST_UPDATED}
      intro={
        <p>
          Estas condiciones regulan el acceso y uso de la plataforma StorageOS. Al registrarte o
          utilizar el servicio, aceptas quedar vinculado por ellas. Los campos resaltados deben
          completarse con los datos del prestador antes de publicar.
        </p>
      }
    >
      <LegalSection n={1} title="Información del prestador">
        <p>El servicio es prestado por:</p>
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
              Contacto: <Fill>[correo@dominio]</Fill>
            </>,
          ]}
        />
        <p>
          Esta información se facilita en cumplimiento de la Ley 34/2002 de servicios de la sociedad
          de la información y de comercio electrónico (LSSI-CE).
        </p>
      </LegalSection>

      <LegalSection n={2} title="Objeto y descripción del servicio">
        <p>
          StorageOS es una plataforma en la nube (SaaS) para la gestión integral de locales de
          self-storage: trasteros, contratos, inquilinos, facturación, control de accesos y
          operativa diaria. El servicio se presta bajo la modalidad de suscripción y se dirige a
          empresas y profesionales; no está destinado a consumidores.
        </p>
      </LegalSection>

      <LegalSection n={3} title="Cuenta y registro">
        <LegalList
          items={[
            <>
              Para usar el servicio debes crear una cuenta con información veraz, completa y
              actualizada.
            </>,
            <>
              Eres responsable de la confidencialidad de tus credenciales y de toda la actividad que
              se realice desde tu cuenta. Recomendamos activar la autenticación en dos pasos.
            </>,
            <>
              Debes notificarnos sin demora cualquier uso no autorizado o brecha de seguridad de la
              que tengas conocimiento.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection n={4} title="Planes, precios y facturación">
        <LegalList
          items={[
            <>
              El servicio se ofrece en distintos planes de suscripción, con las funcionalidades y
              límites que se indiquen en cada momento.
            </>,
            <>
              Los precios y la periodicidad de cobro son los vigentes en la contratación. Salvo
              indicación en contrario, los importes se expresan sin IVA, que se añadirá cuando
              proceda.
            </>,
            <>
              La suscripción se renueva automáticamente por periodos iguales salvo cancelación antes
              de la renovación.
            </>,
            <>
              El impago habilita al prestador a suspender o cancelar el acceso al servicio, previo
              aviso, conforme a la política de gestión de cobros.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection n={5} title="Periodo de prueba">
        <p>
          Si se ofrece un periodo de prueba, el servicio se presta durante dicho periodo sin coste y
          «tal cual». Al finalizar, la suscripción pasará al plan contratado salvo que canceles
          antes de que termine.
        </p>
      </LegalSection>

      <LegalSection n={6} title="Uso aceptable y obligaciones del cliente">
        <p>
          Te comprometes a utilizar el servicio conforme a la ley y a estas condiciones, y a no:
        </p>
        <LegalList
          items={[
            <>Usar el servicio para fines ilícitos o que vulneren derechos de terceros.</>,
            <>
              Introducir datos de terceros sin base jurídica para ello, o sin haber informado a los
              interesados cuando corresponda.
            </>,
            <>
              Intentar acceder de forma no autorizada a la plataforma, a las cuentas de otros
              clientes o a su infraestructura.
            </>,
            <>
              Realizar ingeniería inversa, revender o explotar el servicio más allá de lo permitido,
              salvo autorización expresa.
            </>,
            <>
              Introducir código malicioso o comprometer la seguridad o disponibilidad del servicio.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection n={7} title="Datos de tus inquilinos y protección de datos">
        <p>
          Respecto de los datos personales que introduces en la plataforma sobre tus inquilinos,
          contratos o accesos, tú actúas como responsable del tratamiento y StorageOS como
          encargado, tratándolos únicamente para prestarte el servicio y siguiendo tus
          instrucciones, conforme al art. 28 RGPD y al acuerdo de tratamiento de datos aplicable.
          Eres responsable de disponer de base jurídica y de informar a tus inquilinos. El
          tratamiento de tus propios datos como cliente se rige por nuestra{' '}
          <a href="/privacidad" className="underline hover:text-foreground">
            Política de Privacidad
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection n={8} title="Propiedad intelectual">
        <p>
          El software, la marca, el diseño y demás elementos de la plataforma son titularidad del
          prestador o de sus licenciantes y están protegidos por la normativa de propiedad
          intelectual e industrial. La suscripción te concede un derecho de uso limitado, no
          exclusivo e intransferible, mientras esté vigente. Los datos y contenidos que introduces
          siguen siendo tuyos.
        </p>
      </LegalSection>

      <LegalSection n={9} title="Disponibilidad, soporte y modificaciones del servicio">
        <p>
          Nos esforzamos por mantener el servicio disponible y seguro, pero puede haber
          interrupciones por mantenimiento, causas técnicas o de fuerza mayor. Podemos evolucionar,
          mejorar o modificar funcionalidades del servicio; si un cambio fuera sustancial y te
          perjudicara, te lo comunicaremos con antelación razonable.
        </p>
      </LegalSection>

      <LegalSection n={10} title="Limitación de responsabilidad">
        <p>
          En la máxima medida permitida por la ley, el prestador no responde de los daños
          indirectos, lucro cesante, pérdida de datos derivada de un uso indebido o interrupciones
          ajenas a su control. Nada en estas condiciones excluye la responsabilidad que no pueda
          limitarse legalmente (como el dolo o la negligencia grave). El servicio se presta con
          diligencia profesional, pero no se garantiza que esté libre de errores ni que resulte apto
          para un fin particular no acordado.
        </p>
      </LegalSection>

      <LegalSection n={11} title="Duración, cancelación y suspensión">
        <LegalList
          items={[
            <>
              Puedes cancelar tu suscripción en cualquier momento; surtirá efecto al final del
              periodo de facturación en curso, sin derecho a reembolso de importes ya devengados
              salvo que la ley disponga otra cosa.
            </>,
            <>
              Podemos suspender o cancelar el servicio en caso de incumplimiento grave de estas
              condiciones, impago o uso que ponga en riesgo la seguridad o a terceros.
            </>,
            <>
              Tras la baja podrás solicitar la exportación de tus datos durante un plazo razonable,
              tras el cual podrán suprimirse conforme a nuestra Política de Privacidad y a la ley.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection n={12} title="Modificación de las condiciones">
        <p>
          Podemos actualizar estas condiciones. Publicaremos la versión vigente en esta página con
          su fecha de actualización y, si los cambios fueran relevantes, te avisaremos. El uso
          continuado del servicio tras la entrada en vigor implica su aceptación.
        </p>
      </LegalSection>

      <LegalSection n={13} title="Ley aplicable y jurisdicción">
        <p>
          Estas condiciones se rigen por la legislación española. Para la resolución de cualquier
          controversia, las partes se someten a los Juzgados y Tribunales de{' '}
          <Fill>[localidad]</Fill>, salvo que una norma imperativa disponga otro fuero.
        </p>
      </LegalSection>

      <LegalSection n={14} title="Contacto">
        <p>
          Para cualquier duda sobre estas condiciones, escríbenos a <Fill>[correo@dominio]</Fill>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
