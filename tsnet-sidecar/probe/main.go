// Command probe is a throw-away diagnostic: bring a tsnet node up with no auth
// key and print exactly what the library reports, without the sidecar's own logic
// in the way.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"tailscale.com/tsnet"
)

func main() {
	dir, err := os.MkdirTemp("", "tsnet-probe-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)
	fmt.Println("state dir:", dir)

	srv := &tsnet.Server{
		Dir:      dir,
		Hostname: "probe-node",
		Logf:     log.Printf,
		UserLogf: func(format string, args ...any) { fmt.Printf("[USER] "+format+"\n", args...) },
	}
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()

	go func() {
		// Independent polling: does LocalClient work before login?
		time.Sleep(3 * time.Second)
		lc, err := srv.LocalClient()
		fmt.Println("LocalClient err:", err)
		if err != nil {
			return
		}
		st, err := lc.Status(ctx)
		if err != nil {
			fmt.Println("Status err:", err)
			return
		}
		fmt.Printf("backend=%s authurl=%q ips=%v\n", st.BackendState, st.AuthURL, st.TailscaleIPs)
	}()

	start := time.Now()
	st, err := srv.Up(ctx)
	fmt.Printf("Up returned after %v: err=%v\n", time.Since(start).Round(time.Second), err)
	if st != nil {
		fmt.Printf("status: backend=%s authurl=%q ips=%v\n", st.BackendState, st.AuthURL, st.TailscaleIPs)
	}
}
