// Command tsnet-sidecar puts FatFish on a Tailscale network without installing
// the Tailscale daemon.
//
// It embeds an official Tailscale node (tailscale.com/tsnet) inside this process,
// listens on the tailnet, and forwards every accepted connection to the local
// FatFish server. Nothing is exposed to the LAN or the internet: the only way in
// is the tailnet, which is already encrypted and access-controlled by the
// tailnet's ACLs.
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
	State    string   `json:"state"`                   // starting | login_required | running | stopped | error
	Backend  string   `json:"backend_state,omitempty"` // raw ipn state, for diagnostics
	Hostname string   `json:"hostname,omitempty"`
	Port     int      `json:"port"`
	Target   string   `json:"target"`
	LoginURL string   `json:"login_url,omitempty"`
	Addrs    []string `json:"addresses,omitempty"`
	URL      string   `json:"url,omitempty"`
	Error    string   `json:"error,omitempty"`
	Conns    int64    `json:"connections"`
	Since    string   `json:"since,omitempty"`
	PID      int      `json:"pid"`
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
	// An empty path means "do not persist": the unit tests exercise the proxy
	// without touching the filesystem, which also keeps their cleanup from failing
	// on a machine where the temp directory is not writable.
	if r.path == "" {
		return
	}
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

// listener is set once the node is up, so shutdown can close it from main.
var listener atomic.Pointer[net.Listener]

// teeWriter sends log lines to a file, and to stderr only when stderr is a real
// console.
//
// The distinction is not cosmetic. The shell spawns this process with stderr
// redirected to a pipe nobody drains, so writing there blocks once the pipe buffer
// fills -- and because tsnet logs from inside its own locks, one blocked write
// froze the entire backend: the node stayed at "starting", with no login URL and
// no error, on a network that was working the whole time. Writing to the file the
// shell polls avoids that; an interactive run still gets console output.
type teeWriter struct {
	files   []string
	console bool
	mu      sync.Mutex
}

func newTeeWriter(file string) *teeWriter {
	console := false
	if info, err := os.Stderr.Stat(); err == nil {
		console = info.Mode()&os.ModeCharDevice != 0
	}
	return &teeWriter{files: []string{file}, console: console}
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
	if t.console {
		t.mu.Lock()
		_, err := os.Stderr.Write(p)
		t.mu.Unlock()
		if err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

func main() {
	var (
		state     = flag.String("state", "", "directory for the node's state (required)")
		hostname  = flag.String("hostname", "fatfish", "name this node gets on the tailnet")
		authKey   = flag.String("authkey", "", "Tailscale auth key; empty means interactive login")
		port      = flag.Int("port", 80, "port to listen on inside the tailnet")
		target    = flag.String("target", "127.0.0.1:5100", "local FatFish server to forward to")
		statusFn  = flag.String("status", "", "path of the status JSON to keep up to date")
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

	log.SetOutput(newTeeWriter(filepath.Join(*state, "tsnet.log")))
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[tsnet] ")

	srv := &tsnet.Server{
		Dir:       *state,
		Hostname:  *hostname,
		AuthKey:   *authKey,
		Ephemeral: *ephemeral,
		Logf:      log.Printf,
		UserLogf:  log.Printf,
	}
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Up blocks until the node is authenticated and connected. It is not the way to
	// learn *why* we are not connected -- that is the status poll below.
	go func() {
		if _, err := srv.Up(ctx); err != nil {
			log.Printf("up: %v", err)
		}
	}()

	// The login URL is NOT in the logs: tsnet keeps it in the client status as
	// AuthURL. The first version of this file scraped the log for it and therefore
	// never found it -- the node sat at "starting" forever while the network was
	// perfectly fine. Polling the client also gives the backend state and, once
	// authenticated, the assigned tailnet addresses.
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}

			lc, err := srv.LocalClient()
			if err != nil {
				continue
			}
			st, err := lc.Status(ctx)
			if err != nil || st == nil {
				continue
			}

			var addrs []string
			for _, ip := range st.TailscaleIPs {
				addrs = append(addrs, ip.String())
			}
			host := strings.TrimSuffix(st.Self.DNSName, ".")
			backend := st.BackendState
			authURL := st.AuthURL

			rep.set(func(s *status) {
				s.Backend = backend
				if host != "" {
					s.Hostname = host
				}
				if authURL != "" {
					s.LoginURL = authURL
				}
				if len(addrs) > 0 {
					s.Addrs = addrs
					s.State = "running"
					s.URL = fmt.Sprintf("http://%s:%d/", addrs[0], s.Port)
					s.LoginURL = ""
					s.Error = ""
					return
				}
				switch backend {
				case "NeedsLogin":
					s.State = "login_required"
				case "NeedsMachineAuth":
					s.State = "login_required"
					s.Error = "节点已登录，等待管理员在 Tailscale 后台批准"
				case "Starting":
					if s.State != "login_required" {
						s.State = "starting"
					}
				case "Stopped":
					if s.State != "running" {
						s.State = "stopped"
					}
				}
			})
		}
	}()

	// Listening is only meaningful once the node is authenticated, and calling
	// Listen while unauthenticated blocks the very goroutine that drives the login
	// flow -- which is exactly how the first version of this file sat at
	// "starting" for ever on a perfectly working network. So: bring the node up
	// first, and only then start accepting.
	go func() {
		if _, err := srv.Up(ctx); err != nil {
			log.Printf("up: %v", err)
			rep.set(func(s *status) {
				if s.State != "running" {
					s.Error = err.Error()
				}
			})
			return
		}
		ln, err := srv.Listen("tcp", fmt.Sprintf(":%d", *port))
		if err != nil {
			rep.set(func(s *status) {
				s.State = "error"
				s.Error = "listen: " + err.Error()
			})
			log.Printf("listen: %v", err)
			return
		}
		log.Printf("listening on tailnet port %d, forwarding to %s", *port, *target)
		listener.Store(&ln)

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
	if ln := listener.Load(); ln != nil {
		_ = (*ln).Close()
	}
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
