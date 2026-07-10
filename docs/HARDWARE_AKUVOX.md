# Control de accesos con terminales comerciales (Akuvox / QR / PIN) — guía

Guía para integrar un **terminal comercial de acceso** (teclado PIN + lector QR)
con StorageOS **por API abierta, sin depender del software del fabricante**.

El caso de referencia es **Akuvox** (serie A0x), porque tiene el mejor encaje con
la arquitectura que StorageOS ya soporta (**Patrón A**: el lector consulta
`/access/verify` en tiempo real). El mismo enfoque sirve para cualquier lector
que pueda **componer una URL con el código leído** (escáneres QR/Wiegand→HTTP,
2N, y muchos terminales IP en "modo servidor de terceros").

> Para el controlador DIY con ESP32, ver [`HARDWARE_ESP32.md`](HARDWARE_ESP32.md).
> Para el cableado de la cancela perimetral, ver [`HARDWARE_CANCELA.md`](HARDWARE_CANCELA.md).

---

## 1. Los dos patrones (recordatorio)

- **Patrón A — el lector pregunta** (recomendado): al presentar PIN/QR, el
  terminal hace una petición HTTP a StorageOS con el código; StorageOS valida
  (estado, pago al día, horario, local/trastero) y responde permitir/denegar.
  La credencial vive **solo** en StorageOS; el terminal no guarda usuarios.
- **Patrón B — sincronizar credenciales al terminal**: StorageOS empuja los
  PIN/QR al terminal por su API local y el terminal valida **offline**. Más
  resiliente si se cae la red, pero exige un módulo de sincronización +
  reconciliación (altas/bajas/impagos). Es el modelo de ZKTeco (ADMS/PUSH) y
  Dahua. **No implementado** en StorageOS todavía (ver §7).

Esta guía cubre el **Patrón A**, que ya está soportado end-to-end.

---

## 2. El endpoint que consume el terminal

Hay dos formas equivalentes de llamar a la verificación; usa la que soporte tu
terminal:

### 2.a `POST /v1/access/verify` (controladores propios / ESP32)

```
POST https://<API>/v1/access/verify
Headers: X-Device-Key: <DEVICE_KEY>
Body:    { "method": "pin", "credential": "481902", "deviceId": "<HW_ID>" }
```

### 2.b `GET /v1/access/verify?...` (terminales que integran por "URL con placeholders")

Muchos terminales comerciales (Akuvox en modo _servidor de terceros_, escáneres
QR/Wiegand→HTTP) **no permiten POST con body ni cabeceras personalizadas**: solo
dejan configurar **una URL con placeholders** que el terminal rellena con lo
leído. Para esos, StorageOS expone la **misma verificación por GET**:

```
GET https://<API>/v1/access/verify?key=<DEVICE_KEY>&device=<HW_ID>&pin={Pin}
GET https://<API>/v1/access/verify?key=<DEVICE_KEY>&device=<HW_ID>&qr={QRCode}
GET https://<API>/v1/access/verify?key=<DEVICE_KEY>&device=<HW_ID>&card={Card}
```

- `key` = la **API key del dispositivo** (se puede pasar también por header
  `X-Device-Key` si el terminal lo permite — es más seguro que en la URL).
- `device` = el **Hardware ID** que diste de alta.
- Uno de `pin` / `qr` / `card` (el terminal sustituye el placeholder, p. ej.
  Akuvox usa `{Pin}` / `{QRCode}` / `{Card}`). El **método se infiere** del
  parámetro presente. Alternativa genérica: `&method=pin&code={...}`.

**Respuesta (200)** — idéntica en POST y GET:

```json
{ "result": "allowed", "allowed": true, "customerName": "Ana García" }
```

`allowed:false` con `result` = `denied_invalid_credential` /
`denied_inactive_credential` / `denied_outside_hours` / `denied_wrong_facility` /
`denied_dunning` (impago) / `denied_unknown`. `401` si falta/es incorrecta la
API key. StorageOS **registra cada intento** en su log de accesos.

---

## 3. ¿Quién abre la puerta? (la decisión de diseño clave)

En el Patrón A, tras validar hay que **accionar el relé**. Dos opciones:

### Opción 1 (recomendada) — StorageOS acciona el relé

`/access/verify`, si el resultado es permitido, dispara el `LockProvider`
configurado en el dispositivo (**HTTP firmado** o **MQTT**). Así el "abrir" **no
depende de que el terminal interprete nuestra respuesta**: lo controlamos
nosotros. Configura el device con:

- **`controlUrl`** = la API de relé del propio terminal (p. ej. Akuvox tiene un
  endpoint HTTP para conmutar su relé), **o** un relé independiente (Shelly,
  ESP32, Home Assistant). StorageOS hará un `POST` firmado con HMAC (ver
  [`HARDWARE_ESP32.md §7`](HARDWARE_ESP32.md)).
- o **`mqttTopic`** si usas un relé por MQTT.

Es el modo más robusto y el que recomendamos para producción.

### Opción 2 — el terminal abre su propio relé según nuestra respuesta

Algunos terminales (Akuvox en modo _customize_) pueden **abrir su relé si la
respuesta del servidor cumple un formato concreto** y mostrar un mensaje en
pantalla. Nuestra respuesta incluye el booleano `allowed`, que puedes **mapear**
en la configuración del terminal. **Ojo:** el formato exacto que espera cada
terminal para "abrir" **varía por modelo/firmware** y hay que confirmarlo en su
**manual de HTTP API** antes de desplegar. Por eso recomendamos la Opción 1.

---

## 4. Configurar el terminal Akuvox (resumen)

> Basado en la documentación pública de integración con terceros de Akuvox. Los
> nombres de menú cambian entre modelos/firmware; confirma con tu distribuidor
> (en España: **By Demes**, **Visiotech**). Verifica en el manual del modelo
> concreto que soporta el "modo servidor de terceros" con lectura QR.

1. Da de alta el dispositivo en StorageOS: **Accesos → Dispositivos → Nuevo**,
   tipo `gate` (cancela) / `door`, asígnalo al local, copia la **API key** (se
   muestra una vez) y fija un **Hardware ID** estable.
2. En el terminal Akuvox, entra en la sección de **integración con dispositivo/
   servidor de terceros** (HTTP API / "Third-party") y configura la **URL de
   verificación** apuntando al GET del §2.b con tu `key`, `device` y el
   placeholder correspondiente (`{Pin}` para teclado, `{QRCode}` para QR).
3. Autenticación de la petición: usa `key` en la URL o, si el terminal lo
   permite, mueve la API key al header `X-Device-Key` (más seguro).
4. Apertura del relé: elige la Opción 1 (recomendada, configura `controlUrl`/
   `mqttTopic` en StorageOS) o la Opción 2 (mapea `allowed` en el terminal).
5. Prueba: PIN/QR de un cliente al corriente → abre; de un cliente con factura
   vencida → `denied_dunning` (no abre). Revisa **Accesos → Registro**.

---

## 5. Seguridad

- **HTTPS siempre** (la API va sobre TLS). Si pones la API key en la URL (`?key=`),
  ten en cuenta que puede quedar en logs/proxies intermedios: **prefiere el
  header `X-Device-Key`** cuando el terminal lo soporte.
- **Una API key por dispositivo**, revocable/rotable desde el panel.
- **Rate limit / anti-fuerza-bruta**: `/access/verify` tiene 60 req/min por IP
  **y** un lockout temporal (Redis) por **dispositivo** (tras N PINs/QR no
  reconocidos — frena el tecleo masivo) y por **credencial** (tras N
  denegaciones sobre una misma credencial; excluye el impago para no bloquear a
  quien va a pagar). Un acceso permitido resetea los contadores. Umbrales por
  env `ACCESS_BRUTEFORCE_*` (defaults: 10/dispositivo, 20/credencial, ventana
  5 min, bloqueo 15 min; fail-open si Redis cae). El lockout por dispositivo
  (no por IP) evita que varios lectores tras el mismo NAT se bloqueen entre sí.
- La **validación es online**: si el terminal pierde conexión con la API, nadie
  entra (no hay caché offline en Patrón A). Deja **siempre la salida libre**
  (ver [`HARDWARE_CANCELA.md §3`](HARDWARE_CANCELA.md)) y valora una conexión
  fiable (4G de respaldo) o el Patrón B si necesitas operar sin red.

---

## 6. Qué hardware encaja (y qué no)

| Opción                                                 | Patrón | Encaje                                                                                                                                                              |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Akuvox A03 / A05S** (PIN + QR + RFID, IP65, PoE)     | **A**  | ⭐ Recomendado: API HTTP pública, modo "servidor de terceros" (URL con placeholders), sin cloud. Confirma con el distribuidor el soporte de QR-servidor del modelo. |
| **2N Access Unit 2.0 / QR**                            | A/B    | HTTP API muy bien documentada; premium.                                                                                                                             |
| **ESP32 + teclado Wiegand / escáner QR (GM861)**       | A puro | Máxima libertad y coste mínimo; DIY (sin carcasa/soporte de fabricante). Ver [`HARDWARE_ESP32.md`](HARDWARE_ESP32.md).                                              |
| **ZKTeco SpeedFace-V5L[QR] / SF + controladora Atlas** | **B**  | Barato y con stock, pero valida offline → requiere el módulo de sincronización ADMS/PUSH (no implementado, §7).                                                     |
| **Hikvision MinMoe (ISAPI)**                           | B      | REST local (ISAPI); el QR sin su cloud es incierto por modelo.                                                                                                      |
| Lectores QR de **Dahua** (ASR2101A-QR)                 | —      | ❌ Solo hablan RS-485 con controladoras Dahua; no reenvían el código a terceros.                                                                                    |
| ZKTeco **C3/inBio**                                    | —      | ❌ PULL SDK (DLL Windows + polling); mal encaje con el stack.                                                                                                       |
| **PTI / Noke / OpenTech**                              | —      | ❌ Cloud propietario con cuota; sin API local. Solo si un cliente ya los tiene.                                                                                     |

**Camino sugerido**: piloto con **ESP32 + teclado/QR** (ya funciona sin código
nuevo) para validar el flujo end-to-end; luego decidir **Akuvox** (Patrón A,
menos código, valida online) vs **ZKTeco** (más barato por unidad, valida
offline pero exige el módulo del §7).

---

## 7. Roadmap — Patrón B (sincronización de credenciales)

Para terminales que solo validan **offline** (ZKTeco ADMS/PUSH, Dahua, Hikvision
ISAPI), StorageOS necesitaría un módulo que:

1. **Empuje** las credenciales (`access_credentials`) al terminal por su API
   local cuando se emiten/suspenden/revocan (alta al firmar, bloqueo por impago,
   revocación al finalizar).
2. **Reconcilie** periódicamente (el terminal como fuente de verdad de "quién
   está cargado") y **consuma los eventos** de acceso del terminal hacia
   `access_logs`.

Es un provider más (`SyncLockProvider`) + un endpoint que reciba el push del
terminal. No está implementado; se prioriza si un cliente elige hardware de
Patrón B.
