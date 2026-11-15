package main

import (
	"bytes"
	"io"
	"net"
	"testing"
	"time"
)

// echoServer starts a TCP server that echoes everything back.
func echoServer(t *testing.T) (string, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}(conn)
		}
	}()
	return ln.Addr().String(), func() { _ = ln.Close() }
}

// The proxy is the only part of this program that touches both a tailnet
// connection and the local server, so it is the part worth testing without a
// Tailscale account: everything else is the official library.
func TestProxyForwardsBothDirections(t *testing.T) {
	target, stop := echoServer(t)
	defer stop()

	// Stand in for the tailnet side: a listener whose accepted connection is
	// handed to proxy(), and a client to write through it.
	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("front listen: %v", err)
	}
	defer front.Close()

	rep := &reporter{path: t.TempDir() + "/status.json"}
	rep.st = status{State: "running", Target: target}

	go func() {
		conn, err := front.Accept()
		if err != nil {
			return
		}
		proxy(conn, target, rep)
	}()

	client, err := net.Dial("tcp", front.Addr().String())
	if err != nil {
		t.Fatalf("dial front: %v", err)
	}
	defer client.Close()

	want := []byte("你好, FatFish over tailnet")
	if _, err := client.Write(want); err != nil {
		t.Fatalf("write: %v", err)
	}

	_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
	got := make([]byte, len(want))
	if _, err := io.ReadFull(client, got); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("echo mismatch: got %q want %q", got, want)
	}
}

func TestProxySurvivesADeadTarget(t *testing.T) {
	// A port nothing listens on: proxy must close the client connection rather
	// than hanging or panicking.
	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("front listen: %v", err)
	}
	defer front.Close()

	rep := &reporter{path: t.TempDir() + "/status.json"}
	rep.st = status{State: "running"}
	go func() {
		conn, err := front.Accept()
		if err != nil {
			return
		}
		proxy(conn, "127.0.0.1:1", rep)
	}()

	client, err := net.Dial("tcp", front.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 1)
	if _, err := client.Read(buf); err == nil {
		t.Fatal("expected the connection to be closed for a dead target")
	}
}
