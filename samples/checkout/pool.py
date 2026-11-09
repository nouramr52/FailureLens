"""Checkout connection pool.

The acquire timeout is the line a release check should notice. Tests require it to stay at 50ms.
"""


def configured_timeout() -> int:
    return 50


class ConnectionPool:
    def __init__(self, timeout_ms: int | None = None) -> None:
        self.timeout_ms = configured_timeout() if timeout_ms is None else timeout_ms


def acquire_connection(pool: ConnectionPool) -> str:
    if pool.timeout_ms < configured_timeout():
        raise TimeoutError(f"Pool saturated ({pool.timeout_ms}ms)")
    return "connection"
