"""Opt-in DashScope reranking with the primary LLM's credentials and region."""

from __future__ import annotations

import json
import logging
import math
import time
from urllib.parse import urlsplit, urlunsplit

import httpx

from app.core.model_provider.config_loader import ConfigLoader

logger = logging.getLogger(__name__)
MODEL = "qwen3.7-text-rerank"
TIMEOUT_SECONDS = 8
MAX_CANDIDATES = 50
MAX_DOCUMENT_CHARACTERS = 8192
MAX_TOTAL_CHARACTERS = 120_000
MAX_RESPONSE_BYTES = 128_000


def rerank_url(api_base: str) -> str:
    """Keep the configured region/workspace; never forward a key to another host."""
    parsed = urlsplit(api_base)
    host = parsed.hostname or ""
    allowed = host in {
        "dashscope.aliyuncs.com",
        "dashscope-intl.aliyuncs.com",
        "dashscope-us.aliyuncs.com",
    } or host.endswith(".maas.aliyuncs.com")
    if (
        parsed.scheme != "https"
        or not allowed
        or parsed.username
        or parsed.password
        or parsed.port not in {None, 443}
        or parsed.query
        or parsed.fragment
        or parsed.path.rstrip("/") not in {"/compatible-mode/v1", "/api/v1", "/v1"}
    ):
        raise ValueError("unsupported_primary_rerank_endpoint")
    return urlunsplit(
        ("https", parsed.netloc, "/api/v1/services/rerank/text-rerank/text-rerank", "", "")
    )


def rerank_with_primary(query: str, documents: list[dict], top_k: int) -> list[dict]:
    """One bounded request; malformed/failed results preserve the original Top-K."""
    original = documents[:top_k]
    if len(documents) < 2:
        return original
    try:
        if not query.strip() or len(query) > 2000 or not 1 <= top_k <= MAX_CANDIDATES:
            raise ValueError("invalid_rerank_query")
        candidates = documents[:MAX_CANDIDATES]
        texts = [doc["content"] for doc in candidates]
        if (
            any(
                not isinstance(text, str) or not text.strip() or len(text) > MAX_DOCUMENT_CHARACTERS
                for text in texts
            )
            or len(query) + sum(map(len, texts)) > MAX_TOTAL_CHARACTERS
        ):
            raise ValueError("rerank_input_budget")
        endpoints = ConfigLoader.load().providers.get("llm", [])
        if not endpoints or not endpoints[0].enabled or not endpoints[0].api_key:
            raise ValueError("primary_unavailable")
        primary = endpoints[0]
        url = rerank_url(primary.api_base)
        count = min(top_k, len(candidates))
        deadline = time.monotonic() + TIMEOUT_SECONDS
        with httpx.Client(
            timeout=TIMEOUT_SECONDS, follow_redirects=False, trust_env=False
        ) as client:
            with client.stream(
                "POST",
                url,
                headers={"Authorization": f"Bearer {primary.api_key}"},
                json={
                    "model": MODEL,
                    "input": {"query": query, "documents": texts},
                    "parameters": {"top_n": count},
                },
            ) as response:
                response.raise_for_status()
                body = bytearray()
                for part in response.iter_bytes(chunk_size=4096):
                    if time.monotonic() > deadline or len(body) + len(part) > MAX_RESPONSE_BYTES:
                        raise ValueError("rerank_response_budget")
                    body.extend(part)
        if time.monotonic() > deadline:
            raise TimeoutError("rerank_deadline")
        payload = json.loads(body)
        if payload.get("code"):
            raise ValueError("rerank_provider_rejected")
        results = payload["output"]["results"]
        if not isinstance(results, list) or len(results) != count:
            raise ValueError("rerank_result_count")
        seen = set()
        ranked = []
        for item in results:
            index, score = item["index"], item["relevance_score"]
            if (
                type(index) is not int
                or not 0 <= index < len(candidates)
                or index in seen
                or type(score) not in {int, float}
                or not math.isfinite(score)
                or not 0 <= score <= 1
            ):
                raise ValueError("invalid_rerank_result")
            seen.add(index)
            ranked.append({**candidates[index], "rerank_score": float(score)})
        return sorted(ranked, key=lambda doc: doc["rerank_score"], reverse=True)
    except Exception as error:
        # Provider bodies, source text and credentials must not enter logs.
        logger.warning("Qwen reranking skipped; using retrieval order (%s)", type(error).__name__)
        return original
