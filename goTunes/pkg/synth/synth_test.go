package synth

import (
	"testing"
)

func BenchmarkRenderSample(b *testing.B) {
	s := NewSynth(44100)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = s.RenderSampleWithCutoff(392.0, 196.0, 98.0, 0.3, 0.4, float64(i)/44100.0, 0, 0.8)
	}
}

func TestSynthOutputBounds(t *testing.T) {
	s := NewSynth(44100)
	for i := 0; i < 1000; i++ {
		out := s.RenderSampleWithCutoff(440.0, 220.0, 110.0, 0.5, 0.5, float64(i)/44100.0, 0, 0.5)
		if out > 1.0 || out < -1.0 {
			t.Fatalf("Sample at step %d exceeded DAC bounds: %f", i, out)
		}
	}
}
