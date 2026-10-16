import pytest
from benchmark_quality import word_error_rate


def test_word_error_rate_measures_insertions_deletions_and_substitutions():
    assert word_error_rate("Ada abre la puerta.", "ada abre la puerta") == 0
    assert word_error_rate("Ada abre la puerta", "Ada cierra la puerta") == 0.25
    assert word_error_rate("Ada abre la puerta", "Ada abre puerta") == 0.25
    assert word_error_rate("Ada abre puerta", "Ada abre la puerta") == pytest.approx(1 / 3)
    with pytest.raises(ValueError):
        word_error_rate("", "texto")
