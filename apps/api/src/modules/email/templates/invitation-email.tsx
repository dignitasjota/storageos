import { Button, Link, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

export interface InvitationEmailProps {
  recipientName: string;
  inviterName: string;
  tenantName: string;
  role: string;
  acceptUrl: string;
}

/** Rol en palabras (el email llega a alguien que aún no conoce el panel). */
const ROLE_LABEL: Record<string, string> = {
  owner: 'propietario',
  manager: 'gestor',
  staff: 'personal del local',
  readonly: 'consulta (solo lectura)',
};

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
        <strong>{ROLE_LABEL[role] ?? role}</strong>. Acepta la invitación para crear tu cuenta:
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
        Aceptar invitación
      </Button>

      <Text style={{ marginTop: 24, marginBottom: 0, fontSize: 13, color: '#475569' }}>
        Si el botón no funciona, copia este enlace en el navegador:
        <br />
        <Link href={acceptUrl} style={{ color: '#2563eb' }}>
          {acceptUrl}
        </Link>
      </Text>

      <Text style={{ marginTop: 24, marginBottom: 0, fontSize: 13, color: '#475569' }}>
        El enlace caduca en 7 días. Si no esperabas esta invitación, puedes ignorar este email.
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
