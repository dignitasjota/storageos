-- Función para generar UUID versión 7 (timestamp-ordered) según el draft IETF.
-- Layout (16 bytes): 48 bits timestamp ms big-endian + 4 bits versión (7) +
-- 12 bits aleatorios + 2 bits variant RFC4122 (10) + 62 bits aleatorios.
--
-- Ventajas frente a v4: las inserciones quedan casi ordenadas en el índice
-- B-tree por id, lo que reduce la fragmentación y mejora la localidad de
-- caché para consultas recientes.
--
-- Requiere la extensión pgcrypto para `gen_random_bytes`.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
PARALLEL SAFE
AS $$
DECLARE
    ts_millis bigint;
    raw_bytes bytea;
BEGIN
    -- Timestamp UTC en milisegundos, big-endian, 8 bytes; tomamos los 6 LSB.
    ts_millis := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
    raw_bytes := substring(int8send(ts_millis) from 3 for 6) || gen_random_bytes(10);

    -- Byte 6: versión 7 en los 4 bits altos -> (byte & 0x0F) | 0x70.
    raw_bytes := set_byte(raw_bytes, 6, ((get_byte(raw_bytes, 6) & 15) | 112));

    -- Byte 8: variant RFC 4122 en los 2 bits altos -> (byte & 0x3F) | 0x80.
    raw_bytes := set_byte(raw_bytes, 8, ((get_byte(raw_bytes, 8) & 63) | 128));

    RETURN encode(raw_bytes, 'hex')::uuid;
END
$$;

COMMENT ON FUNCTION uuid_generate_v7() IS
    'Genera un UUID v7 (timestamp-ordered). Definido en docs/DATA_MODEL.md.';
