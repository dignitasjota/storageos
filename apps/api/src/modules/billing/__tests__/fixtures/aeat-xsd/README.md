# Esquemas de Veri\*Factu (AEAT)

Copias de los XSD oficiales que usa `verifactu-xsd.spec.ts` para validar el XML que generamos, descargadas el 8 de noviembre de 2026:

- `SuministroLR.xsd`, `SuministroInformacion.xsd` y `ConsultaLR.xsd`, de la sede de la AEAT (`https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/`).
- `xmldsig-core-schema.xsd`, del W3C (lo importa `SuministroInformacion.xsd`).

Único cambio: en `SuministroInformacion.xsd` la importación de `xmldsig-core-schema.xsd` apunta a la copia local, para validar sin red. Si la AEAT publica una versión nueva de los esquemas, se sustituyen aquí.
