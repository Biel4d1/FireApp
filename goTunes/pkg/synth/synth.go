package synth

import (
	"math"
	"math/rand"
)

type Synth struct {
	sampleRate float64
	lpf1       float64
	lpf2       float64
	droneLpf   float64
	midLpf     float64

	phaseSub1  float64
	phaseSub2  float64
	phaseSub3  float64
	phaseKick  float64
	phaseMid1  float64
	phaseMid2  float64
	phaseLead1 float64
	phaseLead2 float64
	phaseLead3 float64

	delayBufL []float64
	delayBufR []float64
	delayHead int

	rng *rand.Rand
}

func NewSynth(sampleRate int) *Synth {
	if sampleRate <= 0 {
		sampleRate = 44100
	}
	delayLen := int(0.16304 * float64(sampleRate))
	return &Synth{
		sampleRate: float64(sampleRate),
		delayBufL:  make([]float64, delayLen),
		delayBufR:  make([]float64, delayLen),
		rng:        rand.New(rand.NewSource(42)),
	}
}

func (s *Synth) RenderSampleWithCutoff(leadHz, midHz, droneHz, leadVol, midVol, t float64, channel int, cutoff float64) float64 {
	dt := 1.0 / s.sampleRate

	if leadHz <= 0 { leadHz = 392.0 }
	if midHz <= 0 { midHz = 196.0 }
	if droneHz <= 0 { droneHz = 98.0 }

	beatTime := math.Mod(t, 0.43478)
	eightTime := math.Mod(t, 0.21739)

	// Sub-bass Drone
	subFreq := droneHz
	phaseOffset := 0.0
	if channel == 1 { phaseOffset = 0.15 }

	s.phaseSub1 += 2.0 * math.Pi * subFreq * dt
	s.phaseSub2 += 2.0 * math.Pi * (subFreq * 0.5) * dt
	s.phaseSub3 += 2.0 * math.Pi * (subFreq * 1.5) * dt

	if s.phaseSub1 > 2.0*math.Pi { s.phaseSub1 -= 2.0 * math.Pi }
	if s.phaseSub2 > 2.0*math.Pi { s.phaseSub2 -= 2.0 * math.Pi }
	if s.phaseSub3 > 2.0*math.Pi { s.phaseSub3 -= 2.0 * math.Pi }

	subFundamental := math.Sin(s.phaseSub1 + phaseOffset)
	subDeep := math.Sin(s.phaseSub2 + phaseOffset)
	subFifth := math.Sin(s.phaseSub3 + phaseOffset)

	rawDrone := (0.55 * subFundamental) + (0.35 * subDeep) + (0.10 * subFifth)
	droneAlpha := 1.0 - math.Exp(-2.0*math.Pi*180.0*dt)
	s.droneLpf += droneAlpha * (rawDrone - s.droneLpf)
	dronePad := 0.48 * s.droneLpf

	// Kick
	kickEnv := math.Exp(-beatTime * 17.0)
	kickPitch := 145.0 * math.Exp(-beatTime * 30.0)
	s.phaseKick += 2.0 * math.Pi * kickPitch * dt
	if s.phaseKick > 2.0*math.Pi { s.phaseKick -= 2.0 * math.Pi }
	kick := kickEnv * 0.65 * math.Sin(s.phaseKick)

	// Hi-Hat
	hatEnv := 0.0
	if eightTime > 0.10869 {
		hatEnv = math.Exp(-(eightTime - 0.10869) * 38.0)
	}
	whiteNoise := (s.rng.Float64()*2.0 - 1.0)
	hiHat := hatEnv * 0.14 * whiteNoise

	// Snare
	snareEnv := 0.0
	if beatTime > 0.21739 {
		snareEnv = math.Exp(-(beatTime - 0.21739) * 22.0)
	}
	snare := snareEnv * 0.20 * whiteNoise

	// Mid-Pad
	s.phaseMid1 += 2.0 * math.Pi * (midHz * 0.995) * dt
	s.phaseMid2 += 2.0 * math.Pi * (midHz * 1.005) * dt
	if s.phaseMid1 > 2.0*math.Pi { s.phaseMid1 -= 2.0 * math.Pi }
	if s.phaseMid2 > 2.0*math.Pi { s.phaseMid2 -= 2.0 * math.Pi }

	m1 := (s.phaseMid1 / math.Pi) - 1.0
	m2 := (s.phaseMid2 / math.Pi) - 1.0
	rawMid := (m1 + m2) * 0.5

	sidechain := 0.15 + 0.85*(1.0-kickEnv)
	activeMidVol := midVol * sidechain * 1.35

	midAlpha := 1.0 - math.Exp(-2.0*math.Pi*1600.0*dt)
	s.midLpf += midAlpha * (rawMid - s.midLpf)
	midBody := activeMidVol * s.midLpf

	// Supersaw Lead
	s.phaseLead1 += 2.0 * math.Pi * leadHz * dt
	s.phaseLead2 += 2.0 * math.Pi * (leadHz * 0.994) * dt
	s.phaseLead3 += 2.0 * math.Pi * (leadHz * 1.006) * dt

	if s.phaseLead1 > 2.0*math.Pi { s.phaseLead1 -= 2.0 * math.Pi }
	if s.phaseLead2 > 2.0*math.Pi { s.phaseLead2 -= 2.0 * math.Pi }
	if s.phaseLead3 > 2.0*math.Pi { s.phaseLead3 -= 2.0 * math.Pi }

	l1 := (s.phaseLead1 / math.Pi) - 1.0
	l2 := (s.phaseLead2 / math.Pi) - 1.0
	l3 := (s.phaseLead3 / math.Pi) - 1.0

	leadSaw := leadVol * (l1 + l2 + l3) * 0.32 * (1.0 - kickEnv*0.3)

	dryMix := dronePad + midBody + kick + hiHat + snare + leadSaw

	// Stereo Ping-Pong Delay
	var delayedSample float64
	if channel == 0 {
		delayedSample = s.delayBufR[s.delayHead]
		s.delayBufL[s.delayHead] = dryMix + (delayedSample * 0.38)
	} else {
		delayedSample = s.delayBufL[s.delayHead]
		s.delayBufR[s.delayHead] = dryMix + (delayedSample * 0.38)
	}

	if channel == 0 {
		s.delayHead = (s.delayHead + 1) % len(s.delayBufL)
	}

	wetMix := dryMix + (delayedSample * 0.26)

	// Master Low-Pass Filter
	cutoffHz := 1000.0 + (cutoff * 5000.0)
	alpha := 1.0 - math.Exp(-2.0*math.Pi*cutoffHz*dt)

	s.lpf1 += alpha * (wetMix - s.lpf1)
	s.lpf2 += alpha * (s.lpf1 - s.lpf2)

	out := math.Tanh(s.lpf2 * 1.3) * 0.92
	return out
}
