// Command tsnet-sidecar puts FatFish on a Tailscale network without installing
// the Tailscale daemon.
//
// It embeds an official Tailscale node (tailscale.com/tsnet) inside this process,
// listens on the tailnet, and forwards every accepted connection to the local
// FatFish server. Nothing is exposed to the LAN or the internet: the only way in
// is the tailnet, which is already end-to-end encrypted and access-controlled by
// the tailnet's ACLs.
//
// Why a separate process instead of inside the Python app: tsnet is a Go library,
// and FatFish's server is Python. A sidecar keeps the Python side untouched -- it
// still binds 127.0.0.1 only -- while the Go process owns the Tailscale identity.
//
// The shell owns this process: it passes a state directory, a target port and a
// status file, then reads that file to show the user a login URL or the node's
// address. Running it by hand works too; see the flags below.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

// status is what the shell reads to render the "远程访问" section. It is written
// atomically (temp file + rename) so a reader never sees half a JSON document.
type status struct {
	State     string   `json:"state"` // starting | login_required | running | stopped | error
	Hostname  string   `json:"hostname,omitempty"`
	Port      int      `json:"port"`
	Target    string   `json:"target"`
	LoginURL  string   `json:"login_url,omitempty"`
	Addresses []string `json:"addresses,omitempty"`
	URL       string   `json:"url,omitempty"`
	Error     string   `json:"error,omitempty"`
	Conns     int64    `json:"connections"`
	Since     string   `json:"since,omitempty"`
	PID       int      `json:"pid"`
}

type reporter struct {
	path string
	mu   sync.Mutex
	st   status
}

func (r *reporter) set(fn func(*status)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	fn(&r.st)
	r.writeLocked()
}

func (r *reporter) writeLocked() {
	r.st.Conns = atomic.LoadInt64(&connCount)
	data, err := json.MarshalIndent(r.st, "", "  ")
	if err != nil {
		return
	}
	tmp := r.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		log.Printf("write status: %v", err)
		return
	}
	if err := os.Rename(tmp, r.path); err != nil {
		log.Printf("rename status: %v", err)
	}
}

var connCount int64

// loginWatcher captures the interactive login URL that tsnet prints when no auth
// key is configured. Without this the user would never see it: the shell starts
// this process without a console, so the URL is only reachable through the log
// file and the status document.
type loginWatcher struct {
	mu  sync.Mutex
	url string
}

func (w *loginWatcher) Logf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Print(msg)
	if strings.Contains(msg, "https://login.tailscale.com") {
		if i := strings.Index(msg, "https://"); i >= 0 {
			url := strings.TrimSpace(msg[i:])
			if j := strings.IndexAny(url, " \t"); j >= 0 {
				url = url[:j]
			}
			w.mu.Lock()
			w.url = url
			w.mu.Unlock()
		}
	}
}

func (w *loginWatcher) URL() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.url
}

func main() {
	var (
		state    = flag.String("state", "", "directory for the node's state (required)")
		hostname = flag.String("hostname", "fatfish", "name this node gets on the tailnet")
		authKey  = flag.String("authkey", "", "Tailscale auth key; empty means interactive login")
		port     = flag.Int("port", 80, "port to listen on inside the tailnet")
		target   = flag.String("target", "127.0.0.1:5100", "local FatFish server to forward to")
		statusFn = flag.String("status", "", "path of the status JSON to keep up to date")
		ephemeral = flag.Bool("ephemeral", false, "remove the node when it goes offline")
	)
	flag.Parse()

	if *state == "" {
		fmt.Fprintln(os.Stderr, "tsnet-sidecar: --state is required")
		os.Exit(2)
	}
	if err := os.MkdirAll(*state, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "tsnet-sidecar: state dir: %v\n", err)
		os.Exit(2)
	}

	statusPath := *statusFn
	if statusPath == "" {
		statusPath = filepath.Join(*state, "tsnet-status.json")
	}

	rep := &reporter{path: statusPath}
	rep.st = status{
		State:    "starting",
		Hostname: *hostname,
		Port:     *port,
		Target:   *target,
		PID:      os.Getpid(),
		Since:    time.Now().Format(time.RFC3339),
	}
	rep.set(func(*status) {})

	watch := &loginWatcher{}
	log.SetOutput(&teeWriter{files: []string{filepath.Join(*state, "tsnet.log")}})
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[tsnet] ")

	srv := &tsnet.Server{
		Dir:       *state,
		Hostname:  *hostname,
		AuthKey:   *authKey,
		Ephemeral: *ephemeral,
		Logf:      watch.Logf,
	}
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Up blocks until the node is authenticated and connected. With no auth key
	// it returns an error and the login URL arrives through Logf, which is why the
	// URL is also written to the status file below.
	upErr := make(chan error, 1)
	go func() {
		_, err := srv.Up(ctx)
		upErr <- err
	}()

	go func() {
		// Publish the login URL as soon as it appears, without waiting for Up to
		// return: the user needs the link while the node is still unauthenticated.
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if url := watch.URL(); url != "" {
					rep.set(func(s *status) {
						if s.LoginURL != url {
							s.LoginURL = url
							if s.State == "starting" {
								s.State = "login_required"
							}
						}
					})
				}
			}
		}
	}()

	select {
	case err := <-upErr:
		if err != nil {
			url := watch.URL()
			msg := err.Error()
			rep.set(func(s *status) {
				s.Error = msg
				s.LoginURL = url
				if url != "" {
					s.State = "login_required"
				} else {
					s.State = "error"
				}
			})
			if url == "" {
				log.Printf("up failed: %v", err)
				os.Exit(1)
			}
			// Unauthenticated but a login URL exists: keep the process alive so the
			// user can approve the node, then continue once it comes up.
			log.Printf("waiting for login: %s", url)
		}
	case <-time.After(2 * time.Minute):
		rep.set(func(s *status) { s.Error = "timed out bringing the node up" })
		log.Printf("timeout waiting for tsnet")
	}

	// If the first Up failed for want of a login, retry once the user approves.
	go func() {
		for i := 0; i < 120; i++ {
			time.Sleep(5 * time.Second)
			if _, err := srv.Up(ctx); err == nil {
				return
			}
		}
	}()

	// Give the node a moment to report its addresses; tsnet exposes them through
	// LocalClient only after Up succeeds.
	go func() {
		for i := 0; i < 60; i++ {
			lc, err := srv.LocalClient()
			if err == nil {
				if st, err := lc.Status(ctx); err == nil {
					var addrs []string
					for _, ip := range st.TailscaleIPs {
						addrs = append(addrs, ip.String())
					}
					host := strings.TrimSuffix(st.Self.DNSName, ".")
					rep.set(func(s *status) {
						s.Addresses = addrs
						if host != "" {
							s.Hostname = host
						}
						if len(addrs) > 0 {
							s.State = "running"
							s.URL = fmt.Sprintf("http://%s:%d/", addrs[0], s.Port)
							s.LoginURL = ""
						}
					})
					if len(addrs) > 0 {
						return
					}
				}
			}
			time.Sleep(2 * time.Second)
		}
	}()

	ln, err := srv.Listen("tcp", fmt.Sprintf(":%d", *port))
	if err != nil {
		rep.set(func(s *status) {
			s.State = "error"
			s.Error = "listen: " + err.Error()
		})
		log.Printf("listen: %v", err)
		os.Exit(1)
	}
	log.Printf("listening on tailnet port %d, forwarding to %s", *port, *target)

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				select {
				case <-ctx.Done():
					return
				default:
				}
				if errors.Is(err, net.ErrClosed) {
					return
				}
				log.Printf("accept: %v", err)
				time.Sleep(200 * time.Millisecond)
				continue
			}
			go proxy(conn, *target, rep)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	log.Printf("shutting down")
	rep.set(func(s *status) { s.State = "stopped" })
	_ = ln.Close()
}

// proxy pipes one tailnet connection to the local server and back.
//
// Half-closes are propagated rather than tearing both directions down on the
// first EOF: an SSE stream closes from the client side while the server may still
// be flushing a final frame, and cutting that off loses messages.
func proxy(client net.Conn, target string, rep *reporter) {
	defer client.Close()
	atomic.AddInt64(&connCount, 1)
	rep.set(func(*status) {})
	defer rep.set(func(*status) {})

	server, err := net.DialTimeout("tcp", target, 5*time.Second)
	if err != nil {
		log.Printf("dial %s: %v", target, err)
		return
	}
	defer server.Close()

	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(server, client)
		if tcp, ok := server.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(client, server)
		if tcp, ok := client.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		done <- struct{}{}
	}()
	<-done
	<-done

	atomic.AddInt64(&connCount, -1)
	rep.set(func(*status) {})
}

// teeWriter sends log lines to stderr and to a file, so the shell can show them
// after the fact even though it never sees this process's console.
type teeWriter struct {
	files []string
}

func (t *teeWriter) Write(p []byte) (int, error) {
	for _, name := range t.files {
		f, err := os.OpenFile(name, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			continue
		}
		_, _ = f.Write(p)
		_ = f.Close()
	}
	return os.Stderr.Write(p)
}
