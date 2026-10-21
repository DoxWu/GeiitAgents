"""Stable cloud embedding identity shared by ingestion and offline migration."""

import hashlib
import json


def embedding_space_id(config, dimension: int) -> str:
    identity = {
        "type": config.type,
        "model": config.model,
        "api_base": config.api_base,
        "dimension": int(dimension),
    }
    encoded = json.dumps(identity, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
