package music

import "math"

// Note represents a MIDI pitch value
type Note int

func NewNote(midi int) Note {
	return Note(midi)
}

func (n Note) MIDI() int {
	return int(n)
}

func (n Note) Hz() float64 {
	return 440.0 * math.Pow(2.0, (float64(n)-69.0)/12.0)
}

// Key defines scale constraints
type Key struct {
	root Note
}

func NewMinorKey(root Note) Key {
	return Key{root: root}
}

func (k Key) Contains(n Note) bool {
	pc := (n.MIDI() - k.root.MIDI()) % 12
	if pc < 0 {
		pc += 12
	}
	// Natural minor pitch classes: 0, 2, 3, 5, 7, 8, 10
	switch pc {
	case 0, 2, 3, 5, 7, 8, 10:
		return true
	default:
		return false
	}
}
