# Integración con hardware Dahua (control de accesos + cámaras/NVR + alarma) — diseño técnico

> **Estado (2026-07-16): software implementado y en verde, a falta del kit físico.**
> El andamiaje de la integración está construido y testeado **con stubs/servidores
> simulados** (sin hardware). Lo pendiente es rellenar los cuerpos CGI reales del
> adapter (marcados `VERIFY` en el código) contra el doc de firmware del terminal.
> Lo ya mergeado:
>
> - **Fase 1 (#360)** — auth **Digest** (sin dependencia nueva) + `DahuaLockProvider`
>   (apertura remota por `accessControl.cgi`) + **resolución del provider por device**
>   (`access_devices.provider` + `LockProviderRegistry`; multi-tenant con hardware mixto).
> - **Cámaras/alarma (#361)** — ingesta de **eventos + snapshots** (webhook con token
>   por device → snapshot a MinIO privado → feed `/cameras`); agnóstica del origen
>   (push del equipo / agente on-site / puente DSS). La alarma reutiliza el webhook
>   (`kind:'alarm'`).
> - **Fase 2A (#362)** — sync **Patrón B**: `CredentialSyncProvider` + `StubSyncProvider`
>   + `DahuaSyncProvider` (scaffold `VERIFY`) + `DahuaSyncService` + cron de reconciliación.
> - **Cámaras en la ficha del local (#363)** — pestaña «Cámaras».
>
> **Pendiente (necesita el kit)**: cuerpos CGI reales (`recordUpdater`/`recordFinder`,
> campos del firmware), perfiles horarios (curfew/ventanas → time profiles), armar/
> desarmar contra el NVR, y el agente on-site del NAT si el equipo queda en una LAN
> sin ruta desde la nube. Antes de comprar: pedir la *"HTTP API for Access Control"*
> del firmware a By Demes/Visiotech + confirmar NVR compatible con AirShield.
>
> Este documento describe **cómo** encajan los terminales de
> control de accesos, las cámaras/NVR y la alarma (AirShield) de Dahua en el
> sistema de accesos y en la app, con las interfaces exactas del código actual y
> los endpoints reales de la API de Dahua.
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
- **Alarma: Dahua AirShield frente a Ajax (decisión 2026-07-14).** Ajax es mejor
  alarma como producto, pero su API es **gated** (Enterprise API para empresas
  "con miles de sistemas") y **cloud-only**. AirShield **enlazado al NVR** entra
  por la **misma API/adapter** que cámaras/accesos → una integración, un timeline
  unificado (alarma + vídeo + acceso) y verificación por vídeo nativa. Ajax queda
  como **adapter futuro "premium"** detrás del mismo puerto si un cliente lo
  exige. Detalle en la Parte C.
- **Antes de comprar:** la doc oficial de la API de accesos **no es 100%
  pública** (portal de partners). Pedir al distribuidor español (By Demes /
  Visiotech) la *"HTTP API for Access Control"* del firmware exacto del modelo.

---

# Arquitectura de integración (ports & adapters)

> **Objetivo:** que cambiar de fabricante en el futuro (Dahua → otro) cueste
> **escribir otro adapter**, no tocar la aplicación. Esta sección fija **cómo** se
> aísla el proveedor. Es la guía de referencia; el detalle específico de Dahua
> vive en las Partes A y B.

## La decisión: adapter **in-process**, NO microservicio

Lo que da la capacidad de cambiar de proveedor con impacto mínimo **es la
interfaz (el "puerto"), no un límite de proceso**. StorageOS ya usa este patrón
(anti-corruption layer / adapter) **dentro del propio proceso** en todas las
integraciones externas: `PaymentGateway` (Stripe), `EmailProvider` (smtp/resend),
`WhatsAppProvider` (stub/meta_waba), `AiProvider` (stub/anthropic) y, para
hardware, **`LockProvider`** (stub/mqtt/http) — clase abstracta + DI por `Symbol`
+ factory por env. **Dahua se añade igual: una implementación más detrás del
puerto**; el core no se entera.

**Un microservicio separado NO es necesario para desacoplarse del proveedor** y
añade coste (despliegue, red, latencia, otro punto de fallo) sin más
desacoplamiento del que ya da la interfaz. Se reserva para presiones concretas
(ver más abajo).

## Regla de oro: el core habla en verbos de dominio

El riesgo real no es "servicio sí/no", es **que se filtren conceptos del
fabricante al core** (`CardStatus`, `recordUpdater`, Digest, `channel`,
`snapshot.cgi`…). Si `AccessIntegrationsService` mencionara `CardStatus=8`, ya
estaría atado a Dahua aunque hubiese una interfaz. **Todo lo específico del
fabricante vive DENTRO del adapter.**

## El puerto neutral (propuesta)

Extiende el `LockProvider` actual (`apps/api/src/modules/access/providers/lock-provider.ts`)
hacia un puerto de hardware de accesos más amplio, en verbos de dominio:

```ts
// Puerto neutral — NINGÚN concepto de fabricante aquí.
interface AccessHardwareProvider {
  // Patrón A — apertura remota (ya existe como LockProvider.open()).
  openDoor(device: DeviceRef): Promise<{ dispatched: boolean; message?: string }>;

  // Patrón B — sincronización de credenciales al terminal.
  upsertCredential(device: DeviceRef, cred: CredentialSpec): Promise<HardwareCredRef>;
  setCredentialState(ref: HardwareCredRef, state: 'active' | 'suspended' | 'revoked'): Promise<void>;
  removeCredential(ref: HardwareCredRef): Promise<void>;

  // Reconciliación de logs del hardware → nuestra tabla access_logs.
  pullEvents(device: DeviceRef, since: Date): Promise<AccessEvent[]>;
}
```

- `CredentialSpec` = método (pin/qr/rfid) + secreto + scope (locales/trasteros) +
  ventanas; conceptos **nuestros**, no de Dahua.
- `AccessEvent` = `{ method, result, credentialRef, occurredAt, ... }`, mapeado
  ya a nuestros enums (`AccessResult`, `AccessMethod`).
- El core (`AccessVerifyService`, `AccessDevicesService`,
  `AccessIntegrationsService`) **solo conoce este puerto**.

## Dónde vive lo de Dahua (dentro del adapter)

`DahuaProvider implements AccessHardwareProvider` traduce el puerto a Dahua y
**nada de esto sale del adapter**:

| Verbo del puerto | Traducción Dahua (encapsulada) |
|---|---|
| `openDoor` | `GET accessControl.cgi?action=openDoor` + **Digest** |
| `upsertCredential` | `recordUpdater.cgi?action=insert&name=AccessControlCard...` |
| `setCredentialState('suspended')` | `recordUpdater update CardStatus=8` (impago) / `=4` (staff) |
| `setCredentialState('active')` | `recordUpdater update CardStatus=0` |
| `removeCredential` | `recordUpdater action=remove` |
| `pullEvents` | `recordFinder.cgi ... AccessControlCardRec` → map a `AccessEvent` |

Cambiar a otro fabricante mañana = escribir `AcmeProvider implements
AccessHardwareProvider` con **su** mapeo; el core no cambia una línea.

**⚠️ Resolución del adapter: por DEVICE, no global.** Hoy la factory por env
(`LOCK_PROVIDER=stub|mqtt|http`) elige **un** provider para toda la plataforma.
En un SaaS multi-tenant eso no basta: cada local puede tener hardware distinto
(un tenant con ESP32/HTTP, otro con Dahua, la cancela por MQTT). El diseño
objetivo es que **cada `access_devices` declare su provider** (columna
`provider` o `metadata.provider`) y un `ProviderRegistry` resuelva el adapter
**por device** en `remoteOpen`/`openForCustomer`/sync (fallback al env global si
el device no lo declara → retrocompatible). Puede hacerse en el mismo PR del
`DahuaLockProvider`: es un cambio pequeño y evita una migración de comportamiento
después.

## Cuándo SÍ extraer un adapter a un servicio aparte (triggers)

No por defecto; solo ante una presión concreta. Y como la **interfaz ya existe**,
extraerlo entonces es un refactor **barato y localizado** (no te casas hoy):

1. **Runtime incompatible**: el fabricante solo trae SDK binario/Python (p. ej. el
   Dahua **NetSDK** C/.NET) que no quieres en tu API Node → sidecar. *(Con Dahua
   por CGI HTTP NO aplica: se hace en Node.)*
2. **Aislar el radio de fallo**: SDK inestable que no debe tumbar API/worker.
3. **Despliegue/escalado o equipo independientes.**

## El eje ORTOGONAL: el NAT (esto sí es un deployable aparte)

Independiente de la abstracción de proveedor. El hardware vive en la **LAN del
local tras NAT**, así que el Patrón B (sync + `pullEvents`) y los snapshots/eventos
de cámara necesitan alcanzar la LAN. Ahí sí hay un **agente on-site** por local
con túnel saliente — pero resuelve **red, no vendor-lock-in**, y puede ser
**tonto** (solo túnel/proxy), dejando la lógica del proveedor en tus adapters de
la nube accesibles a través del túnel. No confundir los dos ejes.

## Resumen

- **Abstracción de proveedor → in-process, extendiendo `LockProvider`** hacia
  `AccessHardwareProvider`. Es lo que ya haces en el resto del sistema.
- **Disciplina clave:** el fabricante no se filtra al core; todo dentro del adapter.
- **Servicio/agente aparte → solo por el NAT**, o por un trigger concreto (SDK
  binario, aislamiento). Extraerlo luego es barato porque el puerto ya existe.

---

# Despliegue: nube vs on-site

> **Regla:** el agente on-site **NO va en el `docker-compose` de la nube**. Son dos
> planos distintos, en máquinas distintas.

## Los dos planos

```
┌─ NUBE (tu VPS + Portainer) ──────────────┐          ┌─ LOCAL del cliente (LAN) ─────────────┐
│  docker-compose.prod / portainer         │          │  Caja on-site (mini-PC / RPi / NVR)   │
│  · api  · worker  · web                  │          │  · agente StorageOS (su propio Docker)│
│  · postgres · redis · minio              │◄────────►│  · alcanza terminales/cámaras Dahua   │
│  MULTI-TENANT, centralizado              │  túnel   │    por la LAN                         │
└──────────────────────────────────────────┘ saliente └───────────────────────────────────────┘
```

- **Nube:** tu stack actual (`docker-compose.prod.yml` / `docker-compose.portainer.yml`)
  en el VPS, centralizado y multi-tenant. **No puede alcanzar** la LAN de ningún
  local (está tras el NAT del cliente) → el agente **no se añade aquí**.
- **On-site:** un componente **por local**, en la LAN junto al hardware. Artefacto
  **separado** (repo/imagen aparte), **uno por instalación**, no uno global.

## Forma del agente on-site

Docker es buen empaquetado, pero **desplegado en la caja del local** con su
**propio compose de 1 servicio** (no el de la nube):

- Cajita barata en el local (mini-PC / Raspberry Pi, o el NVR si admite
  contenedores) con Docker + `docker-compose.agent.yml`: el agente + el cliente de
  túnel (WireGuard/Tailscale, **saliente** — sin abrir puertos).
- **Actualizaciones:** imagen versionada que la caja hace `pull` (Watchtower o
  mecanismo propio), por-sitio.
- **Alternativa sin Docker:** binario Go/Node como servicio `systemd`. Docker =
  aislamiento + updates limpios; systemd = menos dependencias en la caja.
- **Diseño recomendado: agente "tonto"** = solo túnel/proxy hacia la LAN; la
  lógica del fabricante se queda en tus **adapters de la nube** (así el mismo
  agente sirve para cualquier fabricante — no reimplementas Dahua en la caja).

## Cuándo hace falta caja on-site (y cuándo NO)

| Caso | ¿Agente/caja on-site? |
|---|---|
| Cámara: eventos + snapshot por **push** del equipo (FTP/email/HTTP linkage) | ❌ No (si el equipo sale a Internet) |
| Cámara: snapshot **on-demand** ("una foto ahora") | ✅ Sí |
| Accesos **Patrón A** (abrir puerta remoto: tú llamas al terminal) | ✅ Sí |
| Accesos **Patrón B** (sync de credenciales + leer logs) | ✅ Sí |

Para **cámaras con el alcance acotado** (solo eventos + snapshot) puedes empezar
**sin caja**: el equipo empuja el evento a tu endpoint. Para **accesos** casi
siempre necesitas alcanzar la LAN (abrir/sincronizar es "tú → terminal"), así que
el agente es el patrón realista salvo que el terminal soporte auto-registro
saliente (modo tipo DSS, propietario).

## Recomendación de despliegue

1. **No metas el agente en el `docker-compose` de la nube.** Es repo/imagen aparte
   con su compose propio, por local.
2. **Empieza sin agente donde puedas:** cámaras por push (90% del valor de cámaras,
   cero infra por sitio).
3. **Agente on-site solo para accesos** (y snapshot on-demand si se quiere), y
   diseñado **tonto** (túnel/proxy) para no atarlo a Dahua.

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

## A.5-bis ⚠️ Límites del Patrón B: qué reglas nuestras NO aplican en la puerta

En Patrón B **el terminal valida solo** → las reglas que hoy viven en NUESTRO
`AccessVerifyService` **no se ejecutan en cada apertura física**. Hay que
mapearlas al terminal o asumir la degradación de forma consciente:

| Regla nuestra (server-side) | En Patrón B con Dahua | Mitigación |
|---|---|---|
| **Toque de queda del local** (`facilities.access_curfew_*`) | El terminal no consulta nuestro curfew | Mapear a los **perfiles horarios del terminal** (time sections/period de la credencial Dahua); el sync los recalcula al cambiar la config del local |
| **Ventanas horarias por credencial** (`allowedHours.windows`) | Ídem | Ídem (validar en piloto que la granularidad de Dahua — días de semana + franjas — cubre nuestro modelo) |
| **Pase nocturno single-use** (`maxUses`/`usesCount`, caduca 08:00) | El terminal no descuenta usos nuestros | Sincronizarlo como credencial con **validez temporal** (`ValidDateStart/End`) y **borrarla tras el primer uso reconciliado** (ventana de carrera: entre el uso y la reconciliación podría reutilizarse) — o mantener el pase nocturno SOLO en puertas Patrón A |
| **Anti-fuerza-bruta** (`AccessRateLimitService`, Redis) | No aplica en la puerta | El terminal trae su propio anti-passback/lockout (verificar en piloto); nuestra capa sigue protegiendo `/access/verify` y la apertura remota |
| **Suspensión por impago** | ✅ Sí aplica | Vía `CardStatus=8` (con la **latencia del sync**, no instantánea si el terminal está offline) |

**Regla de oro:** las features "ricas" (pase nocturno, single-use, ventanas
finas) funcionan al 100% en **Patrón A**; en **Patrón B** se degradan a lo que el
terminal soporte. Documentar por local qué patrón usa cada puerta y no prometer
al operador features que su hardware no puede cumplir.

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

## A.9 Resiliencia: ¿qué pasa si se va internet o la luz?

### Corte de INTERNET → los inquilinos SIGUEN entrando ✅ (por diseño)

Es la razón principal de elegir **Patrón B** como modo nativo: las credenciales
están sincronizadas **dentro del terminal** y él valida **en local, sin red**.
Las aperturas quedan como *offline records* (el ASI6214S guarda hasta 300.000
eventos) y se reconcilian a `access_logs` cuando vuelve la conexión.

Qué se degrada durante el corte (aceptable y conocido):

| Función | Sin internet |
|---|---|
| Entrar con PIN / tarjeta / QR en el lector | ✅ Funciona |
| «Tu móvil es la llave» (apertura desde el portal/staff) | ❌ No (nube→terminal) |
| Alta de PIN nuevo / pase nocturno recién comprado | ⏳ No llega al terminal hasta el sync |
| **Corte por impago** decidido durante la caída | ⏳ El moroso sigue entrando hasta que el sync propague `CardStatus` |
| Logs/eventos en la app | ⏳ Llegan al reconciliar, no en vivo |

Contraste: una puerta en **Patrón A puro** (el hardware valida contra nuestro
`/access/verify`, p. ej. ESP32/Akuvox) **NO abre sin internet**. De ahí el
híbrido: **Patrón B para la validación diaria** + Patrón A solo como capa extra
(apertura remota).

### Corte de LUZ → solo con respaldo (hardware, no software)

Sin electricidad no funciona ningún terminal ni cerradura, del fabricante que
sea. Checklist de instalación:

1. **SAI/UPS** (o fuente de alimentación con batería de 12 V, estándar en control
   de accesos) alimentando terminal + cerradura + router/switch. El consumo es de
   vatios: un SAI modesto aguanta horas.
2. **Tipo de cerradura (decisión de seguridad):** **fail-secure** (abrepuertas
   eléctrico: sin luz queda **cerrada**) vs **fail-safe** (ventosa magnética: sin
   luz queda **abierta**). Para accesos exteriores de un trastero: **fail-secure
   + SAI**.
3. **Evacuación (normativa):** la salida **desde dentro** debe ser siempre posible
   sin corriente (manilla/barra antipánico **mecánica**) — independiente del lector.
4. La alarma **AirShield** sigue protegiendo: el hub lleva batería de respaldo y
   los detectores van a pilas; al volver la red reporta lo ocurrido.

### ¿Y una llave física o un "código de emergencia"?

- **Sin internet no hace falta nada especial**: los códigos normales funcionan
  (validación local, Patrón B).
- **Sin electricidad NINGÚN código funciona** (el teclado está muerto) — no
  existe el "código de emergencia" sin corriente. La respuesta del sector es
  **mecánica**:
  1. Toda puerta electrificada conserva un **bombín mecánico con llave física**
     (el abrepuertas fail-secure se monta junto a una cerradura normal). La llave
     la tiene **el staff**, no los inquilinos — idealmente con **amaestramiento**
     (una llave maestra para todos los cilindros del local).
  2. Las cancelas/puertas **motorizadas** traen de serie **desbloqueo manual con
     llave** (se desembraga el motor y se abre a mano).
  3. La **ventosa magnética no tiene llave** (sin luz queda abierta) — otro motivo
     para fail-secure + bombín.
- **Jerarquía de respaldo**: red caída → códigos locales (Patrón B) · luz caída →
  el **SAI** mantiene los códigos vivos · SAI agotado o **terminal averiado** →
  **llave mecánica del staff**. En un apagón largo el inquilino depende del staff
  (asumible); la salida desde dentro siempre es mecánica por normativa.

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
**endpoint de ingesta** (webhook HTTP; si el equipo solo habla FTP, un pequeño
contenedor FTP→webhook) y el dispositivo nos empuja el evento con su JPEG. Cero
gateway, cero puertos entrantes **en el local**. Limitación: el snapshot es **el
del evento**, no "una foto ahora mismo" arbitraria.

> **Nota de despliegue:** este ingest (webhook y/o contenedor FTP) es
> **centralizado** y SÍ vive en **nuestro compose de la nube** — no confundir con
> la regla "el agente on-site no va en la nube": el agente resuelve *salida hacia
> la LAN*; el ingest recibe *entradas desde los equipos*. Preferir **HTTP upload**
> si el firmware lo trae; FTP como fallback (ojo a los puertos pasivos del FTP en
> el VPS/NPM). Autenticación realista: **credenciales/token por device** (el
> equipo no sabe firmar HMAC nuestro).

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

# Parte C — Alarma de intrusión (Dahua AirShield; Ajax descartado por ahora)

> **Decisión (2026-07-14): Dahua AirShield** como alarma por defecto. **Ajax
> Systems** es mejor alarma como producto, pero para NUESTRO caso pierde por la
> integración. Ajax queda como **adapter futuro "premium"** detrás del mismo
> puerto neutral si un cliente lo exige y se consigue acceso a su API.

## C.1 Por qué AirShield y no Ajax (comparativa)

| Criterio | **Ajax Systems** | **Dahua AirShield** |
|---|---|---|
| **Calidad como alarma** | ⭐ Referencia del mercado (Jeweller, retrofit impecable, catálogo enorme) | Más reciente/menos rodada; correcta |
| **Grados EN 50131** | Grade 2 estándar; **Grade 3** disponible (Superior MotionCam G3 / Hub Hybrid) | Grade 2 + PD6662 (sin Grade 3 público) |
| **Verificación** | Foto (MotionCam, líder) | Foto (PIR-Cam) + **vídeo nativo con las cámaras Dahua** (alarma + persona detectada) |
| **API para nuestra app** | **Enterprise API**: existe pero **muy gated** (literal: para empresas "que ya sirven miles de sistemas Ajax", aprobación previa) y **cloud-only** (Ajax Cloud; sin API local/LAN ni MQTT oficial). Push real → vía **CMS/SIA DC-09** (posicionarse como CRA) | **Enlazado al NVR por red** → los eventos de intrusión entran por el **mismo `eventManager.cgi` device-direct** que cámaras/accesos. Alternativa **Open IoT API** (cloud DoLynk) |
| **Coste de integración para nosotros** | **Un adapter nuevo entero**, cloud, con gate de acceso incierto | **≈ 0 marginal**: un tipo de evento más en el adapter Dahua |
| **Timeline unificado** (alarma+vídeo+acceso) | No (dos ecosistemas a correlacionar) | ✅ Nativo (NVR/DMSS agregan todo) |

**Cuándo compensaría Ajax:** cliente que lo exija por marca/seguro/CRA, o que
necesite Grade 3 con verificación fotográfica premium. Gracias a ports &
adapters, añadirlo después es un adapter más — no bloquear el diseño por Ajax hoy.

## C.2 Vía de integración de AirShield

- **Hardware:** Alarm Hub (p. ej. `ARC3800H`, hasta 150 periféricos, 433/868 MHz,
  AES128) + detectores (PIR, PIR-Cam, apertura, sirena…).
- **La vía recomendada — enlazar el Hub al NVR** ("network protocol", no contacto
  seco): el NVR agrega los eventos de intrusión junto a los de las cámaras →
  nuestro adapter Dahua los consume por la **misma suscripción de eventos del
  NVR** (`eventManager.cgi?action=attach`) que la Parte B. Además habilita el
  linkage alarma↔vídeo (verificación) y **armar/desarmar desde el NVR**.
- **Armar/desarmar desde la app:** vía NVR-linkage (device-direct) o vía **Open
  IoT API** (cloud DoLynk — rompe la preferencia device-direct; usar solo si la
  vía NVR no lo cubre). En el puerto neutral sería un verbo nuevo
  (`setArmedState(partition, 'armed'|'disarmed'|'home')`).
- **CRA (recepción profesional):** AirShield sale a central receptora por
  **SIA DC-09 / Sur-Gard** vía su converter. **Nota España:** para que una alarma
  despache a policía debe estar conectada a una **CRA homologada** e instalada
  por empresa de seguridad autorizada (RD 2364/1994 / Orden INT/316/2011) — eso
  es un contrato del operador con una CRA, **no** algo que sustituya nuestra app.
  Nuestra app muestra el timeline; la CRA gestiona la intervención.

## C.3 Encaje en la app (mismo modelo que cámaras)

- Los eventos de alarma (armado, desarmado, salto de zona, tamper, batería) entran
  como **un tipo más de evento** en la ingesta de la Parte B (`camera_events` o una
  tabla `security_events_hw` común con `kind: camera|alarm`), correlacionables con
  el snapshot de la cámara de la misma zona.
- Vistas: los mismos sitios que B.4 (ficha del local + incidencias) + un **estado
  de armado por local** en la ficha del local (y opcionalmente armar/desarmar para
  staff con permiso, cuando se implemente el verbo).
- El «ver en directo» de una alarma → app DMSS (misma decisión que cámaras).

## C.4 Cautelas a validar en el piloto de alarma

1. **Modelo/firmware del NVR**: no todos exponen el menú IoT/alarm-hub (puede
   requerir firmware específico).
2. Validar que la suscripción vía NVR entrega el **detalle** (zona, detector,
   tamper), no solo un evento genérico.
3. Confirmar el **armado/desarmado por API vía NVR**; si solo existe por Open IoT
   (cloud), decidir si se acepta esa dependencia o se deja el armado en DMSS.

---

# Anexo — Lista de materiales (BOM) para un local tipo

> Local mediano de referencia: 1 puerta peatonal de entrada + pasillos + (opcional)
> cancela de vehículos, ~6 cámaras, alarma de 4 zonas. Precios orientativos de
> calle (2026), IVA aparte. Ajustar cantidades al plano real.

## A. Control de accesos (por puerta peatonal)

| Componente | Modelo/tipo | Aprox. |
|---|---|---|
| Terminal de acceso (PIN+tarjeta+QR+cara) | **Dahua ASI6214S** (valida en local = Patrón B) | 250–400 € |
| Abrepuertas eléctrico **fail-secure** 12 V | Dorcas/CDVI estándar | 30–60 € |
| Cerradura mecánica + **bombín amaestrado** | Llave maestra del staff (último recurso) | 40–80 € |
| Fuente 12 V con batería ("SAI de la puerta") | Caja 12 V 3–5 A con hueco de batería | 40–70 € |
| Batería 12 V 7 Ah | Plomo AGM | 15–25 € |
| Manilla/barra **antipánico mecánica** interior | Obligatoria (evacuación sin corriente) | 60–150 € |
| Contacto magnético de puerta | Estado abierta/cerrada (ACK + alarma) | 5–15 € |
| Cableado (Cat6 al terminal + 2×1 mm² a cerradura + canaleta) | — | 30–60 € |

Cancela de vehículos: motor con desbloqueo manual por llave (de serie) + relé
accionado por el terminal o segundo lector — ver `HARDWARE_CANCELA.md`.
**Subtotal por puerta: ~500–800 €.**

## B. Cámaras (alcance acotado: eventos + snapshots)

| Componente | Modelo/tipo | Aprox. |
|---|---|---|
| **NVR Dahua PoE** 4–8 canales | Serie NVR4x04/4x08-P — ⚠️ **modelo con menú IoT compatible AirShield, confirmar ANTES de comprar** | 120–300 € |
| Disco de videovigilancia | WD Purple 2–4 TB | 60–120 € |
| Cámaras IP PoE **con IA** (detección de persona/IVS — evita falsos positivos en el push) | Domo/bullet 4 MP (IPC-HDW2441 / HFW2441) × 4–8: entrada ext. · recepción · 1/pasillo · cancela | 60–120 €/ud |
| Cable UTP Cat6 por cámara (el NVR PoE alimenta) | — | 50–100 € |

**Subtotal (6 cámaras): ~700–1.200 €.**

## C. Alarma (AirShield, enlazada al NVR)

| Componente | Modelo/tipo | Aprox. |
|---|---|---|
| **Alarm Hub** | ARC3800H (batería integrada, 150 periféricos) | 150–250 € |
| Detectores PIR (1/zona: recepción, pasillos, muelle) | PIR estándar o **PIR-Cam** (foto de verificación) | 30–60 € / 80–120 € |
| Contactos magnéticos inalámbricos (puertas acceso/emergencia) | — | 25–40 €/ud |
| Sirena interior + exterior | Inalámbricas AirShield | 50–90 €/ud |
| Teclado/mando de armado (opcional; se arma por app/horario) | — | 30–60 € |

Detectores a pilas. **Subtotal (4 zonas): ~500–900 €.**
⚠️ **CRA**: despacho a policía = contrato con CRA homologada + instalación por
empresa autorizada (RD 2364/1994); sin CRA, la alarma avisa a app/DMSS y suena.

## D. Red e infraestructura común (el "rack" del local)

| Componente | Modelo/tipo | Aprox. |
|---|---|---|
| **Router con failover 4G/LTE** | Teltonika RUT241/RUT906 — si cae la fibra, el push y el sync siguen por 4G | 150–250 € |
| Switch PoE 8 puertos | Para el terminal ASI / cámaras extra | 60–100 € |
| **SAI/UPS 600–1000 VA** | Rack: router + switch + NVR + agente | 80–150 € |
| **Agente on-site** (sync Patrón B + reconciliación por túnel saliente) | Raspberry Pi 5 / mini-PC + SSD + Docker | 80–150 € |
| Armario/caja rack **con llave** | — | 60–120 € |
| VLAN de dispositivos (cámaras/terminal sin salida a Internet salvo push) | Config del router | — |

**Subtotal: ~450–800 €.**

## Total orientativo del local tipo

| Bloque | Rango |
|---|---|
| Accesos (1 puerta) | 500–800 € |
| Cámaras (6) | 700–1.200 € |
| Alarma (4 zonas) | 500–900 € |
| Red/infra | 450–800 € |
| **Total hardware** | **~2.200–3.700 €** + instalación |

---

## Fuentes

- DAHUA ACCESS CONTROL PRODUCTS INTEGRATION INSTRUCTION Ver1.0 (portal de
  partners, files.dahua.support).
- Dahua HTTP API v2.x (recopilación de CGI: `accessControl.cgi`,
  `recordUpdater.cgi`, `recordFinder.cgi`, `eventManager.cgi`, `snapshot.cgi`,
  `mediaFileFind`).
- DahuaWiki — Access Control; manuales ASI6214S / ASI7214Y-V3 / ASR2100A-ME.
- ONVIF Profiles S/G/T.
- Dahua AirShield (dahuasecurity.com/singlePage/custom/AirShield) + nota Open
  ARC / Open IoT API + manual del Alarm Hub.
- Ajax Systems: Enterprise API (ajax.systems/blog/enterprise-api), soporte "do
  you have an API", Ajax Cloud Signaling (SIA DC-09), Translator PRO; grados
  EN 50131 y MotionCam.

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
4. Piloto de alarma (AirShield): Alarm Hub + 1-2 detectores **enlazados al NVR**;
   validar que los eventos de intrusión llegan por la suscripción del NVR con
   detalle de zona, el linkage alarma↔cámara, y el armado/desarmado por API vía
   NVR (cautelas C.4). Confirmar el modelo de NVR compatible ANTES de comprarlo.
5. En el primer PR de código: **resolución del provider por device** (columna/
   metadata en `access_devices` + registry con fallback al env) — evita una
   migración de comportamiento después.
6. Validar en piloto el **mapeo de reglas al terminal** (A.5-bis): curfew y
   ventanas → perfiles horarios Dahua; decidir si el pase nocturno se limita a
   puertas Patrón A.
