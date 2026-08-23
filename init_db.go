package main

import (
	"log"
)

func initPostgreSQL() {
	if db == nil {
		return
	}

	// 1. Enable pgvector extension if available
	_, err := db.Exec("CREATE EXTENSION IF NOT EXISTS vector;")
	if err != nil {
		log.Printf("Warning: Could not enable pgvector extension (%v). Continuing...", err)
	} else {
		log.Println("pgvector extension enabled.")
	}

	// 2. Create Users Table
	usersTable := `
	CREATE TABLE IF NOT EXISTS users (
		id SERIAL PRIMARY KEY,
		username TEXT NOT NULL UNIQUE,
		password TEXT NOT NULL,
		profile_pic_url TEXT
	);`
	if _, err := db.Exec(usersTable); err != nil {
		log.Fatalf("Error creating users table: %v", err)
	}

	// 3. Create Videos Table
	videosTable := `
	CREATE TABLE IF NOT EXISTS videos (
		id SERIAL PRIMARY KEY,
		filename TEXT NOT NULL,
		thumbnail TEXT,
		description TEXT,
		tags TEXT,
		uploader_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
		likes_count INTEGER DEFAULT 0,
		dislikes_count INTEGER DEFAULT 0,
		is_published BOOLEAN DEFAULT TRUE,
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);`
	if _, err := db.Exec(videosTable); err != nil {
		log.Fatalf("Error creating videos table: %v", err)
	}

	// Add embedding column if vector extension is present
	var hasEmbeddingCol bool
	err = db.QueryRow("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='videos' AND column_name='embedding')").Scan(&hasEmbeddingCol)
	if err == nil && !hasEmbeddingCol {
		_, err = db.Exec("ALTER TABLE videos ADD COLUMN embedding vector(512);")
		if err == nil {
			log.Println("Added 512-d embedding column to videos table.")
		}
	}

	// 4. Create Likes Table
	likesTable := `
	CREATE TABLE IF NOT EXISTS likes (
		user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
		video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
		PRIMARY KEY (user_id, video_id)
	);`
	db.Exec(likesTable)

	// 5. Create Dislikes Table
	dislikesTable := `
	CREATE TABLE IF NOT EXISTS dislikes (
		user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
		video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
		PRIMARY KEY (user_id, video_id)
	);`
	db.Exec(dislikesTable)

	// 6. Create Comments Table
	commentsTable := `
	CREATE TABLE IF NOT EXISTS comments (
		id SERIAL PRIMARY KEY,
		video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
		user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
		comment_text TEXT NOT NULL,
		timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);`
	db.Exec(commentsTable)

	// 7. Create Interactions Table
	interactionsTable := `
	CREATE TABLE IF NOT EXISTS interactions (
		user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
		video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
		watch_time_ms INTEGER DEFAULT 0,
		is_liked BOOLEAN DEFAULT FALSE,
		is_commented BOOLEAN DEFAULT FALSE,
		timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (user_id, video_id)
	);`
	db.Exec(interactionsTable)

	// 8. Create Reports Table
	reportsTable := `
	CREATE TABLE IF NOT EXISTS reports (
		id SERIAL PRIMARY KEY,
		video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
		user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
		reason TEXT,
		is_ai_flagged BOOLEAN DEFAULT FALSE,
		timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);`
	db.Exec(reportsTable)

	// 9. Create Searches Table
	searchesTable := `
	CREATE TABLE IF NOT EXISTS searches (
		id SERIAL PRIMARY KEY,
		user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
		query TEXT NOT NULL,
		timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);`
	db.Exec(searchesTable)

	log.Println("PostgreSQL initialization complete.")
}
