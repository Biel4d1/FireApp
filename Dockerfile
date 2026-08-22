# Stage 1: Build the Go binary
FROM golang:alpine AS builder

WORKDIR /app

ENV GOTOOLCHAIN=auto

COPY go.mod go.sum ./
RUN go mod download

COPY . .
# Ensure all package references are synchronized in go.mod/go.sum
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -o server .

# Stage 2: Create runtime container
FROM alpine:latest

RUN apk add --no-cache ffmpeg ca-certificates

WORKDIR /backend

COPY --from=builder /app/server .
RUN mkdir -p uploads/videos uploads/profiles

EXPOSE 5000

CMD ["./server"]
