"""Generate multi-resolution BrandMark PNG, ICO, and ICNS icons into desktop/icons/ using pure Python stdlib."""
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "desktop" / "icons"

BG = (35, 32, 30, 255)      # #23201E warm charcoal
WAVE = (250, 247, 242, 255) # #FAF7F2 warm paper
DOT = (212, 98, 42, 255)    # #D4622A terracotta accent


def in_round_rect(x: float, y: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = max(x0 + r, min(x, x1 - r))
    cy = max(y0 + r, min(y, y1 - r))
    if (x < x0 + r or x > x1 - r) and (y < y0 + r or y > y1 - r):
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    return True


def in_capsule(x: float, y: float, cx: float, y0: float, y1: float, rad: float) -> bool:
    cy = max(y0, min(y, y1))
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad


def sample(u: float, v: float) -> tuple[int, int, int, int]:
    # Normalized to 28x28 BrandMark viewBox from Illustrations.tsx
    px = u * 28.0
    py = v * 28.0
    if not in_round_rect(px, py, 2.0, 2.0, 26.0, 26.0, 7.0):
        return (0, 0, 0, 0)
    if (px - 20.5) ** 2 + (py - 8.5) ** 2 <= 2.35 ** 2:
        return DOT
    if (
        in_capsule(px, py, 9.5, 11.5, 16.5, 1.05)
        or in_capsule(px, py, 13.5, 8.5, 19.5, 1.05)
        or in_capsule(px, py, 17.5, 11.0, 17.0, 1.05)
    ):
        return WAVE
    return BG


def render_rgba(size: int, ss: int = 4) -> bytes:
    buf = bytearray(size * size * 4)
    n = ss * ss
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    u = (x + (sx + 0.5) / ss) / size
                    v = (y + (sy + 0.5) / ss) / size
                    sr, sg, sb, sa = sample(u, v)
                    r += sr * sa
                    g += sg * sa
                    b += sb * sa
                    a += sa
            idx = (y * size + x) * 4
            if a == 0:
                buf[idx : idx + 4] = b"\x00\x00\x00\x00"
            else:
                buf[idx] = round(r / a)
                buf[idx + 1] = round(g / a)
                buf[idx + 2] = round(b / a)
                buf[idx + 3] = round(a / n)
    return bytes(buf)


def encode_png(size: int, rgba: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw.extend(rgba[y * stride : (y + 1) * stride])
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def encode_ico(entries: list[tuple[int, bytes]]) -> bytes:
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    dir_entries = bytearray()
    payload = bytearray()
    for size, png in entries:
        dim = 0 if size >= 256 else size
        dir_entries.extend(struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png), offset))
        payload.extend(png)
        offset += len(png)
    return header + bytes(dir_entries) + bytes(payload)


def encode_icns(entries: list[tuple[bytes, bytes]]) -> bytes:
    body = bytearray()
    for ostype, png in entries:
        body.extend(ostype)
        body.extend(struct.pack(">I", 8 + len(png)))
        body.extend(png)
    return b"icns" + struct.pack(">I", 8 + len(body)) + bytes(body)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    pngs: dict[int, bytes] = {}
    for sz in (16, 32, 48, 64, 128, 256, 512, 1024):
        ss = 4 if sz <= 128 else (2 if sz <= 512 else 1)
        pngs[sz] = encode_png(sz, render_rgba(sz, ss=ss))

    (OUT / "32x32.png").write_bytes(pngs[32])
    (OUT / "128x128.png").write_bytes(pngs[128])
    (OUT / "128x128@2x.png").write_bytes(pngs[256])
    (OUT / "icon.png").write_bytes(pngs[512])
    (OUT / "icon.ico").write_bytes(encode_ico([(s, pngs[s]) for s in (16, 32, 48, 64, 128, 256)]))
    (OUT / "icon.icns").write_bytes(
        encode_icns([
            (b"icp4", pngs[16]),
            (b"icp5", pngs[32]),
            (b"icp6", pngs[64]),
            (b"ic07", pngs[128]),
            (b"ic08", pngs[256]),
            (b"ic09", pngs[512]),
            (b"ic10", pngs[1024]),
        ])
    )
    print(f"Generated icons in {OUT}")


if __name__ == "__main__":
    main()
