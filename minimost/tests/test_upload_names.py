"""Uploaded filenames must survive a round trip, including non-ASCII ones.

``secure_filename`` is lossy for anything non-ASCII: it turned ``报告.pdf`` into
``pdf`` and ``季度总结 2026.docx`` into ``2026.docx``, so a Chinese-speaking user's
file arrived nameless and, in the first case, without an extension. These tests pin
the replacement: percent-encoding, reversible, and still path-safe.
"""

import urllib.parse

from minimost.chat import _decode_upload_name, _encode_upload_name

CASES = [
    "report.pdf",
    "报告.pdf",
    "季度总结 2026.docx",
    "a b.zip",
    "50%.pdf",
    "noext",
    "emoji😀.png",
    "~!@#$%^&()[]{}中文.txt",
    "x" * 200 + ".bin",
]


def test_names_round_trip():
    """Encoding then decoding recovers the name the sender used."""
    for original in CASES:
        encoded = _encode_upload_name(original)
        stored = "f" * 32 + "_" + encoded
        decoded = _decode_upload_name(stored)
        # Long names are truncated on purpose; everything else must be exact.
        expected = original if len(original) <= 60 else original[:60]
        assert decoded == expected, f"{original!r} -> {encoded!r} -> {decoded!r}"


def test_encoded_names_are_path_safe():
    """Nothing that could escape the upload directory survives."""
    for original in CASES:
        encoded = _encode_upload_name(original)
        assert "/" not in encoded, original
        assert "\\" not in encoded, original
        assert ".." not in encoded, original
        assert len(encoded) <= 180, original


def test_directory_part_is_dropped():
    """A crafted request can send a path; only the final component is kept."""
    assert "/" not in _encode_upload_name("../../etc/passwd")
    assert "\\" not in _encode_upload_name("C:\\windows\\evil.exe")


def test_ascii_names_stay_readable():
    """The common case keeps a human-readable name on disk."""
    assert _encode_upload_name("quarterly report.pdf") == "quarterly report.pdf"


def test_chinese_name_keeps_its_extension():
    """The extension is what makes the download openable, so it must survive."""
    encoded = _encode_upload_name("报告.pdf")

    assert encoded.endswith(".pdf")
    assert urllib.parse.unquote(encoded) == "报告.pdf"


def test_decode_tolerates_a_legacy_name():
    """Old uploads were stored with secure_filename; those must not crash."""
    legacy = "f" * 32 + "_" + "report.pdf"

    assert _decode_upload_name(legacy) == "report.pdf"


def test_decode_of_an_unprefixed_name_returns_it():
    """Image uploads have no name suffix at all."""
    assert _decode_upload_name("f" * 32 + ".png") == "f" * 32 + ".png"


def test_truncation_keeps_the_name_decodable():
    """Cutting an escape sequence in half would make the name undecodable."""
    encoded = _encode_upload_name("中" * 200 + ".pdf")

    assert len(encoded) <= 180
    # errors="strict" raises on a truncated %XX, which is exactly what we forbid.
    decoded = urllib.parse.unquote(encoded, errors="strict")
    assert decoded
