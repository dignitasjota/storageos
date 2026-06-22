# ESP32 — controlador de acceso (firmware de ejemplo)

Firmware de ejemplo para validar accesos de StorageOS desde un **ESP32** con un
teclado 4x4 y un relé. Implementa el **Patrón A** (el lector pregunta a
`POST /v1/access/verify`). Guía completa: [`../../HARDWARE_ESP32.md`](../../HARDWARE_ESP32.md).

> ⚠️ Ejemplo educativo, no oficial. Revísalo y adáptalo a tu instalación antes de
> ponerlo en una puerta real.

## Requisitos

- **Arduino IDE** con el core de **ESP32** instalado
  (Gestor de placas → "esp32 by Espressif"), o PlatformIO.
- Librerías (Gestor de librerías):
  - **ArduinoJson** (Benoit Blanchon)
  - **Keypad** (Mark Stanley, Alexander Brevig)
- `WiFi.h`, `WiFiClientSecure.h`, `HTTPClient.h` vienen con el core ESP32.

## Pasos

1. Da de alta el dispositivo en el panel (**Accesos → Dispositivos**) y copia la
   **API key** que se muestra una sola vez y el **Hardware ID** que pusiste.
2. Abre `esp32-access-controller.ino` y rellena la sección `CONFIG`:
   `WIFI_SSID`, `WIFI_PASS`, `API_HOST`, `DEVICE_ID`, `DEVICE_KEY`.
3. Ajusta los pines si tu cableado difiere (`RELAY_PIN`, `ROW_PINS`, `COL_PINS`).
4. Selecciona la placa **ESP32 Dev Module**, conecta por USB y **Subir**.
5. Abre el **Monitor Serie** a **115200 baudios**.
6. Teclea un PIN válido + `#`. Deberías ver `HTTP 200 → {"allowed":true,...}` y
   el pulso del relé. `*` borra lo tecleado.

## Cableado resumido

| ESP32           | Conecta a            |
| --------------- | -------------------- |
| GPIO 13         | IN del relé          |
| 5V / VIN        | VCC del relé         |
| GND             | GND del relé         |
| GPIO 19/18/5/17 | filas del teclado    |
| GPIO 16/4/14/12 | columnas del teclado |

El relé (contacto **NO/COM**) corta/da los 12V del **cerradero eléctrico**.

## Producción

- Cambia `client.setInsecure()` por `client.setCACert(...)` con la CA raíz de tu
  dominio (Let's Encrypt **ISRG Root X1**) para validar el certificado TLS.
- La `DEVICE_KEY` es un secreto: una por dispositivo; regénerala en el panel si se
  filtra. No la subas a un repositorio público.
- Alimenta con una pequeña **UPS** y decide fail-safe/fail-secure según la puerta.
