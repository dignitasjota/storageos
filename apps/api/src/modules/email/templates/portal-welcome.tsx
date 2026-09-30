import { Button, Link, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface PortalWelcomeEmailProps {
  tenantName: string;
  customerName: string;
  link: string;
  ttlDays: number;
  loginUrl: string;
}

/** Bienvenida al inquilino recién dado de alta, con su acceso al portal. */
export function PortalWelcomeEmail({
  tenantName,
  customerName,
  link,
  ttlDays,
  loginUrl,
}: PortalWelcomeEmailProps) {
  return (
    <EmailLayout
      preview={`Tu acceso al área de clientes de ${tenantName}`}
      heading={
        customerName
          ? `Hola ${customerName}, bienvenido a ${tenantName}`
          : `Bienvenido a ${tenantName}`
      }
    >
      <Text style={{ fontSize: '14px', lineHeight: '22px', color: '#444' }}>
        Ya tienes tu cuenta en el área de clientes de {tenantName}. Desde ahí puedes ver tus
        contratos y facturas, pagar, consultar tu acceso al local y escribirnos.
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
          Entrar a mi cuenta
        </Button>
      </Section>
      <Text style={{ fontSize: '12px', color: '#888' }}>
        El enlace caduca en {ttlDays} días y solo se puede usar una vez. Después puedes pedir uno
        nuevo cuando quieras en <Link href={loginUrl}>{loginUrl}</Link>.
      </Text>
    </EmailLayout>
  );
}
