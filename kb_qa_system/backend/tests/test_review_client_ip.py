from types import SimpleNamespace

import pytest

from app.core.client_ip import get_client_ip
from app.core.config import settings


def make_request(peer, forwarded=""):
    return SimpleNamespace(
        client=SimpleNamespace(host=peer),
        headers={"X-Forwarded-For": forwarded},
    )


@pytest.mark.parametrize(
    ("peer", "forwarded", "expected"),
    [
        ("198.51.100.20", "203.0.113.10", "198.51.100.20"),
        ("127.0.0.1", "203.0.113.50, 10.0.0.1", "203.0.113.50"),
        ("127.0.0.1", "203.0.113.50, not-an-ip", "127.0.0.1"),
        ("127.0.0.1", "", "127.0.0.1"),
    ],
)
def test_client_ip_uses_only_a_valid_trusted_proxy_chain(monkeypatch, peer, forwarded, expected):
    monkeypatch.setattr(settings, "TRUSTED_PROXIES", "127.0.0.1,10.0.0.0/8")
    assert get_client_ip(make_request(peer, forwarded)) == expected


def test_client_ip_supports_ipv6_proxy_networks(monkeypatch):
    monkeypatch.setattr(settings, "TRUSTED_PROXIES", "::1,2001:db8:1::/48")
    request = make_request("::1", "2001:db8:ffff::10, 2001:db8:1::2")
    assert get_client_ip(request) == "2001:db8:ffff::10"


def test_client_ip_returns_none_without_socket_peer(monkeypatch):
    monkeypatch.setattr(settings, "TRUSTED_PROXIES", "127.0.0.1")
    assert get_client_ip(SimpleNamespace(client=None, headers={})) is None
