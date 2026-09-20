package generator

import (
	"math"
	"math/rand"
	"sync"
)

type Generator struct {
	mu          sync.Mutex
	seed        int64
	tension     float64
	keyName     string
	rootMIDI    float64
	section     int
	phraseMotif []float64
	rhythmMask  []bool
	r           *rand.Rand
	barCount    int
}

var euroOffsets = []float64{0, 8, 3, 10}

func NewGenerator(seed int64) *Generator {
	g := &Generator{
		seed:    seed,
		tension: 0.85,
	}
	g.Regenerate(seed)
	return g
}

func (g *Generator) Regenerate(seed int64) {
	g.mu.Lock()
	defer g.mu.Unlock()

	if seed <= 0 {
		seed = 55
	}
	g.seed = seed
	g.r = rand.New(rand.NewSource(seed))

	g.rootMIDI = 43.0
	g.keyName = "G Minor Bittersweet Eurodance"
	g.section = 0
	g.barCount = 0

	g.buildBittersweetHook()
}

func (g *Generator) buildBittersweetHook() {
	g.phraseMotif = make([]float64, 64)
	g.rhythmMask = make([]bool, 64)
	baseG := 67.0

	for i := 0; i < 64; i++ {
		if i%8 == 0 || i%8 == 4 || i%8 == 6 {
			g.rhythmMask[i] = true
		} else {
			g.rhythmMask[i] = false
		}
	}

	g.phraseMotif[0] = baseG + 7.0
	g.phraseMotif[4] = baseG + 8.0
	g.phraseMotif[8] = baseG + 7.0
	g.phraseMotif[12] = baseG + 3.0

	g.phraseMotif[16] = baseG + 10.0
	g.phraseMotif[20] = baseG + 7.0
	g.phraseMotif[24] = baseG + 3.0
	g.phraseMotif[28] = baseG + 5.0

	g.phraseMotif[32] = baseG + 7.0
	g.phraseMotif[36] = baseG + 10.0
	g.phraseMotif[40] = baseG + 7.0
	g.phraseMotif[44] = baseG + 3.0

	g.phraseMotif[48] = baseG + 5.0
	g.phraseMotif[52] = baseG + 3.0
	g.phraseMotif[56] = baseG
	g.phraseMotif[60] = baseG + 2.0

	currentPitch := baseG + 7.0
	for i := 0; i < 64; i++ {
		if g.phraseMotif[i] != 0 {
			currentPitch = g.phraseMotif[i]
		} else {
			g.phraseMotif[i] = currentPitch
		}
	}
}

func (g *Generator) SampleStateAtTime(t float64) (float64, float64, float64, float64, float64, float64) {
	g.mu.Lock()
	defer g.mu.Unlock()

	step := int(math.Floor(t / 0.10869))
	bar := (step / 16) % 4
	inBarStep := step % 16
	motifStep := (bar * 16) + inBarStep

	totalBars := step / 16

	macroPhase := (totalBars / 16) % 4
	g.section = macroPhase

	if totalBars != g.barCount && totalBars%16 == 0 {
		g.barCount = totalBars
		g.buildBittersweetHook()
	}

	chordOffset := euroOffsets[bar]
	chordRootMIDI := g.rootMIDI + chordOffset

	leadMIDI := g.phraseMotif[motifStep]

	var leadVol, midVol, octaveShift float64
	switch g.section {
	case 0:
		leadVol = 0.12
		midVol = 0.20
		octaveShift = -12.0
	case 1:
		leadVol = 0.25
		midVol = 0.38
		octaveShift = 0.0
	case 2:
		leadVol = 0.38
		midVol = 0.48
		octaveShift = 0.0
	case 3:
		leadVol = 0.14
		midVol = 0.28
		octaveShift = -12.0
	}

	if leadMIDI > 0 {
		leadMIDI += octaveShift
		for leadMIDI > 77.0 {
			leadMIDI -= 12.0
		}
		for leadMIDI < 55.0 {
			leadMIDI += 12.0
		}
	}

	midHz := midiToHz(chordRootMIDI + 12.0)
	leadHz := midiToHz(leadMIDI)
	droneHz := midiToHz(chordRootMIDI)

	return leadHz, midHz, droneHz, leadVol, midVol, g.tension
}

func (g *Generator) SetTension(v float64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.tension = v
}

func midiToHz(midi float64) float64 {
	return 440.0 * math.Pow(2.0, (midi-69.0)/12.0)
}
