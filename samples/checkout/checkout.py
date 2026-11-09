"""Checkout entry point. Calls the pool, so a pool change lands in this blast radius."""

from samples.checkout.pool import ConnectionPool, acquire_connection


def handle_checkout_request() -> str:
    return acquire_connection(ConnectionPool())
