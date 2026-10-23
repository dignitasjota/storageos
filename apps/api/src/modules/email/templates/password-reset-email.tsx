import { Button, Link, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

export interface PasswordResetEmailProps {
  fullName: string;
  resetUrl: string;
  ipAddress?: string;
}

export function PasswordResetEmail({ fullName, resetUrl, ipAddress }: PasswordResetEmailProps) {
  return (
    <EmailLayout
      preview="Restablece tu contraseña de TrasterOS"
      heading={`Hola ${fullName}, restablece tu contraseña`}
    >
      <Text style={{ margin: 0, marginBottom: 16 }}>
        Hemos recibido una solicitud para restablecer tu contraseña. Si fuiste tú, pulsa el botón de
        abajo:
      </Text>

      <Button
        href={resetUrl}
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
        Cambiar mi contraseña
      </Button>

      <Text style={{ marginTop: 24, marginBottom: 0, fontSize: 13, color: '#475569' }}>
        Si el botón no funciona, copia este enlace en el navegador:
        <br />
        <Link href={resetUrl} style={{ color: '#2563eb' }}>
          {resetUrl}
        </Link>
      </Text>

      <Text style={{ marginTop: 24, marginBottom: 0, fontSize: 13, color: '#475569' }}>
        El enlace caduca en 1 hora. Si no pediste este cambio, ignora este email y tu cuenta sigue
        segura{ipAddress ? ` (petición desde la IP ${ipAddress})` : ''}.
      </Text>
    </EmailLayout>
  );
}

PasswordResetEmail.PreviewProps = {
  fullName: 'Jane Doe',
  resetUrl: 'https://app.storageos.local/reset-password/abc.def',
  ipAddress: '203.0.113.7',
} satisfies PasswordResetEmailProps;

export default PasswordResetEmail;
