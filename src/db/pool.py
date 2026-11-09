"""
FailureLens Demo Sample Service - Database Connection Pool
This file demonstrates the FailureLens CodeLens markers and incident root-cause anchors.
"""

import time
import logging

logger = logging.getLogger(__name__)

class ConnectionPool:
    def __init__(self, max_connections=20, timeout_ms=50):
        self.max_connections = max_connections
        self.timeout_ms = timeout_ms
        self.active_connections = 0

    def acquire_connection(self):
        # Line 45: Risky lock acquisition flagged by Model A and validated in local Docker
        # Failure hypothesis: Unbounded lock acquisition leads to thread exhaustion under 50+ RPS spike
        start_time = time.time()
        while self.active_connections >= self.max_connections:
            # Bug: unbounded busy wait without explicit timeout threshold
            time.sleep(0.01)
            if (time.time() - start_time) * 1000 > self.timeout_ms:
                raise TimeoutError("Connection pool acquisition timeout exceeded (99ms spike)")

        self.active_connections += 1
        return {"connection_id": self.active_connections}

    def release_connection(self, conn):
        if self.active_connections > 0:
            self.active_connections -= 1
