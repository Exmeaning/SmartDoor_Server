const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== 配置 ====================
const CONFIG = {
    SENDER_TOKEN: process.env.SENDER_TOKEN || 'sender-secret-token',
    DEVICE_TOKEN: process.env.DEVICE_TOKEN || 'device-secret-token',
    MAX_QUEUE_SIZE: 100,  // 每个设备最大队列长度
    MAX_RESULT_CACHE: 50, // 最大结果缓存数
    COMMAND_TIMEOUT: 60000, // 命令超时时间(ms)
    DEVICE_TIMEOUT: 35000,  // 设备离线判定时间(ms)
    CLEANUP_INTERVAL: 30000, // 清理间隔(ms)
};

// ==================== 内存管理结构 ====================
class MemoryManager {
    constructor() {
        // 命令队列：设备ID -> 命令数组
        this.commandQueues = new Map();
        // 命令结果：命令ID -> 结果
        this.commandResults = new Map();
        // 设备状态
        this.deviceStatus = new Map();
        // 待发送者获取的结果
        this.senderResults = new Map();
        
        // 启动定期清理
        this.startCleanup();
    }
    
    // 添加命令到队列
    addCommand(deviceId, command) {
        if (!this.commandQueues.has(deviceId)) {
            this.commandQueues.set(deviceId, []);
        }
        
        const queue = this.commandQueues.get(deviceId);
        
        // 限制队列大小
        if (queue.length >= CONFIG.MAX_QUEUE_SIZE) {
            queue.shift(); // 移除最旧的命令
        }
        
        const commandObj = {
            command_id: `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            command: command.command,
            params: command.params || {},
            priority: command.priority || 'normal',
            timestamp: Date.now(),
            timeout: Date.now() + CONFIG.COMMAND_TIMEOUT
        };
        
        queue.push(commandObj);
        return commandObj.command_id;
    }
    
    // 获取设备的下一个命令
    getNextCommand(deviceId) {
        const queue = this.commandQueues.get(deviceId);
        if (!queue || queue.length === 0) {
            return null;
        }
        
        // 清理超时命令
        const now = Date.now();
        while (queue.length > 0 && queue[0].timeout < now) {
            const timedOut = queue.shift();
            this.addSenderResult(timedOut.command_id, {
                success: false,
                error: 'Command timeout'
            });
        }
        
        return queue.shift() || null;
    }
    
    // 添加发送者结果
    addSenderResult(commandId, result) {
        if (!this.senderResults.has('default')) {
            this.senderResults.set('default', []);
        }
        
        const results = this.senderResults.get('default');
        
        // 限制结果缓存大小
        if (results.length >= CONFIG.MAX_RESULT_CACHE) {
            results.shift();
        }
        
        results.push({
            command_id: commandId,
            result: result,
            timestamp: Date.now()
        });
    }
    
    // 获取并清空发送者结果
    getSenderResults() {
        const results = this.senderResults.get('default') || [];
        this.senderResults.set('default', []);
        return results;
    }
    
    // 更新设备状态
    updateDeviceStatus(deviceId) {
        this.deviceStatus.set(deviceId, {
            online: true,
            lastSeen: Date.now()
        });
    }
    
    // 获取所有设备状态
    getDeviceStatuses() {
        const now = Date.now();
        const statuses = [];
        
        for (const [deviceId, status] of this.deviceStatus.entries()) {
            statuses.push({
                device_id: deviceId,
                online: (now - status.lastSeen) < CONFIG.DEVICE_TIMEOUT,
                last_seen: status.lastSeen
            });
        }
        
        return statuses;
    }
    
    // 定期清理过期数据
    startCleanup() {
        setInterval(() => {
            const now = Date.now();
            
            // 清理超时命令
            for (const [deviceId, queue] of this.commandQueues.entries()) {
                const validCommands = queue.filter(cmd => cmd.timeout > now);
                if (validCommands.length !== queue.length) {
                    this.commandQueues.set(deviceId, validCommands);
                }
            }
            
            // 清理空队列
            for (const [deviceId, queue] of this.commandQueues.entries()) {
                if (queue.length === 0) {
                    this.commandQueues.delete(deviceId);
                }
            }
            
            // 清理离线设备
            for (const [deviceId, status] of this.deviceStatus.entries()) {
                if (now - status.lastSeen > CONFIG.DEVICE_TIMEOUT * 2) {
                    this.deviceStatus.delete(deviceId);
                }
            }
            
            // 内存使用日志
            const memUsage = process.memoryUsage();
            console.log(`Memory: RSS=${Math.round(memUsage.rss / 1024 / 1024)}MB, ` +
                       `Heap=${Math.round(memUsage.heapUsed / 1024 / 1024)}MB/` +
                       `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);
        }, CONFIG.CLEANUP_INTERVAL);
    }
}

// 创建内存管理器实例
const memory = new MemoryManager();

// ==================== 中间件 ====================

// Token验证中间件
const authenticateDevice = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    
    if (token !== CONFIG.DEVICE_TOKEN) {
        return res.status(401).json({
            success: false,
            code: 401,
            message: 'Unauthorized: Invalid device token',
            timestamp: Date.now()
        });
    }
    
    next();
};

const authenticateSender = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    
    if (token !== CONFIG.SENDER_TOKEN) {
        return res.status(401).json({
            success: false,
            code: 401,
            message: 'Unauthorized: Invalid sender token',
            timestamp: Date.now()
        });
    }
    
    next();
};

// CORS中间件
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ==================== K230设备端 API ====================

// 设备轮询命令
app.get('/api/device/poll', authenticateDevice, (req, res) => {
    const deviceId = req.query.device_id || req.headers['x-device-id'] || 'unknown';
    
    // 更新设备状态
    memory.updateDeviceStatus(deviceId);
    
    // 获取下一个命令
    const command = memory.getNextCommand(deviceId);
    
    if (command) {
        res.json({
            success: true,
            code: 200,
            message: 'Command pending',
            data: command,
            timestamp: Date.now()
        });
    } else {
        res.json({
            success: true,
            code: 200,
            message: 'No pending commands',
            data: null,
            timestamp: Date.now()
        });
    }
});

// 设备心跳
app.get('/api/heartbeat', authenticateDevice, (req, res) => {
    const deviceId = req.query.device_id || req.headers['x-device-id'] || 'unknown';
    memory.updateDeviceStatus(deviceId);
    
    res.json({
        success: true,
        code: 200,
        message: 'OK',
        data: {
            server_time: Date.now(),
            config_version: '1.0.0',
            update_available: false
        },
        timestamp: Date.now()
    });
});

// 设备事件上报
app.post('/api/event', authenticateDevice, (req, res) => {
    const { device_id, event_type, data } = req.body;
    
    memory.updateDeviceStatus(device_id);
    
    // 处理命令执行结果
    if (event_type === 'command_executed' && data.command_id) {
        memory.addSenderResult(data.command_id, {
            success: data.success,
            message: data.message,
            execution_time: data.execution_time
        });
    }
    
    // 记录其他事件（简化处理，实际可以存储或转发）
    console.log(`Event from ${device_id}: ${event_type}`);
    
    res.json({
        success: true,
        code: 200,
        message: '事件已接收',
        data: {
            event_id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            received_at: Date.now()
        },
        timestamp: Date.now()
    });
});

// 时间戳端点（解决NTP问题）
app.get('/api/time', (req, res) => {
    const now = new Date();
    res.json({
        success: true,
        timestamp: Date.now(),
        timestamp_seconds: Math.floor(Date.now() / 1000),
        iso: now.toISOString(),
        timezone: 'UTC',
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
        day: now.getUTCDate(),
        hour: now.getUTCHours(),
        minute: now.getUTCMinutes(),
        second: now.getUTCSeconds()
    });
});

// ==================== 发送端 API ====================

// 发送命令
app.post('/api/sender/command', authenticateSender, (req, res) => {
    const { target_device, command, params, priority } = req.body;
    
    if (!target_device || !command) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: target_device, command'
        });
    }
    
    const commandId = memory.addCommand(target_device, {
        command,
        params,
        priority
    });
    
    res.json({
        success: true,
        message: 'Command queued',
        command_id: commandId,
        timestamp: Date.now()
    });
});

// 发送端轮询结果
app.get('/api/sender/poll', authenticateSender, (req, res) => {
    const results = memory.getSenderResults();
    
    res.json({
        success: true,
        pending_results: results.map(r => ({
            command_id: r.command_id,
            status: 'completed',
            result: r.result,
            timestamp: r.timestamp
        })),
        timestamp: Date.now()
    });
});

// 查询设备状态
app.get('/api/sender/devices', authenticateSender, (req, res) => {
    const devices = memory.getDeviceStatuses();
    
    res.json({
        success: true,
        devices: devices,
        timestamp: Date.now()
    });
});

// ==================== 健康检查 ====================

app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        memory: {
            rss_mb: Math.round(memUsage.rss / 1024 / 1024),
            heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
            heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024)
        },
        timestamp: Date.now()
    });
});

// 根路径
app.get('/', (req, res) => {
    res.json({
        name: 'K230 Relay Server',
        version: '1.0.0',
        endpoints: {
            device: ['/api/device/poll', '/api/heartbeat', '/api/event', '/api/time'],
            sender: ['/api/sender/command', '/api/sender/poll', '/api/sender/devices'],
            health: '/health'
        }
    });
});

// ==================== 启动服务器 ====================

app.listen(port, () => {
    console.log(`K230 Relay Server running on port ${port}`);
    console.log(`Device Token: ${CONFIG.DEVICE_TOKEN.substr(0, 8)}...`);
    console.log(`Sender Token: ${CONFIG.SENDER_TOKEN.substr(0, 8)}...`);
});
