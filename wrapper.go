// wrapper.go — lva-installer launcher
// Finds node and main.cjs relative to this executable's location and exec's them.
// Compiles to a native binary on all platforms with zero dependencies.
//
// Build all platforms from Linux (requires Go installed):
//   GOOS=linux   GOARCH=amd64 go build -ldflags="-s -w" -o lva-installer         wrapper.go
//   GOOS=linux   GOARCH=arm64 go build -ldflags="-s -w" -o lva-installer-arm64   wrapper.go
//   GOOS=darwin  GOARCH=amd64 go build -ldflags="-s -w" -o lva-installer-macos   wrapper.go
//   GOOS=darwin  GOARCH=arm64 go build -ldflags="-s -w" -o lva-installer-macos-arm64 wrapper.go
//   GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o lva-installer.exe     wrapper.go

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func main() {
	// Resolve the directory containing this executable
	exePath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "lva-installer: failed to resolve executable path: %v\n", err)
		os.Exit(1)
	}
	// Follow symlinks so we get the real directory
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "lva-installer: failed to resolve symlinks: %v\n", err)
		os.Exit(1)
	}
	dir := filepath.Dir(exePath)

	// Node binary and bundled script sit next to this executable
	nodeBin := filepath.Join(dir, "node")
	if runtime.GOOS == "windows" {
		nodeBin = filepath.Join(dir, "node.exe")
	}
	script := filepath.Join(dir, "main.cjs")

	// Verify both exist before attempting to exec
	for _, f := range []string{nodeBin, script} {
		if _, err := os.Stat(f); os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "lva-installer: missing file: %s\n", f)
			fmt.Fprintf(os.Stderr, "  The archive may be incomplete. Re-download lva-installer.\n")
			os.Exit(1)
		}
	}

	// Build argv: node main.cjs [user args...]
	args := append([]string{script}, os.Args[1:]...)
	cmd := exec.Command(nodeBin, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "lva-installer: %v\n", err)
		os.Exit(1)
	}
}
