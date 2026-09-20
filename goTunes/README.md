# goTunes 🎵

**Real-Time Procedural Eurodance Synthesis Engine in Go**

goTunes is a low-latency procedural music engine written in **Go** using [`ebitengine/oto/v3`](https://github.com/ebitengine/oto).

It generates continuous late-1990s / early-2000s-inspired Eurodance music entirely through real-time synthesis, without relying on prerecorded PCM samples.

The engine combines procedural harmony, melodic generation, supersaw synthesis, bass, pads, rhythmic ducking, stereo delay, and real-time parameter control through an HTTP API.

Musically, the project explores the melodic and harmonic character associated with tracks such as *Better Off Alone*, *Daddy DJ*, and *Dreams (Will Come Alive)* while generating its own musical material.

---

## ✨ Features

* Infinite procedural music generation
* Real-time PCM synthesis
* No prerecorded audio samples
* Procedural minor-key chord progressions
* Dynamically generated lead melodies
* Multi-oscillator supersaw synthesis
* Sub-bass synthesis
* Detuned atmospheric pads
* Four-on-the-floor rhythmic ducking
* Stereo ping-pong delay
* Soft clipping
* Runtime parameter control through REST endpoints
* Long-running clock management
* Thread-safe communication between control and audio systems

---

## 🏛 Architecture

```text
                         ┌─────────────────────────────┐
                         │     HTTP Control Plane      │
                         │                             │
                         │  POST /api/tension          │
                         │  POST /api/generate         │
                         └──────────────┬──────────────┘
                                        │
                                        │ shared engine state
                                        ▼
                         ┌─────────────────────────────┐
                         │    Procedural Music Engine  │
                         │                             │
                         │ • Harmonic progression      │
                         │ • Melody generation         │
                         │ • Structural macro cycles   │
                         │ • Tension state             │
                         └──────────────┬──────────────┘
                                        │
                                        ▼
┌────────────────────┐      ┌──────────────────────────────┐
│ Transport / Clock  │─────▶│       DSP Signal Chain       │
│                    │      │                              │
│ • Frame position   │      │ • Sub-bass oscillators       │
│ • Beat position    │      │ • Supersaw lead              │
│ • Bar position     │      │ • Detuned pad                │
│ • Modulo clocks    │      │ • Rhythmic ducking           │
└────────────────────┘      │ • Stereo ping-pong delay     │
                            │ • Soft clipping               │
                            └──────────────┬───────────────┘
                                           │
                                           ▼
                            ┌──────────────────────────────┐
                            │        oto/v3 Stream         │
                            │                              │
                            │     16-bit stereo PCM        │
                            │         44.1 kHz             │
                            └──────────────────────────────┘
```

---

## 🔬 Technical Highlights

### Procedural Harmonic Engine

The harmonic engine is currently centered around **G natural minor**, using a Eurodance-oriented progression:

```text
Gm → E♭ → B♭ → F
```

Instead of replaying a fixed melody, the generator selects notes under tonal and structural constraints.

Melodic movement can include:

* scale-wise motion;
* controlled leaps;
* chord-tone targeting;
* repeated motifs;
* tension and release;
* register constraints;
* voice-leading between harmonic regions.

The goal is to retain a recognizable melodic identity while allowing continuously generated variations.

---

### Procedural Lead Generation

Lead melodies are generated algorithmically rather than loaded from MIDI or audio files.

The generator can use harmonic context to bias note selection toward:

```text
Root
Third
Fifth
Scale neighbors
Passing tones
Tension tones
```

This allows each regeneration cycle to create different melodic material while remaining inside the tonal framework of the engine.

---

### Supersaw Lead

The primary lead voice uses multiple slightly detuned oscillators to produce a wide Eurodance-style supersaw texture.

Conceptually:

```text
Oscillator 1 → center pitch
Oscillator 2 → slightly detuned downward
Oscillator 3 → slightly detuned upward
```

The oscillators are mixed before entering the delay and output stages.

---

### Sub-Bass Layer

The low-frequency layer combines sine-based oscillators around the `G1 / G2` register.

A low-pass stage is used to retain the fundamental-heavy character of the bass while reducing unnecessary high-frequency content.

Typical cutoff:

```text
≈ 180 Hz
```

---

### Sidechained Mid-Pad

The midrange pad uses detuned saw oscillators and an amplitude envelope synchronized to the four-on-the-floor rhythm.

The result approximates the characteristic “breathing” motion common in dance music:

```text
Kick
 │
 ▼
Gain reduction
 │
 ▼
Pad recovers exponentially
```

This creates rhythmic movement without requiring a prerecorded sidechain source.

---

### Stereo Ping-Pong Delay

Lead material is routed through a stereo feedback delay.

A typical delay duration is based around:

```text
3/16 note
```

Alternating left/right feedback helps create stereo width and melodic continuity.

---

### Soft Clipping

The final signal can be constrained using nonlinear saturation based on:

```text
tanh(x)
```

This helps prevent extreme peaks while introducing a smoother form of saturation than hard clipping.

---

## ⏱ Clock and Transport Management

Long-running procedural audio systems need stable timing.

goTunes uses bounded clock calculations rather than allowing timing variables to grow indefinitely.

For example:

```go
phase := math.Mod(t, stepPeriod)
```

Modulo-based timing keeps local phase values bounded and reduces precision problems associated with continuously increasing floating-point counters during extended playback.

The transport system tracks musical position such as:

* sample/frame position;
* beat position;
* step position;
* bar position;
* progression state.

---

## 🔐 Concurrent State Management

The audio engine and HTTP control layer operate concurrently.

Runtime state changes are synchronized so that parameters can be modified without stopping the PCM stream.

Conceptually:

```text
HTTP request
     │
     ▼
Shared engine state
     │
     ├──── synchronization ────┐
     │                          │
     ▼                          ▼
Control logic              Audio callback
```

This makes it possible to update musical parameters while synthesis continues.

---

## 🎛 REST API

goTunes exposes a small HTTP control API for manipulating the running synthesis engine.

### Update Tension

```http
POST /api/tension
```

Example:

```bash
curl -X POST http://localhost:8080/api/tension \
  -H "Content-Type: application/json" \
  -d '{"tension": 0.95}'
```

The tension value can influence musical or DSP parameters while the stream remains active.

---

### Generate New Material

```http
POST /api/generate
```

Example:

```bash
curl -X POST http://localhost:8080/api/generate
```

This triggers procedural regeneration of musical material without requiring the audio engine to restart.

---

## 🚀 Quick Start

### Requirements

* Go **1.22+**
* Linux audio support
* ALSA development headers when required by the system
* Git

On Debian/Ubuntu:

```bash
sudo apt install libasound2-dev
```

On Arch Linux:

```bash
sudo pacman -S go alsa-lib
```

---

### Clone the Repository

```bash
git clone https://github.com/Biel4d1/goTunes.git
cd goTunes
```

Download dependencies:

```bash
go mod tidy
```

Run the engine:

```bash
go run ./cmd/server/main.go
```

Once running, the audio stream starts and the control API becomes available locally.

---

## 🧪 Tests and Benchmarks

Run the test suite:

```bash
go test ./...
```

Run tests verbosely:

```bash
go test -v ./...
```

Run benchmarks:

```bash
go test -bench=. ./...
```

Run benchmarks with allocation statistics:

```bash
go test -bench=. -benchmem ./...
```

For a real-time DSP application, allocation measurements are particularly useful because unexpected heap allocations inside the audio path can cause latency spikes or garbage-collection pressure.

---

## 🎼 Musical Model

The current musical system is based around a Eurodance-oriented tonal framework.

Example progression:

```text
i → VI → III → VII

Gm → E♭ → B♭ → F
```

This progression provides a strong balance between:

* minor-key melancholy;
* harmonic lift;
* repetition;
* melodic resolution;
* late-1990s / early-2000s dance character.

The procedural system can then generate melodic movement over this harmonic skeleton.

---

## 🔊 Audio Pipeline

A simplified signal path looks like this:

```text
Procedural Notes
      │
      ▼
Oscillators
      │
      ├───────────────┐
      │               │
      ▼               ▼
Supersaw Lead      Sub-Bass
      │               │
      ▼               │
Stereo Delay          │
      │               │
      ├───────┐       │
      │       │       │
      ▼       ▼       ▼
      Pad / Rhythmic Layers
              │
              ▼
             Mix
              │
              ▼
        Soft Saturation
              │
              ▼
        Stereo PCM Output
              │
              ▼
            oto/v3
```

---

## 📁 Project Structure

A typical project layout:

```text
goTunes/
├── cmd/
│   └── server/
│       └── main.go
│
├── internal/
│   ├── audio/
│   ├── dsp/
│   ├── engine/
│   ├── music/
│   └── api/
│
├── go.mod
├── go.sum
├── LICENSE
└── README.md
```

The exact structure may vary as the engine evolves.

---

## 🗺 Roadmap

Potential future improvements include:

* additional chord progressions;
* multiple minor keys;
* key modulation;
* PolyBLEP or other anti-aliasing oscillators;
* resonant filters;
* ADSR envelopes;
* procedural kick, clap and hi-hat synthesis;
* arpeggiators;
* LFO modulation;
* configurable BPM;
* dynamic song sections;
* breakdown/build/drop generation;
* preset system;
* WebSocket control;
* real-time spectrum visualization;
* waveform visualization;
* WAV export;
* MIDI export;
* desktop interface;
* browser-based control panel.

---

## 🇧🇷 Português

### Visão Geral

**goTunes** é um motor procedural de música em tempo real desenvolvido em **Go** utilizando `ebitengine/oto/v3`.

O projeto gera música inspirada no Eurodance do final dos anos 1990 e início dos anos 2000 inteiramente através de síntese em tempo real, sem depender de samples PCM pré-gravados.

O motor combina:

* geração harmônica procedural;
* geração de melodias;
* síntese supersaw;
* sub-bass;
* pads;
* ducking rítmico;
* delay stereo;
* processamento DSP;
* controle em tempo real por API HTTP.

---

### Motor Harmônico

O sistema atual é centrado em **Sol menor natural**, utilizando uma progressão típica de Eurodance:

```text
Gm → E♭ → B♭ → F
```

A geração melódica é condicionada pela escala e pelos acordes ativos, permitindo produzir novas variações sem abandonar o contexto tonal.

---

### Síntese

O pipeline inclui:

* sub-bass multi-oscilador;
* lead supersaw desafinado;
* pads de médio alcance;
* ducking sincronizado ao ritmo;
* delay stereo ping-pong;
* saturação suave;
* saída PCM stereo em tempo real.

---

### Controle em Tempo Real

Parâmetros do motor podem ser alterados através da API HTTP sem interromper a reprodução.

Atualizar tensão:

```bash
curl -X POST http://localhost:8080/api/tension \
  -H "Content-Type: application/json" \
  -d '{"tension": 0.95}'
```

Gerar novo material:

```bash
curl -X POST http://localhost:8080/api/generate
```

---

### Executando

```bash
git clone https://github.com/Biel4d1/goTunes.git
cd goTunes

go mod tidy
go run ./cmd/server/main.go
```

---

## 📄 License

Distributed under the **MIT License**.

See [`LICENSE`](LICENSE) for details.
