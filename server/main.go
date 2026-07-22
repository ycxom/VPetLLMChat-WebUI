package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	protocolVersion = 1
	maxFrameBytes   = 96 * 1024
	maxCiphertext   = 64 * 1024
)

type config struct {
	addr           string
	allowedOrigins map[string]struct{}
	requireTLS     bool
}

type envelope struct {
	Type       string `json:"type"`
	Version    int    `json:"v,omitempty"`
	RoomID     string `json:"room_id,omitempty"`
	Role       string `json:"role,omitempty"`
	Verifier   string `json:"verifier,omitempty"`
	MessageID  string `json:"message_id,omitempty"`
	Nonce      string `json:"nonce,omitempty"`
	Ciphertext string `json:"ciphertext,omitempty"`
	Code       string `json:"code,omitempty"`
	PeerOnline *bool  `json:"peer_online,omitempty"`
}

type client struct {
	conn   *websocket.Conn
	send   chan []byte
	roomID string
	role   string
	rate   []time.Time
}

type room struct {
	verifier string
	clients  map[string]*client
}

type hub struct {
	register   chan *registration
	unregister chan *client
	relay      chan *relayRequest
	rooms      map[string]*room
}

type registration struct {
	client   *client
	verifier string
	result   chan error
}

type relayRequest struct {
	client *client
	data   []byte
}

func newHub() *hub {
	return &hub{
		register:   make(chan *registration),
		unregister: make(chan *client),
		relay:      make(chan *relayRequest),
		rooms:      make(map[string]*room),
	}
}

func (h *hub) run() {
	for {
		select {
		case req := <-h.register:
			r, ok := h.rooms[req.client.roomID]
			if !ok {
				r = &room{verifier: req.verifier, clients: make(map[string]*client)}
				h.rooms[req.client.roomID] = r
			}
			if subtle.ConstantTimeCompare([]byte(r.verifier), []byte(req.verifier)) != 1 {
				req.result <- errors.New("authentication failed")
				continue
			}
			if _, exists := r.clients[req.client.role]; exists {
				req.result <- errors.New("role already connected")
				continue
			}
			r.clients[req.client.role] = req.client
			req.result <- nil
			h.notifyPresence(r)

		case c := <-h.unregister:
			r, ok := h.rooms[c.roomID]
			if !ok || r.clients[c.role] != c {
				continue
			}
			delete(r.clients, c.role)
			close(c.send)
			if len(r.clients) == 0 {
				delete(h.rooms, c.roomID)
			} else {
				h.notifyPresence(r)
			}

		case req := <-h.relay:
			r, ok := h.rooms[req.client.roomID]
			if !ok || r.clients[req.client.role] != req.client {
				continue
			}
			peerRole := "browser"
			if req.client.role == "browser" {
				peerRole = "plugin"
			}
			if peer := r.clients[peerRole]; peer != nil {
				select {
				case peer.send <- req.data:
				default:
					_ = peer.conn.Close()
				}
			}
		}
	}
}

func (h *hub) notifyPresence(r *room) {
	for role, c := range r.clients {
		peerRole := "browser"
		if role == "browser" {
			peerRole = "plugin"
		}
		online := r.clients[peerRole] != nil
		data, _ := json.Marshal(envelope{Type: "presence", Version: protocolVersion, PeerOnline: &online})
		select {
		case c.send <- data:
		default:
		}
	}
}

func main() {
	var addr string
	flag.StringVar(&addr, "addr", envOr("ADDR", "127.0.0.1:8787"), "listen address")
	flag.Parse()

	cfg := config{
		addr:           addr,
		allowedOrigins: parseOrigins(envOr("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")),
		requireTLS:     strings.EqualFold(os.Getenv("REQUIRE_TLS"), "true"),
	}
	h := newHub()
	go h.run()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /{$}", wsHandler(cfg, h))

	server := &http.Server{
		Addr:              cfg.addr,
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	slog.Info("remote chat relay listening", "addr", cfg.addr)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func wsHandler(cfg config, h *hub) http.HandlerFunc {
	upgrader := websocket.Upgrader{
		HandshakeTimeout: 5 * time.Second,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" { // Native plugin clients do not send Origin.
				return true
			}
			_, ok := cfg.allowedOrigins[origin]
			return ok
		},
	}

	return func(w http.ResponseWriter, r *http.Request) {
		if cfg.requireTLS && r.TLS == nil && r.Header.Get("X-Forwarded-Proto") != "https" {
			http.Error(w, "TLS required", http.StatusUpgradeRequired)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(maxFrameBytes)
		_ = conn.SetReadDeadline(time.Now().Add(8 * time.Second))

		var hello envelope
		if err := conn.ReadJSON(&hello); err != nil || !validHello(hello) {
			writeClose(conn, websocket.ClosePolicyViolation, "invalid hello")
			return
		}

		c := &client{conn: conn, send: make(chan []byte, 16), roomID: hello.RoomID, role: hello.Role}
		result := make(chan error, 1)
		h.register <- &registration{client: c, verifier: hello.Verifier, result: result}
		if err := <-result; err != nil {
			writeClose(conn, websocket.ClosePolicyViolation, err.Error())
			return
		}

		_ = conn.SetReadDeadline(time.Time{})
		go c.writePump(h)
		c.readPump(h)
	}
}

func (c *client) readPump(h *hub) {
	defer func() {
		h.unregister <- c
		_ = c.conn.Close()
	}()
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(70 * time.Second))
	})
	_ = c.conn.SetReadDeadline(time.Now().Add(70 * time.Second))

	for {
		messageType, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		if messageType != websocket.TextMessage || len(data) > maxFrameBytes || !c.allowMessage() {
			writeClose(c.conn, websocket.ClosePolicyViolation, "invalid or excessive traffic")
			return
		}
		var msg envelope
		if json.Unmarshal(data, &msg) != nil || !validRelay(msg, c.roomID) {
			writeClose(c.conn, websocket.ClosePolicyViolation, "invalid relay")
			return
		}
		h.relay <- &relayRequest{client: c, data: data}
	}
}

func (c *client) writePump(h *hub) {
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case data, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *client) allowMessage() bool {
	now := time.Now()
	cutoff := now.Add(-10 * time.Second)
	kept := c.rate[:0]
	for _, t := range c.rate {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	c.rate = kept
	if len(c.rate) >= 20 {
		return false
	}
	c.rate = append(c.rate, now)
	return true
}

func validHello(m envelope) bool {
	return m.Type == "hello" && m.Version == protocolVersion &&
		(m.Role == "plugin" || m.Role == "browser") &&
		validBase64URL(m.RoomID, 22, 32) && validBase64URL(m.Verifier, 43, 64)
}

func validRelay(m envelope, roomID string) bool {
	return m.Type == "relay" && m.Version == protocolVersion && m.RoomID == roomID &&
		validBase64URL(m.MessageID, 16, 32) && validBase64URL(m.Nonce, 16, 24) &&
		validBase64URL(m.Ciphertext, 24, maxCiphertext)
}

func validBase64URL(value string, min, max int) bool {
	if len(value) < min || len(value) > max {
		return false
	}
	for _, r := range value {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func writeClose(conn *websocket.Conn, code int, reason string) {
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
	_ = conn.Close()
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func parseOrigins(value string) map[string]struct{} {
	result := make(map[string]struct{})
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result[item] = struct{}{}
		}
	}
	return result
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func (m envelope) String() string {
	return fmt.Sprintf("%s/v%d", m.Type, m.Version)
}
