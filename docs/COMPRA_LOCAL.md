# Lista de compra del local (hardware) — TrasterOS

> Lista **accionable** para pedir al distribuidor (By Demes / Visiotech / Dahua Iberia).
> El **porqué** de cada elección y la arquitectura están en
> [`HARDWARE_DAHUA.md`](HARDWARE_DAHUA.md) (accesos + cámaras + alarma),
> [`HARDWARE_ESP32.md`](HARDWARE_ESP32.md) (alternativa low-cost por puerta) y
> [`HARDWARE_CANCELA.md`](HARDWARE_CANCELA.md) (cancela de vehículos).
> Precios orientativos de calle 2026, **IVA e instalación aparte**.

Recomendación: **empezar por el KIT PILOTO** (1 puerta + 2 cámaras + alarma
mínima) para validar en campo los `VERIFY` del software (recno, solo-PIN, QR,
facial, agente Bridge) antes de equipar el local completo.

---

## ⚠️ Verificar ANTES de pedir (2 preguntas al distribuidor)

- [ ] **NVR compatible con AirShield**: que el modelo de NVR lleve **menú IoT** y
  admita enlazar el **Alarm Hub AirShield** (para el timeline unificado
  alarma+vídeo). Si no, la alarma va por su cuenta.
- [ ] **Terminal ASI6214S con lector QR nativo** que **reporte el token del QR**
  (no solo un CardNo interno): es lo que sincronizamos desde TrasterOS. Confirmar
  también **modo solo-PIN** en el teclado.

---

## 🧪 KIT PILOTO (primera compra, ~700–1.000 € + IVA)

Objetivo: 1 puerta peatonal con accesos + facial + 2 cámaras + alarma de 1–2 zonas
+ el agente on-site. Suficiente para cerrar todos los `VERIFY` del software.

### Accesos (1 puerta)
- [ ] **1× Terminal Dahua ASI6214S** (PIN + tarjeta + QR + **cara** + huella) — *el add-on facial se prueba aquí* · 250–400 €
- [ ] 1× Abrepuertas eléctrico **fail-secure** 12 V (Dorcas/CDVI) · 30–60 €
- [ ] 1× Cerradura mecánica + **bombín amaestrado** (llave maestra del staff, último recurso) · 40–80 €
- [ ] 1× Fuente 12 V 3–5 A con hueco de batería + **1× batería 12 V 7 Ah AGM** («SAI de la puerta») · 55–95 €
- [ ] 1× Contacto magnético de puerta (ACK abierta/cerrada) · 5–15 €
- [ ] 1× Manilla/barra **antipánico mecánica** interior (evacuación sin corriente) · 60–150 €
- [ ] Cableado: Cat6 al terminal + 2×1 mm² a la cerradura + canaleta · 30–60 €

### Cámaras (mínimo para probar la ingesta)
- [ ] **1× NVR Dahua PoE 4 canales** (serie NVR4x04-P, *con menú IoT — ver arriba*) · 120–200 €
- [ ] 1× Disco WD Purple 2 TB · 60–90 €
- [ ] **2× Cámara IP PoE 4 MP con IA** (IPC-HDW2441 domo / IPC-HFW2441 bullet): 1 entrada + 1 recepción · 60–120 €/ud

### Alarma (mínima)
- [ ] **1× Alarm Hub AirShield ARC3800H** (batería integrada) · 150–250 €
- [ ] 1–2× Detector PIR inalámbrico (o **PIR-Cam** con foto de verificación) · 30–120 €/ud
- [ ] 1× Sirena interior inalámbrica AirShield · 50–90 €

### Infraestructura on-site (el «cerebro» del local)
- [ ] **1× Agente on-site**: Raspberry Pi 5 (o mini-PC) + SSD + fuente — *aquí corre el agente Bridge (`apps/bridge`)* · 80–150 €
- [ ] 1× Switch PoE 8 puertos (terminal ASI + cámaras) · 60–100 €
- [ ] 1× SAI/UPS 600–1000 VA (router + switch + NVR + agente) · 80–150 €

---

## 🏢 AMPLIACIÓN a LOCAL COMPLETO (tras validar el piloto)

Local mediano de referencia: 1 puerta + pasillos + (opcional) cancela, ~6 cámaras,
alarma de 4 zonas. Suma sobre el piloto.

### Accesos
- [ ] Terminal adicional por cada **puerta peatonal** extra (repetir el bloque de accesos del piloto)
- [ ] **Cancela de vehículos** (opcional): motor con **desbloqueo manual por llave** + relé accionado por el terminal o 2º lector — ver `HARDWARE_CANCELA.md`

### Cámaras (hasta 6–8)
- [ ] Ampliar a **NVR 8 canales** si superas 4 cámaras (serie NVR4x08-P) · 200–300 €
- [ ] Disco WD Purple 4 TB (si grabas 24/7) · +30–60 €
- [ ] **+4 cámaras IP PoE 4 MP con IA** (1/pasillo · muelle · cancela) · 60–120 €/ud
- [ ] Cable UTP Cat6 por cámara · 50–100 €

### Alarma (4 zonas)
- [ ] Ampliar a **1 PIR por zona** (recepción, pasillos, muelle) · 30–120 €/ud
- [ ] Contactos magnéticos inalámbricos en puertas de acceso/emergencia · 25–40 €/ud
- [ ] **Sirena exterior** inalámbrica · 50–90 €
- [ ] Teclado/mando de armado (opcional; normalmente se arma por app/horario) · 30–60 €

### Red / rack
- [ ] **Router con failover 4G/LTE** (Teltonika RUT241/RUT906): si cae la fibra, el push y el sync siguen por 4G · 150–250 €
- [ ] Armario/caja rack **con llave** · 60–120 €
- [ ] Config: **VLAN de dispositivos** (cámaras/terminal sin salida a internet salvo el push)

---

## 💶 Presupuesto orientativo

| Configuración | Rango (hardware, IVA aparte) |
|---|---|
| **Kit piloto** (1 puerta + 2 cámaras + alarma mínima + agente) | **~700–1.000 €** |
| **Local completo** (1 puerta + 6–8 cámaras + alarma 4 zonas + red) | **~2.200–3.700 €** |
| + puerta peatonal adicional | +500–800 €/ud |
| + cancela de vehículos | según motor (ver `HARDWARE_CANCELA.md`) |

Instalación (electricista/instalador de seguridad) aparte.

---

## Notas legales / operativas

- **CRA (despacho a policía):** requiere **contrato con una Central Receptora de
  Alarmas homologada** + instalación por empresa de seguridad autorizada
  (RD 2364/1994). Sin CRA, AirShield **avisa a la app/DMSS y hace sonar la
  sirena**, pero no despacha a la policía. Es un contrato del operador, no de
  nuestra app.
- **Resiliencia (por diseño):** sin internet, los inquilinos **siguen entrando**
  (Patrón B: el terminal valida en local con las credenciales sincronizadas);
  sin luz, el **SAI** mantiene el terminal + cerradura, y como último recurso está
  el **bombín mecánico** del staff. La alarma tiene batería de respaldo.
- **Facial (add-on):** se prueba con el ASI6214S del piloto; es la funcionalidad
  premium `facial_access` que ya se vende desde el panel.
