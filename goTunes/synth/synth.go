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

	// Portamento Smoothers
	smoothLeadHz  float64
	smoothMidHz   float64
	smoothDroneHz float64

	// Phase accumulators
	phaseSub1  float64
	phaseSub2  float64
	phaseSub3  float64
	phaseKick  float64
	phaseMid1  float64
	phaseMid2  float64
	phaseLead1 float64
	phaseLead2 float64
	phaseArp   float64

	// Delay Buffer Memory
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
		sampleRate:    float64(sampleRate),
		delayBufL:     make([]float64, delayLen),
		delayBufR:     make([]float64, delayLen),
		rng:           rand.New(rand.NewSource(42)),
		smoothLeadHz:  392.0,
		smoothMidHz:   196.0,
		smoothDroneHz: 98.0,
	}
}

func (s *Synth) RenderSampleWithCutoff(leadHz, midHz, droneHz, leadVol, midVol, t float64, channel int, cutoff float64) float64 {
	dt := 1.0 / s.sampleRate

	if leadHz <= 0 { leadHz = 392.0 }
	if midHz <= 0 { midHz = 196.0 }
	if droneHz <= 0 { droneHz = 98.0 }

	// Portamento Lag Filters: Smooth frequency jumps to prevent clicks and harshness
	portamentoSpeed := 25.0 * dt
	s.smoothLeadHz += (leadHz - s.smoothLeadHz) * portamentoSpeed
	s.smoothMidHz += (midHz - s.smoothMidHz) * portamentoSpeed
	s.smoothDroneHz += (droneHz - s.smoothDroneHz) * portamentoSpeed

	beatTime := math.Mod(t, 0.43478)
	stepTime := math.Mod(t, 0.10869)
	eightTime := math.Mod(t, 0.21739)

	// 1. Warm Sub-Bass Drone
	subFreq := s.smoothDroneHz
	phaseOffset := 0.0
	if channel == 1 {
		phaseOffset = 0.10
	}

	s.phaseSub1 += 2.0 * math.Pi * subFreq * dt
	s.phaseSub2 += 2.0 * math.Pi * (subFreq * 0.5) * dt
	s.phaseSub3 += 2.0 * math.Pi * (subFreq * 1.5) * dt

	if s.phaseSub1 > 2.0*math.Pi { s.phaseSub1 -= 2.0 * math.Pi }
	if s.phaseSub2 > 2.0*math.Pi { s.phaseSub2 -= 2.0 * math.Pi }
	if s.phaseSub3 > 2.0*math.Pi { s.phaseSub3 -= 2.0 * math.Pi }

	subFundamental := math.Sin(s.phaseSub1 + phaseOffset)
	subDeep := math.Sin(s.phaseSub2 + phaseOffset)
	subFifth := math.Sin(s.phaseSub3 + phaseOffset)

	rawDrone := (0.60 * subFundamental) + (0.30 * subDeep) + (0.10 * subFifth)

	droneAlpha := 1.0 - math.Exp(-2.0*math.Pi*160.0*dt)
	s.droneLpf += droneAlpha * (rawDrone - s.droneLpf)
	dronePad := 0.45 * s.droneLpf

	// 2. Gentle Kick Drum
	kickEnv := math.Exp(-beatTime * 18.0)
	kickPitch := 130.0 * math.Exp(-beatTime * 32.0)
	s.phaseKick += 2.0 * math.Pi * kickPitch * dt
	if s.phaseKick > 2.0*math.Pi { s.phaseKick -= 2.0 * math.Pi }
	kick := kickEnv * 0.50 * math.Sin(s.phaseKick)

	// 3. Soft Off-Beat Hi-Hat
	hatEnv := 0.0
	if eightTime > 0.10869 {
		hatEnv = math.Exp(-(eightTime - 0.10869) * 45.0)
	}
	whiteNoise := (s.rng.Float64()*2.0 - 1.0)
	hiHat := hatEnv * 0.08 * whiteNoise

	// 4. Snare Drum
	snareEnv := 0.0
	if beatTime > 0.21739 {
		snareEnv = math.Exp(-(beatTime - 0.21739) * 28.0)
	}
	snare := snareEnv * 0.12 * whiteNoise

	// 5. Breathing Mid Pad (Sine Wave Combination)
	s.phaseMid1 += 2.0 * math.Pi * (s.smoothMidHz * 0.997) * dt
	s.phaseMid2 += 2.0 * math.Pi * (s.smoothMidHz * 1.003) * dt
	if s.phaseMid1 > 2.0*math.Pi { s.phaseMid1 -= 2.0 * math.Pi }
	if s.phaseMid2 > 2.0*math.Pi { s.phaseMid2 -= 2.0 * math.Pi }

	m1 := math.Sin(s.phaseMid1)
	m2 := math.Sin(s.phaseMid2)
	rawMid := (m1 + m2) * 0.5

	sidechain := 0.25 + 0.75*(1.0-kickEnv)
	activeMidVol := midVol * sidechain * 1.0

	midAlpha := 1.0 - math.Exp(-2.0*math.Pi*1200.0*dt)
	s.midLpf += midAlpha * (rawMid - s.midLpf)
	midBody := activeMidVol * s.midLpf

	// 6. Smooth Lead (Sine + Triangle Hybrid to eliminate aliasing screeches)
	s.phaseLead1 += 2.0 * math.Pi * s.smoothLeadHz * dt
	s.phaseLead2 += 2.0 * math.Pi * (s.smoothLeadHz * 1.004) * dt
	if s.phaseLead1 > 2.0*math.Pi { s.phaseLead1 -= 2.0 * math.Pi }
	if s.phaseLead2 > 2.0*math.Pi { s.phaseLead2 -= 2.0 * math.Pi }

	pluckEnv := math.Exp(-stepTime * 20.0)
	pluckWave := pluckEnv * 0.18 * math.Sin(s.phaseLead1)

	// Smooth Triangle wave calculation
	triWave := 2.0*math.Abs(2.0*(s.phaseLead1/(2.0*math.Pi))-1.0) - 1.0
	leadSmooth := leadVol * (math.Sin(s.phaseLead1)*0.6 + triWave*0.4) * 0.25 * (1.0 - kickEnv*0.3)

	// 7. Subtle Rolling High Arp
	s.phaseArp += 2.0 * math.Pi * (s.smoothLeadHz * 2.0) * dt
	if s.phaseArp > 2.0*math.Pi { s.phaseArp -= 2.0 * math.Pi }
	arpWave := 0.04 * math.Sin(s.phaseArp) * (1.0 - kickEnv*0.2)

	dryMix := dronePad + midBody + kick + hiHat + snare + pluckWave + leadSmooth + arpWave

	// 8. Stereo Feedback Delay
	var delayedSample float64
	if channel == 0 {
		delayedSample = s.delayBufR[s.delayHead]
		s.delayBufL[s.delayHead] = dryMix + (delayedSample * 0.25)
	} else {
		delayedSample = s.delayBufL[s.delayHead]
		s.delayBufR[s.delayHead] = dryMix + (delayedSample * 0.25)
	}

	if channel == 0 {
		s.delayHead = (s.delayHead + 1) % len(s.delayBufL)
	}

	wetMix := dryMix + (delayedSample * 0.15)

	// Master 2-Pole Low-Pass Filter
	cutoffHz := 400.0 + (cutoff * 2800.0)
	alpha := 1.0 - math.Exp(-2.0*math.Pi*cutoffHz*dt)

	s.lpf1 += alpha * (wetMix - s.lpf1)
	s.lpf2 += alpha * (s.lpf1 - s.lpf2)

	// Warm Soft Clipper (Drive reduced to 0.85 for clean saturation)
	out := math.Tanh(s.lpf2 * 0.85) * 0.88
	return out
}
