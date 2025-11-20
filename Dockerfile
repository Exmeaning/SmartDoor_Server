# 阶段 1: 编译环境
FROM golang:1.21-alpine AS builder

WORKDIR /app

# --- 核心修改 ---
# 1. 先把所有文件(包括 go.mod 和 main.go)全搬进去
COPY . .

# 2. 这时候 main.go 已经在里面了，tidy 就能扫描到引用并下载依赖了
RUN go mod tidy
# ----------------

# 3. 编译
RUN CGO_ENABLED=0 GOOS=linux go build -o server main.go

# 阶段 2: 运行环境 (Alpine)
FROM alpine:latest

# 安装 CA 证书 (否则 R2 连接会报错)
RUN apk --no-cache add ca-certificates

WORKDIR /root/

# 只把编译好的二进制文件拿过来
COPY --from=builder /app/server .

# 暴露端口
EXPOSE 3000

# 运行
CMD ["./server"]