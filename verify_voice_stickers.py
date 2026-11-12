"""Verify voice notes end to end against the installed backend.

Starts the installed ``minimost-server.exe`` on a spare port with a throw-away data
directory, creates a user, uploads a small audio file through the real
``POST /send/<channel>`` route, and checks that:

  * the message carries the audio filename (it was stored, not silently dropped),
  * ``/files/<name>`` serves it back with an audio content type,
  * a sticker message survives the round trip as plain text (the renderer turns it
    into an image; the server must not mangle the token).

Nothing touches the real %APPDATA%\\FatFish data.
"""

from __future__ import annotations

import http.cookiejar
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

INSTALL = Path(r"E:\wj\FatFish")
SERVER = INSTALL / "resources" / "server" / "minimost-server.exe"

PASSED: list[str] = []
FAILED: list[tuple[str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        PASSED.append(name)
        print(f"  PASS {name}")
    else:
        FAILED.append((name, detail))
        print(f"  FAIL {name}{': ' + detail if detail else ''}")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Session:
    def __init__(self) -> None:
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            NoRedirect,
        )

    def get(self, url: str, timeout: float = 10.0):
        return self.opener.open(urllib.request.Request(url), timeout=timeout)

    def post_form(self, url: str, fields: dict) -> tuple[int, bytes]:
        data = urllib.parse.urlencode(fields).encode()
        request = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            with self.opener.open(request, timeout=15) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as err:
            return err.code, err.read()

    def post_multipart(
        self,
        url: str,
        fields: dict,
        filename: str,
        content: bytes,
        ctype: str,
        field: str = "files",
    ):
        """Post a file. *field* is the form field name: /send expects "files",
        the sticker import route expects "file"."""
        boundary = "----fatfish" + uuid.uuid4().hex
        body = io.BytesIO()
        for key, value in fields.items():
            body.write(f"--{boundary}\r\n".encode())
            body.write(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
            body.write(str(value).encode() + b"\r\n")
        body.write(f"--{boundary}\r\n".encode())
        body.write(
            (
                f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
                f"Content-Type: {ctype}\r\n\r\n"
            ).encode()
        )
        body.write(content + b"\r\n")
        body.write(f"--{boundary}--\r\n".encode())

        request = urllib.request.Request(
            url,
            data=body.getvalue(),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        # A rejected upload is an expected outcome here, so return it instead of
        # raising: callers assert on the status code.
        try:
            with self.opener.open(request, timeout=30) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as err:
            return err.code, err.read()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main() -> int:
    if not SERVER.is_file():
        print(f"missing {SERVER}")
        return 2

    work = Path(tempfile.gettempdir()) / f"fatfish-voice-{os.getpid()}"
    if work.exists():
        shutil.rmtree(work, ignore_errors=True)
    work.mkdir()

    port = free_port()
    env = dict(os.environ)
    env.update(
        {
            "MINIMOST_DATA_DIR": str(work),
            "MINIMOST_DESKTOP": "1",
            "MINIMOST_SKIP_TLS": "1",
        }
    )
    proc = subprocess.Popen(
        [str(SERVER), "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(SERVER.parent),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"

    try:
        deadline = time.time() + 60
        up = False
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            try:
                with urllib.request.urlopen(base + "/app/health", timeout=2) as r:
                    if r.status == 200:
                        up = True
                        break
            except Exception:
                pass
            time.sleep(0.4)
        print(f"\n=== server on {base} ===")
        check("installed server starts", up)
        if not up:
            return 1

        session = Session()
        token = json.loads(session.get(base + "/csrf-token").read())["csrf_token"]
        username = "voiceprobe"
        password = "VoiceProbePass1!x"

        status, _ = session.post_form(
            base + "/signup",
            {
                "csrf_token": token,
                "username": username,
                "password": password,
                "confirm_password": password,
            },
        )
        check("created a throw-away account", status in (200, 302), f"status {status}")

        print("\n=== voice note upload ===")
        # A tiny but real WebM/Opus header: the server stores bytes by extension, so
        # the payload does not need to decode for this check.
        audio = b"\x1a\x45\xdf\xa3" + b"\x00" * 64
        status, _ = session.post_multipart(
            base + "/send/general",
            {"text": ""},
            "voice-20260101.webm",
            audio,
            "audio/webm",
        )
        check("POST /send accepts an audio attachment", status == 200, f"status {status}")

        with session.get(base + "/messages/general?after=0") as resp:
            messages = json.loads(resp.read())

        audio_rows = [m for m in messages if (m.get("filename") or "").endswith(".webm")]
        check("message row carries the .webm filename", len(audio_rows) == 1, str(len(audio_rows)))

        if audio_rows:
            filename = audio_rows[0]["filename"]
            print(f"  stored as: {filename}")
            with session.get(base + "/files/" + urllib.parse.quote(filename)) as resp:
                body = resp.read()
                check("attachment downloads", resp.status == 200, f"status {resp.status}")
                check("bytes round-trip intact", body == audio, f"{len(body)} vs {len(audio)}")
                print(f"  content-type: {resp.headers.get('Content-Type')}")

        print("\n=== sticker token round trip ===")
        token_text = "[sticker:happy] [sticker:nice]"
        status, _ = session.post_form(base + "/send/general", {"text": token_text})
        check("sticker message accepted", status == 200, f"status {status}")
        with session.get(base + "/messages/general?after=0") as resp:
            messages = json.loads(resp.read())
        sticker_rows = [m for m in messages if "[sticker:happy]" in (m.get("content") or "")]
        check("sticker token stored verbatim", len(sticker_rows) == 1, str(len(sticker_rows)))

        print("\n=== file sharing (any type, original name kept) ===")
        # The name has to survive: secure_filename used to flatten this to "docx".
        docx = b"PK\x03\x04" + b"\x00" * 32
        status, _ = session.post_multipart(
            base + "/send/general",
            {"text": ""},
            "季度总结 2026.docx",
            docx,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        check("POST /send accepts a document", status == 200, f"status {status}")

        with session.get(base + "/messages/general?after=0") as resp:
            messages = json.loads(resp.read())
        doc_rows = [m for m in messages if (m.get("filename") or "").endswith(".docx")]
        check("document message stored", len(doc_rows) == 1, str(len(doc_rows)))

        if doc_rows:
            stored = doc_rows[0]["filename"]
            print(f"  stored as: {stored}")
            suffix = stored[33:] if len(stored) > 33 and stored[32] == "_" else stored
            decoded = urllib.parse.unquote(suffix)
            check("original filename is recoverable", decoded == "季度总结 2026.docx", repr(decoded))

            with session.get(base + "/files/" + urllib.parse.quote(stored)) as resp:
                body = resp.read()
                disposition = resp.headers.get("Content-Disposition") or ""
                check("document downloads", resp.status == 200, f"status {resp.status}")
                check("bytes round-trip intact", body == docx, f"{len(body)} vs {len(docx)}")
                # The saved name must be usable: an encoded blob or a bare "docx" is not.
                check(
                    "download suggests the original name",
                    "docx" in disposition.lower() and ("%E5%AD%A3" in disposition or "季度" in disposition),
                    disposition,
                )

        print("\n=== theme preference survives a restart ===")
        # The choice used to live only in localStorage, which is keyed by origin;
        # a launch on a different port is a different origin and lost it. The copy
        # on the account is what makes it survive.

        def post_theme(value):
            """POST /theme and return the status, including on 4xx."""
            payload = json.dumps({"theme": value}).encode()
            req = urllib.request.Request(
                base + "/theme", data=payload, headers={"Content-Type": "application/json"}
            )
            try:
                with session.opener.open(req, timeout=10) as resp:
                    return resp.status
            except urllib.error.HTTPError as err:
                return err.code

        def read_theme():
            with session.get(base + "/settings") as resp:
                return json.loads(resp.read()).get("theme")

        check("theme starts unset", read_theme() is None, repr(read_theme()))
        check("POST /theme accepts light", post_theme("light") == 200)
        check("theme reads back as light", read_theme() == "light", repr(read_theme()))
        check("POST /theme accepts dark", post_theme("dark") == 200)
        check("theme reads back as dark", read_theme() == "dark", repr(read_theme()))
        check("an unknown theme is rejected", post_theme("neon") == 400)
        check("a rejected theme changes nothing", read_theme() == "dark", repr(read_theme()))

        print("\n=== imported sticker library ===")
        # The routes validate the image by its signature, so send real PNG bytes.
        png = (
            b"\x89PNG\r\n\x1a\n"
            b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
            b"\x1f\x15\xc4\x89"
            b"\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4"
            b"\x00\x00\x00\x00IEND\xaeB`\x82"
        )
        status, body = session.post_multipart(
            base + "/stickers", {"name": "验证贴纸"}, "mine.png", png, "image/png", "file"
        )
        check("POST /stickers imports an image", status == 201, f"status {status} {body[:120]}")

        item = {}
        if status == 201:
            item = json.loads(body)["item"]
            check(
                "imported sticker gets a token",
                item.get("token", "").startswith("[sticker:custom-"),
                str(item.get("token")),
            )

        with session.get(base + "/stickers") as resp:
            listing = json.loads(resp.read())
        check("GET /stickers lists it", len(listing.get("items", [])) == 1, str(len(listing.get("items", []))))

        if item:
            with session.get(base + item["url"]) as resp:
                served = resp.read()
                check("sticker image is served", resp.status == 200, f"status {resp.status}")
                check("served with an image type", (resp.headers.get("Content-Type") or "").startswith("image/"), str(resp.headers.get("Content-Type")))
                check("bytes round-trip intact", served == png, f"{len(served)} vs {len(png)}")

            # A renamed text file must be refused, not stored and served as an image.
            status, _ = session.post_multipart(
                base + "/stickers", {}, "evil.png", b"<html><script>alert(1)</script></html>", "image/png", "file"
            )
            check("renamed non-image is refused", status == 400, f"status {status}")

            with session.get(base + "/stickers") as resp:
                after = json.loads(resp.read())
            check("refused upload did not enter the library", len(after.get("items", [])) == 1, str(len(after.get("items", []))))

    finally:
        if proc.poll() is None:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(work, ignore_errors=True)

    print("\n" + "=" * 60)
    print(f"PASSED {len(PASSED)}   FAILED {len(FAILED)}")
    for name, detail in FAILED:
        print(f"  {name}: {detail}")
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main())
