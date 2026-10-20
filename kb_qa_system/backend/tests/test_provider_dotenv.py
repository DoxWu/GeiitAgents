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
