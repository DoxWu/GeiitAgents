"""Untrusted URL and parser resource tests; no real network or large allocations."""
import io
import socket
import time
import zipfile
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests
from PIL import Image

from app.core import public_http
from app.core.url_validator import URLValidationError
from app.services.document_pipeline.resource_limits import read_limited, validate_docx_archive
from app.services.document_pipeline.parsers import UrlParser, DocxParser
from app.services.document_pipeline import parsers


def address(ip):
    return [(socket.AF_INET6 if ':' in ip else socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 443))]


def test_dns_rebind_is_rejected_before_transport(monkeypatch):
    answers = iter([address('8.8.8.8'), address('127.0.0.1')])
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *a: next(answers))
    send = Mock()
    monkeypatch.setattr(requests.Session, 'send', send)
    with pytest.raises(URLValidationError):
        public_http.public_get('https://example.test/article')
    send.assert_not_called()


@pytest.mark.parametrize('ip', ['8.8.8.8', '2606:4700:4700::1111'])
def test_pinned_transport_host_sni_and_proxy_policy(monkeypatch, ip):
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *a: address(ip))
    calls = []
    response = requests.Response()
    response.status_code = 200
    response.raw = Mock()
    def send(session, prepared, **kwargs):
        adapter = session.get_adapter(prepared.url)
        calls.append((prepared, kwargs, adapter.poolmanager.connection_pool_kw, session.trust_env))
        return response
    monkeypatch.setattr(requests.Session, 'send', send)
    monkeypatch.setenv('HTTPS_PROXY', 'http://127.0.0.1:8888')
    result = public_http.public_get('https://example.test:443/article?q=ok')
    prepared, options, pool, trust = calls[0]
    assert ip in prepared.url
    assert prepared.headers['Host'] == 'example.test:443'
    assert pool['assert_hostname'] == pool['server_hostname'] == 'example.test'
    assert trust is False
    assert options['allow_redirects'] is False
    result.close()


def test_mixed_private_public_dns_is_rejected(monkeypatch):
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *a: address('8.8.8.8') + address('10.0.0.1'))
    with pytest.raises(URLValidationError):
        public_http.public_get('https://example.test')


@pytest.mark.parametrize('header', [None, '1', 'nonsense', '100000'])
def test_image_stream_aborts_and_always_closes(monkeypatch, header):
    consumed = []
    def chunks(**kwargs):
        for i in range(100):
            consumed.append(i)
            yield b'x' * 32
    response = SimpleNamespace(headers={} if header is None else {'Content-Length': header},
        is_redirect=False, is_permanent_redirect=False, raise_for_status=lambda: None,
        iter_content=chunks, close=Mock())
    monkeypatch.setattr(parsers, 'public_get', lambda *a, **k: response)
    from app.core.config import settings
    monkeypatch.setattr(settings, 'URL_IMAGE_MAX_SIZE', 64)
    assert UrlParser()._download_and_filter_image('https://example.test/image') is None
    assert len(consumed) <= 3
    response.close.assert_called()


def test_stream_deadline():
    response = SimpleNamespace(headers={}, iter_content=lambda **k: iter([b'1']))
    with pytest.raises(ValueError, match='时间'):
        read_limited(response, 100, time.monotonic() - 1)


def test_docx_expansion_budget_rejects_small_compressed_input(tmp_path):
    path = tmp_path / 'fixture.docx'
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', 'types')
        z.writestr('word/document.xml', 'x' * 10000)
    with pytest.raises(ValueError, match='预算'):
        validate_docx_archive(path, maximum=1024)
    with pytest.raises(ValueError, match='预算'):
        DocxParser().parse(path)


def test_image_pixels_and_unknown_format_rejected(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, 'PARSER_MAX_IMAGE_PIXELS', 100)
    out = io.BytesIO()
    Image.new('RGB', (20, 20)).save(out, format='PNG')
    assert not UrlParser._is_image_large_enough(out.getvalue())
    assert not UrlParser._is_image_large_enough(b'<svg/>')
