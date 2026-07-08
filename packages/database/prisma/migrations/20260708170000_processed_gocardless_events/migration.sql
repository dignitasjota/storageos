-- Deduplicación de eventos entrantes de GoCardless (como processed_stripe_events).
-- GoCardless reentrega lotes completos y puede entregar desordenado; sin dedup,
-- un evento `confirmed` repetido sumaba dos veces al `amountPaid`. La PK = id del
-- evento GoCardless (`EVxxxx`). Tabla GLOBAL (sin tenant, sin RLS): el webhook la
-- consume con el cliente admin, igual que la de Stripe.
CREATE TABLE "processed_gocardless_events" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "processed_gocardless_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "processed_gocardless_events_received_at_idx"
    ON "processed_gocardless_events" ("received_at");
