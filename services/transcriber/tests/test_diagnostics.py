from __future__ import annotations

import json

from dotty_transcriber.diagnostics import DiagnosticReporter, summarize_transcription_result


def test_reporter_writes_session_and_job_reports(tmp_path):
    reporter = DiagnosticReporter(tmp_path)
    reporter.record(
        "session:7",
        "job",
        "started",
        "Trabajo iniciado",
        job_id="session:7:chunk:1",
        metrics={"attempts": 1, "secret": "do-not-store"},
    )
    reporter.record(
        "session:7",
        "job",
        "success",
        "Trabajo completado correctamente",
        job_id="session:7:chunk:1",
        duration_ms=1250,
        evidence=["result_persisted"],
        metrics={"segments": 3},
    )

    directory = tmp_path / ".diagnostics" / "session_7"
    events = [json.loads(line) for line in (directory / "activity.transcriber.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len(events) == 2
    assert events[0]["metrics"]["secret"] == "[REDACTED]"

    session_report = reporter.read_session_report("session:7")
    assert session_report is not None
    assert session_report["event_count"] == 2
    assert session_report["outcomes"]["success"] == 1
    assert session_report["processes"]["job"]["total_duration_ms"] == 1250

    job_report = reporter.read_job_report("session:7", "session:7:chunk:1")
    assert job_report is not None
    assert job_report["final_outcome"] == "success"
    assert job_report["event_count"] == 2


def test_transcription_summary_explains_quality_and_speed():
    metrics = summarize_transcription_result(
        {
            "status": "transcribed",
            "device": "cuda",
            "language": "es",
            "language_probability": 0.98,
            "duration_seconds": 12.0,
            "duration_after_vad_seconds": 10.0,
            "segments": [
                {
                    "status": "transcribed",
                    "words": [
                        {"text": " hola", "probability": 0.9},
                        {"text": " mundo", "probability": 0.8},
                    ],
                },
                {
                    "status": "suspected_hallucination",
                    "words": [{"text": " ruido", "probability": 0.2}],
                },
            ],
        },
        wall_seconds=2.0,
        gpu_seconds=2.0,
        speech_ratio=0.75,
        rms_dbfs=-24.5,
    )

    assert metrics["segments_total"] == 2
    assert metrics["segments_accepted"] == 1
    assert metrics["segments_suspected_hallucination"] == 1
    assert metrics["word_count"] == 3
    assert metrics["average_word_confidence"] == 0.6333
    assert metrics["realtime_factor"] == 0.2
    assert metrics["audio_seconds_per_wall_second"] == 5.0
