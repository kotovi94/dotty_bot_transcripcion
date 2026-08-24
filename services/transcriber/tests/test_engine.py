from pathlib import Path
from types import SimpleNamespace

from dotty_transcriber.config import Settings
from dotty_transcriber.engine import WhisperEngine


class FakeModel:
    def __init__(self) -> None:
        self.options = {}

    def transcribe(self, _audio: str, **options):
        self.options = options
        word = SimpleNamespace(start=0.1, end=0.4, word=" campaña", probability=0.92)
        segment = SimpleNamespace(
            start=0.1,
            end=0.4,
            text=" campaña",
            words=[word],
            avg_logprob=-0.2,
            no_speech_prob=0.03,
            compression_ratio=1.1,
        )
        info = SimpleNamespace(
            language="es",
            language_probability=0.99,
            duration=1.0,
            duration_after_vad=0.8,
        )
        return iter([segment]), info


class EmptyVadModel:
    def transcribe(self, _audio: str, **_options):
        raise ValueError(
            "boolean index did not match indexed array along axis 0; "
            "size of axis is 0 but size of corresponding boolean axis is 1"
        )


def test_quality_options_and_confidence_are_preserved(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path,
        database_path=tmp_path / "queue.db",
        secret="secret",
        model="small",
        device="cpu",
        compute_type="int8",
        language="es",
        initial_prompt="Dotty",
        beam_size=5,
        patience=1.0,
        repetition_penalty=1.05,
        no_repeat_ngram_size=0,
        vad_threshold=0.45,
        vad_min_silence_ms=400,
        vad_speech_pad_ms=250,
    )
    model = FakeModel()
    progress = []
    result = WhisperEngine(settings)._transcribe_with_model(
        model,
        tmp_path / "audio.wav",
        "es",
        "Campaña",
        "Barovia",
        lambda ratio, processed, duration: progress.append((ratio, processed, duration)),
    )
    assert model.options["beam_size"] == 5
    assert model.options["no_repeat_ngram_size"] == 0
    assert model.options["hotwords"] == "Barovia"
    assert model.options["vad_parameters"]["min_silence_duration_ms"] == 400
    assert model.options["condition_on_previous_text"] is False
    assert result["duration_after_vad_seconds"] == 0.8
    assert result["segments"][0]["words"][0]["probability"] == 0.92
    assert progress[-1] == (0.5, 0.4, 0.8)


def test_treats_empty_vad_output_as_silence(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path,
        database_path=tmp_path / "queue.db",
        secret="secret",
        model="small",
        device="cpu",
        compute_type="int8",
        language="es",
        initial_prompt="",
        beam_size=5,
        patience=1.0,
        repetition_penalty=1.05,
        no_repeat_ngram_size=0,
        vad_threshold=0.45,
        vad_min_silence_ms=400,
        vad_speech_pad_ms=250,
    )
    engine = WhisperEngine(settings)
    engine._model = EmptyVadModel()

    result = engine.transcribe(tmp_path / "silence.wav", "es")

    assert result["segments"] == []
    assert result["duration_after_vad_seconds"] == 0.0


def test_marks_suspicious_tail_segments(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path,
        database_path=tmp_path / "queue.db",
        secret="secret",
        model="small",
        device="cpu",
        compute_type="int8",
        language="es",
        initial_prompt="Dotty",
        beam_size=5,
        patience=1.0,
        repetition_penalty=1.05,
        no_repeat_ngram_size=0,
        vad_threshold=0.45,
        vad_min_silence_ms=400,
        vad_speech_pad_ms=250,
    )
    engine = WhisperEngine(settings)
    result = engine._filter_segment(
        {
            "start_ms": 900,
            "end_ms": 1_600,
            "text": "Gracias por ver el video",
            "avg_logprob": -1.3,
            "no_speech_prob": 0.93,
            "compression_ratio": 1.2,
            "words": [],
        }
    )
    assert result is not None
    assert result["status"] == "suspected_hallucination"


def test_marks_repeated_hotword_hallucinations(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path,
        database_path=tmp_path / "queue.db",
        secret="secret",
        model="small",
        device="cpu",
        compute_type="int8",
        language="es",
        initial_prompt="Dotty",
        beam_size=5,
        patience=1.0,
        repetition_penalty=1.05,
        no_repeat_ngram_size=0,
        vad_threshold=0.45,
        vad_min_silence_ms=400,
        vad_speech_pad_ms=250,
    )
    result = WhisperEngine(settings)._filter_segment(
        {
            "start_ms": 0,
            "end_ms": 4_000,
            "text": "Dotty reanudar, Dotty reanudar, Dotty reanudar, Dotty reanudar",
            "avg_logprob": -0.1,
            "no_speech_prob": 0.05,
            "compression_ratio": 2.0,
            "words": [],
        }
    )
    assert result is not None
    assert result["status"] == "suspected_hallucination"


def test_marks_known_hallucination_even_when_voice_confidence_is_high(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path,
        database_path=tmp_path / "queue.db",
        secret="secret",
        model="small",
        device="cpu",
        compute_type="int8",
        language="es",
        initial_prompt="",
        beam_size=5,
        patience=1.0,
        repetition_penalty=1.05,
        no_repeat_ngram_size=0,
        vad_threshold=0.45,
        vad_min_silence_ms=400,
        vad_speech_pad_ms=250,
    )
    result = WhisperEngine(settings)._filter_segment(
        {
            "start_ms": 0,
            "end_ms": 2_000,
            "text": "¡Gracias por ver el vídeo!",
            "avg_logprob": -0.1,
            "no_speech_prob": 0.05,
            "compression_ratio": 1.0,
            "words": [{"text": "Gracias", "probability": 0.95}],
        }
    )
    assert result is not None
    assert result["status"] == "suspected_hallucination"
    assert "known_hallucination_phrase" in result["validation_reasons"]


def test_marks_short_repeated_artifact(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path,
        database_path=tmp_path / "queue.db",
        secret="secret",
        model="small",
        device="cpu",
        compute_type="int8",
        language="es",
        initial_prompt="",
        beam_size=5,
        patience=1.0,
        repetition_penalty=1.05,
        no_repeat_ngram_size=0,
        vad_threshold=0.45,
        vad_min_silence_ms=400,
        vad_speech_pad_ms=250,
    )
    result = WhisperEngine(settings)._filter_segment(
        {
            "start_ms": 0,
            "end_ms": 3_000,
            "text": "Unido, Unido, Unido, Unido",
            "avg_logprob": -0.2,
            "no_speech_prob": 0.05,
            "compression_ratio": 1.0,
            "words": [],
        }
    )
    assert result is not None
    assert result["status"] == "suspected_hallucination"


def test_truncates_large_prompts_before_sending_to_model(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        recordings_dir=tmp_path,
        database_path=tmp_path / "queue.db",
        secret="secret",
        model="small",
        device="cpu",
        compute_type="int8",
        language="es",
        initial_prompt="Dotty",
        beam_size=5,
        patience=1.0,
        repetition_penalty=1.05,
        no_repeat_ngram_size=0,
        vad_threshold=0.45,
        vad_min_silence_ms=400,
        vad_speech_pad_ms=250,
    )
    model = FakeModel()
    long_prompt = " ".join(["palabra"] * 400)
    long_hotwords = " ".join(["termino"] * 400)
    WhisperEngine(settings)._transcribe_with_model(
        model,
        tmp_path / "audio.wav",
        "es",
        long_prompt,
        long_hotwords,
        None,
    )
    assert len(model.options["initial_prompt"]) < len(long_prompt)
    assert len(model.options["hotwords"]) < len(long_hotwords)
