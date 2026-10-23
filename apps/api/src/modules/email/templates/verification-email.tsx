import { Button, Link, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

export interface VerificationEmailProps {
  fullName: string;
  verifyUrl: string;
  /** Identificador de la empresa: se pide al entrar al panel. */
  tenantSlug?: string;
}

export function VerificationEmail({ fullName, verifyUrl, tenantSlug }: VerificationEmailProps) {
  return (
    <EmailLayout
      preview="Verifica tu cuenta de TrasterOS"
      heading={`Hola ${fullName}, confirma tu email`}
    >
      <Text style={{ margin: 0, marginBottom: 16 }}>
        Gracias por crear tu cuenta. Para activar el acceso, confirma tu email pulsando el botón:
      </Text>

      <Button
        href={verifyUrl}
        style={{
          backgroundColor: '#2563eb',
          color: '#ffffff',
          padding: '12px 20px',
          borderRadius: 6,
          fontWeight: 600,
          textDecoration: 'none',
          display: 'inline-block',
        }}
      >
        Verificar mi cuenta
      </Button>

      <Text style={{ marginTop: 24, marginBottom: 0, fontSize: 13, color: '#475569' }}>
        Si el botón no funciona, copia este enlace en el navegador:
        <br />
        <Link href={verifyUrl} style={{ color: '#2563eb' }}>
          {verifyUrl}
        </Link>
      </Text>

      {tenantSlug && (
        <Text style={{ marginTop: 24, marginBottom: 0 }}>
          Para entrar al panel te pediremos el identificador de tu empresa:{' '}
          <strong>{tenantSlug}</strong>. Guárdalo.
        </Text>
      )}

      <Text style={{ marginTop: 24, marginBottom: 0, fontSize: 13, color: '#475569' }}>
        El enlace caduca en 24 horas. Si no creaste esta cuenta, puedes ignorar este email.
      </Text>
    </EmailLayout>
  );
}

VerificationEmail.PreviewProps = {
  fullName: 'Jane Doe',
  verifyUrl: 'https://app.storageos.local/verify-email/abc.def',
  tenantSlug: 'trasteros-garcia',
} satisfies VerificationEmailProps;

export default VerificationEmail;
