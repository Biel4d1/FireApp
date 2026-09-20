package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync/atomic"
	"time"

	"goTunes/pkg/generator"
	"goTunes/pkg/synth"

	"github.com/ebitengine/oto/v3"
)

const channelCount = 2

type AudioStreamer struct {
	gen        *generator.Generator
	synth      *synth.Synth
	sampleRate int
	samplePos  uint64
}

func NewAudioStreamer(gen *generator.Generator, sampleRate int) *AudioStreamer {
	return &AudioStreamer{
		gen:        gen,
		synth:      synth.NewSynth(sampleRate),
		sampleRate: sampleRate,
	}
}

func (s *AudioStreamer) Read(buf []byte) (n int, err error) {
	bytesPerSample := 2 * channelCount
	numSamples := len(buf) / bytesPerSample

	for i := 0; i < numSamples; i++ {
		pos := atomic.AddUint64(&s.samplePos, 1)
		t := float64(pos) / float64(s.sampleRate)

		leadHz, midHz, droneHz, leadVol, midVol, tension := s.gen.SampleStateAtTime(t)

		leftSample := s.synth.RenderSampleWithCutoff(leadHz, midHz, droneHz, leadVol, midVol, t, 0, tension)
		leftInt := int16(leftSample * 32767.0)

		rightSample := s.synth.RenderSampleWithCutoff(leadHz, midHz, droneHz, leadVol, midVol, t, 1, tension)
		rightInt := int16(rightSample * 32767.0)

		idx := i * bytesPerSample
		buf[idx] = byte(leftInt)
		buf[idx+1] = byte(leftInt >> 8)
		buf[idx+2] = byte(rightInt)
		buf[idx+3] = byte(rightInt >> 8)
	}

	return numSamples * bytesPerSample, nil
}

func main() {
	port := flag.Int("port", 8080, "HTTP server port")
	sampleRate := flag.Int("sample-rate", 44100, "Audio output sample rate (Hz)")
	seed := flag.Int64("seed", 42, "PRNG seed for procedural generation")
	flag.Parse()

	gen := generator.NewGenerator(*seed)
	streamer := NewAudioStreamer(gen, *sampleRate)

	op := &oto.NewContextOptions{
		SampleRate:   *sampleRate,
		ChannelCount: channelCount,
		Format:       oto.FormatSignedInt16LE,
		BufferSize:   time.Millisecond * 40,
	}

	otoCtx, ready, err := oto.NewContext(op)
	if err != nil {
		log.Fatalf("Failed to initialize Oto context: %v", err)
	}
	<-ready

	player := otoCtx.NewPlayer(streamer)
	player.Play()

	http.HandleFunc("/api/tension", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var payload struct {
			Tension float64 `json:"tension"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		gen.SetTension(payload.Tension)
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, `{"status":"ok"}`)
	})

	http.HandleFunc("/api/generate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		gen.Regenerate(time.Now().UnixNano())
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, `{"status":"regenerated"}`)
	})

	fmt.Printf("goTunes Eurodance Engine playing at %d Hz. Control API on :%d...\n", *sampleRate, *port)
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", *port), nil))
}
