"""Covering test for the checkout pool timeout."""

from samples.checkout.pool import ConnectionPool, acquire_connection


def test_acquire_timeout_stays_safe():
    pool = ConnectionPool()
    assert pool.timeout_ms == 50
    assert acquire_connection(pool) == "connection"
