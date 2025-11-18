// index.js
const express = require('express');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB 防炸

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // 提供 dashboard

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || 'dev-token-change-me';
const MAX_EVENTS = parseInt(process.env.MAX_EVENTS) || 2000;
const MAX_COMMANDS_PER_DEVICE = 50;

// 数据存储（内存，自动清理）
const commandQueues = new Map(); // device_id -> Array<command>
const events = [];               // 全局事件流（最近 N 条）
const faces = new Map();         // person_name -> {feature_hex, image_hex?, registered_at}
let eventIdCounter = 0;

// 中间件：Token 验证
const auth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.split(' ')[1];
  if (token !== TOKEN) {
    return res.status(401).json({
      success: false,
      code: 401,
      message: 'Unauthorized: Invalid or missing token',
      timestamp: Math.floor(Date.now() / 1000)
    });
  }
  next();
};

// === 公共接口 ===
app.get('/api/time', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  res.json({
    timestamp: now,
    datetime: new Date().toISOString().replace('T', ' ').substr(0, 19)
  });
});

app.get('/api/heartbeat', auth, (req, res) => {
  res.json({
    success: true,
    code: 200,
    message: 'OK',
    data: { server_time: Math.floor(Date.now() / 1000), config_version: '1.0.0', update_available: false },
    timestamp: Math.floor(Date.now() / 1000)
  });
});

// === K230 设备端接口 ===
app.get('/api/device/poll', auth, (req, res) => {
  const device_id = req.query.device_id || 'unknown';
  const queue = commandQueues.get(device_id) || [];
  const command = queue.length > 0 ? queue.shift() : null;

  // 自动清理超长队列
  if (queue.length > MAX_COMMANDS_PER_DEVICE) {
    queue.splice(0, queue.length - MAX_COMMANDS_PER_DEVICE);
  }

  const now = Math.floor(Date.now() / 1000);
  res.json(command ? {
    success: true, code: 200, message: 'Command pending', data: command, timestamp: now
  } : {
    success: true, code: 200, message: 'No pending commands', data: null, timestamp: now
  });
});

app.post('/api/event', auth, express.json(), (req, res) => {
  const event = {
    id: eventIdCounter++,
    ...req.body,
    received_at: Math.floor(Date.now() / 1000)
  };

  events.push(event);
  if (events.length > MAX_EVENTS) events.shift(); // 内存控制核心

  res.json({
    success: true,
    code: 200,
    message: '事件已接收',
    data: { event_id: `evt_${event.received_at}_${event.id}`, received_at: event.received_at },
    timestamp: event.received_at
  });
});

// 图片上传（仅接收，不持久化存储，节省成本）
['granted', 'denied'].forEach(type => {
  app.post(`/api/upload/${type}`, auth, upload.single('file'), (req, res) => {
    res.json({
      success: true,
      code: 200,
      message: '图片上传成功',
      data: { file_id: `img_${Date.now()}`, url: `https://fake-storage.example.com/${type}/${Date.now()}.jpg` },
      timestamp: Math.floor(Date.now() / 1000)
    });
  });
});

// 人脸相关接口（内存存储，重启丢失，够用且最省钱）
app.post('/api/face/register/hex', auth, express.json({ limit: '50mb' }), (req, res) => {
  const { person_name, feature_hex, image_hex } = req.body;
  if (!person_name || !feature_hex) return res.status(400).json({ success: false, code: 400, message: 'missing fields' });

  faces.set(person_name, {
    feature_hex,
    image_hex,
    registered_at: Math.floor(Date.now() / 1000)
  });

  res.json({
    success: true,
    code: 200,
    message: 'Face registered successfully',
    data: { person_name },
    timestamp: Math.floor(Date.now() / 1000)
  });
});

app.get('/api/face/list', auth, (req, res) => {
  const list = Array.from(faces.entries()).map(([name, info]) => ({
    name,
    face_id: `face_${info.registered_at}`,
    registered_at: info.registered_at
  }));
  res.json({
    success: true,
    code: 200,
    data: { faces: list, total: list.length },
    timestamp: Math.floor(Date.now() / 1000)
  });
});

app.get('/api/face/download/:name', auth, (req, res) => {
  const info = faces.get(req.params.name);
  if (!info) return res.status(404).json({ success: false, code: 404, message: 'Face not found' });

  if (req.query.format === 'hex') {
    return res.json({
      success: true,
      code: 200,
      data: { person_name: req.params.name, feature_hex: info.feature_hex, feature_size: info.feature_hex.length / 2 }
    });
  }

  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${req.params.name}.bin"`);
  res.send(Buffer.from(info.feature_hex, 'hex'));
});

app.delete('/api/face/:name', auth, (req, res) => {
  const deleted = faces.delete(req.params.name);
  res.json({
    success: true,
    code: 200,
    message: deleted ? 'Face deleted successfully' : 'Face not found',
    data: { person_name: req.params.name, deleted_count: deleted ? 1 : 0 }
  });
});

app.post('/api/face/sync', auth, express.json(), (req, res) => {
  const { local_faces = [] } = req.body;
  const serverFaces = Array.from(faces.keys());
  const to_download = serverFaces.filter(name => !local_faces.includes(name));

  res.json({
    success: true,
    code: 200,
    message: 'Sync completed',
    data: { to_download, to_upload: [], synced: local_faces.length, total: serverFaces.length },
    timestamp: Math.floor(Date.now() / 1000)
  });
});

// === 发送客户端专用接口 ===
app.post('/api/command', auth, express.json(), (req, res) => {
  const { device_id, command, params = {}, priority = 'normal' } = req.body;
  if (!device_id || !command) return res.status(400).json({ success: false, code: 400, message: 'missing device_id or command' });

  const cmd = {
    command_id: `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`,
    command,
    params,
    priority,
    timestamp: Math.floor(Date.now() / 1000)
  };

  if (!commandQueues.has(device_id)) commandQueues.set(device_id, []);
  const queue = commandQueues.get(device_id);
  queue.push(cmd);

  // 限制队列长度防内存泄漏
  if (queue.length > MAX_COMMANDS_PER_DEVICE) queue.shift();

  res.json({ success: true, code: 200, message: 'Command queued', data: cmd });
});

// 发送端轮询获取新事件（1s 轮询）
app.get('/api/sender/poll', auth, (req, res) => {
  const last_ts = parseInt(req.query.last_timestamp) || 0;
  const newEvents = events.filter(e => (e.timestamp || e.received_at || 0) > last_ts);

  const latest_ts = events.length > 0
    ? Math.max(...events.map(e => e.timestamp || e.received_at || 0))
    : Math.floor(Date.now() / 1000);

  res.json({
    success: true,
    code: 200,
    message: newEvents.length ? 'New events' : 'No new events',
    data: newEvents,
    latest_timestamp: latest_ts,
    timestamp: Math.floor(Date.now() / 1000)
  });
});

// Web 控制台首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`K230 中转服务器已启动：https://your-project.zeabur.app (Port ${PORT})`);
});
