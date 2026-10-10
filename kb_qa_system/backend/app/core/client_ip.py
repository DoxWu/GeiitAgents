"""Resolve client IPs from the socket peer and a configured proxy chain."""

import ipaddress

from app.core.config import settings


def _parse_ip(value: str):
    try:
        return ipaddress.ip_address(value.strip())
    except (ValueError, AttributeError):
        return None


def _trusted_networks():
    networks = []
    for entry in settings.TRUSTED_PROXIES.split(","):
        value = entry.strip()
        if not value:
            continue
        try:
            networks.append(ipaddress.ip_network(value, strict=False))
        except ValueError:
            continue
    return networks


def get_client_ip(request) -> str | None:
    peer = _parse_ip(request.client.host) if request.client else None
    if peer is None:
        return None

    networks = _trusted_networks()
    if not any(peer.version == network.version and peer in network for network in networks):
        return str(peer)

    chain = []
    for value in request.headers.get("X-Forwarded-For", "").split(","):
        parsed = _parse_ip(value)
        if parsed is None:
            return str(peer)
        chain.append(parsed)

    chain.append(peer)
    for address in reversed(chain):
        if not any(
            address.version == network.version and address in network
            for network in networks
        ):
            return str(address)
    return str(chain[0]) if chain else str(peer)
