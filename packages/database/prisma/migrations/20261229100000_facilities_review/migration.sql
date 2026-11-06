-- Revisión de Locales: segundo aviso cuando un documento del local ya ha caducado.
ALTER TABLE "facility_documents" ADD COLUMN "expired_notified_at" TIMESTAMPTZ(6);

-- Lo que seguía encendido en locales ya borrados: desde ahora se apaga al borrarlos.
UPDATE "maintenance_plans" p SET "is_active" = false
  FROM "facilities" f WHERE p."facility_id" = f."id" AND f."deleted_at" IS NOT NULL AND p."is_active";
UPDATE "recurring_expenses" r SET "active" = false
  FROM "facilities" f WHERE r."facility_id" = f."id" AND f."deleted_at" IS NOT NULL AND r."active";
UPDATE "access_devices" d SET "is_active" = false
  FROM "facilities" f WHERE d."facility_id" = f."id" AND f."deleted_at" IS NOT NULL AND d."is_active";
UPDATE "camera_devices" c SET "is_active" = false
  FROM "facilities" f WHERE c."facility_id" = f."id" AND f."deleted_at" IS NOT NULL AND c."is_active";
