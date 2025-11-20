const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// --- 配置加载 ---
const PORT = process.env.PORT || 3000;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'default_device_token';
const USER_TOKEN = process.env.USER_TOKEN || 'default_user_token';

// R2 配置 (兼容 S3 协议)
const R2_CONFIG = {
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
};
const BUCKET_NAME = process.env.R2_BUCKET_NAME;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const s3Client = new S3Client(R2_CONFIG);
app.use(express.json()); 
const API_TOKEN = process.env.API_TOKEN || 'external_secret_999';


// --- 内存数据存储 ---
// 仅保留最近 50 条日志，重启后丢失 (但图片保存在 R2)
let logs = []; 
let deviceStatus = {
    connected: false,
    camera: false,
    door: 'UNKNOWN' // OPEN, CLOSED, UNKNOWN
};

// --- 前端代码 (嵌入式) ---
const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>智能开门系统 SmartDoor</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
    <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
    <style type="text/tailwindcss">
        @theme { --color-bg-dark: #1a1a1a; --color-card-dark: #262626; --color-accent-green: #10b981; --color-accent-blue: #3b82f6; }
        body { font-family: 'Inter', sans-serif; background-color: var(--color-bg-dark); color: #e5e7eb; }
        .log-scroll::-webkit-scrollbar { width: 6px; }
        .log-scroll::-webkit-scrollbar-track { background: #262626; }
        .log-scroll::-webkit-scrollbar-thumb { background: #4b5563; border-radius: 3px; }
        .fade-enter-active, .fade-leave-active { transition: opacity 0.3s ease; }
        .fade-enter-from, .fade-leave-to { opacity: 0; }
        .list-enter-active, .list-leave-active { transition: all 0.4s ease; }
        .list-enter-from, .list-leave-to { opacity: 0; transform: translateY(-20px); }
    </style>
</head>
<body class="h-screen w-screen overflow-hidden flex flex-col">
    <div id="app" class="h-full w-full flex flex-col relative z-10">
        <!-- 鉴权页 -->
        <transition name="fade">
            <div v-if="!isAuthenticated" class="absolute inset-0 z-50 flex items-center justify-center p-4 bg-bg-dark bg-[url('https://images.unsplash.com/photo-1550751827-4bd374c3f58b?q=80&w=2070')] bg-cover bg-center">
                <div class="absolute inset-0 bg-black/70 backdrop-blur-sm"></div>
                <div class="relative w-full max-w-md bg-card-dark/90 p-8 rounded-2xl shadow-2xl border border-gray-700 text-center">
                    <h1 class="text-2xl font-bold text-white mb-2">SmartDoor 智能开门机</h1>
                    <p class="text-gray-400 text-sm mb-6">请输入访问令牌</p>
                    <div class="space-y-4">
                        <input v-model="inputToken" type="password" placeholder="输入 User Token" class="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-accent-blue outline-none" @keyup.enter="login">
                        <button @click="login" class="w-full py-3 bg-accent-blue hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors cursor-pointer">进入控制台</button>
                    </div>
                </div>
            </div>
        </transition>

        <!-- 控制台 -->
        <div v-if="isAuthenticated" class="flex flex-col h-full">
            <header class="h-16 flex-none bg-card-dark border-b border-gray-800 flex items-center justify-between px-4 shadow-md z-10">
                <div class="flex items-center gap-3"><div class="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center text-white font-bold text-xs">SD</div><h1 class="font-bold text-lg">智能开门控制</h1></div>
                <div class="flex items-center gap-2 bg-gray-800 px-3 py-1.5 rounded-full border border-gray-700"><span class="text-xs text-gray-300">{{ connected ? '已连接' : '连接中...' }}</span><span :class="['w-2.5 h-2.5 rounded-full', connected ? 'bg-green-500 animate-pulse' : 'bg-red-500']"></span></div>
            </header>

            <main class="flex-grow flex flex-col overflow-hidden p-4 gap-4 max-w-4xl mx-auto w-full">
                <div class="grid grid-cols-2 gap-4 flex-none">
                    <div class="bg-card-dark p-4 rounded-xl border border-gray-700 flex flex-col items-center justify-center gap-2">
                        <div :class="['p-2 rounded-full', cameraOnline ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400']"><svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg></div>
                        <div class="text-sm text-gray-400">摄像头</div><div :class="cameraOnline ? 'text-green-400' : 'text-red-400'" class="font-semibold">{{ cameraOnline ? '在线' : '离线' }}</div>
                    </div>
                    <div class="bg-card-dark p-4 rounded-xl border border-gray-700 flex flex-col items-center justify-center gap-2">
                        <div :class="['p-2 rounded-full', doorState === 'OPEN' ? 'bg-red-500/10 text-red-400' : (doorState === 'CLOSED' ? 'bg-green-500/10 text-green-400' : 'bg-gray-500/10 text-gray-400')]"><svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg></div>
                        <div class="text-sm text-gray-400">门锁状态</div><div class="font-semibold text-white">{{ doorState === 'OPEN' ? '已开启' : (doorState === 'CLOSED' ? '已关闭' : '未知') }}</div>
                    </div>
                </div>

                <div class="flex-none space-y-3">
                    <div class="grid grid-cols-2 gap-3">
                        <button @click="emitCommand('OPEN')" class="h-20 bg-gradient-to-r from-green-600 to-emerald-600 hover:shadow-lg rounded-xl text-white font-bold text-lg flex flex-col items-center justify-center cursor-pointer">一键开门</button>
                        <button @click="emitCommand('CLOSE')" class="h-20 bg-gradient-to-r from-red-600 to-pink-600 hover:shadow-lg rounded-xl text-white font-bold text-lg flex flex-col items-center justify-center cursor-pointer">立即关门</button>
                    </div>
                    <div class="grid grid-cols-2 gap-3">
                        <button @click="emitCommand('REGISTER_FACE')" class="py-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm text-gray-200 font-medium cursor-pointer">👤 注册人脸</button>
                        <button @click="emitCommand('REFRESH')" class="py-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm text-gray-200 font-medium cursor-pointer">🔄 刷新状态</button>
                    </div>
                </div>

                <div class="flex-grow flex flex-col bg-black/40 rounded-xl border border-gray-800 overflow-hidden">
                    <div class="flex items-center justify-between px-4 py-2 bg-gray-800/50 border-b border-gray-700"><span class="text-xs font-bold text-gray-400 uppercase">系统日志</span><button @click="logs = []" class="text-xs text-gray-500 hover:text-white cursor-pointer">清空</button></div>
                    <div class="flex-grow overflow-y-auto p-4 space-y-3 log-scroll">
                        <transition-group name="list">
                            <div v-for="log in logs" :key="log.id" class="flex gap-3 items-start bg-gray-800/50 p-3 rounded-lg border border-gray-700/50">
                                <div class="flex-none w-16 text-xs font-mono text-gray-500 pt-1">{{ formatTime(log.time) }}</div>
                                <div class="flex-grow"><div class="flex items-center gap-2 mb-1"><span :class="getBadgeClass(log.type)">{{ log.type }}</span></div><p class="text-sm text-gray-300">{{ log.msg }}</p></div>
                                <div v-if="log.imgUrl" class="flex-none cursor-pointer" @click="openImage(log.imgUrl)"><img :src="log.imgUrl" class="w-12 h-12 object-cover rounded border border-gray-600"></div>
                            </div>
                        </transition-group>
                    </div>
                </div>
            </main>
            
            <!-- 页脚 -->
            <footer class="flex-none text-center py-3 text-[10px] text-gray-600 border-t border-gray-800/50">
                <p>Powered by Exmeaning | 图片由 Cloudflare R2 加速 | 项目开源地址 <a href="https://github.com/Exmeaning/SmartDoor" target="_blank" class="text-gray-500 hover:text-gray-400">GitHub.com/Exmeaning/SmartDoor</a></p>
            </footer>
        </div>

        <!-- 模态框 -->
        <transition name="fade">
            <div v-if="showModal" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-md p-4" @click="showModal = false">
                <img :src="currentImage" class="max-w-full max-h-full rounded-lg border border-gray-700" @click.stop>
            </div>
        </transition>
    </div>
    <script>
        const { createApp } = Vue;
        createApp({
            data() { return { isAuthenticated: false, inputToken: '', token: '', socket: null, connected: false, cameraOnline: false, doorState: 'UNKNOWN', logs: [], showModal: false, currentImage: '' } },
            mounted() { if(localStorage.getItem('USER_TOKEN')) { this.token = localStorage.getItem('USER_TOKEN'); this.isAuthenticated = true; this.initSocket(); } },
            methods: {
                login() { if(!this.inputToken) return; this.token = this.inputToken; localStorage.setItem('USER_TOKEN', this.token); this.isAuthenticated = true; this.initSocket(); },
                initSocket() {
                    this.socket = io({ auth: { token: this.token, type: 'web' } });
                    this.socket.on('connect', () => this.connected = true);
                    this.socket.on('disconnect', () => this.connected = false);
                    this.socket.on('log', log => { this.logs.unshift(log); if(this.logs.length > 50) this.logs.pop(); });
                    this.socket.on('status', s => { this.cameraOnline = s.camera; this.doorState = s.door; });
                    this.socket.on('connect_error', () => { alert('Token 错误或连接失败'); this.isAuthenticated = false; });
                },
                emitCommand(cmd) { if(this.socket) this.socket.emit('command', { cmd }); },
                formatTime(t) { return new Date(t).toLocaleTimeString('zh-CN', {hour12:false}); },
                getBadgeClass(t) { const b="px-2 py-0.5 rounded text-xs font-bold uppercase border "; return t==='success'?b+"bg-green-500/20 text-green-400 border-green-500/30":t==='reject'?b+"bg-red-500/20 text-red-400 border-red-500/30":b+"bg-gray-600/20 text-gray-300 border-gray-600/30"; },
                openImage(u) { this.currentImage = u; this.showModal = true; }
            }
        }).mount('#app');
    </script>
</body>
</html>
`;

// --- HTTP 路由 ---
app.get('/', (req, res) => res.send(HTML_CONTENT));

// --- R2 辅助函数 ---
async function uploadToR2(base64Data) {
    if (!process.env.R2_BUCKET_NAME) return null;
    try {
        // 去掉 Base64 头部 (data:image/jpeg;base64,...)
        const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        const fileName = `logs/${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
        
        await s3Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: fileName,
            Body: buffer,
            ContentType: 'image/jpeg'
        }));
        return fileName; // 返回 Key，不要返回完整 URL (因为是私有桶)
    } catch (e) {
        console.error("R2 Upload Error:", e);
        return null;
    }
}

async function getSignedUrlForKey(key) {
    if (!key) return null;
    try {
        const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
        return await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1小时有效
    } catch (e) {
        console.error("Sign URL Error:", e);
        return null;
    }
}
app.post('/api/command', (req, res) => {
    // 1. 校验 Token (通过 Header 或 Query 参数)
    const token = req.headers['authorization'] || req.query.token;
    
    // 简单处理：支持 "Bearer xxx" 或直接 "xxx"
    const cleanToken = token && token.startsWith('Bearer ') ? token.slice(7) : token;

    if (cleanToken !== API_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized', msg: '密钥错误' });
    }

    // 2. 获取指令
    const { cmd } = req.body;
    if (!cmd) {
        return res.status(400).json({ error: 'Missing command', msg: '请在 body 中发送 { "cmd": "OPEN" }' });
    }

    // 3. 检查设备是否在线
    if (!deviceStatus.connected) {
        return res.status(503).json({ error: 'Device Offline', msg: '树莓派离线，无法执行' });
    }

    // 4. 通过 WebSocket 转发给树莓派
    console.log(`[API] External command received: ${cmd}`);
    io.to('device_room').emit('command', { cmd: cmd });

    // 5. 记录日志供 WebUI 查看
    const logMsg = `外部接口触发指令: ${cmd}`;
    // 广播日志给 Web 端
    io.to('web_room').emit('log', { 
        id: Date.now(), time: new Date(), type: 'system', msg: logMsg 
    });
    // 存入内存
    logs.unshift({ id: Date.now(), time: new Date(), type: 'system', msg: logMsg });
    if(logs.length > 50) logs.pop();

    // 6. 响应 HTTP 成功
    res.json({ success: true, msg: `指令 ${cmd} 已发送` });
});
// --- Socket.io 逻辑 ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    const type = socket.handshake.auth.type; // 'web' or 'device'

    if (type === 'device' && token === DEVICE_TOKEN) {
        socket.userType = 'device';
        return next();
    }
    if (type === 'web' && token === USER_TOKEN) {
        socket.userType = 'web';
        return next();
    }
    return next(new Error("Authentication error"));
});

io.on('connection', async (socket) => {
    console.log(`Client connected: ${socket.userType} (${socket.id})`);

    if (socket.userType === 'device') {
        socket.join('device_room');
        deviceStatus.connected = true;
        deviceStatus.camera = true; // 假设连上就是在线
        io.to('web_room').emit('status', deviceStatus);

        socket.on('disconnect', () => {
            deviceStatus.connected = false;
            deviceStatus.camera = false;
            io.to('web_room').emit('status', deviceStatus);
        });

        // 树莓派上报日志
        socket.on('report', async (data) => {
            // data: { type: 'success'|'reject', msg: 'xxx', image: 'base64...' }
            
            // 1. 构造日志对象
            const logEntry = {
                id: Date.now(),
                time: new Date(),
                type: data.type,
                msg: data.msg,
                imgUrl: null, // 初始为空
                r2Key: null   // 用于后续生成签名链接
            };

            // 2. 如果有图片，先直接把 Base64 给 Web 端用于实时显示 (极速)
            if (data.image) {
                logEntry.imgUrl = data.image.startsWith('data:') ? data.image : `data:image/jpeg;base64,${data.image}`;
            }

            // 3. 广播给当前在线的 Web 用户
            io.to('web_room').emit('log', logEntry);

            // 4. 异步：上传 R2 并更新内存记录
            if (data.image) {
                const key = await uploadToR2(data.image);
                if (key) {
                    logEntry.r2Key = key;
                    logEntry.imgUrl = null; // 内存里为了省空间，上传成功后可以删掉 Base64 (可选)
                    
                    // 更新 logs 数组
                    logs.unshift(logEntry);
                    if (logs.length > 50) logs.pop();
                }
            } else {
                logs.unshift(logEntry);
                if (logs.length > 50) logs.pop();
            }
        });

        // 树莓派更新门状态
        socket.on('door_status', (status) => {
            deviceStatus.door = status; // 'OPEN' or 'CLOSED'
            io.to('web_room').emit('status', deviceStatus);
        });
    }

    if (socket.userType === 'web') {
        socket.join('web_room');
        
        // 发送当前状态
        socket.emit('status', deviceStatus);

        // 发送历史日志 (需要为 R2 图片生成签名链接)
        const historyLogs = await Promise.all(logs.map(async (log) => {
            if (log.r2Key) {
                const signedUrl = await getSignedUrlForKey(log.r2Key);
                return { ...log, imgUrl: signedUrl }; // 替换为临时链接
            }
            return log;
        }));
        // 倒序发给前端，或者前端自己处理，这里直接发数组，前端根据代码是 unshift，所以我们倒着发？
        // 前端逻辑是 unshift，所以历史记录应该按时间倒序（最新的在 logs[0]）直接发过去
        // 但是 socket.emit 是一次性的，这里简单处理：倒着遍历发，或者改前端
        // 为了简化，我们发送一个特殊事件 'history_logs' 或者逐条发
        // 这里逐条发送，从最旧的开始发，这样前端 unshift 后顺序是对的
        for (let i = historyLogs.length - 1; i >= 0; i--) {
            socket.emit('log', historyLogs[i]);
        }

        // Web 发送指令
        socket.on('command', (data) => {
            // data: { cmd: 'OPEN' }
            console.log(`Command received: ${data.cmd}`);
            // 转发给树莓派
            io.to('device_room').emit('command', { cmd: data.cmd });
        });
    }
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});