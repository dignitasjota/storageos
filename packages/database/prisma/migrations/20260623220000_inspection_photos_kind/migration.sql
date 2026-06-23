-- Generaliza las fotos de check-out a fotos de inspección (check-in + check-out).
-- Renombra la tabla y añade `kind`; las filas existentes son check-out.
ALTER TABLE "contract_checkout_photos" RENAME TO "contract_inspection_photos";
ALTER INDEX "contract_checkout_photos_tenant_contract_idx"
  RENAME TO "contract_inspection_photos_tenant_id_contract_id_idx";

ALTER TABLE "contract_inspection_photos" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'checkout';

-- La policy RLS `tenant_isolation` y los constraints viajan con la tabla al
-- renombrarla; no hace falta recrearlos.
