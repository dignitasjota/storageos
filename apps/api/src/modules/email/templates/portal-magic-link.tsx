import { Button, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface PortalMagicLinkEmailProps {
  tenantName: string;
  link: string;
  ttlMinutes: number;
  /** Idioma del inquilino. */
  locale?: 'es' | 'en';
  /** `reset`: enlace para fijar la contraseña (otro texto). */
  purpose?: 'login' | 'reset';
}

const COPY = {
  es: {
    login: {
      title: (t: string) => `Accede a tu cuenta de ${t}`,
      body: 'Hemos recibido una solicitud de acceso. Haz clic en el botón para entrar a tu área de clientes y consultar tus facturas.',
      cta: 'Acceder a mi cuenta',
      foot: (m: number) =>
        `El enlace caduca en ${m} minutos y solo se puede usar una vez. Si no has solicitado este acceso, ignora este email.`,
    },
    reset: {
      title: (t: string) => `Restablece tu contraseña de ${t}`,
      body: 'Hemos recibido una solicitud para fijar o cambiar la contraseña de tu área de clientes. Haz clic en el botón para elegir una nueva.',
      cta: 'Elegir contraseña',
      foot: (m: number) =>
        `El enlace caduca en ${m} minutos y solo se puede usar una vez. Si no lo has pedido, ignora este email: tu contraseña no cambia.`,
    },
  },
  en: {
    login: {
      title: (t: string) => `Sign in to your ${t} account`,
      body: 'We have received a sign-in request. Click the button to go to your customer area and check your invoices.',
      cta: 'Sign in',
      foot: (m: number) =>
        `The link expires in ${m} minutes and can only be used once. If you did not request it, ignore this email.`,
    },
    reset: {
      title: (t: string) => `Reset your ${t} password`,
      body: 'We have received a request to set or change the password of your customer area. Click the button to choose a new one.',
      cta: 'Choose password',
      foot: (m: number) =>
        `The link expires in ${m} minutes and can only be used once. If you did not request it, ignore this email: your password will not change.`,
    },
  },
} as const;

export function PortalMagicLinkEmail({
  tenantName,
  link,
  ttlMinutes,
  locale = 'es',
  purpose = 'login',
}: PortalMagicLinkEmailProps) {
  const c = COPY[locale][purpose];
  return (
    <EmailLayout
      brandName={tenantName}
      locale={locale}
      preview={c.title(tenantName)}
      heading={c.title(tenantName)}
    >
      <Text style={{ fontSize: '14px', lineHeight: '22px', color: '#444' }}>{c.body}</Text>
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
          {c.cta}
        </Button>
      </Section>
      <Text style={{ fontSize: '12px', color: '#888' }}>{c.foot(ttlMinutes)}</Text>
    </EmailLayout>
  );
}

/** Asunto del correo, en el idioma del inquilino. */
export function portalMagicLinkSubject(
  tenantName: string,
  locale: 'es' | 'en' = 'es',
  purpose: 'login' | 'reset' = 'login',
): string {
  return COPY[locale][purpose].title(tenantName);
}
