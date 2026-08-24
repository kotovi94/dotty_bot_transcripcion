import json
from pathlib import Path

from dotty_transcriber.config import Settings
from dotty_transcriber.voice_processing import AdaptiveVoiceProcessor


def settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path / "recordings",
        database_path=tmp_path / "queue.db",
        secret="secret",
        model="small",
        device="cpu",
        compute_type="int8",
        language="es",
        initial_prompt="",
        beam_size=1,
        patience=1.0,
        repetition_penalty=1.0,
        no_repeat_ngram_size=0,
        vad_threshold=0.45,
        vad_min_silence_ms=500,
        vad_speech_pad_ms=400,
    )


def test_discord_audio_with_no_local_speech_is_not_sent_to_whisper(tmp_path: Path) -> None:
    processor = AdaptiveVoiceProcessor(
        settings(tmp_path),
        decoder=lambda _: [0.01] * 16_000,
        detector=lambda _audio, **_options: [],
    )
    result = processor.analyze(tmp_path / "source.wav", "user-1", "session-1")
    assert result.state == "NON_SPEECH"
    assert result.duration_seconds == 1.0


def test_speech_preserves_prebuffer_hangover_and_separate_profiles(tmp_path: Path) -> None:
    observed = {}

    def detector(_audio, **options):
        observed.update(options)
        return [{"start": 1_600, "end": 14_400}]

    processor = AdaptiveVoiceProcessor(
        settings(tmp_path),
        decoder=lambda _: [0.1] * 16_000,
        detector=detector,
    )
    result = processor.analyze(tmp_path / "original.wav", "user-1", "session-1")
    assert result.state == "SPEECH"
    assert observed["speech_pad_ms"] == 400
    assert observed["min_silence_duration_ms"] == 500
    permanent = json.loads((tmp_path / "users" / "user-1" / "voice_profile.json").read_text())
    session = json.loads((tmp_path / "recordings" / "session-1" / "session_voice_profiles.json").read_text())
    assert "human_speech_profile" in permanent
    assert "acoustic_profile" in permanent
    assert session["users"]["user-1"]["sample_count"] == 1


def test_corrupt_profile_recovers_with_bounded_defaults(tmp_path: Path) -> None:
    path = tmp_path / "users" / "user-1" / "voice_profile.json"
    path.parent.mkdir(parents=True)
    path.write_text("not-json", encoding="utf-8")
    processor = AdaptiveVoiceProcessor(
        settings(tmp_path),
        decoder=lambda _: [0.1] * 8_000,
        detector=lambda _audio, **_options: [{"start": 0, "end": 8_000}],
    )
    result = processor.analyze(tmp_path / "source.wav", "user-1", "session-1")
    assert 300 <= result.vad_parameters["speech_pad_ms"] <= 600
    assert 400 <= result.vad_parameters["min_silence_duration_ms"] <= 1_200


def test_users_are_isolated(tmp_path: Path) -> None:
    processor = AdaptiveVoiceProcessor(
        settings(tmp_path),
        decoder=lambda _: [0.1] * 8_000,
        detector=lambda _audio, **_options: [{"start": 0, "end": 8_000}],
    )
    processor.analyze(tmp_path / "a.wav", "user-a", "session-1")
    processor.analyze(tmp_path / "b.wav", "user-b", "session-1")
    assert (tmp_path / "users" / "user-a" / "voice_profile.json").exists()
    assert (tmp_path / "users" / "user-b" / "voice_profile.json").exists()
