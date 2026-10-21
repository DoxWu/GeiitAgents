"""Citation bounds for single sources and inclusive source ranges."""

import pytest

from app.services.rag_chain import RAGChainService


@pytest.mark.parametrize(
    ("answer", "source_count", "expected"),
    [
        ("依据[文档1]。", 1, "依据[文档1]。"),
        ("依据[文档 2]。", 2, "依据[文档 2]。"),
        ("依据[文档1-5]。", 5, "依据[文档1-5]。"),
        ("依据[文档 2–4]。", 4, "依据[文档 2–4]。"),
        ("依据[文档1-5]。", 4, "依据。"),
        ("依据[文档3-2]。", 5, "依据。"),
        ("依据[文档0-2]。", 5, "依据。"),
        ("依据[文档1]。", 0, "依据。"),
    ],
)
def test_sanitize_answer_validates_single_and_range_citations(answer, source_count, expected):
    service = object.__new__(RAGChainService)

    assert service._sanitize_answer(answer, source_count) == expected
