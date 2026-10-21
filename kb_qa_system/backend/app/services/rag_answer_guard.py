"""Narrow lexical boundaries for medical evidence failures found during A12 review.

These rules do not establish clinical relevance, record ownership, or answerability.
Unmatched questions continue through the existing evidence prompt and validation.
"""

import re
from typing import Any

_PERSONAL_HEALTH = re.compile(
    r"我的(?:症状|病情|病历|诊断|用药|身体)|"
    r"我(?:最近|现在|目前|一直|经常|总是|这几天|昨天|今天)?(?:有|得了|患|出现|感觉|疼|痛|咳嗽|发烧|发热|心悸|心慌)|"
    r"我(?:的)?(?:脸上|身上|头部|肚子|胸口|皮肤|手臂|腿上)|"
    r"我(?:能不能|可以|能否|是否|应该|该|可否|能)?(?:吃|服用|用药)|"
    r"(?:适合我|对我(?:是否|有没有|有无)?(?:有效|有用|安全))|"
    r"\b(?:I have|my symptoms?|my diagnosis|should I take|can I take|safe for me|help me treat)\b",
    re.IGNORECASE,
)
_MEDICAL_CUES = re.compile(
    r"症状|病情|诊断|治疗|用药|服药|服用|吃药|药品|药物|疗效|适应证|副作用|疾病|疼|痛|心悸|心慌|胸闷|气短|发烧|发热|"
    r"咳嗽|恶心|呕吐|麻木|抽搐|粉刺|皮炎|疙瘩|麻子|symptom|diagnos|treat|medicine|medication|drug|dose",
    re.IGNORECASE,
)
_CASE_EVIDENCE = re.compile(
    r"病历|病例|病案|历史个案|就诊记录|入院记录|出院记录|既往史|现病史|诊疗记录|medical record|case history|"
    r"(?:患者|病人|patient).{0,64}(?:病史|确诊|诊断|入院|出院|治疗经过|用药史)|"
    r"病情分析[：:].{0,512}指导意见|医生建议[：:].{0,64}(?:您好|你好|建议你|建议您)",
    re.IGNORECASE | re.DOTALL,
)
_DRUG_NAME = re.compile(
    r"[\u4e00-\u9fffA-Za-z0-9·-]{2,30}?(?:胶囊|糖浆|颗粒|口服液|注射液|滴眼液|软膏|药膏)"
)
_NAME_PREFIX = re.compile(
    r"^(?:(?:请问|我想请问|我想知道|我想咨询|我是否可以|我能不能|我可以|我应该|我吃|我服用|服用|吃|使用|"
    r"药物|药品|这个|这种|的|和|以及|或|还有)+)"
)
_DRUG_EFFECT = re.compile(r"有用|有效|疗效|适应证|适用|治疗|能治|可治|缓解|改善|安全|副作用")
_HISTORICAL_FACT = re.compile(r"历史|原记录|原问答|病例|病历|个案")
_QUOTED_TEXT = re.compile(r'“[^”]*”|「[^」]*」|"[^"\n]*"|‘[^’]*’')


def _case_source_index(search_results: list[dict[str, Any]]) -> int | None:
    for index, result in enumerate(search_results, start=1):
        # A title alone cannot establish that the returned text is a clinical case.
        if _CASE_EVIDENCE.search(str(result.get("content", ""))):
            return index
    return None


def _is_personal_medical_query(question: str) -> bool:
    personal_text = question
    if _HISTORICAL_FACT.search(question):
        # Quoting an old question does not itself ask for advice for the current user.
        personal_text = _QUOTED_TEXT.sub("", question)
    return bool(_PERSONAL_HEALTH.search(personal_text) and _MEDICAL_CUES.search(personal_text))


def requires_medical_evidence(question: str) -> bool:
    """Keep recognized medical queries out of retrieval-free chat and query rewriting."""
    return _is_personal_medical_query(question) or bool(
        _DRUG_EFFECT.search(question)
        and _MEDICAL_CUES.search(question)
        and _DRUG_NAME.search(question)
    )


def medical_answer_boundary(question: str, search_results: list[dict[str, Any]]) -> str | None:
    """Return fixed wording for recognized evidence gaps, without calling a model."""
    case_index = _case_source_index(search_results)
    personal = _is_personal_medical_query(question)
    if personal and case_index is not None:
        return (
            "检索到的历史病例或诊疗问答不能作为判断您当前病情或推荐用药的依据。"
            f" [文档{case_index}]"
        )
    if personal and not search_results:
        return "未找到足以判断您当前病情或推荐用药的资料。"

    if _DRUG_EFFECT.search(question) and _MEDICAL_CUES.search(question):
        contents = [str(result.get("content", "")).casefold() for result in search_results]
        for match in _DRUG_NAME.finditer(question):
            medication = _NAME_PREFIX.sub("", match.group()).casefold()
            if medication and not any(medication in content for content in contents):
                # Absence is not a fact supported by an arbitrary source citation.
                return "现有资料未完整对应所问药品，无法确认其疗效或适用性。"
    return None
