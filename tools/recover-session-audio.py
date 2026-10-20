"""Export playable audio from a saved Dotty manifest without changing source data.

Usage: python tools/recover-session-audio.py SESSION_ID
The output goes to data/recovered-audio/SESSION_ID and never overwrites files.
"""

import hashlib
import json
import shutil
import subprocess
import sys
import wave
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RATE = 48_000
BYTES_PER_FRAME = 2
ZERO_BLOCK = bytes(1_048_576)


def fail(message: str) -> None:
    raise RuntimeError(message)


def write_zeros(pipe, frames: int) -> None:
    remaining = frames * BYTES_PER_FRAME
    while remaining:
        size = min(remaining, len(ZERO_BLOCK))
        pipe.write(memoryview(ZERO_BLOCK)[:size])
        remaining -= size


def read_manifest(session_id: str, data_root: Path):
    if not session_id.isascii() or not session_id.isalnum():
        fail("ID de sesión inválido")
    source = data_root / "recordings" / session_id
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("sessionId") != session_id or manifest.get("status") not in ("interrupted", "completed"):
        fail("El manifiesto no corresponde a una sesión cerrada")
    if not manifest.get("clips") or not manifest.get("chunks"):
        fail("La sesión no tiene audio recuperable")
    return source, manifest


def validate_chunks(source: Path, manifest: dict) -> dict:
    clips = {clip["clipIndex"]: clip for clip in manifest["clips"]}
    groups = defaultdict(list)
    seen = set()
    for chunk in manifest["chunks"]:
        relative = Path(chunk["file"].replace("\\", "/"))
        if relative.is_absolute() or ".." in relative.parts or relative.parts[0] != "audio":
            fail(f"Ruta de audio inválida: {chunk['id']}")
        if chunk["id"] in seen or chunk["clipIndex"] not in clips:
            fail(f"Fragmento duplicado o clip desconocido: {chunk['id']}")
        seen.add(chunk["id"])
        path = source / relative
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1_048_576), b""):
                digest.update(block)
        if path.stat().st_size != chunk["bytes"] or digest.hexdigest() != chunk["sha256"]:
            fail(f"El fragmento no coincide con el manifiesto: {chunk['id']}")
        with wave.open(str(path), "rb") as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, RATE, "NONE"):
                fail(f"Formato WAV inesperado: {chunk['id']}")
            frames = wav.getnframes()
        start = round((chunk["startedOffsetMs"] - clips[chunk["clipIndex"]]["sessionStartOffsetMs"]) * RATE / 1000)
        if start < 0:
            fail(f"Inicio anterior al clip: {chunk['id']}")
        groups[(chunk["clipIndex"], chunk["speakerUserId"])].append((start, frames, path))
    for items in groups.values():
        items.sort(key=lambda item: item[0])
        end = 0
        for start, frames, _ in items:
            if start < end:
                fail("Hay fragmentos superpuestos de una misma voz; se requiere revisión manual")
            end = start + frames
    return groups


def encode_track(items: list, target: Path, minimum_frames: int) -> int:
    process = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", str(RATE),
         "-ac", "1", "-i", "pipe:0", "-c:a", "flac", "-compression_level", "5", str(target)],
        stdin=subprocess.PIPE,
    )
    position = 0
    try:
        for start, frames, path in items:
            write_zeros(process.stdin, start - position)
            with wave.open(str(path), "rb") as wav:
                remaining = frames
                while remaining:
                    count = min(remaining, 48_000)
                    data = wav.readframes(count)
                    if len(data) != count * BYTES_PER_FRAME:
                        fail(f"WAV truncado: {path.name}")
                    process.stdin.write(data)
                    remaining -= count
            position = start + frames
        write_zeros(process.stdin, max(0, minimum_frames - position))
        process.stdin.close()
        if process.wait() != 0:
            fail(f"ffmpeg no pudo codificar {target.name}")
        return max(position, minimum_frames)
    except BaseException:
        if process.poll() is None:
            process.kill()
        process.wait()
        raise


def recover(session_id: str, data_root: Path) -> Path:
    source, manifest = read_manifest(session_id, data_root)
    groups = validate_chunks(source, manifest)
    if shutil.which("ffmpeg") is None:
        fail("No se encontró ffmpeg")
    destination = data_root / "recovered-audio" / session_id
    if destination.exists():
        index = destination / "recovery.json"
        if index.is_file():
            prior = json.loads(index.read_text(encoding="utf-8"))
            files = [destination / clip["mixFile"] for clip in prior["clips"]]
            files += [destination / track["file"] for clip in prior["clips"] for track in clip["tracks"]]
            if prior.get("sessionId") == session_id and prior.get("chunksValidated") == len(manifest["chunks"]) and all(path.is_file() and path.stat().st_size > 0 for path in files):
                return destination
        fail(f"La carpeta de salida ya existe y requiere revisión: {destination}")
    destination.mkdir(parents=True, exist_ok=False)
    names = {chunk["speakerUserId"]: chunk["speakerName"] for chunk in manifest["chunks"]}
    summary = {"sessionId": session_id, "sourceStatus": manifest["status"],
               "sourceManifest": str(source / "manifest.json"), "chunksValidated": len(manifest["chunks"]),
               "note": "Audio recuperado de los WAV conservados. La interrupción original permanece registrada.",
               "clips": []}
    try:
        for clip in manifest["clips"]:
            index = clip["clipIndex"]
            minimum_frames = round(clip["durationSeconds"] * RATE)
            speakers = sorted(speaker for clip_index, speaker in groups if clip_index == index)
            if not speakers:
                continue
            tracks = []
            for speaker in speakers:
                target = destination / f"clip_{index:03d}_voz_{speaker}.flac"
                frames = encode_track(groups[(index, speaker)], target, minimum_frames)
                tracks.append({"speakerUserId": speaker, "speakerName": names.get(speaker, speaker), "file": target.name,
                               "chunks": len(groups[(index, speaker)]), "durationSeconds": frames / RATE})
                print(f"Creado: {target.name}", flush=True)
            mixed = destination / f"clip_{index:03d}_mezcla.flac"
            command = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
            for track in tracks:
                command += ["-i", str(destination / track["file"])]
            command += ["-filter_complex", f"amix=inputs={len(tracks)}:duration=longest:normalize=0,alimiter=limit=0.95",
                        "-c:a", "flac", "-compression_level", "5", str(mixed)]
            subprocess.run(command, check=True)
            print(f"Creado: {mixed.name}", flush=True)
            summary["clips"].append({"clipIndex": index, "mixFile": mixed.name, "tracks": tracks})
        (destination / "recovery.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except BaseException:
        (destination / "RECOVERY_INCOMPLETE.txt").write_text("La exportación quedó incompleta. Los WAV originales siguen intactos.\n", encoding="utf-8")
        raise
    return destination


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        fail("Uso: recover-session-audio.py SESSION_ID [DATA_ROOT]")
    data_root = Path(sys.argv[2]).resolve() if len(sys.argv) == 3 else ROOT / "data"
    print(recover(sys.argv[1], data_root))
