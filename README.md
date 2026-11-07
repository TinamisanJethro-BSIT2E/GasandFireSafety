# IoT-Based Gas Leakage and Fire Safety System with Automatic Control

Capstone web and firmware prototype for the Department of Hospitality Management, Cavite State University – Imus Campus.

The ESP32 runs the gas/fire detection and actuator logic locally. The web server provides monitoring, settings, history, accounts, and optional Telegram alerts; the safety logic does **not** depend on the server or Wi-Fi.

> **Safety notice:** This is an educational prototype, not a certified fire alarm or gas safety product. Do not rely on it to protect life or property. Validate sensor calibration, relay isolation, mechanical valve behavior, power supplies, and failure modes with a qualified engineer. Keep tests supervised and use safe, simulated conditions.

## Folder structure

```text
gasfiresystem/
├── server/
│   ├── auth.js            # JWT authentication and role middleware
│   ├── db.js              # SQLite schema, migrations, first-run administrator
│   ├── index.js           # Express, static files, WebSocket setup
│   └── routes.js          # Auth, device, history, settings, users, control APIs
├── public/
│   ├── index.html         # Login
│   ├── dashboard.html     # Live status and graph
│   ├── history.html       # Filtered log and CSV/PDF export
│   ├── settings.html      # Threshold, delay, Telegram, password
│   ├── users.html         # Viewer management
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
- An internet connection for the initial npm dependency install.
- For ESP32 builds: Arduino IDE or PlatformIO plus the libraries listed in the firmware section.

In the project folder:

```powershell
Copy-Item .env.example .env
npm install
npm start
```

Then visit [http://localhost:3000](http://localhost:3000).

The server creates `data/gas-safety.db` and migrates its schema automatically. On first startup, it seeds:

- **Username:** `admin`
- **Password:** `Admin123!`

The seeded administrator must change this password on first login. Change the credentials in `.env` before first startup for a non-demo deployment. Back up the SQLite database and protect `.env`; never expose the server or demo credentials to the public internet. Use HTTPS and replace both example secrets before deployment.

To use another port, set `PORT` in `.env`. `DATABASE_PATH` can point to a different SQLite file. The browser Chart.js bundle is served from the installed package; no CDN connection is needed.

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
- Settings: admin-only threshold/delay/Telegram updates and password change.
- Users: administrators can create and delete viewer accounts. Last administrator and current session cannot be deleted.
- Viewer accounts can monitor and export history; all protected operations are enforced server-side.
- Optional Telegram delivery requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env` and enabling it in Settings. The ESP32's GSM module handles SMS. Alarm events also create a server-side “SMS Sent” record documenting that SMS dispatch was requested by the device.
- Admin “Test buzzer” queues a limited buzzer-test command for the ESP32. It cannot remotely switch off safety actuators.

## API overview

Browser API uses an HTTP-only JWT cookie. ESP32 endpoints require `x-device-api-key`.

| Method | Endpoint | Access |
|---|---|---|
| `POST` | `/api/auth/login` | Public, rate-limited |
| `POST` | `/api/auth/logout` | Public |
| `GET` | `/api/auth/me` | Authenticated |
| `POST` | `/api/auth/password` | Authenticated |
| `GET` | `/api/status` | Authenticated |
| `GET` | `/api/history?from=&to=&type=&page=` | Authenticated |
| `GET` | `/api/history/export?format=csv\|pdf&from=&to=&type=` | Authenticated |
| `GET` / `PUT` | `/api/settings` | Read: authenticated; update: admin |
| `GET` / `POST` / `DELETE` | `/api/users` | Admin |
| `POST` | `/api/control` | Admin; only `buzzer_test` |
| `POST` | `/api/device/data` | Device key |
| `POST` | `/api/device/event` | Device key |
| `GET` | `/api/device/config` | Device key |
| `GET` | `/api/device/commands` | Device key |
| `POST` | `/api/device/commands/:id/complete` | Device key |
| WebSocket | `/live` | Authenticated cookie |

SQLite tables include `users`, `readings`, `events`, `settings`, and `device_commands`, with indexes and schema creation on startup.

## Manual configuration checklist

1. Copy `.env.example` to `.env`; replace `JWT_SECRET` and `DEVICE_API_KEY` with long random values. Set admin credentials before the first run.
2. For real hardware, set Wi-Fi name/password, the server's LAN URL, matching device key, and the GSM destination phone number in the firmware.
3. Calibrate sensor threshold and delay; verify pin numbers, active polarity, relay module behavior, LCD address, servo travel, and safe valve position for your exact hardware.
4. Add Telegram bot token/chat ID only if Telegram alerts are wanted; enable Telegram in admin Settings.
5. Supply and isolate the GSM modem, relays, pump, fan, servo, and sensors according to their respective specifications.
