package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/crypto/pbkdf2"
	"golang.org/x/crypto/scrypt"
)

var (
	ctx          = context.Background()
	db           *sql.DB
	rdb          *redis.Client
	jwtSecret    []byte
	jwtAlgorithm = jwt.SigningMethodHS256
)

const jwtExpDays = 7

// -----------------------------------------------------------------------------
// Database & Migration Helpers
// -----------------------------------------------------------------------------

func getDB() *sql.DB {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		host := getEnv("PGHOST", "localhost")
		port := getEnv("PGPORT", "5432")
		user := getEnv("PGUSER", "postgres")
		password := os.Getenv("PGPASSWORD")
		dbname := getEnv("PGDATABASE", "smartvideos")
		dsn = fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable", user, password, host, port, dbname)
	}

	database, err := sql.Open("pgx", dsn)
	if err != nil {
		log.Fatalf("[FATAL] Postgres connection error: %v", err)
	}

	var pingErr error
	for i := 1; i <= 15; i++ {
		pingErr = database.Ping()
		if pingErr == nil {
			log.Println("✅ Successfully connected to PostgreSQL!")
			return database
		}
		log.Printf("⏳ Waiting for PostgreSQL to be ready (attempt %d/15)...", i)
		time.Sleep(2 * time.Second)
	}

	log.Fatalf("[FATAL] Postgres ping error after retries: %v", pingErr)
	return nil
}

func ensureProfileColumn() {
	var exists bool
	query := "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='profile_pic_url')"
	if err := db.QueryRow(query).Scan(&exists); err == nil && !exists {
		db.Exec("ALTER TABLE users ADD COLUMN profile_pic_url TEXT")
		log.Println("Added profile_pic_url column to users table.")
	}
}

func ensureIsPublishedColumn() {
	var exists bool
	query := "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='videos' AND column_name='is_published')"
	if err := db.QueryRow(query).Scan(&exists); err == nil && !exists {
		db.Exec("ALTER TABLE videos ADD COLUMN is_published BOOLEAN DEFAULT TRUE")
		log.Println("Added is_published column to videos table.")
	}
}

func initRedis() *redis.Client {
	redisURL := getEnv("REDIS_URL", "redis://localhost:6379/0")
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Printf("[WARNING] Redis URL parse error: %v", err)
		return nil
	}
	client := redis.NewClient(opt)
	if err := client.Ping(ctx).Err(); err != nil {
		log.Printf("[WARNING] Redis ping failed: %v", err)
		return nil
	}
	return client
}

func syncRedisFromDB() {
	if rdb == nil {
		return
	}
	rows, err := db.Query("SELECT video_id, user_id FROM likes")
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var videoID, userID int
			if err := rows.Scan(&videoID, &userID); err == nil {
				rdb.SAdd(ctx, fmt.Sprintf("video:%d:likes", videoID), strconv.Itoa(userID))
			}
		}
	}

	rowsDislikes, err := db.Query("SELECT video_id, user_id FROM dislikes")
	if err == nil {
		defer rowsDislikes.Close()
		for rowsDislikes.Next() {
			var videoID, userID int
			if err := rowsDislikes.Scan(&videoID, &userID); err == nil {
				rdb.SAdd(ctx, fmt.Sprintf("video:%d:dislikes", videoID), strconv.Itoa(userID))
			}
		}
	}
	log.Println("[INFO] Redis synced with database likes and dislikes on startup")
}

func enqueueRQTask(funcName string, args ...interface{}) {
	if rdb == nil {
		return
	}
	jobID := fmt.Sprintf("%x", time.Now().UnixNano())
	payload := map[string]interface{}{
		"id":        jobID,
		"func_name": funcName,
		"args":      args,
		"kwargs":    map[string]interface{}{},
	}
	data, err := json.Marshal(payload)
	if err == nil {
		rdb.RPush(ctx, "rq:queue:default", data)
	}
}

func formatUploadPath(raw string) string {
	if raw == "" {
		return ""
	}
	cleaned := strings.TrimPrefix(raw, "/")
	if !strings.HasPrefix(cleaned, "uploads/") {
		cleaned = "uploads/" + cleaned
	}
	return cleaned
}

// -----------------------------------------------------------------------------
// Auth & Password Verification
// -----------------------------------------------------------------------------

func verifyPassword(hashedPassword, password string) bool {
	if err := bcrypt.CompareHashAndPassword([]byte(hashedPassword), []byte(password)); err == nil {
		return true
	}

	if strings.HasPrefix(hashedPassword, "scrypt:") {
		parts := strings.Split(hashedPassword, "$")
		if len(parts) == 3 {
			params := strings.Split(parts[0], ":")
			if len(params) == 4 {
				N, _ := strconv.Atoi(params[1])
				r, _ := strconv.Atoi(params[2])
				p, _ := strconv.Atoi(params[3])
				salt := []byte(parts[1])
				expectedHash, err := hex.DecodeString(parts[2])
				if err == nil {
					derivedKey, err := scrypt.Key([]byte(password), salt, N, r, p, len(expectedHash))
					if err == nil {
						return subtle.ConstantTimeCompare(derivedKey, expectedHash) == 1
					}
				}
			}
		}
	}

	if strings.HasPrefix(hashedPassword, "pbkdf2:") {
		parts := strings.Split(hashedPassword, "$")
		if len(parts) == 3 {
			headerParts := strings.Split(parts[0], ":")
			if len(headerParts) >= 3 {
				iterations, err := strconv.Atoi(headerParts[2])
				if err == nil {
					salt := []byte(parts[1])
					expectedHash, err := hex.DecodeString(parts[2])
					if err == nil {
						derivedKey := pbkdf2.Key([]byte(password), salt, iterations, len(expectedHash), sha256.New)
						return subtle.ConstantTimeCompare(derivedKey, expectedHash) == 1
					}
				}
			}
		}
	}

	return false
}

func generateToken(userID int) (string, error) {
	claims := jwt.MapClaims{
		"user_id": userID,
		"exp":     time.Now().Add(time.Hour * 24 * jwtExpDays).Unix(),
		"iat":     time.Now().Unix(),
	}
	token := jwt.NewWithClaims(jwtAlgorithm, claims)
	return token.SignedString(jwtSecret)
}

func parseUserIDFromClaim(val interface{}) (int, bool) {
	switch v := val.(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	case int64:
		return int(v), true
	case string:
		if id, err := strconv.Atoi(v); err == nil {
			return id, true
		}
	}
	return 0, false
}

func tokenRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		auth := c.GetHeader("Authorization")
		if auth == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Authorization header required"})
			c.Abort()
			return
		}

		parts := strings.Split(auth, " ")
		if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Authorization header must be Bearer token"})
			c.Abort()
			return
		}

		token, err := jwt.Parse(parts[1], func(token *jwt.Token) (interface{}, error) {
			if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method")
			}
			return jwtSecret, nil
		})

		if err != nil || !token.Valid {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			c.Abort()
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid claims"})
			c.Abort()
			return
		}

		userID, ok := parseUserIDFromClaim(claims["user_id"])
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid user_id in token"})
			c.Abort()
			return
		}

		c.Set("current_user_id", userID)
		c.Next()
	}
}

func parseOptionalUserID(c *gin.Context) *int {
	if qUser := c.Query("user_id"); qUser != "" {
		if id, err := strconv.Atoi(qUser); err == nil {
			return &id
		}
	}
	auth := c.GetHeader("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		tokenStr := strings.TrimPrefix(auth, "Bearer ")
		token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
			return jwtSecret, nil
		})
		if err == nil && token.Valid {
			if claims, ok := token.Claims.(jwt.MapClaims); ok {
				if id, ok := parseUserIDFromClaim(claims["user_id"]); ok {
					return &id
				}
			}
		}
	}
	return nil
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

func signupHandler(c *gin.Context) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Username == "" || req.Password == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username and password required"})
		return
	}

	var existingID int
	err := db.QueryRow("SELECT id FROM users WHERE username = $1", req.Username).Scan(&existingID)
	if err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "username taken"})
		return
	}

	hashed, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "hashing error"})
		return
	}

	var userID int
	err = db.QueryRow("INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id", req.Username, string(hashed)).Scan(&userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("db error: %v", err)})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"message": "user created", "user_id": userID})
}

func loginHandler(c *gin.Context) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Username == "" || req.Password == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username and password required"})
		return
	}

	var userID int
	var hashedPassword string
	err := db.QueryRow("SELECT id, password FROM users WHERE username = $1", req.Username).Scan(&userID, &hashedPassword)
	if err != nil || !verifyPassword(hashedPassword, req.Password) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	token, err := generateToken(userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token generation error"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "login successful", "token": token})
}

func meHandler(c *gin.Context) {
	userID := c.GetInt("current_user_id")
	var username string
	var profilePicUrl sql.NullString

	err := db.QueryRow("SELECT username, profile_pic_url FROM users WHERE id = $1", userID).Scan(&username, &profilePicUrl)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "user not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"user": gin.H{
			"id":              userID,
			"username":        username,
			"profile_pic_url": formatUploadPath(profilePicUrl.String),
		},
	})
}

func deleteAccountHandler(c *gin.Context) {
	userID := c.GetInt("current_user_id")
	var req struct {
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Password == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "password and valid token required"})
		return
	}

	var hashedPassword string
	err := db.QueryRow("SELECT password FROM users WHERE id = $1", userID).Scan(&hashedPassword)
	if err != nil || !verifyPassword(hashedPassword, req.Password) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	_, err = db.Exec("DELETE FROM users WHERE id = $1", userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("db error: %v", err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "account deleted"})
}

// Fixed: Full Parity Multi-Factor Recommendation Engine
func personalizedFeedHandler(c *gin.Context) {
	currentUserID := parseOptionalUserID(c)
	userParam := -1
	if currentUserID != nil {
		userParam = *currentUserID
	}

	var hasEmbeddingCol bool
	db.QueryRow("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='videos' AND column_name='embedding')").Scan(&hasEmbeddingCol)

	var sqlQuery string
	var params []interface{}

	if hasEmbeddingCol {
		sqlQuery = `
WITH user_engaged_videos AS (
    SELECT v_sub.id, v_sub.embedding
    FROM interactions i
    JOIN videos v_sub ON i.video_id = v_sub.id
    WHERE i.user_id = $1
      AND (i.watch_time_ms >= 3000 OR EXISTS(SELECT 1 FROM likes l WHERE l.user_id = $2 AND l.video_id = v_sub.id))
      AND v_sub.embedding IS NOT NULL
),
user_liked_tags AS (
    SELECT string_agg(v_sub.tags, ',') AS preferred_tags
    FROM interactions i
    JOIN videos v_sub ON i.video_id = v_sub.id
    WHERE i.user_id = $3 AND (i.watch_time_ms >= 3000 OR EXISTS(SELECT 1 FROM likes l WHERE l.user_id = $4 AND l.video_id = v_sub.id))
)
SELECT v.id, v.filename, COALESCE(v.thumbnail, '') AS thumbnail, COALESCE(v.description, '') AS description, v.uploader_id, COALESCE(u.username, '') AS username, COALESCE(u.profile_pic_url, '') AS profile_pic_url, COALESCE(v.tags, '') AS tags, COALESCE(v.likes_count, 0) AS likes_count,
  COALESCE(COUNT(DISTINCT c.id), 0) as comments_count,
  CASE WHEN EXISTS(SELECT 1 FROM likes lk WHERE lk.user_id = $5 AND lk.video_id = v.id) THEN 1 ELSE 0 END AS liked_score,
  CASE WHEN EXISTS(SELECT 1 FROM dislikes dk WHERE dk.user_id = $6 AND dk.video_id = v.id) THEN 1 ELSE 0 END AS disliked_score,
  ((0.35 * (CASE WHEN COALESCE(max_watch.max_w,0) > 0 THEN CAST(COALESCE(user_watch.uw,0) AS FLOAT) / max_watch.max_w ELSE 0 END))
   + (0.25 * (
      CASE
        WHEN v.embedding IS NOT NULL AND EXISTS(SELECT 1 FROM user_engaged_videos) THEN
          (SELECT AVG(1 - (v.embedding <=> uev.embedding)) FROM user_engaged_videos uev)
        WHEN v.tags IS NOT NULL AND v.tags != '' AND (SELECT preferred_tags FROM user_liked_tags) IS NOT NULL THEN
          LEAST(1.0, (SELECT COUNT(*) FROM unnest(string_to_array(v.tags, ',')) tag WHERE (SELECT preferred_tags FROM user_liked_tags) LIKE '%' || tag || '%') * 0.25)
        ELSE 0
      END
     ))
   + (0.15 * (CASE WHEN EXISTS(SELECT 1 FROM comments c3 JOIN videos vv ON c3.video_id = vv.id WHERE c3.user_id = $7 AND vv.uploader_id = v.uploader_id) THEN 1 ELSE 0 END))
   + (0.15 * (CASE WHEN EXISTS(SELECT 1 FROM likes lk WHERE lk.user_id = $8 AND lk.video_id = v.id) THEN 1 ELSE 0 END))
   - (0.30 * (CASE WHEN EXISTS(SELECT 1 FROM dislikes dk2 WHERE dk2.user_id = $9 AND dk2.video_id = v.id) THEN 1 ELSE 0 END))
  ) AS weighted_score,
  (COALESCE(v.likes_count, 0) + COALESCE(COUNT(DISTINCT c.id), 0)) AS global_popularity
FROM videos v
LEFT JOIN users u ON v.uploader_id = u.id
LEFT JOIN comments c ON v.id = c.video_id
LEFT JOIN (SELECT video_id, MAX(watch_time_ms) AS max_w FROM interactions GROUP BY video_id) AS max_watch ON max_watch.video_id = v.id
LEFT JOIN (SELECT video_id, watch_time_ms AS uw FROM interactions WHERE user_id = $10) AS user_watch ON user_watch.video_id = v.id
WHERE COALESCE(v.is_published, TRUE) = TRUE
GROUP BY v.id, u.username, u.profile_pic_url, max_watch.max_w, user_watch.uw, v.embedding
ORDER BY weighted_score DESC, global_popularity DESC, v.id DESC`
		params = []interface{}{userParam, userParam, userParam, userParam, userParam, userParam, userParam, userParam, userParam, userParam}
	} else {
		sqlQuery = `
WITH user_liked_tags AS (
    SELECT string_agg(v_sub.tags, ',') AS preferred_tags
    FROM interactions i
    JOIN videos v_sub ON i.video_id = v_sub.id
    WHERE i.user_id = $1 AND (i.watch_time_ms >= 3000 OR EXISTS(SELECT 1 FROM likes l WHERE l.user_id = $2 AND l.video_id = v_sub.id))
)
SELECT v.id, v.filename, COALESCE(v.thumbnail, '') AS thumbnail, COALESCE(v.description, '') AS description, v.uploader_id, COALESCE(u.username, '') AS username, COALESCE(u.profile_pic_url, '') AS profile_pic_url, COALESCE(v.tags, '') AS tags, COALESCE(v.likes_count, 0) AS likes_count,
  COALESCE(COUNT(DISTINCT c.id), 0) as comments_count,
  CASE WHEN EXISTS(SELECT 1 FROM likes lk WHERE lk.user_id = $3 AND lk.video_id = v.id) THEN 1 ELSE 0 END AS liked_score,
  CASE WHEN EXISTS(SELECT 1 FROM dislikes dk WHERE dk.user_id = $4 AND dk.video_id = v.id) THEN 1 ELSE 0 END AS disliked_score,
  ((0.35 * (CASE WHEN COALESCE(max_watch.max_w,0) > 0 THEN CAST(COALESCE(user_watch.uw,0) AS FLOAT) / max_watch.max_w ELSE 0 END))
   + (0.25 * (
      CASE
        WHEN v.tags IS NOT NULL AND v.tags != '' AND (SELECT preferred_tags FROM user_liked_tags) IS NOT NULL THEN
          LEAST(1.0, (SELECT COUNT(*) FROM unnest(string_to_array(v.tags, ',')) tag WHERE (SELECT preferred_tags FROM user_liked_tags) LIKE '%' || tag || '%') * 0.25)
        ELSE 0
      END
     ))
   + (0.15 * (CASE WHEN EXISTS(SELECT 1 FROM comments c3 JOIN videos vv ON c3.video_id = vv.id WHERE c3.user_id = $5 AND vv.uploader_id = v.uploader_id) THEN 1 ELSE 0 END))
   + (0.15 * (CASE WHEN EXISTS(SELECT 1 FROM likes lk WHERE lk.user_id = $6 AND lk.video_id = v.id) THEN 1 ELSE 0 END))
   - (0.30 * (CASE WHEN EXISTS(SELECT 1 FROM dislikes dk2 WHERE dk2.user_id = $7 AND dk2.video_id = v.id) THEN 1 ELSE 0 END))
  ) AS weighted_score,
  (COALESCE(v.likes_count, 0) + COALESCE(COUNT(DISTINCT c.id), 0)) AS global_popularity
FROM videos v
LEFT JOIN users u ON v.uploader_id = u.id
LEFT JOIN comments c ON v.id = c.video_id
LEFT JOIN (SELECT video_id, MAX(watch_time_ms) AS max_w FROM interactions GROUP BY video_id) AS max_watch ON max_watch.video_id = v.id
LEFT JOIN (SELECT video_id, watch_time_ms AS uw FROM interactions WHERE user_id = $8) AS user_watch ON user_watch.video_id = v.id
WHERE COALESCE(v.is_published, TRUE) = TRUE
GROUP BY v.id, u.username, u.profile_pic_url, max_watch.max_w, user_watch.uw
ORDER BY weighted_score DESC, global_popularity DESC, v.id DESC`
		params = []interface{}{userParam, userParam, userParam, userParam, userParam, userParam, userParam, userParam}
	}

	rows, err := db.Query(sqlQuery, params...)
	if err != nil {
		log.Printf("[FEED DB ERROR] %v", err)
		c.JSON(http.StatusOK, gin.H{"videos": []gin.H{}})
		return
	}
	defer rows.Close()

	videos := make([]gin.H, 0)
	for rows.Next() {
		var id, uploaderID, likesCount, commentsCount, likedScore, dislikedScore, globalPopularity int
		var filename, thumbnail, description, username, profilePicUrl, tags string
		var weightedScore float64

		if err := rows.Scan(&id, &filename, &thumbnail, &description, &uploaderID, &username, &profilePicUrl, &tags, &likesCount, &commentsCount, &likedScore, &dislikedScore, &weightedScore, &globalPopularity); err != nil {
			log.Printf("[FEED SCAN ERROR] %v", err)
			continue
		}

		var isLikedFlag, isDislikedFlag bool
		var finalLikes, finalDislikes int64 = int64(likesCount), 0

		if rdb != nil {
			keyLikes := fmt.Sprintf("video:%d:likes", id)
			keyDislikes := fmt.Sprintf("video:%d:dislikes", id)
			finalLikes = rdb.SCard(ctx, keyLikes).Val()
			finalDislikes = rdb.SCard(ctx, keyDislikes).Val()
			if currentUserID != nil {
				uidStr := strconv.Itoa(*currentUserID)
				isLikedFlag = rdb.SIsMember(ctx, keyLikes, uidStr).Val()
				isDislikedFlag = rdb.SIsMember(ctx, keyDislikes, uidStr).Val()
			}
		} else {
			isLikedFlag = likedScore > 0
			isDislikedFlag = dislikedScore > 0
		}

		videos = append(videos, gin.H{
			"id":             id,
			"filename":       filename,
			"thumbnail":      formatUploadPath(thumbnail),
			"description":    description,
			"uploader_id":    uploaderID,
			"username":       username,
			"profile_pic_url": formatUploadPath(profilePicUrl),
			"tags":           tags,
			"likes_count":    finalLikes,
			"comments_count": commentsCount,
			"is_liked":       isLikedFlag,
			"is_disliked":    isDislikedFlag,
			"dislikes_count": finalDislikes,
			"weighted_score": weightedScore,
		})
	}

	c.JSON(http.StatusOK, gin.H{"videos": videos})
}

func listVideosHandler(c *gin.Context) {
	personalizedFeedHandler(c)
}

func getCommentsHandler(c *gin.Context) {
	videoIDStr := c.Param("video_id")
	videoID, err := strconv.Atoi(videoIDStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid video_id"})
		return
	}

	rows, err := db.Query(`
		SELECT c.id, c.comment_text, c.timestamp, c.user_id, u.username, COALESCE(u.profile_pic_url, '')
		FROM comments c JOIN users u ON c.user_id = u.id
		WHERE c.video_id = $1 ORDER BY c.timestamp ASC
	`, videoID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("db error: %v", err)})
		return
	}
	defer rows.Close()

	comments := make([]gin.H, 0)
	for rows.Next() {
		var id, userID int
		var commentText, username, profilePic string
		var timestamp time.Time

		if err := rows.Scan(&id, &commentText, &timestamp, &userID, &username, &profilePic); err == nil {
			comments = append(comments, gin.H{
				"id":              id,
				"video_id":        videoID,
				"user_id":         userID,
				"comment_text":    commentText,
				"timestamp":       timestamp,
				"username":        username,
				"profile_pic_url": formatUploadPath(profilePic),
			})
		}
	}

	c.JSON(http.StatusOK, gin.H{"comments": comments})
}

func addCommentHandler(c *gin.Context) {
	userID := c.GetInt("current_user_id")
	var req struct {
		VideoID     int    `json:"video_id"`
		CommentText string `json:"comment_text"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.VideoID == 0 || req.CommentText == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "video_id and comment_text required"})
		return
	}

	var commentID int
	var timestamp time.Time
	err := db.QueryRow("INSERT INTO comments (video_id, user_id, comment_text) VALUES ($1, $2, $3) RETURNING id, timestamp", req.VideoID, userID, req.CommentText).Scan(&commentID, &timestamp)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("db error: %v", err)})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"message": "comment added",
		"comment": gin.H{
			"id":           commentID,
			"video_id":     req.VideoID,
			"user_id":      userID,
			"comment_text": req.CommentText,
			"timestamp":    timestamp,
		},
	})
}

// Fixed: Supports Postgres Fallback if Redis is Offline
func toggleLikeHandler(c *gin.Context) {
	userID := c.GetInt("current_user_id")
	var req struct {
		VideoID int `json:"video_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.VideoID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "authenticated user and video_id are required"})
		return
	}

	var action string
	var likesCount, dislikesCount int64
	var isLiked, isDisliked bool

	if rdb != nil {
		keyLikes := fmt.Sprintf("video:%d:likes", req.VideoID)
		keyDislikes := fmt.Sprintf("video:%d:dislikes", req.VideoID)
		uidStr := strconv.Itoa(userID)

		if rdb.SIsMember(ctx, keyLikes, uidStr).Val() {
			rdb.SRem(ctx, keyLikes, uidStr)
			action = "unliked"
		} else {
			rdb.SAdd(ctx, keyLikes, uidStr)
			rdb.SRem(ctx, keyDislikes, uidStr)
			action = "liked"
		}

		likesCount = rdb.SCard(ctx, keyLikes).Val()
		dislikesCount = rdb.SCard(ctx, keyDislikes).Val()
		isLiked = rdb.SIsMember(ctx, keyLikes, uidStr).Val()
		isDisliked = rdb.SIsMember(ctx, keyDislikes, uidStr).Val()

		c.JSON(http.StatusOK, gin.H{
			"message":        action,
			"likes_count":    likesCount,
			"dislikes_count": dislikesCount,
			"is_liked":       isLiked,
			"is_disliked":    isDisliked,
		})
		return
	}

	// PostgreSQL Failover Branch
	var exists bool
	db.QueryRow("SELECT EXISTS(SELECT 1 FROM likes WHERE user_id = $1 AND video_id = $2)", userID, req.VideoID).Scan(&exists)
	if exists {
		db.Exec("DELETE FROM likes WHERE user_id = $1 AND video_id = $2", userID, req.VideoID)
		action = "unliked"
	} else {
		db.Exec("INSERT INTO likes (user_id, video_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", userID, req.VideoID)
		db.Exec("DELETE FROM dislikes WHERE user_id = $1 AND video_id = $2", userID, req.VideoID)
		action = "liked"
	}

	db.QueryRow("SELECT COUNT(*) FROM likes WHERE video_id = $1", req.VideoID).Scan(&likesCount)
	db.QueryRow("SELECT COUNT(*) FROM dislikes WHERE video_id = $1", req.VideoID).Scan(&dislikesCount)
	db.Exec("UPDATE videos SET likes_count = $1, dislikes_count = $2 WHERE id = $3", likesCount, dislikesCount, req.VideoID)

	db.QueryRow("SELECT EXISTS(SELECT 1 FROM likes WHERE user_id = $1 AND video_id = $2)", userID, req.VideoID).Scan(&isLiked)
	db.QueryRow("SELECT EXISTS(SELECT 1 FROM dislikes WHERE user_id = $1 AND video_id = $2)", userID, req.VideoID).Scan(&isDisliked)

	c.JSON(http.StatusOK, gin.H{
		"message":        action,
		"likes_count":    likesCount,
		"dislikes_count": dislikesCount,
		"is_liked":       isLiked,
		"is_disliked":    isDisliked,
	})
}

// Fixed: Supports Postgres Fallback if Redis is Offline
func toggleDislikeHandler(c *gin.Context) {
	userID := c.GetInt("current_user_id")
	var req struct {
		VideoID int `json:"video_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.VideoID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "authenticated user and video_id are required"})
		return
	}

	var action string
	var likesCount, dislikesCount int64
	var isLiked, isDisliked bool

	if rdb != nil {
		keyLikes := fmt.Sprintf("video:%d:likes", req.VideoID)
		keyDislikes := fmt.Sprintf("video:%d:dislikes", req.VideoID)
		uidStr := strconv.Itoa(userID)

		if rdb.SIsMember(ctx, keyDislikes, uidStr).Val() {
			rdb.SRem(ctx, keyDislikes, uidStr)
			action = "removed_dislike"
		} else {
			rdb.SAdd(ctx, keyDislikes, uidStr)
			rdb.SRem(ctx, keyLikes, uidStr)
			action = "disliked"
		}

		likesCount = rdb.SCard(ctx, keyLikes).Val()
		dislikesCount = rdb.SCard(ctx, keyDislikes).Val()
		isLiked = rdb.SIsMember(ctx, keyLikes, uidStr).Val()
		isDisliked = rdb.SIsMember(ctx, keyDislikes, uidStr).Val()

		c.JSON(http.StatusOK, gin.H{
			"message":        action,
			"likes_count":    likesCount,
			"dislikes_count": dislikesCount,
			"is_liked":       isLiked,
			"is_disliked":    isDisliked,
		})
		return
	}

	// PostgreSQL Failover Branch
	var exists bool
	db.QueryRow("SELECT EXISTS(SELECT 1 FROM dislikes WHERE user_id = $1 AND video_id = $2)", userID, req.VideoID).Scan(&exists)
	if exists {
		db.Exec("DELETE FROM dislikes WHERE user_id = $1 AND video_id = $2", userID, req.VideoID)
		action = "removed_dislike"
	} else {
		db.Exec("INSERT INTO dislikes (user_id, video_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", userID, req.VideoID)
		db.Exec("DELETE FROM likes WHERE user_id = $1 AND video_id = $2", userID, req.VideoID)
		action = "disliked"
	}

	db.QueryRow("SELECT COUNT(*) FROM likes WHERE video_id = $1", req.VideoID).Scan(&likesCount)
	db.QueryRow("SELECT COUNT(*) FROM dislikes WHERE video_id = $1", req.VideoID).Scan(&dislikesCount)
	db.Exec("UPDATE videos SET likes_count = $1, dislikes_count = $2 WHERE id = $3", likesCount, dislikesCount, req.VideoID)

	db.QueryRow("SELECT EXISTS(SELECT 1 FROM likes WHERE user_id = $1 AND video_id = $2)", userID, req.VideoID).Scan(&isLiked)
	db.QueryRow("SELECT EXISTS(SELECT 1 FROM dislikes WHERE user_id = $1 AND video_id = $2)", userID, req.VideoID).Scan(&isDisliked)

	c.JSON(http.StatusOK, gin.H{
		"message":        action,
		"likes_count":    likesCount,
		"dislikes_count": dislikesCount,
		"is_liked":       isLiked,
		"is_disliked":    isDisliked,
	})
}

func uploadHandler(c *gin.Context) {
	file, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file is required"})
		return
	}

	userIDStr := c.PostForm("user_id")
	description := c.PostForm("description")
	userID, err := strconv.Atoi(userIDStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	ext := strings.ToLower(filepath.Ext(file.Filename))
	if ext != ".mp4" && ext != ".mov" && ext != ".avi" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file type not allowed"})
		return
	}

	uploadDir := filepath.Join("uploads", "videos")
	os.MkdirAll(uploadDir, 0755)

	uniqueName := fmt.Sprintf("%x%s", time.Now().UnixNano(), ext)
	savePath := filepath.Join(uploadDir, uniqueName)

	if err := c.SaveUploadedFile(file, savePath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("upload error: %v", err)})
		return
	}

	var videoID int
	err = db.QueryRow("INSERT INTO videos (filename, description, uploader_id) VALUES ($1, $2, $3) RETURNING id", uniqueName, description, userID).Scan(&videoID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("db error: %v", err)})
		return
	}

	enqueueRQTask("backend.background_extract_and_save_thumbnail", savePath, videoID)
	enqueueRQTask("backend.background_run_tagger", uniqueName, videoID)

	c.JSON(http.StatusCreated, gin.H{
		"message":  "upload successful",
		"video_id": videoID,
		"filename": uniqueName,
	})
}

func uploadProfilePicHandler(c *gin.Context) {
	userID := c.GetInt("current_user_id")
	file, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file is required"})
		return
	}

	ext := strings.ToLower(filepath.Ext(file.Filename))
	if ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".gif" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file type not allowed"})
		return
	}

	uploadDir := filepath.Join("uploads", "profiles")
	os.MkdirAll(uploadDir, 0755)

	uniqueName := fmt.Sprintf("%x%s", time.Now().UnixNano(), ext)
	savePath := filepath.Join(uploadDir, uniqueName)

	if err := c.SaveUploadedFile(file, savePath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("upload error: %v", err)})
		return
	}

	relativeURL := fmt.Sprintf("uploads/profiles/%s", uniqueName)
	_, err = db.Exec("UPDATE users SET profile_pic_url = $1 WHERE id = $2", relativeURL, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("db error: %v", err)})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"message":         "profile picture uploaded",
		"profile_pic_url": relativeURL,
	})
}

func removeProfilePicHandler(c *gin.Context) {
	userID := c.GetInt("current_user_id")
	var profilePicUrl sql.NullString
	db.QueryRow("SELECT profile_pic_url FROM users WHERE id = $1", userID).Scan(&profilePicUrl)

	if profilePicUrl.Valid && profilePicUrl.String != "" {
		cleaned := strings.TrimPrefix(profilePicUrl.String, "uploads/")
		os.Remove(filepath.Join("uploads", cleaned))
	}

	db.Exec("UPDATE users SET profile_pic_url = NULL WHERE id = $1", userID)
	c.JSON(http.StatusOK, gin.H{"message": "profile picture removed"})
}

func recordInteractionHandler(c *gin.Context) {
	userID := c.GetInt("current_user_id")
	var req struct {
		VideoID     int `json:"video_id"`
		WatchTimeMs int `json:"watch_time_ms"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.VideoID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "authenticated user and video_id are required"})
		return
	}

	var currentMs int
	err := db.QueryRow("SELECT watch_time_ms FROM interactions WHERE user_id = $1 AND video_id = $2", userID, req.VideoID).Scan(&currentMs)
	if err != nil {
		db.Exec("INSERT INTO interactions (user_id, video_id, watch_time_ms) VALUES ($1, $2, $3)", userID, req.VideoID, req.WatchTimeMs)
		currentMs = req.WatchTimeMs
	} else {
		currentMs += req.WatchTimeMs
		db.Exec("UPDATE interactions SET watch_time_ms = $1 WHERE user_id = $2 AND video_id = $3", currentMs, userID, req.VideoID)
	}

	c.JSON(http.StatusOK, gin.H{"message": "interaction recorded", "watch_time_ms": currentMs})
}

func serveVideoHandler(c *gin.Context) {
	filename := c.Param("filename")
	filePath := filepath.Join("uploads", "videos", filename)

	cleanPath := filepath.Clean(filePath)
	if !strings.HasPrefix(cleanPath, filepath.Clean("uploads/videos")) {
		c.JSON(http.StatusForbidden, gin.H{"error": "invalid file path"})
		return
	}

	if _, err := os.Stat(cleanPath); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}

	ext := strings.ToLower(filepath.Ext(cleanPath))
	mimeType := "video/mp4"
	switch ext {
	case ".mov":
		mimeType = "video/quicktime"
	case ".avi":
		mimeType = "video/x-msvideo"
	case ".webm":
		mimeType = "video/webm"
	}

	c.Header("Accept-Ranges", "bytes")
	c.Header("Content-Type", mimeType)
	c.Header("Cache-Control", "public, max-age=3600")

	c.File(cleanPath)
}

func deleteVideoHandler(c *gin.Context) {
	userID := c.GetInt("current_user_id")
	videoIDStr := c.Param("video_id")
	videoID, err := strconv.Atoi(videoIDStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid video_id"})
		return
	}

	var uploaderID int
	var filename, thumbnail sql.NullString
	err = db.QueryRow("SELECT filename, thumbnail, uploader_id FROM videos WHERE id = $1", videoID).Scan(&filename, &thumbnail, &uploaderID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "video not found"})
		return
	}

	if uploaderID != userID {
		c.JSON(http.StatusForbidden, gin.H{"error": "not authorized to delete this video"})
		return
	}

	_, err = db.Exec("DELETE FROM videos WHERE id = $1", videoID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("db error: %v", err)})
		return
	}

	if filename.Valid && filename.String != "" {
		os.Remove(filepath.Join("uploads", "videos", filename.String))
	}
	if thumbnail.Valid && thumbnail.String != "" {
		os.Remove(filepath.Join("uploads", "videos", thumbnail.String))
	}

	c.JSON(http.StatusOK, gin.H{"message": "video deleted"})
}

func deleteCommentHandler(c *gin.Context) {
	userID := c.GetInt("current_user_id")
	commentIDStr := c.Param("comment_id")
	commentID, err := strconv.Atoi(commentIDStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid comment_id"})
		return
	}

	var commentUserID int
	err = db.QueryRow("SELECT user_id FROM comments WHERE id = $1", commentID).Scan(&commentUserID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "comment not found"})
		return
	}

	if commentUserID != userID {
		c.JSON(http.StatusForbidden, gin.H{"error": "not authorized to delete this comment"})
		return
	}

	_, err = db.Exec("DELETE FROM comments WHERE id = $1", commentID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("db error: %v", err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "comment deleted"})
}

func reportVideoHandler(c *gin.Context) {
	userID := c.GetInt("current_user_id")
	var req struct {
		VideoID int    `json:"video_id"`
		Reason  string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.VideoID == 0 || req.Reason == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "video_id and reason are required"})
		return
	}

	var reportID int
	err := db.QueryRow("INSERT INTO reports (video_id, user_id, reason, is_ai_flagged) VALUES ($1, $2, $3, FALSE) RETURNING id", req.VideoID, userID, req.Reason).Scan(&reportID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("db error: %v", err)})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"message": "report submitted", "report_id": reportID})
}

func reportUserHandler(c *gin.Context) {
	reportingUserID := c.GetInt("current_user_id")
	var req struct {
		ReportedUserID int    `json:"reported_user_id"`
		Reason         string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.ReportedUserID == 0 || req.Reason == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "reported_user_id and reason are required"})
		return
	}

	var reportID int
	err := db.QueryRow("INSERT INTO reports (video_id, user_id, reason, is_ai_flagged) VALUES (NULL, $1, $2, FALSE) RETURNING id", reportingUserID, req.Reason).Scan(&reportID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("db error: %v", err)})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"message": "user report submitted", "report_id": reportID})
}

// -----------------------------------------------------------------------------
// Main Execution
// -----------------------------------------------------------------------------

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}

func main() {
	jwtSecret = []byte(getEnv("JWT_SECRET", "185fca44635612d1eeb60929f72254a184fcb1ae4e960d6c54375dee0e93babd"))

	log.Println("🚀 Initializing PostgreSQL and Redis connections...")
	db = getDB()
	defer db.Close()

	initPostgreSQL()
	ensureProfileColumn()
	ensureIsPublishedColumn()

	rdb = initRedis()
	syncRedisFromDB()

	r := gin.Default()

	corsConfig := cors.DefaultConfig()
	corsConfig.AllowAllOrigins = true
	corsConfig.AllowCredentials = true
	corsConfig.AllowHeaders = []string{"Content-Type", "Authorization", "Origin", "Accept"}
	corsConfig.AllowMethods = []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"}
	r.Use(cors.New(corsConfig))

	r.Static("/uploads", "./uploads")

	r.POST("/signup", signupHandler)
	r.POST("/login", loginHandler)
	r.GET("/me", tokenRequired(), meHandler)
	r.POST("/upload", tokenRequired(), uploadHandler)
	r.POST("/upload_profile_pic", tokenRequired(), uploadProfilePicHandler)
	r.POST("/remove_profile_pic", tokenRequired(), removeProfilePicHandler)
	r.POST("/record_interaction", tokenRequired(), recordInteractionHandler)
	r.GET("/get_comments/:video_id", getCommentsHandler)
	r.POST("/add_comment", tokenRequired(), addCommentHandler)
	r.DELETE("/delete_comment/:comment_id", tokenRequired(), deleteCommentHandler)
	r.DELETE("/delete_video/:video_id", tokenRequired(), deleteVideoHandler)
	r.POST("/report_video", tokenRequired(), reportVideoHandler)
	r.POST("/report_user", tokenRequired(), reportUserHandler)
	r.GET("/video/:filename", serveVideoHandler)
	r.GET("/videos", listVideosHandler)
	r.GET("/personalized_feed", personalizedFeedHandler)
	r.POST("/toggle_like", tokenRequired(), toggleLikeHandler)
	r.POST("/toggle_dislike", tokenRequired(), toggleDislikeHandler)
	r.DELETE("/delete_account", tokenRequired(), deleteAccountHandler)

	port := getEnv("PORT", "5000")
	log.Printf("🔥 Server running on http://0.0.0.0:%s", port)
	r.Run(":" + port)
}