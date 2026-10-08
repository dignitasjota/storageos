-- Certificado de un administrador o asesor apoderado: si el NIF del certificado
-- no es el del tenant, los registros Veri*Factu se envían con <Representante>.
-- cert_organization_nif: NIF de la entidad del certificado (organizationIdentifier),
-- p. ej. la gestoría en un certificado de representante de persona jurídica.
-- representative_name: nombre o razón social del representante (editable).
ALTER TABLE "tenant_aeat_credentials" ADD COLUMN "cert_organization_nif" TEXT;
ALTER TABLE "tenant_aeat_credentials" ADD COLUMN "representative_name" TEXT;
