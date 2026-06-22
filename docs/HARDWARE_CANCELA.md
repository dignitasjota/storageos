# Control de acceso en la cancela perimetral — guía

Guía para el escenario más habitual de self-storage: **se controla solo la(s)
cancela(s) de entrada al recinto**; cada trastero lo cierra el cliente con **su
propio candado físico** (StorageOS no gestiona la cerradura del trastero).

El cliente abre la cancela presentando su **PIN** (auto-emitido al contratar /
primer pago, visible en su portal). StorageOS valida y, si está **al corriente de
pago**, abre. Un moroso recibe `denied_dunning` en la puerta → no entra; al pagar
se reactiva solo.

> Esta guía cubre **lo específico de la cancela** (cableado al motor, salida,
> ubicación del lector, seguridad). El **controlador, el firmware y el contrato de
> `/v1/access/verify`** están en [`HARDWARE_ESP32.md`](HARDWARE_ESP32.md).

---

## 1. Idea clave: no sustituyes la cancela, disparas su "abrir"

Casi todas las cancelas automáticas (correderas, batientes, barreras) ya tienen un
**cuadro de maniobra** (el motor + su electrónica) con una entrada de **contacto
seco** para "abrir". Es la misma señal que usan:

- el **pulsador de pared**,
- el **receptor del mando** a distancia,
- o un teclado/telefonillo existente.

**Tú solo añades una señal más en paralelo**: un **relé de contacto seco** que,
cuando StorageOS dice _allowed_, cierra ese contacto un instante y la cancela abre.
No tocas el motor ni la mecánica.

```
[Cliente teclea PIN] → [ESP32 + teclado IP65] → POST /v1/access/verify → [StorageOS]
                                                          ↓ allowed:true
                  [relé cierra contacto seco] → [borne "START/OPEN" del cuadro] → cancela ABRE
```

---

## 2. Identificar el borne de "abrir" en el cuadro de maniobra

En la regleta del cuadro busca un contacto de mando libre de tensión. Según marca,
los bornes se llaman distinto, pero el patrón es **`COM` + una entrada de mando**:

| Marca (ejemplos)  | Borne "abrir" típico              | Común     |
| ----------------- | --------------------------------- | --------- |
| CAME              | `2-7` (START) o `2-3P` (peatonal) | `2`       |
| BFT               | `START`                           | `COM`     |
| Nice              | `OPEN` / `P.P.` (paso a paso)     | `COM`     |
| FAAC              | `OPEN A` / `B`                    | `−` (COM) |
| Sommer / Marantec | `START` / impulso                 | `COM`     |

- **`START` / `P.P.` / paso a paso**: un pulso abre (y si está abierta, suele
  cerrar) — válido, pero ojo a la lógica "abrir-stop-cerrar".
- **`OPEN` dedicado**: un pulso **solo abre** — **preferible** para acceso (no
  cierra accidentalmente con alguien pasando).
- Conecta el relé como **contacto seco NO** entre ese borne y el `COM`. **No metas
  tensión**: es solo un contacto, igual que el pulsador.

> Si el cuadro no tiene entrada de mando libre, casi siempre puedes **emular el
> mando**: conectar el relé a los contactos del pulsador del propio mando a
> distancia. Pide el manual del cuadro o que lo vea tu instalador.

**Pulso, no mantenido:** configura el relé como **impulso corto** (1-2 s); en el
firmware es `RELAY_OPEN_MS`. La mayoría de cuadros esperan un pulso momentáneo.

---

## 3. La salida del recinto (¡importante!)

StorageOS controla la **entrada**. Para **salir**, deja **salida libre** — nadie
debe quedar atrapado:

- **Espira magnética (lazo inductivo)** bajo el asfalto en el carril de salida:
  detecta el coche y abre. Es lo más cómodo para vehículos.
- **Fotocélula / detector de salida** o **botón de salida** interior.
- Muchos cuadros ya traen entrada para detector de salida; úsala.

> No pongas la apertura de salida detrás de StorageOS: si se cae la red o la API,
> la gente debe poder salir igualmente.

---

## 4. El lector en la cancela

Para acceso de **vehículos** lo estándar es un **teclado PIN** en **poste/pedestal
(gooseneck)** a la altura de la ventanilla del conductor:

- **Teclado antivandálico metálico, IP65/IP66** (intemperie + resistente a golpes).
- **PIN** es lo más práctico: no hay que repartir tarjetas, el cliente lo recibe
  por email y lo ve en su portal, y funciona desde el coche sin móvil.
- Alternativas:
  - **RFID de largo alcance** (tag en el parabrisas) para no parar el coche →
    más caro y requiere repartir tags. Mapea el UID como credencial `rfid`.
  - **QR**: requiere lector/cámara y que el cliente saque el móvil → peor a la
    intemperie y de noche. Menos recomendable en cancela de vehículos.

Coloca el teclado y el controlador en **caja estanca**; el ESP32 va dentro, no a la
intemperie.

---

## 5. Alimentación y conectividad

- **Alimentación**: aprovecha la del cuadro de la cancela si da 12V, o una fuente
  propia. Pon una **UPS pequeña** para que un microcorte no deje la entrada KO.
- **Red**: el ESP32 necesita salida a internet hacia tu API (no requiere IP
  pública ni abrir puertos). **WiFi** si llega buena señal a la cancela, o un
  **router 4G** si está lejos del edificio. Cobertura estable = accesos fiables.

---

## 6. Varias cancelas

Una caja (ESP32 + teclado + relé) **por cancela**. En el panel das de alta **un
dispositivo por cancela** (cada uno con su `hardwareId` y su API key) y lo asocias
a su **local (facility)**. El `allowedFacilityIds` de cada credencial decide qué
cancela puede abrir cada cliente (útil si tienes varios locales o zonas).

---

## 7. Pasos de instalación (resumen)

1. **Mecánica/eléctrica** (instalador de la cancela): localizar el borne `OPEN`/
   `START` + `COM` del cuadro y dejar accesible la salida libre (espira/botón).
2. **Montaje**: poste con teclado IP65 a altura de ventanilla + caja estanca con el
   ESP32 y el relé cerca del cuadro.
3. **Cableado**: relé (NO/COM) → borne de "abrir" del cuadro. Alimentación + UPS.
4. **StorageOS**: panel → **Accesos → Dispositivos → Nuevo**, tipo **`gate`**,
   asígnalo al local, copia la **API key** (se muestra una vez) y el **Hardware ID**.
5. **Firmware**: graba el ESP32 con el ejemplo de
   [`HARDWARE_ESP32.md`](HARDWARE_ESP32.md), rellenando WiFi + `API_HOST` +
   `DEVICE_ID` + `DEVICE_KEY`. Ajusta `RELAY_OPEN_MS` (pulso) si hace falta.
6. **Prueba**: con un cliente de prueba, teclea su PIN → debe abrir. Prueba también
   un cliente **con factura vencida** → debe denegar (`denied_dunning`).
7. **Comprueba el log**: panel → **Accesos → Registro**: cada intento queda
   registrado (permitido/denegado + motivo).

---

## 8. Seguridad y normativa

- **Seguridad de la cancela**: una cancela automática debe llevar sus **dispositivos
  de seguridad** (fotocélulas, banda sensible, límite de fuerza) según **EN 12453 /
  EN 13241**. **No los desconectes**: tu relé solo añade una orden de "abrir", no
  sustituye la seguridad del cierre.
- **Salida siempre disponible** aunque se caiga la API (sección 3).
- **HTTPS + API key por dispositivo**: cada cancela con su key; si se compromete,
  regénerala en el panel. Detalle de seguridad del controlador en
  [`HARDWARE_ESP32.md §8`](HARDWARE_ESP32.md).
- Recomendable un **electricista/instalador de automatismos** para el conexionado al
  cuadro; la parte de StorageOS + ESP32 la configuras tú.

---

## 9. Alternativa sin teclado: abrir desde el móvil

Si prefieres que **no haya teclado** en la cancela, el cliente podría abrir desde su
**portal (PWA)** con un botón "Abrir cancela" y un relé WiFi (Shelly). Esa función
**aún no está implementada** (la apertura remota es solo de staff); es una feature
acotada que se puede añadir. Pregunta si te interesa y se prioriza.
