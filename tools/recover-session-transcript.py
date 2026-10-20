"""Resume transcription of an interrupted recording without deleting old jobs.

Runs independently of the panel, persists progress and produces a partial
transcript until all original WAV chunks have been transcribed.
"""

import importlib.util
import json
import msvcrt
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(__file__).with_name("recover-session-audio.py")
spec = importlib.util.spec_from_file_location("dotty_recover_audio", SOURCE)
audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio)


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_text(path: Path, content: str):
    temp = path.with_name(path.name + ".new")
    temp.write_text(content, encoding="utf-8")
    os.replace(temp, path)


def state_write(path: Path, **values):
    previous = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    atomic_text(path, json.dumps({**previous, **values, "updatedAt": now()}, ensure_ascii=False, indent=2) + "\n")


def database(data_root: Path):
    return sqlite3.connect((data_root / "transcriber.db").resolve().as_uri() + "?mode=ro", uri=True, timeout=5)


def jobs_for_session(data_root: Path, session_id: str, include_results=False):
    fields = "id,audio_path,speaker_user_id,start_offset_ms,language,initial_prompt,hotwords,status,error"
    if include_results:
        fields += ",result_json"
    with closing(database(data_root)) as connection:
        connection.row_factory = sqlite3.Row
        return {row["id"]: dict(row) for row in connection.execute(
            f"SELECT {fields} FROM transcription_job WHERE id LIKE ?", (session_id + ":%",))}


def campaign_speaker_names(data_root: Path, campaign_id: str):
    if not campaign_id:
        return {}
    path = (data_root / "dotty.db").resolve()
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)) as connection:
        return {user_id: (character or "").strip() or player
                for user_id, player, character in connection.execute(
                    "SELECT discordUserId, playerName, characterName FROM CampaignMember WHERE campaignId = ?",
                    (campaign_id,))}


def job_matches(job: dict, chunk: dict, source: Path):
    expected = (source / Path(chunk["file"].replace("\\", "/"))).resolve()
    return (os.path.normcase(os.path.normpath(job["audio_path"])) ==
            os.path.normcase(os.path.normpath(str(expected))) and
            job["speaker_user_id"] == chunk["speakerUserId"] and
            job["start_offset_ms"] == chunk["startedOffsetMs"] and job["language"] == "es")


def api_secret(data_root: Path):
    load_dotenv(ROOT / ".env")
    configured = os.getenv("TRANSCRIBER_SHARED_SECRET", "").strip()
    if configured and configured != "replace-with-a-long-random-local-secret":
        return configured
    return (data_root / "transcriber.secret").read_text(encoding="utf-8").strip()


def api_url():
    value = os.getenv("TRANSCRIBER_BASE_URL", "http://127.0.0.1:8765").rstrip("/")
    if not value.startswith("http://127.0.0.1:"):
        raise RuntimeError("El transcriptor debe estar en 127.0.0.1")
    return value


def post_job(base_url: str, secret: str, payload: dict):
    request = urllib.request.Request(
        base_url + "/v1/jobs", data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        if response.status != 200:
            raise RuntimeError(f"El transcriptor devolvió HTTP {response.status}")


def format_time(milliseconds: int):
    seconds = max(0, milliseconds // 1000)
    return f"{seconds // 3600:02}:{seconds // 60 % 60:02}:{seconds % 60:02}"


def collect(data_root: Path, source: Path, manifest: dict, output: Path, state: Path, replace_existing=False):
    jobs = jobs_for_session(data_root, manifest["sessionId"], include_results=True)
    names = {chunk["speakerUserId"]: chunk["speakerName"] for chunk in manifest["chunks"]}
    names.update(campaign_speaker_names(data_root, manifest.get("campaignId", "")))
    expected = {f"{manifest['sessionId']}:{chunk['id']}": chunk for chunk in manifest["chunks"]}
    lines = []
    raw_lines = []
    completed = failed = queued = processing = 0
    for job_id, chunk in expected.items():
        job = jobs.get(job_id)
        if job is None:
            continue
        if not job_matches(job, chunk, source):
            raise RuntimeError(f"Un trabajo existente no coincide con el WAV conservado: {chunk['id']}")
        status = job["status"]
        if status == "completed" and job["result_json"]:
            completed += 1
            result = json.loads(job["result_json"])
            for segment in result.get("segments", []):
                value = str(segment.get("text", "")).strip()
                if not value:
                    continue
                offset = int(job["start_offset_ms"]) + int(segment.get("start_ms", 0))
                end = int(job["start_offset_ms"]) + int(segment.get("end_ms", segment.get("start_ms", 0)))
                raw_lines.append({"startMs": offset, "endMs": max(offset, end),
                                  "speakerUserId": job["speaker_user_id"],
                                  "speakerName": names.get(job["speaker_user_id"], job["speaker_user_id"]),
                                  "text": value, "rawText": value})
                mark = " [revisar]" if segment.get("status") == "suspected_hallucination" else ""
                lines.append((offset, f"[{format_time(offset)}] **{names.get(job['speaker_user_id'], job['speaker_user_id'])}:** {value}{mark}"))
        elif status == "failed":
            failed += 1
        elif status == "processing":
            processing += 1
        elif status == "queued":
            queued += 1
    lines.sort(key=lambda item: item[0])
    total = len(expected)
    header = [f"# Transcripción recuperada — sesión {manifest['sequenceNumber']}", "",
              f"- Sesión: {manifest['sessionId']}",
              f"- Estado original: {manifest['status']}",
              f"- Fragmentos procesados: {completed}/{total}",
              f"- En cola: {queued}; procesando: {processing}; fallidos: {failed}",
              "- Texto automático; las marcas [revisar] indican segmentos dudosos.", "", "## Transcripción", ""]
    content = "\n".join(header + [line for _, line in lines]) + "\n"
    final = completed == total
    transcript = output / ("transcripcion.md" if final else "transcripcion-parcial.md")
    atomic_text(transcript, content)
    all_terminal = completed + failed == total
    published_path = None
    if final:
        export_dir = data_root / "exports" / manifest["sessionId"]
        export_dir.mkdir(parents=True, exist_ok=True)
        bitacora = export_dir / "bitacora.md"
        raw_path = export_dir / "transcript.raw.json"
        raw_lines.sort(key=lambda line: line["startMs"])
        raw_content = json.dumps({"manifest": manifest, "lines": raw_lines}, ensure_ascii=False, indent=2) + "\n"
        if not replace_existing and raw_path.exists() and raw_path.read_text(encoding="utf-8") != raw_content:
            raise RuntimeError(f"Ya existe una transcripción raw diferente; se conservó sin sobrescribir: {raw_path}")
        if not replace_existing and bitacora.exists() and bitacora.read_text(encoding="utf-8") != content:
            raise RuntimeError(f"Ya existe una bitácora diferente; se conservó sin sobrescribir: {bitacora}")
        if replace_existing:
            atomic_text(bitacora, content)
            atomic_text(raw_path, raw_content)
            (export_dir / "guion.revision.json").unlink(missing_ok=True)
            atomic_text(export_dir / "guion.estado.json", json.dumps({
                "state": "missing", "sessionId": manifest["sessionId"], "model": "",
                "progress": 0, "phase": "Transcripción rehecha; regenera el guion antes de publicar",
                "updatedAt": now(),
            }, ensure_ascii=False, indent=2) + "\n")
            (data_root / "recordings" / manifest["sessionId"] / ".transcription-regenerating").unlink(missing_ok=True)
        else:
            try:
                with bitacora.open("x", encoding="utf-8") as handle:
                    handle.write(content)
            except FileExistsError:
                if bitacora.read_text(encoding="utf-8") != content:
                    raise RuntimeError(f"Ya existe una bitácora diferente; se conservó sin sobrescribir: {bitacora}")
            if not raw_path.exists():
                with raw_path.open("x", encoding="utf-8") as handle:
                    handle.write(raw_content)
        published_path = str(bitacora)
    state_write(state, phase="completed" if final else "failed" if failed and all_terminal else "transcribing",
                total=total, completed=completed, queued=queued, processing=processing,
                missing=total - len(jobs), failed=failed, transcript=str(transcript),
                publishedPath=published_path)
    return final, failed, all_terminal


def run(session_id: str, data_root: Path, replace_existing=False):
    source, manifest = audio.read_manifest(session_id, data_root)
    if manifest["status"] != "interrupted":
        raise RuntimeError("Esta herramienta solo transcribe grabaciones interrumpidas")
    output = data_root / "recovered-audio" / session_id
    output.mkdir(parents=True, exist_ok=True)
    lock_path = output / "transcription.worker.lock"
    with lock_path.open("a+b") as lock:
        lock.seek(0, os.SEEK_END)
        if lock.tell() == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return
        state = output / "transcription.status.json"
        try:
            state_write(state, sessionId=session_id, phase="validating", total=len(manifest["chunks"]))
            audio.validate_chunks(source, manifest)
            jobs = jobs_for_session(data_root, session_id)
            expected = {f"{session_id}:{chunk['id']}": chunk for chunk in manifest["chunks"]}
            if any(job_id not in expected for job_id in jobs):
                raise RuntimeError("Hay trabajos ajenos al manifiesto; se requiere revisión")
            for job_id, job in jobs.items():
                if not job_matches(job, expected[job_id], source):
                    raise RuntimeError(f"Trabajo existente incompatible: {job_id}")
            template = next(iter(jobs.values()), None)
            prompt = template["initial_prompt"] if template else "Juego de rol."
            hotwords = template["hotwords"] if template else ""
            secret = api_secret(data_root)
            base_url = api_url()
            state_write(state, phase="enqueuing", existing=len(jobs))
            for index, (job_id, chunk) in enumerate(expected.items(), start=1):
                if job_id in jobs:
                    continue
                payload = {
                    "id": job_id,
                    "audio_path": str((source / Path(chunk["file"].replace("\\", "/"))).resolve()),
                    "speaker_user_id": chunk["speakerUserId"],
                    "start_offset_ms": chunk["startedOffsetMs"],
                    "language": "es", "initial_prompt": prompt, "hotwords": hotwords,
                }
                try:
                    post_job(base_url, secret, payload)
                except (urllib.error.URLError, TimeoutError):
                    # A timed-out POST may already be durable. Never create a
                    # second identity; inspect the same id before surfacing it.
                    current = jobs_for_session(data_root, session_id)
                    if job_id not in current or not job_matches(current[job_id], chunk, source):
                        raise
                if index % 50 == 0:
                    state_write(state, enqueued=index)
                if index % 100 == 0:
                    collect(data_root, source, manifest, output, state, replace_existing)
            state_write(state, phase="transcribing", enqueued=len(expected))
            previous = None
            while True:
                final, failed, all_terminal = collect(data_root, source, manifest, output, state, replace_existing)
                if final or (failed and all_terminal):
                    break
                snapshot = json.loads(state.read_text(encoding="utf-8"))
                key = (snapshot["completed"], snapshot["queued"], snapshot["processing"])
                if key != previous:
                    print(f"{session_id}: {key[0]}/{len(expected)} fragmentos transcritos", flush=True)
                    previous = key
                time.sleep(20)
        except BaseException as error:
            state_write(state, phase="error", error=str(error))
            raise
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3, 4) or (len(sys.argv) == 4 and sys.argv[3] != "--redo"):
        raise SystemExit("Uso: recover-session-transcript.py SESSION_ID [DATA_ROOT] [--redo]")
    run(sys.argv[1], Path(sys.argv[2]).resolve() if len(sys.argv) >= 3 else ROOT / "data",
        replace_existing=len(sys.argv) == 4)
