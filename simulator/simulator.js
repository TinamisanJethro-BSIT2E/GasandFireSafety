require('dotenv').config();

const baseUrl = (process.env.DEVICE_SERVER_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const deviceKey = process.env.DEVICE_API_KEY;
if (!deviceKey) throw new Error('DEVICE_API_KEY is missing; copy .env.example to .env and configure it');

let previousStatus = 'Normal';
let counter = 0;

async function post(path, body) {
  const response = await fetch(`${baseUrl}/api/device/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-api-key': deviceKey },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${path} returned HTTP ${response.status}: ${detail}`);
  }
}

async function sendSample() {
  const cycleSeconds = Math.floor(Date.now() / 1000) % 30;
  const phase = cycleSeconds < 10 ? 'Normal' : cycleSeconds < 20 ? 'Gas Leak' : 'Fire Detected';
  const status = phase;
  const gasValue = phase === 'Gas Leak' ? 2250 + Math.round(Math.random() * 180) :
    phase === 'Fire Detected' ? 900 + Math.round(Math.random() * 100) : 450 + Math.round(Math.random() * 120);
  const flameDetected = phase === 'Fire Detected';
  const alarm = phase !== 'Normal';
  const fan = phase === 'Gas Leak';
  const pump = flameDetected;
  const reading = {
    gas_value: gasValue,
    flame_detected: flameDetected,
    status,
    fan_on: fan,
    pump_on: pump,
    buzzer_on: alarm,
    regulator_open: !alarm
  };
  await post('data', reading);

  if (status !== previousStatus) {
    if (status === 'Normal') {
      await post('event', {
        event_type: 'Cleared',
        gas_value: gasValue,
        actions: ['readings returned to safe range', 'automatic controls reset']
      });
    } else {
      const actions = status === 'Fire Detected'
        ? ['gas regulator closed', 'water pump on', 'buzzer on']
        : ['gas regulator closed', 'exhaust fan on', 'buzzer on'];
      await post('event', { event_type: status, gas_value: gasValue, actions });
    }
    console.log(`Event: ${status}`);
    previousStatus = status;
  }
  counter += 1;
  console.log(`#${counter} ${status} | gas ${gasValue} ADC | flame ${flameDetected ? 'yes' : 'no'}`);
}

console.log(`Simulator sending to ${baseUrl} (10s normal, 10s gas, 10s fire cycle). Press Ctrl+C to stop.`);
sendSample().catch((error) => { console.error(error.message); process.exitCode = 1; });
setInterval(() => {
  sendSample().catch((error) => console.error(`Simulator request failed: ${error.message}`));
}, 2500);
