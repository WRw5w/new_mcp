"""Encrypt or decrypt a migration ZIP with AES-256-GCM.

Requires `python -m pip install cryptography`. Keep the generated key file
separate from the public repository; possession of it grants archive access.
"""

from __future__ import annotations

import argparse
import secrets
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"AICMIG1"


def encrypt(source: Path, destination: Path, key_file: Path) -> None:
    if destination.exists() or key_file.exists():
        raise FileExistsError("encrypted output or key file already exists")
    key = secrets.token_bytes(32)
    nonce = secrets.token_bytes(12)
    sealed = AESGCM(key).encrypt(nonce, source.read_bytes(), MAGIC)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(MAGIC + nonce + sealed)
    key_file.parent.mkdir(parents=True, exist_ok=True)
    key_file.write_text(key.hex() + "\n", encoding="ascii")


def decrypt(source: Path, destination: Path, key_file: Path) -> None:
    if destination.exists():
        raise FileExistsError("refusing to replace an existing output file")
    data = source.read_bytes()
    if not data.startswith(MAGIC) or len(data) < len(MAGIC) + 12 + 16:
        raise ValueError("not an AIC migration archive")
    key = bytes.fromhex(key_file.read_text(encoding="ascii").strip())
    if len(key) != 32:
        raise ValueError("expected a 32-byte hex key")
    plain = AESGCM(key).decrypt(data[len(MAGIC):len(MAGIC) + 12],
                                data[len(MAGIC) + 12:], MAGIC)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(plain)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("encrypt", "decrypt"))
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    args = parser.parse_args()
    if args.operation == "encrypt":
        encrypt(args.source, args.destination, args.key_file)
    else:
        decrypt(args.source, args.destination, args.key_file)
