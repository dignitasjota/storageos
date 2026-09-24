-- Taquillas apilables: un tipo de trastero se marca "apilable" y dos units
-- de ese tipo pueden compartir el mismo hueco físico del plano (una
-- taquilla arriba, otra abajo), en vez de tener que dibujarse por separado
-- ocupando dos huecos como cualquier otro trastero.
ALTER TABLE "unit_types" ADD COLUMN "stackable" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "units" ADD COLUMN "stack_group_id" UUID;
ALTER TABLE "units" ADD COLUMN "stack_level" INTEGER;

CREATE INDEX "units_stack_group_id_idx" ON "units" ("stack_group_id");
