import { Button, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface PortalMagicLinkEmailProps {
  tenantName: string;
  link: string;
  ttlMinutes: number;
}

export function PortalMagicLinkEmail({ tenantName, link, ttlMinutes }: PortalMagicLinkEmailProps) {
  return (
    <EmailLayout
      preview={`Accede a tu cuenta de ${tenantName}`}
      heading={`Accede a tu cuenta de ${tenantName}`}
    >
      <Text style={{ fontSize: '14px', lineHeight: '22px', color: '#444' }}>
        Hemos recibido una solicitud de acceso. Haz clic en el botón para entrar a tu portal
        personal y consultar tus facturas.
      </Text>
      <Section style={{ marginTop: '24px', marginBottom: '24px', textAlign: 'center' }}>
        <Button
          href={link}
          style={{
            backgroundColor: '#111',
            color: '#fff',
            padding: '12px 22px',
            borderRadius: '6px',
            fontSize: '14px',
            textDecoration: 'none',
          }}
        >
          Acceder a mi cuenta
        </Button>
      </Section>
      <Text style={{ fontSize: '12px', color: '#888' }}>
        El enlace caduca en {ttlMinutes} minutos y solo se puede usar una vez. Si no has solicitado
        este acceso, ignora este email.
      </Text>
    </EmailLayout>
  );
}
