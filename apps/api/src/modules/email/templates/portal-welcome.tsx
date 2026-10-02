import { Button, Link, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface PortalWelcomeEmailProps {
  tenantName: string;
  customerName: string;
  link: string;
  ttlDays: number;
  loginUrl: string;
  /** Idioma del inquilino. */
  locale?: 'es' | 'en';
}

/** Bienvenida al inquilino recién dado de alta, con su acceso al portal. */
export function PortalWelcomeEmail({
  tenantName,
  customerName,
  link,
  ttlDays,
  loginUrl,
  locale = 'es',
}: PortalWelcomeEmailProps) {
  const en = locale === 'en';
  return (
    <EmailLayout
      brandName={tenantName}
      locale={locale}
      preview={portalWelcomeSubject(tenantName, locale)}
      heading={
        en
          ? customerName
            ? `Hello ${customerName}, welcome to ${tenantName}`
            : `Welcome to ${tenantName}`
          : customerName
            ? `Hola ${customerName}, bienvenido a ${tenantName}`
            : `Bienvenido a ${tenantName}`
      }
    >
      <Text style={{ fontSize: '14px', lineHeight: '22px', color: '#444' }}>
        {en
          ? `Your account in the ${tenantName} customer area is ready. From there you can view your contracts and invoices, pay, check your access to the facility and message us.`
          : `Ya tienes tu cuenta en el área de clientes de ${tenantName}. Desde ahí puedes ver tus contratos y facturas, pagar, consultar tu acceso al local y escribirnos.`}
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
          {en ? 'Sign in to my account' : 'Entrar a mi cuenta'}
        </Button>
      </Section>
      <Text style={{ fontSize: '12px', color: '#888' }}>
        {en
          ? `The link expires in ${ttlDays} days and can only be used once. After that you can request a new one at any time at `
          : `El enlace caduca en ${ttlDays} días y solo se puede usar una vez. Después puedes pedir uno nuevo cuando quieras en `}
        <Link href={loginUrl}>{loginUrl}</Link>.
      </Text>
    </EmailLayout>
  );
}

/** Asunto del correo, en el idioma del inquilino. */
export function portalWelcomeSubject(tenantName: string, locale: 'es' | 'en' = 'es'): string {
  return locale === 'en'
    ? `Your access to the ${tenantName} customer area`
    : `Tu acceso al área de clientes de ${tenantName}`;
}
