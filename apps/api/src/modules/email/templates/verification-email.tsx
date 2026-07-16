import { Button, Link, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

export interface VerificationEmailProps {
  fullName: string;
  verifyUrl: string;
}

export function VerificationEmail({ fullName, verifyUrl }: VerificationEmailProps) {
  return (
    <EmailLayout
      preview="Verifica tu cuenta de TrasterOS"
      heading={`Hola ${fullName}, confirma tu email`}
    >
      <Text style={{ margin: 0, marginBottom: 16 }}>
        Gracias por crear tu cuenta. Para activar el acceso, confirma tu email pulsando el boton:
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
        Si el boton no funciona, copia este enlace en el navegador:
        <br />
        <Link href={verifyUrl} style={{ color: '#2563eb' }}>
          {verifyUrl}
        </Link>
      </Text>

      <Text style={{ marginTop: 24, marginBottom: 0, fontSize: 13, color: '#475569' }}>
        El enlace caduca en 24 horas. Si no creaste esta cuenta, puedes ignorar este email.
      </Text>
    </EmailLayout>
  );
}

VerificationEmail.PreviewProps = {
  fullName: 'Jane Doe',
  verifyUrl: 'https://app.storageos.local/verify-email/abc.def',
} satisfies VerificationEmailProps;

export default VerificationEmail;
