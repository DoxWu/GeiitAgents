"""Pinned public HTTP transport for untrusted document URLs.

Environment proxies are disabled. TLS still verifies the original hostname;
only the connection address changes. Each redirect must call this again.
"""
from urllib.parse import urlsplit, urlunsplit

import requests
from requests.adapters import HTTPAdapter

from app.core.url_validator import validate_url, _validate_hostname_ip


class PinnedHTTPSAdapter(HTTPAdapter):
    def __init__(self, hostname: str):
        self.hostname = hostname
        super().__init__(max_retries=0)

    def init_poolmanager(self, connections, maxsize, block=False, **kwargs):
        kwargs.update(assert_hostname=self.hostname, server_hostname=self.hostname)
        super().init_poolmanager(connections, maxsize, block, **kwargs)


def public_get(url: str, *, headers=None, timeout=30, allow_redirects=False, stream=True):
    if allow_redirects:
        raise ValueError("Redirects require validation of every destination")
    validate_url(url, allow_private=False)
    parsed = urlsplit(url)
    hostname = parsed.hostname.encode('idna').decode('ascii')
    # Resolve and validate this entire result, then connect only to its IP literal.
    addresses = _validate_hostname_ip(hostname, False)
    ip = addresses[0]
    authority = f'[{ip}]' if ':' in ip else ip
    if parsed.port:
        authority += f':{parsed.port}'
    pinned = urlunsplit((parsed.scheme, authority, parsed.path or '/', parsed.query, ''))
    host = f'[{hostname}]' if ':' in hostname else hostname
    if parsed.port:
        host += f':{parsed.port}'
    session = requests.Session()
    session.trust_env = False
    if parsed.scheme == 'https':
        session.mount('https://', PinnedHTTPSAdapter(hostname))
    try:
        response = session.get(pinned, headers={**(headers or {}), 'Host': host},
                               timeout=(min(timeout, 10), min(timeout, 5)),
                               allow_redirects=False, stream=stream)
    except Exception:
        session.close()
        raise
    original_close = response.close
    def close():
        try:
            original_close()
        finally:
            session.close()
    response.close = close
    response.url = url
    return response
