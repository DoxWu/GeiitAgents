"""Provider YAML follows the application's .env / process-environment precedence."""

import os

from app.core.model_provider.config_loader import ConfigLoader


def test_dotenv_only_provider_and_nested_defaults(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    for key in ("TEST_DOTENV_KEY", "TEST_DOTENV_BASE", "TEST_MODEL_OVERRIDE"):
        monkeypatch.delenv(key, raising=False)
    (tmp_path / ".env").write_text(
        "TEST_DOTENV_KEY=synthetic-key\nTEST_DOTENV_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1\n",
        encoding="utf-8",
    )
    config_file = tmp_path / "providers.yaml"
    config_file.write_text(
        'providers:\n  llm:\n    - name: primary\n      api_key: "${TEST_MODEL_OVERRIDE:${TEST_DOTENV_KEY}}"\n      api_base: "${TEST_DOTENV_BASE}"\n',
        encoding="utf-8",
    )
    config = ConfigLoader.load(str(config_file))
    assert config.providers["llm"][0].api_key == "synthetic-key"
    assert config.providers["llm"][0].api_base.startswith("https://dashscope.")
    assert "TEST_DOTENV_KEY" not in os.environ
    monkeypatch.setenv("TEST_DOTENV_KEY", "process-value")
    assert ConfigLoader.load(str(config_file)).providers["llm"][0].api_key == "process-value"
    monkeypatch.setenv("TEST_MODEL_OVERRIDE", "explicit-value")
    assert ConfigLoader.load(str(config_file)).providers["llm"][0].api_key == "explicit-value"


def test_absent_dotenv_preserves_yaml_defaults(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("TEST_NO_DOTENV_MODEL", raising=False)
    config_file = tmp_path / "providers.yaml"
    config_file.write_text(
        'providers:\n  llm:\n    - name: primary\n      model: "${TEST_NO_DOTENV_MODEL:fixture-model}"\n',
        encoding="utf-8",
    )
    assert ConfigLoader.load(str(config_file)).providers["llm"][0].model == "fixture-model"


def test_empty_dotenv_value_does_not_mask_legacy_provider_setting(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("MODEL_LANGUAGE_PRIMARY_MODEL", "")
    monkeypatch.setenv("ALIYUN_LLM_MODEL", "legacy-model")
    config_file = tmp_path / "providers.yaml"
    config_file.write_text(
        'providers:\n  llm:\n    - name: primary\n      model: "${MODEL_LANGUAGE_PRIMARY_MODEL:${ALIYUN_LLM_MODEL:default-model}}"\n',
        encoding="utf-8",
    )
    assert ConfigLoader.load(str(config_file)).providers["llm"][0].model == "legacy-model"


def test_env_fallback_builds_independent_model_categories(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    keys = [
        "MODEL_EMBEDDING_PRIMARY_MODEL", "MODEL_EMBEDDING_PRIMARY_API_KEY", "MODEL_EMBEDDING_PRIMARY_API_URL",
        "MODEL_EMBEDDING_PRIMARY_DIMENSION", "MODEL_EMBEDDING_PRIMARY_VECTOR_SPACE",
        "MODEL_EMBEDDING_FALLBACK_ENABLED", "MODEL_EMBEDDING_FALLBACK_MODEL",
        "MODEL_EMBEDDING_FALLBACK_API_KEY", "MODEL_EMBEDDING_FALLBACK_API_URL",
        "MODEL_EMBEDDING_FALLBACK_DIMENSION", "MODEL_EMBEDDING_FALLBACK_VECTOR_SPACE",
        "MODEL_RERANK_PRIMARY_MODEL", "MODEL_RERANK_PRIMARY_API_KEY", "MODEL_RERANK_PRIMARY_API_URL",
        "MODEL_RERANK_FALLBACK_ENABLED", "MODEL_RERANK_FALLBACK_MODEL",
        "MODEL_RERANK_FALLBACK_API_KEY", "MODEL_RERANK_FALLBACK_API_URL",
        "MODEL_IMAGE_GENERATION_PRIMARY_ENABLED", "MODEL_IMAGE_GENERATION_PRIMARY_MODEL",
        "MODEL_IMAGE_GENERATION_PRIMARY_API_KEY", "MODEL_IMAGE_GENERATION_PRIMARY_API_URL",
        "MODEL_IMAGE_GENERATION_FALLBACK_ENABLED", "MODEL_IMAGE_GENERATION_FALLBACK_MODEL",
        "MODEL_IMAGE_GENERATION_FALLBACK_API_KEY", "MODEL_IMAGE_GENERATION_FALLBACK_API_URL",
    ]
    for key in keys:
        monkeypatch.delenv(key, raising=False)
    (tmp_path / ".env").write_text(
        "\n".join([
            "MODEL_EMBEDDING_PRIMARY_MODEL=embed-main",
            "MODEL_EMBEDDING_PRIMARY_API_KEY=embed-main-key",
            "MODEL_EMBEDDING_PRIMARY_API_URL=https://embed-main.example/v1",
            "MODEL_EMBEDDING_PRIMARY_DIMENSION=1024",
            "MODEL_EMBEDDING_PRIMARY_VECTOR_SPACE=shared-1024",
            "MODEL_EMBEDDING_FALLBACK_ENABLED=true",
            "MODEL_EMBEDDING_FALLBACK_MODEL=embed-backup",
            "MODEL_EMBEDDING_FALLBACK_API_KEY=embed-backup-key",
            "MODEL_EMBEDDING_FALLBACK_API_URL=https://embed-backup.example/v1",
            "MODEL_EMBEDDING_FALLBACK_DIMENSION=1024",
            "MODEL_EMBEDDING_FALLBACK_VECTOR_SPACE=shared-1024",
            "MODEL_RERANK_PRIMARY_MODEL=rank-main",
            "MODEL_RERANK_PRIMARY_API_KEY=rank-main-key",
            "MODEL_RERANK_PRIMARY_API_URL=https://dashscope.aliyuncs.com/compatible-mode/v1",
            "MODEL_RERANK_FALLBACK_ENABLED=true",
            "MODEL_RERANK_FALLBACK_MODEL=rank-backup",
            "MODEL_RERANK_FALLBACK_API_KEY=rank-backup-key",
            "MODEL_RERANK_FALLBACK_API_URL=https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
            "MODEL_IMAGE_GENERATION_PRIMARY_ENABLED=true",
            "MODEL_IMAGE_GENERATION_PRIMARY_MODEL=image-main",
            "MODEL_IMAGE_GENERATION_PRIMARY_API_KEY=image-main-key",
            "MODEL_IMAGE_GENERATION_PRIMARY_API_URL=https://image-main.example/v1",
            "MODEL_IMAGE_GENERATION_FALLBACK_ENABLED=true",
            "MODEL_IMAGE_GENERATION_FALLBACK_MODEL=image-backup",
            "MODEL_IMAGE_GENERATION_FALLBACK_API_KEY=image-backup-key",
            "MODEL_IMAGE_GENERATION_FALLBACK_API_URL=https://image-backup.example/v1",
        ]) + "\n",
        encoding="utf-8",
    )

    config = ConfigLoader._fallback_from_env()
    embedding = config.providers["embedding"]
    assert [(item.model, item.api_key, item.api_base, item.enabled) for item in embedding[:2]] == [
        ("embed-main", "embed-main-key", "https://embed-main.example/v1", True),
        ("embed-backup", "embed-backup-key", "https://embed-backup.example/v1", True),
    ]
    assert embedding[0].vector_space_id == embedding[1].vector_space_id == "shared-1024"
    assert [(item.model, item.api_key, item.api_base) for item in config.providers["reranker"]] == [
        ("rank-main", "rank-main-key", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        ("rank-backup", "rank-backup-key", "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"),
    ]
    assert [(item.model, item.api_key, item.api_base, item.enabled) for item in config.providers["image_generation"]] == [
        ("image-main", "image-main-key", "https://image-main.example/v1", True),
        ("image-backup", "image-backup-key", "https://image-backup.example/v1", True),
    ]
