# Stage 1: Build Go binaries
FROM golang:alpine AS builder

# Install git for module resolutions
RUN apk add --no-cache git

WORKDIR /app

ENV GOTOOLCHAIN=auto

# Copy dependency configs and local code
COPY go.mod go.sum ./
COPY . .

RUN go mod download
RUN go mod tidy

# Build web server and db-sync binaries
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
