package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"sync"

	"github.com/Biel4d1/goTunes/synth"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

type DynamicParams struct {
	Valence   float64 `json:"valence"`
	Arousal   float64 `json:"arousal"`
	Intensity float64 `json:"intensity"`
}

type ManagedEngine struct {
	mu        sync.Mutex
	Synth     *synth.Synth
	TimeClock float64
	Cutoff    float64
}

func StartAudioWorker(ctx context.Context, rdbClient *redis.Client, me *ManagedEngine) {
	if rdbClient == nil {
		return
	}
	pubsub := rdbClient.Subscribe(ctx, "fireapp:audio:parameters")
	go func() {
		defer pubsub.Close()
		ch := pubsub.Channel()
		for msg := range ch {
			var p DynamicParams
			if err := json.Unmarshal([]byte(msg.Payload), &p); err == nil {
				me.mu.Lock()
				me.Cutoff = p.Valence
				me.mu.Unlock()
			}
		}
	}()
}

func HandleAudioStream(me *ManagedEngine) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Content-Type", "audio/l16;rate=44100;channels=1")
		c.Header("Transfer-Encoding", "chunked")
		c.Header("Connection", "keep-alive")
		c.Header("Cache-Control", "no-cache, no-store, must-revalidate")

		dt := 1.0 / 44100.0
		c.Stream(func(w io.Writer) bool {
			buf := new(bytes.Buffer)
			me.mu.Lock()
			for i := 0; i < 4410; i++ {
				sample := me.Synth.RenderSampleWithCutoff(392.0, 196.0, 98.0, 0.5, 0.5, me.TimeClock, 0, me.Cutoff)
				intSample := int16(sample * 32767)
				_ = binary.Write(buf, binary.LittleEndian, intSample)
				me.TimeClock += dt
			}
			me.mu.Unlock()
			_, writeErr := w.Write(buf.Bytes())
			return writeErr == nil
		})
	}
}

func HandleAppDownload(c *gin.Context) {
	platform := c.Param("platform")
	var filename string

	switch platform {
		case "android":
			c.Header("Content-Type", "application/vnd.android.package-archive")
			filename = "fireapp-preview.apk"
		case "windows":
			filename = "family-finance-setup.exe"
		default:
			filename = "family-finance-x86_64.AppImage"
	}
	c.FileAttachment("/var/www/gostore/binaries/"+filename, filename)
}
