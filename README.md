# IoT-Based Gas Leakage and Fire Safety System with Automatic Control

Capstone web and firmware prototype for the Department of Hospitality Management, Cavite State University – Imus Campus.

The ESP32 runs the gas/fire detection and actuator logic locally. The web server provides public monitoring and event history; the safety logic does **not** depend on the server or Wi-Fi.

> **Safety notice:** This is an educational prototype, not a certified fire alarm or gas safety product. Do not rely on it to protect life or property. Validate sensor calibration, relay isolation, mechanical valve behavior, power supplies, and failure modes with a qualified engineer. Keep tests supervised and use safe, simulated conditions.

## Folder structure

```text
gasfiresystem/
├── server/
│   ├── db.js              # PostgreSQL connection and schema setup
│   ├── index.js           # Express, static files, WebSocket setup
│   └── routes.js          # Public monitoring and device APIs
├── public/
│   ├── dashboard.html     # Live status and graph
│   ├── history.html       # Filtered log and CSV/PDF export
│   ├── about.html         # System and wiring diagrams
│   ├── app.css
│   └── app.js
├── firmware/
│   └── gas_fire_safety.ino
├── simulator/
│   └── simulator.js
├── .env.example
├── package.json
└── README.md
```

## Requirements and setup

- Node.js 20 or newer and npm.
- PostgreSQL 12 or newer, with an empty database created for this application.
- An internet connection for the initial npm dependency install.
- For ESP32 builds: Arduino IDE or PlatformIO plus the libraries listed in the firmware section.

In the project folder:

```powershell
Copy-Item .env.example .env.local
npm.cmd install
npm.cmd start
```

In `.env.local`, set `DATABASE_URL` to your Supabase PostgreSQL connection string and replace `DEVICE_API_KEY` with a long random key. In Supabase, open **SQL Editor**, paste and run [`database/schema.sql`](./database/schema.sql). The schema contains only the `readings` and `events` tables. The server also applies this schema on startup if the tables do not already exist. Existing SQLite records are not imported.

Then visit [http://localhost:3000](http://localhost:3000). There is no sign-in page; monitoring and history are publicly accessible.

If you already ran the previous schema in Supabase, run [`database/remove-users-settings.sql`](./database/remove-users-settings.sql) once in the SQL Editor. This permanently deletes the old user accounts, saved settings, and queued device commands. Back up anything you need before running it. The web dashboard and history endpoints are now public, so do not deploy them if those readings or events must remain private.

To use another port, set `PORT` in `.env.local`. Set `DATABASE_URL` to your PostgreSQL connection string. `GAS_THRESHOLD` (default `1800`) and `DETECTION_DELAY_SECONDS` (default `5`) configure fixed device thresholds; the dashboard is read-only. The browser Chart.js bundle is served from the installed package; no CDN connection is needed.

### Run from Visual Studio Code

Open this project folder in VS Code and select **Run and Debug** from the sidebar. Choose **Run Gas Safety System** and press the green Run button (or F5). VS Code starts the Node server in its integrated terminal and opens the app in your browser once the server is ready. The source remains in the project Explorer; closing the browser does not remove or hide the code.

You can also run **Terminal → Run Build Task** and select **Start Gas Safety System**. Stop a server started in the terminal with Ctrl+C. Do not start a second copy while another server is already using the configured port.

## Run the simulator

With the server running in another terminal:

```powershell
npm run simulate
```

The simulator sends a reading every 2.5 seconds and rotates through safe, gas alarm, and fire alarm states. Readings make the device appear online; it becomes offline after 15 seconds without a successful reading. Set `DEVICE_SERVER_URL` in `.env` if the server is not at `http://localhost:3000`. Stop with Ctrl+C.

## ESP32 firmware

Open `firmware/gas_fire_safety.ino` in Arduino IDE. Install:

- ESP32 board support (Arduino-ESP32)
- ArduinoJson
- ESP32Servo
- LiquidCrystal_I2C

At the top of the sketch, configure `WIFI_SSID`, `WIFI_PASSWORD`, `SERVER_BASE_URL`, `DEVICE_API_KEY`, and `ALERT_PHONE_NUMBER`. The `DEVICE_API_KEY` must exactly match `.env`. Use the computer's LAN address in `SERVER_BASE_URL` when the device is on another Wi-Fi client (for example, `http://192.168.1.25:3000`); `localhost` on the ESP32 would refer to the ESP32 itself. Ensure firewall rules allow the ESP32 to reach the server.

The sketch uses GPIO34 ADC raw counts for MQ-6 readings. The default threshold is 1800 counts and the default detection delay is 5 seconds. Configure calibrated values in the web Settings page; valid ranges are 100–4095 ADC counts and 1–60 seconds. Settings are stored in ESP32 Preferences as a fallback. Gas alarm clear hysteresis is 90% of the threshold. Flame input defaults to active LOW. Relay outputs default to active LOW.

The network work runs in a separate FreeRTOS task so a network request or GSM SMS does not block the loop that samples sensors and applies local safety logic. HTTP is plain-text and intended only for a trusted local prototype network; do not use it across an untrusted network.

### Example wiring

| Component | ESP32 connection | Power / wiring note |
|---|---|---|
| MQ-6 analog output | GPIO34 / ADC1 | Module output must be voltage-limited to ESP32-safe levels. MQ heater requires its rated supply. |
| Flame sensor digital output | GPIO27 | Defaults to active-low; verify the module. |
| Fan relay input | GPIO26 | Active-low relay default; relay contacts must be rated for the load. |
| Pump/sprinkler relay input | GPIO25 | Active-low relay default; keep pump power off the ESP32 supply. |
| Buzzer driver input | GPIO33 | Use a transistor/driver as appropriate; do not exceed GPIO current limits. |
| Servo valve mechanism | GPIO18 | External supply sized for servo; mechanically verify both open and shut-off positions. |
| 16×2 I²C LCD | SDA GPIO21, SCL GPIO22 | Firmware uses address `0x27`; check backpack address and voltage compatibility. |
| SIM800L/SIM900 UART | ESP32 RX2 GPIO16 ← modem TX; ESP32 TX2 GPIO17 → modem RX | Separate supply with sufficient current for GSM bursts. Level-shift UART as required by modem board. |
| ESP32 | USB / regulated supply | Use appropriate grounding, protection, enclosure, and isolation for the prototype. |

Pin definitions, polarity constants, basic wiring comments, and example diagram are in the firmware and About page. Wiring is illustrative: verify your specific modules and loads. A servo is only an example shut-off actuator; solenoid valves require a suitable driver and fail-safe selection.

## Web features and roles

- Dashboard: Normal / Gas Leak / Fire status, gas ADC gauge and threshold, flame and actuator states, online heartbeat, and live 60-reading graph.
- History: date/type filters, pagination, and CSV or PDF export (up to 10,000 filtered events per export).
- Public dashboard: Normal / Gas Leak / Fire status, gas ADC gauge, flame and actuator states, device heartbeat, and live 60-reading graph.
- Public event history with date/type filters, pagination, and CSV/PDF export (up to 10,000 filtered events per export).
- No user accounts, sign-in, settings page, remote buzzer command, or Telegram integration. Configure the gas threshold and detection delay using `GAS_THRESHOLD` and `DETECTION_DELAY_SECONDS`; the ESP32 continues to enforce local safety logic.
- Alarm events also create a server-side “SMS Sent” record documenting that SMS dispatch was requested by the device's GSM module.

## API overview

Dashboard and history APIs are public. ESP32 data submission and configuration endpoints require `x-device-api-key`.

| Method | Endpoint | Access |
|---|---|---|
| `GET` | `/api/status` | Public |
| `GET` | `/api/history?from=&to=&type=&page=` | Public |
| `GET` | `/api/history/export?format=csv\|pdf&from=&to=&type=` | Public |
| `POST` | `/api/device/data` | Device key |
| `POST` | `/api/device/event` | Device key |
| `GET` | `/api/device/config` | Device key |
| WebSocket | `/live` | Public |

PostgreSQL tables are `readings` and `events`, with indexes and schema creation on startup.

## Manual configuration checklist

1. Configure `DATABASE_URL` and a long random `DEVICE_API_KEY` in `.env.local`.
2. For real hardware, set Wi-Fi name/password, the server's LAN URL, matching device key, and the GSM destination phone number in the firmware.
3. Configure `GAS_THRESHOLD` and `DETECTION_DELAY_SECONDS`; verify sensor calibration, pin numbers, active polarity, relay module behavior, LCD address, servo travel, and safe valve position for your exact hardware.
4. Supply and isolate the GSM modem, relays, pump, fan, servo, and sensors according to their respective specifications.
