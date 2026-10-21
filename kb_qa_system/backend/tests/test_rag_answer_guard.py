import asyncio
from types import SimpleNamespace

import pytest

from app.services.rag_answer_guard import medical_answer_boundary
from app.services.rag_chain import RAGChainService

CASE_RESULTS = [
    {
        "content": "病历记录：患者既往心悸，曾由医生评估并记录治疗方案。",
        "metadata": {"document_id": 12, "document_title": "历史病例"},
        "score": 0.91,
    }
]


def test_personal_question_based_on_historical_case_returns_boundary():
    answer = medical_answer_boundary("我最近心悸，能否根据这份病历判断是什么病？", CASE_RESULTS)

    assert answer == "检索到的历史病例或诊疗问答不能作为判断您当前病情或推荐用药的依据。 [文档1]"


def test_unconfirmed_full_medicine_name_returns_boundary():
    results = [{"content": "心悸的日常记录和一般健康说明。", "metadata": {}}]

    answer = medical_answer_boundary("我吃参松养心胶囊能治疗心悸吗？", results)

    assert answer == "现有资料未完整对应所问药品，无法确认其疗效或适用性。"


def test_case_citation_points_to_matching_content_rather_than_first_result():
    results = [{"content": "页面导航。", "metadata": {}}] + CASE_RESULTS
    answer = medical_answer_boundary("我脸上有疙瘩，该用什么药？", results)
    assert answer.endswith("[文档2]")


def test_legacy_clinical_qa_and_direct_body_question_are_guarded():
    results = [{"content": "病情分析：你好，描述症状。指导意见：原个案药名甲。"}]
    answer = medical_answer_boundary("请帮助去除我脸上的疙瘩", results)
    assert "不能作为判断" in answer
    assert "药名甲" not in answer


def test_brand_name_cannot_be_inferred_from_generic_syrup_name():
    results = [{"content": "清凉糖浆：适应证为某种皮炎。"}]
    assert medical_answer_boundary("我想请问青松清凉糖浆对皮炎有用吗？", results)
    assert medical_answer_boundary("青松清凉糖浆对皮炎有用吗？", results)


def test_personal_medical_question_without_sources_does_not_enter_general_knowledge_mode():
    answer = medical_answer_boundary("我现在心悸，应该吃什么药？", [])
    assert answer == "未找到足以判断您当前病情或推荐用药的资料。"
    assert "[文档" not in answer


@pytest.mark.parametrize(
    ("question", "results"),
    [
        ("历史病例里患者服用了什么药？", CASE_RESULTS),
        (
            "我吃参松养心胶囊能治疗心悸吗？",
            [{"content": "参松养心胶囊的名称记录。", "metadata": {}}],
        ),
        (
            "我最近心悸，我应该怎么处理？",
            [{"content": "患者应结合指南中的一般处理原则。", "metadata": {}}],
        ),
        ("请问我最近使用的电脑图片查看器安全吗？", CASE_RESULTS),
        ("请引用历史问答中‘我脸上有疙瘩，该用什么药？’的原回复", CASE_RESULTS),
        ("参松养心胶囊有哪些适应证？", [{"content": "参松养心胶囊适应证。"}]),
        ("我有一份病历数据文件，如何读取？", CASE_RESULTS),
        ("树脂颗粒能有效改善强度吗？", []),
        ("咖啡胶囊怎么用才安全？", []),
    ],
)
def test_historical_facts_and_nonpersonal_questions_remain_available(question, results):
    assert medical_answer_boundary(question, results) is None


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize(
    ("question", "results"),
    [
        ("我最近心悸，能否根据这份病历判断是什么病？", CASE_RESULTS),
        (
            "我吃参松养心胶囊能治疗心悸吗？",
            [{"content": "心悸的日常记录和一般健康说明。", "metadata": {}}],
        ),
        ("我现在心悸，应该吃什么药？", []),
        (
            "青松清凉糖浆对皮炎有用吗？",
            [{"content": "清凉糖浆：适应证为某种皮炎。", "metadata": {}}],
        ),
        (
            "请帮助去除我脸上的疙瘩",
            [{"content": "病情分析：描述症状。指导意见：原个案药名甲。", "metadata": {}}],
        ),
    ],
)
def test_rag_guard_skips_conflict_analysis_and_model(monkeypatch, stream, question, results):
    service = object.__new__(RAGChainService)
    monkeypatch.setattr(
        service,
        "_classify_intent",
        lambda *_args, **_kwargs: pytest.fail("must not call intent LLM"),
    )
    monkeypatch.setattr(
        service,
        "_rewrite_query_for_search",
        lambda *_args, **_kwargs: pytest.fail("must not rewrite"),
    )
    monkeypatch.setattr(service, "retrieve_context", lambda *_args, **_kwargs: results)
    monkeypatch.setattr(
        service,
        "_detect_conflicts",
        lambda *_args, **_kwargs: pytest.fail("must stop before conflict analysis"),
    )
    monkeypatch.setattr(service, "_get_llm_service", lambda: pytest.fail("must not call an LLM"))

    from app.core import prometheus_metrics

    monkeypatch.setattr(prometheus_metrics, "record_rag_metrics", lambda *_args, **_kwargs: None)

    if stream:

        async def collect():
            return [event async for event in service.ask_stream(question)]

        events = asyncio.run(collect())
        assert [event["type"] for event in events] == ["sources", "chunk", "done"]
        assert events[-1]["content"] == events[1]["content"]
        assert len(events[0]["content"]) == len(results)
        assert events[-1]["metrics"]["llm_time_ms"] == 0
        assert events[-1]["metrics"]["model_used"] == ""
        assert events[-1]["content"] == medical_answer_boundary(question, results)
    else:
        answer = service.ask(question)
        assert len(answer["sources"]) == len(results)
        assert answer["answer"] == medical_answer_boundary(question, results)
        assert answer["metrics"]["llm_time_ms"] == 0
        assert answer["metrics"]["model_used"] == ""


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize(
    ("question", "content"),
    [
        ("历史病例里的诊断是什么？", "病例记录：原患者面诊诊断为甲。"),
        ("青松清凉糖浆有哪些适应证？", "青松清凉糖浆：资料记载的适应证。"),
        ("这个杯子的容量是多少？", "杯子容量为 420 毫升。"),
    ],
)
def test_supported_fact_queries_reach_answer_model(monkeypatch, stream, question, content):
    service = RAGChainService()
    results = [{"content": content, "metadata": {"document_id": 12}, "score": 0.9}]
    monkeypatch.setattr(
        service, "_classify_intent", lambda *_args, **_kwargs: SimpleNamespace(needs_retrieval=True)
    )
    monkeypatch.setattr(
        service, "_rewrite_query_for_search", lambda query, *_args, **_kwargs: query
    )
    monkeypatch.setattr(service, "retrieve_context", lambda *_args, **_kwargs: results)
    monkeypatch.setattr(service, "_detect_conflicts", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        service,
        "_validate_before_generation",
        lambda *_args, **_kwargs: SimpleNamespace(should_generate=True, confidence="high"),
    )
    calls = []

    def invoke(messages):
        calls.append(messages)
        return "资料记载的事实 [文档1]"

    async def astream(messages):
        yield invoke(messages)

    monkeypatch.setattr(
        service,
        "_get_llm_service",
        lambda: SimpleNamespace(
            invoke=invoke, astream=astream, last_metrics={"model_used": "test"}
        ),
    )
    from app.core import prometheus_metrics

    monkeypatch.setattr(prometheus_metrics, "record_rag_metrics", lambda *_args, **_kwargs: None)
    if stream:

        async def collect():
            return [event async for event in service.ask_stream(question)]

        events = asyncio.run(collect())
        answer = events[-1]["content"]
        metrics = events[-1]["metrics"]
    else:
        result = service.ask(question)
        answer, metrics = result["answer"], result["metrics"]
    assert len(calls) == 1
    assert answer == "资料记载的事实 [文档1]"
    assert metrics["model_used"] == "test"
