# Control de accesos con ESP32 — guía + firmware de ejemplo

Esta guía explica cómo montar un **controlador de puerta** barato con un **ESP32**
que valida los códigos de los inquilinos contra StorageOS y abre la cerradura.

StorageOS es el **cerebro** (guarda las credenciales, decide si se permite el
acceso, registra cada intento). El ESP32 es el **músculo** en la puerta: lee el
código, pregunta a la API y, si la respuesta es _permitido_, acciona el relé.

> Firmware de ejemplo: [`examples/esp32-access-controller/`](examples/esp32-access-controller/).
> Para el escenario "solo cancela perimetral" (cada trastero con candado del cliente), ver también [`HARDWARE_CANCELA.md`](HARDWARE_CANCELA.md).

---

## 1. Arquitectura: dos patrones

StorageOS soporta dos formas de integrar un controlador físico. Esta guía cubre
sobre todo el **Patrón A**, que es el más sencillo y autónomo.

### Patrón A — el lector pregunta (`/access/verify`) ← recomendado para empezar

```
[Inquilino teclea PIN] → [ESP32 + teclado] → POST /v1/access/verify → [StorageOS]
                                                        ↓ allowed:true
                              [ESP32 acciona el relé] → [Cerradero eléctrico abre]
```

El ESP32 inicia la conexión saliente (HTTPS) hacia la API. **No necesita IP
pública ni abrir puertos** en el local: solo salida a internet. Ideal para
teclados, lectores QR y RFID.

### Patrón B — StorageOS manda abrir (apertura remota)

El backend hace `POST` a una URL del dispositivo (`controlUrl`) cuando el staff
pulsa **"Abrir (remoto)"** en el panel. Requiere que el ESP32 exponga un
**servidor HTTP accesible desde la API** y verifique la firma HMAC. Más
complejo (hay que publicar el dispositivo o tenerlo en la misma red que la API).
Se documenta en la sección 7; el firmware de ejemplo se centra en el Patrón A.

---

## 2. Lista de materiales (BOM) por puerta

| Pieza             | Ejemplo                                                        | Notas                                           |
| ----------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| Microcontrolador  | **ESP32 DevKit** (WROOM-32)                                    | WiFi integrado, ~5-8 €                          |
| Entrada de código | Teclado matricial **4x4**, o lector QR/RFID con salida serie   | según el método                                 |
| Actuador          | **Relé** 5V de 1 canal (con optoacoplador)                     | aísla el ESP32 de la carga                      |
| Cerradura         | **Cerradero eléctrico** (12V) / electroimán / motor de cancela | el actuador real                                |
| Alimentación      | Fuente 12V + regulador a 5V (o fuente doble)                   | el cerradero suele ser 12V                      |
| Opcional          | Fuente con **batería de respaldo (UPS)**                       | que no quede la puerta inutilizable en un corte |

> **Recomendación para arrancar:** empieza por **la cancela perimetral** (un solo
> punto de acceso al recinto) en vez de una cerradura por trastero. Es lo más
> común y barato; cableas el relé a la entrada "abrir" del motor de la cancela.

---

## 3. Esquema de conexión (teclado + relé)

```
ESP32                         Relé (canal 1)
 GPIO 13  ───────────────────► IN
 5V / VIN ───────────────────► VCC
 GND      ───────────────────► GND
                                 │ COM ── 12V+ ─┐
                                 │ NO  ─────────┴─► Cerradero eléctrico ─► 12V GND
ESP32  ── GPIO 12 (LED estado, opcional)

Teclado 4x4 → filas/columnas a 8 GPIO (ver el firmware: ROW_PINS / COL_PINS)
```

- El relé en **NO (normalmente abierto)**: el cerradero solo recibe corriente
  durante el pulso de apertura → **fail-secure** (cerrado si no hay corriente,
  típico en la cancela perimetral de un trastero).
- Para puertas peatonales con requisito de evacuación valora **fail-safe**
  (electroimán que abre al cortar corriente) y cumplir normativa contra incendios.

---

## 4. Dar de alta el dispositivo en StorageOS

1. En el panel: **Accesos → Dispositivos → Nuevo dispositivo**.
2. Rellena:
   - **Local (facility)**: a qué local pertenece (limita qué credenciales valen).
   - **Tipo**: `gate` (cancela), `door` (puerta), `unit_lock` o `other`.
   - **Nombre**: p. ej. "Cancela entrada".
   - **Hardware ID**: un identificador estable que pondrás también en el firmware
     (`DEVICE_ID`). P. ej. `gate-entrada-01`.
3. Al crear el dispositivo, StorageOS muestra **la API key una sola vez**
   (`revealedApiKey`). **Cópiala**: va al firmware como `DEVICE_KEY`. Si la
   pierdes, regenérala desde el panel (invalida la anterior).

API equivalente (si lo automatizas):

```
POST /v1/access/devices
Authorization: Bearer <token de staff>
{ "facilityId": "...", "type": "gate", "name": "Cancela entrada", "hardwareId": "gate-entrada-01" }
→ 201 { ..., "revealedApiKey": "<la key — solo aquí>" }
```

---

## 5. El contrato de `/access/verify`

Lo que el ESP32 llama por cada intento de acceso:

```
POST https://<TU_DOMINIO_API>/v1/access/verify
Headers:
  Content-Type: application/json
  X-Device-Key: <DEVICE_KEY>          ← la API key del dispositivo
Body:
  {
    "method": "pin",                  ← "pin" | "qr" | "rfid"
    "credential": "4821",             ← lo que presentó el inquilino
    "deviceId": "gate-entrada-01"     ← el Hardware ID (o el UUID del device)
  }
```

Respuesta `200 OK`:

```json
{
  "result": "allowed",
  "allowed": true,
  "customerName": "Ana García"
}
```

- **`allowed: true`** → abre. Es el único campo que el firmware necesita mirar.
- **`allowed: false`** → no abras. `result` te dice el motivo (para logs/pantalla):
  `denied_invalid_credential`, `denied_inactive_credential`,
  `denied_outside_hours`, `denied_wrong_facility`, `denied_dunning` (impago),
  `denied_unknown`, `error`.
- `401` → falta o es incorrecta la `X-Device-Key` (revisa la key / hardwareId).

> **Importante:** llama a **`/v1/access/verify`** (con el prefijo de versión). La
> ruta sin versión responde un redirect 308 que complica el cliente del ESP32.
> StorageOS **ya registra cada intento** (permitido o denegado) en su log de
> accesos; el ESP32 no tiene que reportar nada.

---

## 6. Cargar el firmware

Ver [`examples/esp32-access-controller/README.md`](examples/esp32-access-controller/README.md)
para las librerías y los pasos. En resumen:

1. Abre `esp32-access-controller.ino` en el **Arduino IDE** (o PlatformIO).
2. Instala las librerías: **ArduinoJson** y **Keypad** (gestor de librerías).
3. Rellena la sección `CONFIG` del `.ino` (WiFi, `API_HOST`, `DEVICE_ID`,
   `DEVICE_KEY`).
4. Selecciona placa **ESP32 Dev Module**, conecta por USB y sube.
5. Abre el **Monitor Serie** (115200) para ver los logs.

Flujo del firmware (Patrón A):

- El inquilino teclea su PIN y pulsa `#` (o `*` para borrar).
- El ESP32 hace `POST /v1/access/verify`.
- Si `allowed:true` → pulso en el relé (`RELAY_OPEN_MS`) → el cerradero abre.
- Si no → LED de error y vuelve a esperar.

---

## 7. Patrón B — apertura remota (avanzado)

Cuando el staff pulsa **"Abrir (remoto)"** en el panel, StorageOS hace un `POST`
a la `controlUrl` que configuraste en el dispositivo, **firmado con HMAC** usando
el `control_secret` del device:

```
POST <controlUrl>
Headers:
  Content-Type: application/json
  X-StorageOS-Signature: t=<ts>,v1=<hmac>
Body (JSON):
  { "command": "open", "deviceId": "gate-entrada-01", "customerId": "...", "ts": "<ts>" }
```

Donde:

```
hmac = HMAC_SHA256( control_secret, "<ts>.<body_json_exacto>" )   // hex
```

Para usarlo, el ESP32 debe **levantar un servidor HTTP** alcanzable por la API
(IP fija en la LAN de la API, port-forward, o un túnel) y **verificar la firma**
antes de abrir (recalcular el HMAC sobre `"<ts>.<body>"` y comparar; rechazar si
`ts` es viejo, p. ej. > 5 min, para evitar replay). Es más laborioso que el
Patrón A; úsalo solo si necesitas apertura iniciada desde el panel.

---

## 8. Seguridad y buenas prácticas

- **HTTPS siempre.** La API va sobre TLS (Let's Encrypt). El ejemplo usa
  `client.setInsecure()` para arrancar rápido; **en producción** fija el
  certificado raíz (root CA) en el firmware (ver comentario en el `.ino`).
- **La `DEVICE_KEY` es un secreto.** Cada dispositivo con la suya; si se
  compromete, regénerala en el panel. No la subas a repos públicos.
- **Rate limit:** `/access/verify` admite 60 req/min por dispositivo; añade un
  pequeño _debounce_ entre intentos (el firmware ya lo hace).
- **Antiretroceso:** mantén el relé como pulso corto (1-3 s), no como toggle, para
  que un reinicio del ESP32 no deje la puerta abierta.
- **Respaldo:** alimenta el conjunto con una pequeña UPS; decide el modo
  fail-safe/fail-secure según el tipo de puerta y la normativa.

---

## 9. Alternativas sin programar

Si no quieres firmware propio, los providers `http`/`mqtt` de StorageOS funcionan
con hardware comercial controlable por HTTP/MQTT:

- **Terminales comerciales PIN+QR (Akuvox y similares)**: integran por el
  **`GET /v1/access/verify`** (URL con placeholders), sin firmware propio. Ver
  [`HARDWARE_AKUVOX.md`](HARDWARE_AKUVOX.md) (incluye qué hardware encaja y qué
  no: Dahua/ZKTeco/Hikvision/2N).
- **Shelly** (relé WiFi con API HTTP): apertura por Patrón B sin código.
- **Home Assistant** como pasarela (recibe HTTP/MQTT y controla la cerradura).

La integración profunda con cerraduras específicas de self-storage
(**Noke / Janus**, **PTI**) usa cloud propietario y está fuera de alcance por
ahora (ver [`HARDWARE_AKUVOX.md §6`](HARDWARE_AKUVOX.md)).
