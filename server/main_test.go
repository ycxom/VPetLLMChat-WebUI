package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestValidHello(t *testing.T) {
	valid := envelope{Type: "hello", Version: 1, Role: "plugin", RoomID: "abcdefghijklmnopqrstuv", Verifier: "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"}
	if !validHello(valid) {
		t.Fatal("expected hello to be valid")
	}
	valid.Role = "admin"
	if validHello(valid) {
		t.Fatal("unexpected role accepted")
	}
}

func TestRelayBoundToRoom(t *testing.T) {
	m := envelope{Type: "relay", Version: 1, RoomID: "abcdefghijklmnopqrstuv", MessageID: "abcdefghijklmnop", Nonce: "abcdefghijklmnop", Ciphertext: "abcdefghijklmnopqrstuvwxyz"}
	if !validRelay(m, m.RoomID) {
		t.Fatal("expected relay to be valid")
	}
	if validRelay(m, "other-room") {
		t.Fatal("cross-room relay accepted")
	}
}

func TestHubAuthenticatesAndRelaysOpaqueFrame(t *testing.T) {
	h := newHub()
	go h.run()
	plugin := &client{roomID: "room", role: "plugin", send: make(chan []byte, 8)}
	browser := &client{roomID: "room", role: "browser", send: make(chan []byte, 8)}
	registerForTest(t, h, plugin, "verifier")
	registerForTest(t, h, browser, "verifier")
	drain(plugin.send)
	drain(browser.send)

	frame := []byte(`{"type":"relay","ciphertext":"opaque"}`)
	h.relay <- &relayRequest{client: browser, data: frame}
	select {
	case got := <-plugin.send:
		if !bytes.Equal(got, frame) {
			t.Fatalf("relay changed opaque frame: %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("relay timed out")
	}

	intruder := &client{roomID: "room", role: "plugin", send: make(chan []byte, 1)}
	result := make(chan error, 1)
	h.register <- &registration{client: intruder, verifier: "different", result: result}
	if err := <-result; err == nil {
		t.Fatal("mismatched verifier was accepted")
	}
}

func TestWebSocketIsServedAtRootOnly(t *testing.T) {
	h := newHub()
	go h.run()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", wsHandler(config{allowedOrigins: map[string]struct{}{}}, h))
	server := httptest.NewServer(mux)
	defer server.Close()

	rootURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/"
	conn, _, err := websocket.DefaultDialer.Dial(rootURL, nil)
	if err != nil {
		t.Fatalf("root websocket endpoint failed: %v", err)
	}
	defer conn.Close()
	if err := conn.WriteJSON(envelope{
		Type: "hello", Version: 1, Role: "plugin",
		RoomID: "abcdefghijklmnopqrstuv", Verifier: "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
	}); err != nil {
		t.Fatalf("hello failed: %v", err)
	}
	var presence envelope
	if err := conn.ReadJSON(&presence); err != nil || presence.Type != "presence" {
		t.Fatalf("presence failed: %#v, %v", presence, err)
	}

	legacyURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
	legacy, response, err := websocket.DefaultDialer.Dial(legacyURL, nil)
	if legacy != nil {
		_ = legacy.Close()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusNotFound {
		t.Fatalf("legacy /ws endpoint should be absent, response=%v err=%v", response, err)
	}
}

func registerForTest(t *testing.T, h *hub, c *client, verifier string) {
	t.Helper()
	result := make(chan error, 1)
	h.register <- &registration{client: c, verifier: verifier, result: result}
	if err := <-result; err != nil {
		t.Fatalf("registration failed: %v", err)
	}
}

func drain(ch chan []byte) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}
