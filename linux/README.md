# Linux systemd extra (advanced, optional, Podman)

A Podman systemd lifecycle for the backend, as an alternative to the container engine's built-in
`--restart` policy. `redlib-mcp setup` already builds and runs the backend; this only swaps the
process supervisor.

**Important — image store must match.** This is a *Podman* Quadlet and reads *Podman's* image store.
But `redlib-mcp setup` prefers **docker** when both are installed (Plan 2 `detectEngine`), and a
Docker-built `localhost/redlib:latest` lives in Docker's store, which Podman cannot see. So:

- **Podman users:** force setup to use Podman so the image lands where the Quadlet looks —
  `REDLIB_ENGINE=/usr/bin/podman redlib-mcp setup` (an absolute path; bare names are rejected). Then
  install the Quadlet below.
- **Docker users:** you do **not** need this. Setup already applies `--restart unless-stopped`, and
  the Docker service restarts the container on boot — the same lifecycle systemd would give you.

## Use (Podman)

1. Run setup under Podman: `REDLIB_ENGINE=/usr/bin/podman redlib-mcp setup` (builds
   `localhost/redlib:latest` in Podman's store from the pinned reviewed commit).
2. Install the Quadlet:

   ```bash
   mkdir -p ~/.config/containers/systemd
   cp redlib.container ~/.config/containers/systemd/
   systemctl --user daemon-reload
   systemctl --user start redlib-mcp
   ```

## Updates — pinned, not HEAD

This unit never rebuilds or tracks upstream `main`. To move to a newer, reviewed Redlib pin, run
`redlib-mcp update` (rebuilds at the pinned commit and promotes only if verified), then restart the
unit. This is deliberate: unattended rebuild-from-HEAD is an RCE surface and can grab a broken build.
