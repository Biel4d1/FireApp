package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/redis/go-redis/v9"
)

var (
	syncCtx = context.Background()
	keyRe   = regexp.MustCompile(`^video:(?P<id>\d+):(?P<kind>likes|dislikes)$`)
)

func getEnvString(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}

func getPGConn() *sql.DB {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		host := getEnvString("PGHOST", "localhost")
		port := getEnvString("PGPORT", "5432")
		user := getEnvString("PGUSER", "postgres")
		password := os.Getenv("PGPASSWORD")
		dbname := getEnvString("PGDATABASE", "smartvideos")
		dsn = fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable", user, password, host, port, dbname)
	}

	database, err := sql.Open("pgx", dsn)
	if err != nil {
		log.Fatalf("[FATAL] Erro ao abrir conexão com o Postgres: %v", err)
	}
	return database
}

func processKeys(rdb *redis.Client, db *sql.DB, pattern string, isDryRun bool, column string) int {
	var cursor uint64
	processed := 0

	for {
		keys, nextCursor, err := rdb.Scan(syncCtx, cursor, pattern, 0).Result()
		if err != nil {
			log.Printf("[ERRO] Erro ao escanear o Redis com o padrão %s: %v", pattern, err)
			return processed
		}

		for _, key := range keys {
			matches := keyRe.FindStringSubmatch(key)
			if len(matches) < 3 {
				log.Printf("[INFO] Pulando chave fora do padrão: %s", key)
				continue
			}

			videoIDStr := matches[1]
			videoID, err := strconv.Atoi(videoIDStr)
			if err != nil {
				continue
			}

			count, err := rdb.SCard(syncCtx, key).Result()
			if err != nil {
				log.Printf("[ERRO] Erro ao ler contagem (SCard) da chave %s: %v", key, err)
				continue
			}

			fmt.Printf("Chave=%s -> video_id=%d contagem de %s=%d\n", key, videoID, column, count)

			if !isDryRun {
				query := fmt.Sprintf("UPDATE videos SET %s = $1 WHERE id = $2", column)
				_, err := db.Exec(query, count, videoID)
				if err != nil {
					log.Printf("[ERRO] Erro ao atualizar o banco para o vídeo %d (%s): %v", videoID, column, err)
				}
			}
			processed++
		}

		cursor = nextCursor
		if cursor == 0 {
			break
		}
	}

	return processed
}

func main() {
	redisURLFlag := flag.String("redis", getEnvString("REDIS_URL", "redis://localhost:6379/0"), "URL do Redis")
	dryRunFlag := flag.Bool("dry-run", false, "Não grava as alterações no banco, apenas printa")
	flag.Parse()

	// 1. Inicializa Conexão com o Redis
	opt, err := redis.ParseURL(*redisURLFlag)
	if err != nil {
		log.Fatalf("[FATAL] Erro ao processar URL do Redis: %v", err)
	}
	rdb := redis.NewClient(opt)
	defer rdb.Close()

	if err := rdb.Ping(syncCtx).Err(); err != nil {
		log.Fatalf("[FATAL] Não foi possível conectar ao Redis: %v", err)
	}

	// 2. Inicializa Conexão com o Postgres
	db := getPGConn()
	defer db.Close()

	log.Println("⚡ Escaneando Redis para sincronizar likes e dislikes com o Postgres...")

	totalSeen := 0
	totalSeen += processKeys(rdb, db, "video:*:likes", *dryRunFlag, "likes_count")
	totalSeen += processKeys(rdb, db, "video:*:dislikes", *dryRunFlag, "dislikes_count")

	fmt.Printf("✅ Sincronização concluída! Processadas %d chaves com sucesso.\n", totalSeen)
	os.Exit(0)
}
