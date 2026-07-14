# Integración con hardware Dahua (control de accesos + cámaras/NVR) — diseño técnico

> **Estado:** propuesta de diseño (2026-07-14). Ningún código Dahua está aún
> implementado. Este documento describe **cómo** encajarían los terminales de
> control de accesos y las cámaras/NVR de Dahua en el sistema de accesos y en la
> app, con las interfaces exactas del código actual y los endpoints reales de la
> API de Dahua.
>
> Complementa a [`HARDWARE_AKUVOX.md`](HARDWARE_AKUVOX.md) (patrones A/B y el
> endpoint `/access/verify`), [`HARDWARE_ESP32.md`](HARDWARE_ESP32.md) y
> [`HARDWARE_CANCELA.md`](HARDWARE_CANCELA.md).

## 0. TL;DR — veredicto

- **Accesos: encaje excelente.** Todo lo que necesitamos (abrir puerta, cortar el
  acceso de un moroso sin borrar la credencial, leer los logs de acceso) existe
  como **CGI HTTP directo contra el terminal en LAN**, con auth **Digest**, **sin
  la plataforma cloud de pago de Dahua (DSS/ICC)**.
- **Modelo de integración recomendado: Patrón B (offline/sync).** El terminal
  Dahua valida **él mismo** el PIN/tarjeta/QR contra las credenciales que le
  sincronizamos; nosotros lo usamos como fuente de verdad del hardware:
  sincronizar credenciales, **congelarlas por impago** (`CardStatus`), abrir en
  remoto (`openDoor`) y **reconciliar los eventos** hacia `access_logs`.
- **Gotcha del QR:** los lectores Dahua **no reenvían el QR "crudo por HTTP"** a
  nuestro servidor para que lo validemos nosotros (a diferencia de un ESP32 o de
  un escáner QR→HTTP genérico). El QR lo procesa el propio terminal (p. ej.
  **ASI6214S**) contra las credenciales sincronizadas. Para **PIN y RFID** el
  encaje es total; para **QR** hace falta un terminal que lo procese nativamente.
- **Cámaras/NVR: alcance acotado (decisión 2026-07-14) = solo logs de eventos +
  snapshots.** El **vídeo en vivo/grabado se deja a la app oficial de Dahua**
  (DMSS), lo que **elimina** el trozo caro (media-server + transcodificación
  RTSP→HLS/WebRTC). La integración se reduce a **ingesta de eventos + snapshot**,
  que además puede resolverse con **push del propio equipo** (FTP/email/HTTP
  linkage) a un endpoint nuestro, **sin gateway ni túnel** si tiene salida a
  Internet. Un agente on-site ligero solo si se quiere "snapshot on-demand".
- **Antes de comprar:** la doc oficial de la API de accesos **no es 100%
  pública** (portal de partners). Pedir al distribuidor español (By Demes /
  Visiotech) la *"HTTP API for Access Control"* del firmware exacto del modelo.

---

# Parte A — Control de accesos

## A.1 Los dos patrones (recordatorio)

Ver [`HARDWARE_AKUVOX.md` §1](HARDWARE_AKUVOX.md). Resumen:

- **Patrón A (online):** el hardware pregunta a nuestro `/access/verify` en cada
  intento (o nosotros le mandamos abrir). **Nosotros** validamos la credencial
  (hash argon2, curfew, ventanas, single-use, rate-limit).
- **Patrón B (offline/sync):** sincronizamos las credenciales al dispositivo y él
  valida **solo**, sin depender de la red en cada apertura. Los intentos quedan
  como *offline records* que reconciliamos después.

**Dahua encaja de forma nativa en el Patrón B** (el terminal es autónomo por
diseño), con la capa online del Patrón A para la **apertura remota** (botón del
portal/staff que ya existe, ver `AccessVerifyService.openForCustomer` y
`AccessDevicesService.remoteOpen`).

## A.2 Los tres flujos que necesitamos, con el endpoint real de Dahua

Todos son **CGI HTTP contra la IP del terminal en la LAN**, auth **Digest**
(firmware reciente; los muy antiguos usaban Basic).

### A.2.1 Abrir puerta (Patrón A / apertura remota)

```
GET http://<ip-terminal>/cgi-bin/accessControl.cgi?action=openDoor&channel=1&UserID=101&Type=Remote
```
- `channel` (requerido, nº de puerta desde 1); `UserID`/`Type` opcionales
  (`Type` por defecto `Remote`). Respuesta `OK` en éxito.
- Ejemplo:
  ```bash
  curl -s --globoff --digest --user "user:pass" \
    "http://192.168.1.110/cgi-bin/accessControl.cgi?action=openDoor&channel=1&Type=Remote"
  ```
- Esto es exactamente nuestro `LockProvider.open()`.

### A.2.2 Cortar/reactivar acceso por impago (sin borrar la credencial)

Gestión de credenciales vía `recordUpdater.cgi` (acciones `insert`/`update`/`remove`
sobre el registro `AccessControlCard`):

```
# Alta de una credencial (tarjeta / PIN asociado a un usuario)
GET /cgi-bin/recordUpdater.cgi?action=insert&name=AccessControlCard&CardNo=12001&UserID=101&CardName=Juan&CardStatus=0&CardType=0

# CONGELAR por impago (no se borra: al pagar vuelve a 0)
GET /cgi-bin/recordUpdater.cgi?action=update&name=AccessControlCard&recno=<rec>&CardStatus=8

# Reactivar al pagar
GET /cgi-bin/recordUpdater.cgi?action=update&name=AccessControlCard&recno=<rec>&CardStatus=0

# Baja definitiva (fin de contrato)
GET /cgi-bin/recordUpdater.cgi?action=remove&name=AccessControlCard&recno=<rec>
```

**`CardStatus`** trae estados de suspensión nativos, perfectos para el moroso:
`0` Normal · `1` Extraviada · `2` Cancelada · `4` **Frozen** · `8` **Arrearage
(impago)** · `16` **Overdue (vencida)** · `32` Pre-arrearage. Es decir, cortar el
acceso de un inquilino moroso = `update CardStatus=8` y al pagar `update
CardStatus=0`, **sin re-emitir el PIN**. Encaja 1:1 con nuestra lógica de
`suspend`/`resume` por dunning.

### A.2.3 Logs y eventos de acceso

**Consulta histórica** (registro `AccessControlCardRec`, incluye offline records):
```
GET /cgi-bin/recordFinder.cgi?action=find&name=AccessControlCardRec&StartTime=<unix>&EndTime=<unix>&count=100
```
Devuelve quién/cuándo/resultado. Filtros por rango y por `CardNo`.

**Tiempo real** (stream HTTP persistente con heartbeat; **no** es un webhook que
el device postee a una URL nuestra):
```
GET /cgi-bin/eventManager.cgi?action=attach&codes=[AccessControl]&heartbeat=5
```
Se mantiene la conexión abierta y el terminal empuja los eventos conforme
ocurren. En nuestra arquitectura, **el worker** mantendría esta conexión viva por
dispositivo (o, más simple, un poll periódico de `recordFinder`).

### A.2.4 Nada de esto requiere DSS/ICC

Los CGI anteriores funcionan device-direct en LAN. **DSS Express/Pro** (VMS de
Dahua, licencia por puerta) es una capa de gestión centralizada **opcional** que
nosotros ya cubrimos en el SaaS: se ignora por completo. Existe además el
**NetSDK** (librería binaria C/.NET) como alternativa al CGI, pero para nuestro
stack Node el **CGI HTTP encaja mucho mejor**.

## A.3 Costuras de integración en NUESTRO código (dónde enchufar Dahua)

El módulo de accesos ya está preparado para meter un provider nuevo sin tocar el
resto. Puntos de extensión exactos:

| Costura | Fichero | Qué hace hoy | Qué añade Dahua |
|---|---|---|---|
| **`LockProvider`** (abstracto: `open(args)` → `{dispatched}`) | `apps/api/src/modules/access/providers/lock-provider.ts` | Interfaz + `OpenLockArgs` (trae `controlUrl`, `controlSecret`, `deviceId`, `tenantId`, `customerId`) | Nuevo `DahuaLockProvider` que hace `openDoor` por HTTP **Digest** |
| **Factory por env** `LOCK_PROVIDER` | `access.module.ts` (`useFactory`, líneas ~44-56) | `stub`\|`mqtt`\|`http` | Añadir la rama `'dahua'` |
| **Provider HTTP de referencia** | `providers/http-lock.provider.ts` | POST firmado HMAC + timeout 8 s + no lanza (`dispatched:false`) | El `DahuaLockProvider` copia el patrón pero con **GET + Digest** en vez de POST+HMAC |
| **Apertura remota** (staff/portal) | `access-devices.service.ts` `remoteOpen()` (~L246) y `access-verify.service.ts` `openForCustomer()` (portal, #351) | Llaman `this.lock.open(...)` y registran en `access_logs` | Sin cambios: al resolver el provider a Dahua, ya abren por `openDoor` |
| **Suspender/reactivar por impago** | `access-integrations.service.ts` (`@OnEvent invoice.paid` → `resume`; `suspendForDunning` → `suspend`; `contract_ended` → revoke) | Cambia el estado en NUESTRA BD | Un **sync** debe propagar ese cambio al terminal como `CardStatus` |
| **Modelo del device** | `access_devices` (`controlUrl`, `controlSecretEncrypted` AES-GCM, `hardwareId`, `facilityId`, `mqttTopic`, `metadata`) | Ya guarda URL+secreto del controlador | Reutilizamos `controlUrl`=IP del terminal; credenciales del terminal (user/pass Digest) cifradas en `controlSecretEncrypted` o en `metadata` |
| **Log de acceso** | `access_logs` (`deviceId`, `credentialId`, `customerId`, `method` pin/qr/rfid, `result` allowed/denied_*, `attemptedValue`, `reason`, `metadata`, `occurredAt`) | Lo escribe nuestro verify/remoteOpen | El reconciliador de eventos Dahua **inserta** aquí los offline records |

## A.4 Diseño del `DahuaLockProvider` (Patrón A — apertura remota)

Es el trozo pequeño y de menor riesgo. Un provider nuevo análogo a
`HttpLockProvider` pero con **Digest auth** y **GET**:

```ts
// apps/api/src/modules/access/providers/dahua-lock.provider.ts (propuesta)
@Injectable()
export class DahuaLockProvider extends LockProvider {
  get name() { return 'dahua'; }

  async open(args: OpenLockArgs): Promise<OpenLockResult> {
    if (!args.controlUrl) return { dispatched: false, message: 'device_sin_control_url' };
    // controlUrl = "http://<ip>"; el canal/puerta va en metadata del device o
    // se fija a 1. Credenciales Digest (user:pass) descifradas en controlSecret
    // (formato "user:pass").
    const url = `${args.controlUrl}/cgi-bin/accessControl.cgi?action=openDoor&channel=1&Type=Remote`;
    // Digest handshake: 1ª request → 401 con nonce → repetir con Authorization: Digest ...
    // (usar un cliente que soporte Digest, o implementarlo con el WWW-Authenticate).
    // Timeout 8 s + AbortController; NO lanzar → devolver {dispatched:false} ante fallo.
  }
}
```

- **Digest**: Node `fetch` no lo trae; hay dos vías: (a) un helper Digest propio
  (parsear `WWW-Authenticate`, calcular `HA1/HA2/response`), o (b) una dependencia
  ligera (`digest-fetch`/`urllib`). Preferible el helper propio (sin dependencia
  nueva, mismo criterio que el resto del proyecto).
- Reutiliza `controlUrl` (IP del terminal) y `controlSecretEncrypted` (para
  `user:pass`). El `channel`/puerta se guarda en `access_devices.metadata`.
- **Cero cambios** en `remoteOpen`/`openForCustomer`: solo se resuelve el provider.

## A.5 Diseño del módulo de sincronización (Patrón B — el grueso)

Es lo que convierte a Dahua en fuente de verdad del hardware. Análogo al
`SyncLockProvider` que ya estaba en el roadmap para ZKTeco
([`HARDWARE_AKUVOX.md` §7](HARDWARE_AKUVOX.md)).

**Nuevo `DahuaSyncService`** (en el módulo access, corre en el **worker**):

1. **Provisión de usuario + credencial** al firmar/emitir (listener de
   `contract_signed`/`invoice_paid`, ya existentes en
   `access-integrations.service.ts`): `recordUpdater insert` de `AccessUser` +
   `AccessControlCard` (o password/PIN según serie) en cada terminal del scope
   del inquilino (los locales/trasteros de sus contratos vivos — misma resolución
   que `resolveCustomerScope`).
2. **Congelar por impago** (`suspendForDunning`) → `recordUpdater update
   CardStatus=8`; **reactivar** (`invoice.paid → resume`) → `CardStatus=0`;
   **baja** (`contract_ended`) → `recordUpdater remove`.
3. **Reconciliación de logs** (cron en el worker): por cada terminal,
   `recordFinder AccessControlCardRec` desde el último `occurredAt` sincronizado
   → mapear cada registro a `access_logs` (`deviceId`, `credentialId` por
   `CardNo`, `result`, `occurredAt`). Alternativa "en vivo": mantener el
   `eventManager attach` abierto por device (más complejo de operar con muchos
   terminales; el poll es más robusto para v1).
4. **Idempotencia**: guardar el `recno`/`CardNo` que asigna el terminal en el
   `metadata`/`secretPreview` de nuestra `access_credentials`, y un cursor de
   última reconciliación por device en `access_devices.metadata`.

**Mapa de estados credencial → CardStatus:**

| Nuestro estado (`access_credentials.status` / motivo) | Dahua `CardStatus` |
|---|---|
| `active` | `0` (Normal) |
| `suspended` por dunning/impago | `8` (Arrearage) |
| `suspended` por staff (seguridad) | `4` (Frozen) |
| `revoked` / fin de contrato | `remove` (baja) |

## A.6 El gotcha del QR (importante)

- Con ESP32/Akuvox describimos un flujo "escáner QR → HTTP a nuestra URL" donde
  **nosotros** validamos el QR (hash). **Dahua NO hace eso**: el lector saca el QR
  por **RS-485** hacia una controladora Dahua, o lo procesa el **propio terminal**
  internamente.
- Consecuencia: para que el QR funcione con Dahua hay que usar un **terminal que
  procese el QR nativamente** (p. ej. **ASI6214S**) y que valide contra las
  credenciales sincronizadas (Patrón B). No hay un "QR crudo → HTTP" tan limpio.
- **PIN y RFID sí** encajan al 100% en ambos patrones. Recomendación v1: **PIN**
  (el inquilino ya lo tiene en el portal) + opcionalmente RFID; el QR solo si el
  piloto con ASI6214S lo valida en campo.

## A.7 Modelos recomendados

| Modelo | Métodos | Notas |
|---|---|---|
| **ASI6214S** | Cara + huella + tarjeta + **QR** + PIN | "Todo en uno" con QR nativo; RS-485 + Wiegand; 6.000 users / 10.000 tarjetas / 300.000 eventos. **Candidato del piloto.** |
| **ASI7214Y-V3** | Facial alta capacidad + tarjeta + PIN | 50.000 caras; RS-485/RS-232/Wiegand/USB |
| **ASR2100A-ME** (lector) | QR + tarjeta | ⚠️ el **QR solo va por RS-485**, no por Wiegand → necesita controladora Dahua; no encaja con nuestro modelo salvo Patrón B con controladora |

Series con API HTTP de accesos confirmada: **ASI3xxx / ASI6xxx / ASI7xxx**.

## A.8 Seguridad / operativa (accesos)

- Credenciales Digest del terminal (user/pass) **cifradas** (AES-GCM, como
  `controlSecretEncrypted`); nunca en claro ni en logs.
- Forzar cambio de la contraseña por defecto en el primer arranque del terminal.
- Preferir el terminal en una **VLAN de dispositivos** sin salida a Internet; el
  worker le habla por la LAN (o vía el gateway on-site, ver Parte B).
- El corte por impago **congela** (no borra) → reactivación instantánea al pagar
  sin perder el historial ni re-emitir el PIN.
- La apertura real depende del hardware: `dispatched:true` = "comando enviado y
  aceptado", **no** "la puerta abrió físicamente". El ACK físico de apertura
  sigue siendo un pendiente transversal (igual que con el resto del hardware).

---

# Parte B — Cámaras y NVR (solo logs de eventos + snapshots)

> **Decisión de alcance (2026-07-14):** la app integra **únicamente** el **log de
> eventos** (con su miniatura) y **snapshots**. El **vídeo en vivo y la
> reproducción de grabaciones se dejan a la app oficial de Dahua** (DMSS /
> gDMSS / iDMSS en móvil, SmartPSS/DSS en escritorio), que ya resuelve el vídeo
> por su nube P2P sin que tengamos que montar streaming.
>
> Esto **elimina** el trozo caro: no hace falta media-server (MediaMTX/go2rtc/
> Frigate) ni transcodificación RTSP→HLS/WebRTC. La integración se reduce a
> **ingesta de eventos + snapshots**.

## B.1 Qué usamos y qué NO

| | Integramos en la app | Cómo |
|---|---|---|
| **Log de eventos** (movimiento, IVS/línea cruzada, detección de persona, sabotaje…) | ✅ Sí | Con su **snapshot del momento** |
| **Snapshot / imagen** | ✅ Sí | JPEG del evento (y opcionalmente on-demand) |
| **Vídeo en vivo** | ❌ No — app de Dahua (DMSS) | — |
| **Reproducción de grabaciones** | ❌ No — app de Dahua (DMSS/SmartPSS) | — |

Endpoints device-direct (auth **Digest**) que sí usamos:
- **Snapshot JPEG:** `GET /cgi-bin/snapshot.cgi?channel=N`.
- **Eventos con snapshot:** `eventManager.cgi?action=attach&codes=[All]` (stream) o
  `snapManager.cgi?action=attachFileProc` (el evento trae la imagen). También por
  **ONVIF** (pull-point) para no atarnos a Dahua.

## B.2 Arquitectura — más simple sin vídeo, pero sigue el NAT

Las cámaras/NVR viven en la **LAN del local tras NAT/CGNAT**. Al quitar el vídeo,
el camino se simplifica mucho: **basta que los eventos + snapshot lleguen a un
endpoint de ingesta nuestro**, y hay dos formas de conseguirlo **sin abrir
puertos ni túnel** si el equipo tiene salida a Internet.

**Opción 1 (recomendada, casi sin infra) — push del propio equipo:**
```
[ Cámara/NVR Dahua ]  --evento + snapshot (salida a Internet)-->  [ POST /webhooks/camera-events (StorageOS) ]
   alarm linkage: HTTP upload / FTP / email
```
Los equipos Dahua permiten **subir la captura del evento** por **FTP**, **email**
o (según modelo/firmware) **HTTP upload** como "linkage" de la alarma. Montamos un
**endpoint de ingesta** (FTP embebido o webhook HTTP + un buzón email→webhook) y
el dispositivo nos empuja el evento con su JPEG. Cero gateway, cero puertos
entrantes. Limitación: el snapshot es **el del evento**, no "una foto ahora mismo"
arbitraria.

**Opción 2 (si se quiere snapshot on-demand "ver una foto ahora") — agente ligero:**
Un **agente on-site muy ligero** por local (una cajita, o el propio NVR si expone
lo necesario) con **túnel saliente** (WireGuard/Tailscale) que, a petición de
nuestra nube, hace `snapshot.cgi` y devuelve el JPEG. Es **mucho más ligero que un
media-server** (no transcodifica vídeo; solo un GET puntual). Solo se añade si el
"ver una foto ahora" se considera necesario; para el 90% del valor (eventos con
miniatura) basta la Opción 1.

En ambos casos, **nuestro backend hace de proxy/almacén**: el navegador nunca
habla con la cámara → resuelve CORS y no expone credenciales del equipo. Las
credenciales de cada cámara se guardan **cifradas** (patrón `controlSecretEncrypted`).

## B.3 Modelo de datos sugerido (cuando se aborde)

- Tabla `camera_devices` (tenant + facility + `channel` + credenciales cifradas +
  `onvifUrl`/IP + `serialNumber` para que el operador la añada también a **DMSS**).
- Tabla `camera_events` (`deviceId` + tipo de evento + **`snapshotKey`** en MinIO +
  `occurredAt` + `metadata`). El endpoint de ingesta valida el origen (HMAC como
  los webhooks salientes, o secreto por device) e inserta la fila + sube el JPEG.
- Los snapshots van a un **bucket privado** (evidencia), servidos con **URL firmada
  temporal** (mismo patrón que las fotos de inspección de contrato).

## B.4 Dónde se ve en la app

- **Ficha del local:** «Últimos eventos de cámara» (lista con miniatura + hora + tipo).
- **Ficha del trastero / incidencia:** eventos de cámara del pasillo/zona en la
  ventana de tiempo relevante (evidencia junto a la incidencia).
- **Botón «Ver en directo»** → enlace/nota que remite a la **app de Dahua (DMSS)**
  con el nº de serie del equipo; no reproducimos vídeo nosotros.

## B.5 Reparto de esfuerzo (con el alcance acotado)

- **Fase 1 (bajo esfuerzo):** ingesta de eventos + snapshot por **push** (Opción 1)
  + modelo de datos + las dos vistas de arriba. Es el grueso del valor.
- **Fase 2 (opcional):** agente on-site para **snapshot on-demand** (Opción 2).
- **Fuera de alcance:** vídeo en vivo y grabaciones → app de Dahua.

---

## Fuentes

- DAHUA ACCESS CONTROL PRODUCTS INTEGRATION INSTRUCTION Ver1.0 (portal de
  partners, files.dahua.support).
- Dahua HTTP API v2.x (recopilación de CGI: `accessControl.cgi`,
  `recordUpdater.cgi`, `recordFinder.cgi`, `eventManager.cgi`, `snapshot.cgi`,
  `mediaFileFind`).
- DahuaWiki — Access Control; manuales ASI6214S / ASI7214Y-V3 / ASR2100A-ME.
- ONVIF Profiles S/G/T.

## Checklist antes de comprometerse

1. Pedir al distribuidor (By Demes / Visiotech) la **"HTTP API for Access
   Control"** del firmware exacto del **ASI6214S** (o serie ASI7xxx).
2. Piloto de accesos: `DahuaLockProvider` (Digest `openDoor`) + `DahuaSyncService`
   (insert/`CardStatus`/`recordFinder`) con **PIN** primero; validar el flujo
   **QR** en campo antes de comprometerlo.
3. Piloto de cámaras (alcance acotado): configurar el **linkage de alarma** de una
   cámara para que suba el snapshot del evento por **FTP/email/HTTP** a un endpoint
   de ingesta nuestro y validar que el evento + miniatura aparecen en la app. El
   vídeo en vivo se comprueba directamente con la **app DMSS** (sin trabajo por
   nuestra parte).
