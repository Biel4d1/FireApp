# Stage 1: Build Go binaries
FROM golang:alpine AS builder

WORKDIR /app

ENV GOTOOLCHAIN=auto

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN go mod tidy

# Explicitly pass target source files to avoid main() redeclaration conflicts
RUN CGO_ENABLED=0 GOOS=linux go build -o server main.go init_db.go
RUN CGO_ENABLED=0 GOOS=linux go build -o sync_db sync_db.go

# Stage 2: Create runtime container
FROM alpine:latest

RUN apk add --no-cache ffmpeg ca-certificates

WORKDIR /backend

COPY --from=builder /app/server .
COPY --from=builder /app/sync_db .
RUN mkdir -p uploads/videos uploads/profiles

EXPOSE 5000

CMD ["./server"]
