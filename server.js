const express = require('express');
const bodyParser = require('body-parser');
const mqtt = require('mqtt');

const app = express();
app.use(bodyParser.json());

const mqttClient = mqtt.connect('mqtt://broker.hivemq.com:1883');

// Хранилище пользователей и устройств (в памяти – для простоты)
const users = {
  'user@example.com': {
    password: 'password',
    devices: [
      { id: 'SMARTICK-XXXX', name: 'Лампа', type: 'devices.types.light' }
    ]
  }
};

// OAuth2 упрощённо (для навыка)
app.post('/oauth/token', (req, res) => {
  const { username, password } = req.body;
  if (users[username] && users[username].password === password) {
    res.json({ access_token: 'token123', token_type: 'bearer', expires_in: 86400 });
  } else {
    res.status(401).json({ error: 'invalid_grant' });
  }
});

// Получение устройств (для Яндекса)
app.get('/v1.0/user/devices', (req, res) => {
  const user = users['user@example.com']; // в реальности – по токену
  const devices = user.devices.map(d => ({
    id: d.id,
    name: d.name,
    type: d.type,
    capabilities: [
      { type: 'devices.capabilities.on_off', retrievable: true },
      { type: 'devices.capabilities.range', retrievable: true, parameters: { instance: 'brightness', unit: 'percent', range: { min: 0, max: 100 } } },
      { type: 'devices.capabilities.color_setting', retrievable: true, parameters: { color_model: 'rgb' } }
    ]
  }));
  res.json({ devices });
});

// Выполнение команд
app.post('/v1.0/user/devices/action', (req, res) => {
  const payload = req.body;
  const results = [];

  for (const item of payload.payload.devices) {
    const deviceId = item.id;
    const commands = item.capabilities;
    for (const cmd of commands) {
      if (cmd.type === 'devices.capabilities.on_off') {
        const value = cmd.state.value;
        mqttClient.publish(`smartick/${deviceId}/cmd`, JSON.stringify({ cmd: 'power', value }));
      } else if (cmd.type === 'devices.capabilities.range') {
        const value = cmd.state.value;
        mqttClient.publish(`smartick/${deviceId}/cmd`, JSON.stringify({ cmd: 'brightness', value }));
      } else if (cmd.type === 'devices.capabilities.color_setting') {
        const rgb = cmd.state.value;
        const r = (rgb >> 16) & 0xFF;
        const g = (rgb >> 8) & 0xFF;
        const b = rgb & 0xFF;
        mqttClient.publish(`smartick/${deviceId}/cmd`, JSON.stringify({ cmd: 'color', r, g, b }));
      }
    }
    results.push({ id: deviceId });
  }

  res.json({ payload: { devices: results } });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
