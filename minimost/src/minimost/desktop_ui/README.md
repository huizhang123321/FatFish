# Build output

This directory holds the prebuilt desktop interface bundle that
`minimost/desktop.py` serves from `GET /app/`.

It is generated, not hand-edited:

```bash
cd desktop
npm install
npm run build
```

Vite is configured to emit into this directory, and both `setup.cfg`
(`[options.package_data]`) and `packaging/minimost-server.spec` pick the whole
tree up so it ships in the wheel and in the frozen server executable.

Files here are exempt from review in `../.gitignore` terms only by being
rebuilt; keep this README so the directory exists in a fresh clone and the
server can report `ui_bundled: false` instead of failing on a missing path.
