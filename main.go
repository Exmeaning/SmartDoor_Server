package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/zishang520/socket.io/v2/socket"
)

// --- 配置结构 ---
type Config struct {
	Port         string
	DeviceToken  string
	UserToken    string
	APIToken     string
	R2AccountID  string
	R2AccessKey  string
	R2SecretKey  string
	R2BucketName string
}

// --- 数据模型 ---
type LogEntry struct {
	ID     int64     `json:"id"`
	Time   time.Time `json:"time"`
	Type   string    `json:"type"`
	Msg    string    `json:"msg"`
	ImgURL *string   `json:"imgUrl"`
	R2Key  string    `json:"-"`
}

type DeviceStatus struct {
	Connected bool   `json:"connected"`
	Camera    bool   `json:"camera"`
	Door      string `json:"door"`
}

// --- 全局变量 ---
var (
	cfg           Config
	logs          []LogEntry
	logMutex      sync.RWMutex
	deviceStatus  DeviceStatus
	statusMutex   sync.RWMutex
	s3Client      *s3.Client
	presignClient *s3.PresignClient
	
	// 用 sync.Map 替代 s.Set/Get 来存储 socket 类型
	socketMeta    sync.Map // map[SocketID]string ("device" or "web")
)

const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>智能开门系统 SmartDoor (Go)</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
    <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
    <style type="text/tailwindcss">
        @theme { --color-bg-dark: #1a1a1a; --color-card-dark: #262626; --color-accent-green: #10b981; --color-accent-blue: #3b82f6; }
        body { font-family: 'Inter', sans-serif; background-color: var(--color-bg-dark); color: #e5e7eb; }
        .log-scroll::-webkit-scrollbar { width: 6px; }
        .log-scroll::-webkit-scrollbar-track { background: #262626; }
        .log-scroll::-webkit-scrollbar-thumb { background: #4b5563; border-radius: 3px; }
    </style>
</head>
<body class="h-screen w-screen overflow-hidden flex flex-col">
    <div id="app" class="h-full w-full flex flex-col relative z-10">
        <transition name="fade">
            <div v-if="!isAuthenticated" class="absolute inset-0 z-50 flex items-center justify-center p-4 bg-bg-dark bg-[url('https://images.unsplash.com/photo-1550751827-4bd374c3f58b?q=80&w=2070')] bg-cover bg-center">
                <div class="absolute inset-0 bg-black/70 backdrop-blur-sm"></div>
                <div class="relative w-full max-w-md bg-card-dark/90 p-8 rounded-2xl shadow-2xl border border-gray-700 text-center">
                    <h1 class="text-2xl font-bold text-white mb-2">SmartDoor Go版</h1>
                    <p class="text-gray-400 text-sm mb-6">请输入访问令牌</p>
                    <div class="space-y-4">
                        <input v-model="inputToken" type="password" placeholder="输入 User Token" class="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-accent-blue outline-none" @keyup.enter="login">
                        <button @click="login" class="w-full py-3 bg-accent-blue hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors cursor-pointer">进入控制台</button>
                    </div>
                </div>
            </div>
        </transition>
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
            <footer class="flex-none text-center py-3 text-[10px] text-gray-600 border-t border-gray-800/50">
                <p>Powered by Exmeaning (Go Version) | Cloudflare R2 | <a href="https://github.com/Exmeaning/SmartDoor" target="_blank" class="text-gray-500 hover:text-gray-400">GitHub</a></p>
            </footer>
        </div>
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
`

func init() {
	cfg = Config{
		Port:         getEnv("PORT", "3000"),
		DeviceToken:  getEnv("DEVICE_TOKEN", "default_device_token"),
		UserToken:    getEnv("USER_TOKEN", "default_user_token"),
		APIToken:     getEnv("API_TOKEN", "external_secret_999"),
		R2AccountID:  getEnv("R2_ACCOUNT_ID", ""),
		R2AccessKey:  getEnv("R2_ACCESS_KEY_ID", ""),
		R2SecretKey:  getEnv("R2_SECRET_ACCESS_KEY", ""),
		R2BucketName: getEnv("R2_BUCKET_NAME", ""),
	}
	deviceStatus.Door = "UNKNOWN"

	if cfg.R2AccountID != "" && cfg.R2AccessKey != "" {
		r2Endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com", cfg.R2AccountID)
		resolver := aws.EndpointResolverWithOptionsFunc(func(service, region string, options ...interface{}) (aws.Endpoint, error) {
			return aws.Endpoint{URL: r2Endpoint}, nil
		})
		awsCfg, err := config.LoadDefaultConfig(context.TODO(),
			config.WithEndpointResolverWithOptions(resolver),
			config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(cfg.R2AccessKey, cfg.R2SecretKey, "")),
			config.WithRegion("auto"),
		)
		if err != nil {
			log.Printf("Error loading R2 config: %v", err)
		} else {
			s3Client = s3.NewFromConfig(awsCfg)
			presignClient = s3.NewPresignClient(s3Client)
			log.Println("✅ R2 Client initialized")
		}
	}
}

func main() {
	io := socket.NewServer(nil, nil)

	// 中间件鉴权
	io.Use(func(s *socket.Socket, next func(*socket.ExtendedError)) {
		// 1. 使用类型断言安全获取 auth
		authData := s.Handshake().Auth
		var auth map[string]interface{}
		
		// authData 可能是 map[string]interface{} 或者其他
		if m, ok := authData.(map[string]interface{}); ok {
			auth = m
		} else {
			// 尝试从 JSON 转换 (有时候库会给 map[string]any)
			// 简单处理：如果是 nil，就初始化空 map
			auth = make(map[string]interface{})
		}

		var token string
		var clientType string

		if t, ok := auth["token"].(string); ok { token = t }
		if tp, ok := auth["type"].(string); ok { clientType = tp }

		if clientType == "device" && token == cfg.DeviceToken {
			socketMeta.Store(s.Id(), "device")
			next(nil)
			return
		}
		if clientType == "web" && token == cfg.UserToken {
			socketMeta.Store(s.Id(), "web")
			next(nil)
			return
		}
		
		// 打印调试信息方便排查
		log.Printf("Auth failed. Type: %s, Token: %s", clientType, token)
		next(socket.NewExtendedError("Authentication error", nil))
	})

	// 连接事件 (注意：zishang520库的事件回调签名必须是 func(...any))
	io.On("connection", func(args ...any) {
		if len(args) == 0 { return }
		s, ok := args[0].(*socket.Socket)
		if !ok { return }

		// 从 sync.Map 获取类型
		typeVal, _ := socketMeta.Load(s.Id())
		clientType, _ := typeVal.(string)

		log.Printf("Client connected: %v (%v)", clientType, s.Id())

		if clientType == "device" {
			s.Join("device_room")
			updateDeviceStatus(func(ds *DeviceStatus) {
				ds.Connected = true
				ds.Camera = true
			})
			io.To("web_room").Emit("status", deviceStatus)

			// 断开连接
			s.On("disconnect", func(args ...any) {
				socketMeta.Delete(s.Id())
				updateDeviceStatus(func(ds *DeviceStatus) {
					ds.Connected = false
					ds.Camera = false
				})
				io.To("web_room").Emit("status", deviceStatus)
			})

			// 门状态更新
			s.On("door_status", func(args ...any) {
				if len(args) > 0 {
					if status, ok := args[0].(string); ok {
						updateDeviceStatus(func(ds *DeviceStatus) {
							ds.Door = status
						})
						io.To("web_room").Emit("status", deviceStatus)
					}
				}
			})

			// 日志上报
			s.On("report", func(args ...any) {
				if len(args) == 0 { return }
				data, ok := args[0].(map[string]interface{})
				if !ok { return }

				logType, _ := data["type"].(string)
				msg, _ := data["msg"].(string)
				imgBase64, _ := data["image"].(string)

				entry := LogEntry{
					ID:   time.Now().UnixNano(),
					Time: time.Now(),
					Type: logType,
					Msg:  msg,
				}

				// 实时 Base64
				var realtimeImg *string
				if imgBase64 != "" {
					if !strings.HasPrefix(imgBase64, "data:") {
						fullStr := "data:image/jpeg;base64," + imgBase64
						realtimeImg = &fullStr
					} else {
						realtimeImg = &imgBase64
					}
					entry.ImgURL = realtimeImg
				}

				io.To("web_room").Emit("log", entry)

				// 异步 R2
				go func(e LogEntry, b64 string) {
					if b64 != "" {
						key := uploadToR2(b64)
						if key != "" {
							e.R2Key = key
							e.ImgURL = nil
							addLog(e)
						}
					} else {
						addLog(e)
					}
				}(entry, imgBase64)
			})
		}

		if clientType == "web" {
			s.Join("web_room")
			s.Emit("status", deviceStatus)
			sendHistoryLogs(s)

			// 接收指令
			s.On("command", func(args ...any) {
				if len(args) == 0 { return }
				data, ok := args[0].(map[string]interface{})
				if !ok { return }
				
				cmd, _ := data["cmd"].(string)
				log.Printf("Command received: %s", cmd)
				io.To("device_room").Emit("command", map[string]string{"cmd": cmd})
			})
			
			// 清理 Map
			s.On("disconnect", func(args ...any) {
				socketMeta.Delete(s.Id())
			})
		}
	})

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(HTML_CONTENT))
	})

	http.HandleFunc("/api/command", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		token := r.Header.Get("Authorization")
		if token == "" {
			token = r.URL.Query().Get("token")
		}
		token = strings.TrimPrefix(token, "Bearer ")

		if token != cfg.APIToken {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		var reqBody map[string]string
		if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
			http.Error(w, "Bad Request", http.StatusBadRequest)
			return
		}

		cmd := reqBody["cmd"]
		if cmd == "" {
			http.Error(w, "Missing cmd", http.StatusBadRequest)
			return
		}

		if !deviceStatus.Connected {
			http.Error(w, "Device Offline", http.StatusServiceUnavailable)
			return
		}

		io.To("device_room").Emit("command", map[string]string{"cmd": cmd})

		sysLog := LogEntry{
			ID: time.Now().UnixNano(), Time: time.Now(), Type: "system", Msg: "外部接口触发: " + cmd,
		}
		addLog(sysLog)
		io.To("web_room").Emit("log", sysLog)

		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"success":true}`))
	})

	http.Handle("/socket.io/", io.ServeHandler(nil))

	log.Printf("Go Server running on port %s", cfg.Port)
	log.Fatal(http.ListenAndServe(":"+cfg.Port, nil))
}

// --- 辅助函数 ---

func getEnv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func updateDeviceStatus(updater func(*DeviceStatus)) {
	statusMutex.Lock()
	defer statusMutex.Unlock()
	updater(&deviceStatus)
}

func addLog(entry LogEntry) {
	logMutex.Lock()
	defer logMutex.Unlock()
	logs = append([]LogEntry{entry}, logs...)
	if len(logs) > 50 {
		logs = logs[:50]
	}
}

func sendHistoryLogs(s *socket.Socket) {
	logMutex.RLock()
	defer logMutex.RUnlock()

	for i := len(logs) - 1; i >= 0; i-- {
		l := logs[i]
		if l.R2Key != "" && presignClient != nil {
			req, err := presignClient.PresignGetObject(context.TODO(), &s3.GetObjectInput{
				Bucket: aws.String(cfg.R2BucketName),
				Key:    aws.String(l.R2Key),
			}, func(opts *s3.PresignOptions) {
				opts.Expires = time.Hour
			})
			if err == nil {
				url := req.URL
				l.ImgURL = &url
			}
		}
		s.Emit("log", l)
	}
}

func uploadToR2(b64 string) string {
	if s3Client == nil { return "" }
	
	if idx := strings.Index(b64, ","); idx != -1 {
		b64 = b64[idx+1:]
	}

	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		log.Println("Base64 decode error:", err)
		return ""
	}

	key := fmt.Sprintf("logs/%d_%d.jpg", time.Now().Unix(), time.Now().UnixNano()%1000)
	
	_, err = s3Client.PutObject(context.TODO(), &s3.PutObjectInput{
		Bucket:      aws.String(cfg.R2BucketName),
		Key:         aws.String(key),
		Body:        bytes.NewReader(data),
		ContentType: aws.String("image/jpeg"),
	})

	if err != nil {
		log.Println("R2 Upload error:", err)
		return ""
	}
	return key
}