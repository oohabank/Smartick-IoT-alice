const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mqtt = require('mqtt');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ========== MQTT клиент ==========
const mqttClient = mqtt.connect('mqtt://broker.hivemq.com:1883');
mqttClient.on('connect', () => console.log('✅ MQTT connected'));

// ========== Хранилище пользователей (в памяти – для простоты) ==========
// В реальном проекте используйте MongoDB или PostgreSQL
// Структура: { email: { passwordHash, devices: [ { id, name, type } ] } }
const users = {};

// ========== Вспомогательная функция хеширования (простая) ==========
const hashPassword = (password) => {
  // В реальном проекте используйте bcrypt, здесь для простоты – sha256
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');
  hash.update(password);
  return hash.digest('hex');
};

// ========== Эндпоинты для приложения MySmartikHome ==========

// Регистрация нового пользователя
app.post('/api/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  if (users[email]) {
    return res.status(400).json({ error: 'User already exists' });
  }
  users[email] = {
    passwordHash: hashPassword(password),
    devices: []
  };
  console.log(`✅ User registered: ${email}`);
  res.json({ success: true });
});

// Вход пользователя (получение токена)
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = users[email];
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  // В реальном проекте используйте JWT, здесь для простоты токен = email
  res.json({ token: email });
});

// Добавить устройство (при добавлении лампы в приложении)
app.post('/api/devices', (req, res) => {
  const { token, id, name, type } = req.body;
  const user = users[token];
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  if (!id || !name) {
    return res.status(400).json({ error: 'id and name required' });
  }
  if (user.devices.find(d => d.id === id)) {
    return res.status(400).json({ error: 'Device already exists' });
  }
  user.devices.push({ id, name, type: type || 'devices.types.light' });
  console.log(`✅ Device added: ${name} (${id}) for user ${token}`);
  res.json({ success: true });
});

// Получить список устройств пользователя
app.get('/api/devices', (req, res) => {
  const { token } = req.query;
  const user = users[token];
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  res.json({ devices: user.devices });
});

// ========== Эндпоинты для навыка Алисы (Yandex Smart Home API) ==========

// OAuth2 – получение токена по email/password
app.post('/oauth/token', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: 'invalid_grant' });
  }
  res.json({
    access_token: username,
    token_type: 'bearer',
    expires_in: 86400,
    refresh_token: username
  });
});

// Получение списка устройств пользователя (для Яндекса)
app.get('/v1.0/user/devices', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  const token = auth.split(' ')[1]; // Bearer <token>
  const user = users[token];
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  const devices = user.devices.map(d => ({
    id: d.id,
    name: d.name,
    type: d.type,
    capabilities: [
      {
        type: 'devices.capabilities.on_off',
        retrievable: true
      },
      {
        type: 'devices.capabilities.range',
        retrievable: true,
        parameters: {
          instance: 'brightness',
          unit: 'percent',
          range: { min: 0, max: 100 }
        }
      },
      {
        type: 'devices.capabilities.color_setting',
        retrievable: true,
        parameters: { color_model: 'rgb' }
      }
    ]
  }));

  res.json({ devices });
});

// Выполнение команд от Алисы
app.post('/v1.0/user/devices/action', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  const token = auth.split(' ')[1];
  const user = users[token];
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  const payload = req.body;
  const results = [];

  for (const item of payload.payload.devices) {
    const deviceId = item.id;
    const commands = item.capabilities;
    for (const cmd of commands) {
      if (cmd.type === 'devices.capabilities.on_off') {
        const value = cmd.state.value;
        mqttClient.publish(`smartick/${deviceId}/cmd`, JSON.stringify({ cmd: 'power', value }));
        console.log(`📤 Command to ${deviceId}: power = ${value}`);
      } else if (cmd.type === 'devices.capabilities.range') {
        const value = cmd.state.value;
        mqttClient.publish(`smartick/${deviceId}/cmd`, JSON.stringify({ cmd: 'brightness', value }));
        console.log(`📤 Command to ${deviceId}: brightness = ${value}`);
      } else if (cmd.type === 'devices.capabilities.color_setting') {
        const rgb = cmd.state.value; // число 0xRRGGBB
        const r = (rgb >> 16) & 0xFF;
        const g = (rgb >> 8) & 0xFF;
        const b = rgb & 0xFF;
        mqttClient.publish(`smartick/${deviceId}/cmd`, JSON.stringify({ cmd: 'color', r, g, b }));
        console.log(`📤 Command to ${deviceId}: color = #${r.toString(16)}${g.toString(16)}${b.toString(16)}`);
      }
    }
    results.push({ id: deviceId });
  }

  res.json({ payload: { devices: results } });
});

// ========== Запуск сервера ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
