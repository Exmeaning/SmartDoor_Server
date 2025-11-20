# 阶段 1: 编译环境
FROM golang:1.21-alpine AS builder

WORKDIR /app

# 复制依赖文件
COPY go.mod go.sum ./
RUN go mod download

# 复制源码
COPY . .

# 编译 (CGO_ENABLED=0 确保是纯静态二进制，体积最小)
RUN CGO_ENABLED=0 GOOS=linux go build -o server main.go

# 阶段 2: 运行环境 (Alpine)
FROM alpine:latest

# 安装 CA 证书 (否则无法连接 HTTPS 的 R2)
RUN apk --no-cache add ca-certificates

WORKDIR /root/

# 只把编译好的文件拿过来
COPY --from=builder /app/server .

# 暴露端口
EXPOSE 3000

# 运行
CMD ["./server"]