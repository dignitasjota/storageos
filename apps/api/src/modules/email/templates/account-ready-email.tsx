import { Button, Link, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

export interface AccountReadyEmailProps {
  fullName: string;
  /** Enlace para elegir la contraseña (válido 7 días). */
  setPasswordUrl: string;
  /** Identificador de la empresa, que se pide al entrar. */
  tenantSlug: string;
  /** Página de inicio de sesión (para pedir otro enlace si caduca). */
  loginUrl: string;
}

/** Cuenta creada por el equipo de TrasterOS: el propietario elige su contraseña. */
export function AccountReadyEmail({
  fullName,
  setPasswordUrl,
  tenantSlug,
  loginUrl,
}: AccountReadyEmailProps) {
  return (
    <EmailLayout
      preview="Tu cuenta de TrasterOS está lista: elige tu contraseña"
      heading={`Hola ${fullName}, tu cuenta está lista`}
    >
      <Text style={{ margin: 0, marginBottom: 16 }}>
        Hemos creado tu cuenta de TrasterOS. Para entrar, elige tu contraseña:
      </Text>

      <Button
        href={setPasswordUrl}
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
        Elegir mi contraseña
      </Button>

      <Text style={{ marginTop: 24, marginBottom: 0 }}>
        El identificador de tu empresa, que te pediremos al entrar, es <strong>{tenantSlug}</strong>
        .
      </Text>

      <Text style={{ marginTop: 24, marginBottom: 0, fontSize: 13, color: '#475569' }}>
        Si el botón no funciona, copia este enlace en el navegador:
        <br />
        <Link href={setPasswordUrl} style={{ color: '#2563eb' }}>
          {setPasswordUrl}
        </Link>
      </Text>

      <Text style={{ marginTop: 24, marginBottom: 0, fontSize: 13, color: '#475569' }}>
        El enlace caduca en 7 días. Si caduca, pide otro en{' '}
        <Link href={loginUrl} style={{ color: '#2563eb' }}>
          la página de acceso
        </Link>{' '}
        con «He olvidado mi contraseña».
      </Text>
    </EmailLayout>
  );
}

AccountReadyEmail.PreviewProps = {
  fullName: 'Jane Doe',
  setPasswordUrl: 'https://app.storageos.local/reset-password/abc.def',
  tenantSlug: 'trasteros-garcia',
  loginUrl: 'https://app.storageos.local/login',
} satisfies AccountReadyEmailProps;

export default AccountReadyEmail;
