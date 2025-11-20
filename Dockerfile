# 阶段 1: 编译环境 (升级到 1.23 以支持最新 socket.io 库)
FROM golang:1.23-alpine AS builder

WORKDIR /app

# 1. 先把所有文件全搬进去
COPY . .

# 2. 自动拉取依赖
RUN go mod tidy

# 3. 编译
RUN CGO_ENABLED=0 GOOS=linux go build -o server main.go

# 阶段 2: 运行环境 (Alpine)
FROM alpine:latest

# 安装 CA 证书
RUN apk --no-cache add ca-certificates

WORKDIR /root/

# 复制编译产物
COPY --from=builder /app/server .

# 暴露端口
EXPOSE 3000

# 运行
CMD ["./server"]