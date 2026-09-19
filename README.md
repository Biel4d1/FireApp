# 🔥 FireApp (SmartVideos)

<p align="center">
  <a href="#english">English</a> •
  <a href="#português">Português</a>
</p>

---

<a name="english"></a>
## 🇬🇧 English

**FireApp** is a high-performance, asynchronous short-video streaming platform built with a polyglot microservices backend and a React Native mobile client. The system combines lightweight Go API services, asynchronous Python AI workers, Redis in-memory atomic operations, and PostgreSQL vector similarity search (`pgvector`) to deliver instant video playback and intelligent content recommendations.

### 🛠️ Tech Stack & Architecture

- **Backend API (Go / Gin):** Handles REST endpoints, authentication, and HTTP byte-range video streaming.
- **AI Processing Worker (Python / PyTorch / RQ):** Asynchronous worker pipeline that extracts video frames and audio to generate multimodal CLIP vector embeddings (`clip-vit-base-patch32`) and Audio Spectrogram Transformer (AST) concept tags.
- **Caching & Queue (Redis):** In-memory atomicity ($O(1)$) for video likes/dislikes and RQ background task queue management.
- **Database (PostgreSQL + pgvector):** Persistent relational data storage and 512-dimensional vector similarity calculation.
- **Mobile Client (React Native / Expo):** Cross-platform mobile app featuring virtualized snap-scrolling video feeds, range-header caching, and local media library management[cite: 9, 11, 13, 14].

---

### 🚀 Key Features

* **Byte-Range Video Streaming:** Supports HTTP `Accept-Ranges: bytes` for hardware-accelerated playback without re-encoding quality loss.
* **Multimodal Recommendation Engine:** Combines `pgvector` cosine similarity on 512-d CLIP embeddings with explicit user engagement signals (watch duration, likes, comments, author affinity).
* **Async Background AI Tagging:** Automatically samples video frames and audio upon upload to generate concept tags without blocking the API thread.
* **High-Concurrency Reaction Sync:** Manages likes/dislikes in Redis for instant feedback and periodically syncs state back to PostgreSQL.
* **Cross-Platform Mobile App:** Smooth vertical scrolling feed, discovery grid, profile management, and native video downloads.

---

### 📦 System Architecture Diagram
[ Mobile Client (Expo) ]
                                 │
                                 ▼
                       [ Cloudflare Tunnel ]
                                 │
                                 ▼
                       [ Go Web API (Gin) ] ◄──► [ PostgreSQL + pgvector ]
                         (Port 5000)                  (Primary Database)
                              │   ▲
                              │   │ Fast Reads / Cache
                              ▼   │
                          [ Redis ]
                              │
                     Enqueues RQ Tasks
                              │
                              ▼
                  [ Python Worker (RQ Engine) ]
                       ├─ FFmpeg Frame Extraction
                       └─ PyTorch / CLIP / AST Tagging

                       ---

### ⚙️ Getting Started

#### Prerequisites
- Docker & Docker Compose installed
- Node.js (v18+) & Expo CLI (for mobile client development)
- Go (v1.22+) & Python (v3.10+) (optional, for bare-metal setup)

#### 1. Clone the Repository

git clone [https://github.com/Biel4d1/FireApp.git](https://github.com/Biel4d1/FireApp.git)
cd FireApp

REDIS_URL=redis://redis:6379/0
DATABASE_URL=postgresql://user:password@db:5432/smartvideos
JWT_SECRET=your_secure_jwt_secret_here
PORT=5000

docker-compose up -d --build
# Navigate to frontend directory if separate, or run in root
npm install
npx expo start


🇧🇷 Português


O FireApp é uma plataforma de streaming de vídeos curtos de alta performance, construída com uma arquitetura de microsserviços poliglota no backend e um aplicativo móvel em React Native[cite: 4, 5, 9]. O sistema combina a eficiência do Go para APIs de baixa latência, processamento assíncrono em Python para inteligência artificial, operações atômicas em memória com Redis e busca por similaridade vetorial com PostgreSQL (pgvector)[cite: 1, 2, 3, 4, 5, 7].🛠️ Tecnologias UtilizadasBackend API (Go / Gin): Gerencia endpoints REST, autenticação de usuários e streaming via byte-range[cite: 4, 6].Processamento de IA (Python / PyTorch / RQ): Pipeline assíncrono que extrai frames e áudio dos vídeos para gerar embeddings vetoriais multimodais via CLIP (clip-vit-base-patch32) e tags conceituais via Audio Spectrogram Transformer (AST)[cite: 1, 5, 7].Cache e Filas (Redis): Operações em memória de alta velocidade ($O(1)$) para curtidas/descurtidas e gerenciamento de fila de tarefas[cite: 1, 2, 4].Banco de Dados (PostgreSQL + pgvector): Armazenamento relacional e cálculo de similaridade vetorial em 512 dimensões[cite: 3, 7].Aplicativo Móvel (React Native / Expo): Interface nativa com suporte a feed infinito de rolagem vertical, grade de exploração e download de mídia.  🚀 Funcionalidades PrincipaisStreaming Byte-Range Nativo: Suporte a Accept-Ranges: bytes para reprodução contínua e sem perda de qualidade por re-codificação[cite: 4, 10, 13].Motor de Recomendações Multimodal: Cálculo de similaridade por cosseno com pgvector em vetores CLIP de 512 dimensões combinados com sinais de engajamento do usuário (tempo de visualização, curtidas, comentários)[cite: 3, 4, 7].Tagging Assíncrono com IA: Processamento automático de vídeo e áudio no upload sem bloquear a thread principal da API[cite: 4, 7].Sincronização Atômica de Reações: Gerenciamento imediato de curtidas no Redis com persistência assíncrona para o PostgreSQL[cite: 2, 4].App Móvel Multiplataforma: Feed vertical fluido, aba de exploração em grade, perfis de usuário e salvamento de vídeos no dispositivo[cite: 11, 14, 15].⚙️ Como Executar o ProjetoPré-requisitosDocker e Docker Compose instaladosNode.js (v18+) e Expo CLI (para o frontend)1. Clonar o RepositórioBashgit clone [https://github.com/Biel4d1/FireApp.git](https://github.com/Biel4d1/FireApp.git)
cd FireApp
2. Subir o Backend via Docker ComposeBashdocker-compose up -d --build
Este comando inicializa a API Go, o Worker Python, a instância Redis, o banco PostgreSQL com a extensão pgvector e o Cloudflare Tunnel.  3. Iniciar o Aplicativo Móvel (Expo)Bashnpm install
npx expo start
📄 License / LicençaDistribuído sob a licença MIT. Veja LICENSE para mais informações.
---

### How to add this to your repository:

Run these commands in your terminal:

# 1. Commit and push the new README.md
git add README.md
git commit -m "docs: add bilingual production README with architecture diagram"
git push

