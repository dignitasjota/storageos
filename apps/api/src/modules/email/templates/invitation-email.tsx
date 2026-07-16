import { Button, Link, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

export interface InvitationEmailProps {
  recipientName: string;
  inviterName: string;
  tenantName: string;
  role: string;
  acceptUrl: string;
}

export function InvitationEmail({
  recipientName,
  inviterName,
  tenantName,
  role,
  acceptUrl,
}: InvitationEmailProps) {
  return (
    <EmailLayout
      preview={`${inviterName} te ha invitado a ${tenantName} en TrasterOS`}
      heading={`Hola ${recipientName}, te han invitado a ${tenantName}`}
    >
      <Text style={{ margin: 0, marginBottom: 16 }}>
        {inviterName} te ha invitado a unirte a <strong>{tenantName}</strong> en TrasterOS como{' '}
        <strong>{role}</strong>. Acepta la invitacion para crear tu cuenta:
      </Text>

      <Button
        href={acceptUrl}
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
        Aceptar invitacion
      </Button>

      <Text style={{ marginTop: 24, marginBottom: 0, fontSize: 13, color: '#475569' }}>
        Si el boton no funciona, copia este enlace en el navegador:
        <br />
        <Link href={acceptUrl} style={{ color: '#2563eb' }}>
          {acceptUrl}
        </Link>
      </Text>

      <Text style={{ marginTop: 24, marginBottom: 0, fontSize: 13, color: '#475569' }}>
        El enlace caduca en 7 dias. Si no esperabas esta invitacion, puedes ignorar este email.
      </Text>
    </EmailLayout>
  );
}

InvitationEmail.PreviewProps = {
  recipientName: 'Jane Doe',
  inviterName: 'Jota',
  tenantName: 'Demo Storage',
  role: 'manager',
  acceptUrl: 'https://app.storageos.local/invite/abc.def',
} satisfies InvitationEmailProps;

export default InvitationEmail;
