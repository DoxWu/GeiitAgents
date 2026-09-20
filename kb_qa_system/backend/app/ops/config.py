"""Independent settings: usable even if the application DB/Redis are unavailable."""
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class OpsSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=True)
    DATABASE_URL: str = ""
    REDIS_URL: str = ""
    MIGRATE_ON_STARTUP: bool = True
    DB_RECOVERY_ENABLED: bool = True
    DB_STARTUP_TIMEOUT_SECONDS: int = Field(300, ge=1, le=3600)
    DB_RETRY_INTERVAL_SECONDS: int = Field(5, ge=1, le=60)
    DB_CONNECT_TIMEOUT_SECONDS: int = Field(5, ge=1, le=30)
    DB_OPERATION_TIMEOUT_SECONDS: int = Field(600, ge=10, le=7200)
    BOOTSTRAP_ADMIN_ENABLED: bool = False
    SUPERUSER_USERNAME: str = ""
    SUPERUSER_EMAIL: str = ""
    SUPERUSER_PASSWORD: str = ""
    BACKUP_ENABLED: bool = False
    BACKUP_DATABASE_URL: str = ""
    BACKUP_VERIFY_ADMIN_URL: str = ""
    BACKUP_ENCRYPTION_KEY: str = ""
    BACKUP_SOURCE_ID: str = Field("geiit-production", min_length=1, max_length=100)
    BACKUP_INTERVAL_SECONDS: int = Field(86400, ge=60)
    BACKUP_RETENTION_COUNT: int = Field(7, ge=2, le=365)
    BACKUP_MAX_BYTES: int = Field(2 * 1024**3, ge=1024)
    BACKUP_ALLOW_EMPTY: bool = False
    OPS_API_ENABLED: bool = False
    RESTORE_TARGET_DATABASE_URL: str = ""
    RESTORE_TARGET_NAME: str = Field("recovery", pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    RESTORE_ON_EMPTY: bool = False
    RESTORE_MAX_AGE_HOURS: int = Field(168, ge=1)
    OPS_MONITOR_URL: str = ""
    OPS_INTERVAL_SECONDS: int = Field(60, ge=5)
    OPS_FAILURE_THRESHOLD: int = Field(3, ge=1)
    OPS_ALERT_COOLDOWN_SECONDS: int = Field(3600, ge=60)
    OPS_STATE_FILE: str = "./data/ops-state.json"
    OPS_ALERTS_ENABLED: bool = False
    ADMIN_NOTIFY_EMAIL: str = ""
    EMAIL_PROVIDER: str = "http"
    EMAIL_FROM: str = ""
    RESEND_API_KEY: str = ""
    SMTP_HOST: str = ""
    SMTP_PORT: int = 465
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_USE_TLS: bool = True
    SMTP_START_TLS: bool = False
    SMTP_TIMEOUT: int = 15
