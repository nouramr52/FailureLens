"""
Tests for FailureLens Knowledge Graph Change Impact and Safe to Push Node Clearing.
"""
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import json
import pytest
import networkx as nx

from src.engine.visualizer import (
    classify_change_impact,
    inject_change_overlay,
    _legend_html,
    _apply_overlay_markup,
    STATUS_COLORS,
)


@pytest.fixture
def sample_graph():
    """Builds a test directed graph with callers and dependencies."""
    G = nx.DiGraph()
    # Add dummy nodes so critical hubs are concentrated on hub nodes
    for i in range(10):
        G.add_node(f"hub_{i}", source_file="src/hub.py", label=f"hub_{i}", _origin="ast")
        G.add_edge(f"hub_{i}", "node_hub", relation="calls")

    G.add_node("node_hub", source_file="src/hub.py", label="node_hub", _origin="ast")

    # Production nodes: A is called by B, B is called by C
    G.add_node("node_A", source_file="src/service/a.py", label="func_a", _origin="ast")
    G.add_node("node_B", source_file="src/service/b.py", label="func_b", _origin="ast")
    G.add_node("node_C", source_file="src/service/c.py", label="func_c", _origin="ast")

    # Directed call edges: B calls A, C calls B
    G.add_edge("node_B", "node_A", relation="calls")
    G.add_edge("node_C", "node_B", relation="calls")

    return G


def test_classify_change_impact_baseline(sample_graph):
    """Verifies baseline impact classification without cleared nodes."""
    # Simulate pending git changes in a.py
    changes = {"src/service/a.py": {1, 2, 3}}
    impact = classify_change_impact(sample_graph, changes=changes)

    assert impact["available"] is True
    nodes = impact["nodes"]

    # node_A should be edited
    assert "node_A" in nodes
    assert nodes["node_A"]["status"] == "edited"
    assert nodes["node_A"]["edited"] == "yes"

    # node_B should be affected (caller of A)
    assert "node_B" in nodes
    assert nodes["node_B"]["status"] == "affected"
    assert "Could be affected" in nodes["node_B"]["reason"]

    # node_C should also be reached / affected (depth 2)
    assert "node_C" in nodes
    assert nodes["node_C"]["status"] == "affected"


def test_classify_change_impact_with_cleared_nodes(sample_graph):
    """Verifies that clearing a node marks it as 'safe' and subtracts from affected."""
    changes = {"src/service/a.py": {1, 2, 3}}

    # Before clearing
    baseline = classify_change_impact(sample_graph, changes=changes)
    baseline_affected = sum(1 for n in baseline["nodes"].values() if n["status"] == "affected")
    assert baseline_affected == 2  # node_B and node_C

    # Clear node_B
    cleared_nodes = {"node_B"}
    cleared_impact = classify_change_impact(sample_graph, changes=changes, cleared_nodes=cleared_nodes)

    assert cleared_impact["nodes"]["node_B"]["status"] == "safe"
    assert "Safe to push" in cleared_impact["nodes"]["node_B"]["reason"]

    # node_C is still affected
    assert cleared_impact["nodes"]["node_C"]["status"] == "affected"

    # Count affected vs safe
    counts = {"edited": 0, "affected": 0, "safe": 0, "critical": 0}
    for info in cleared_impact["nodes"].values():
        counts[info["status"]] += 1

    assert counts["safe"] == 1
    assert counts["affected"] == baseline_affected - 1  # Subtracted!


def test_classify_change_impact_with_failed_nodes(sample_graph):
    """Verifies that failed test nodes are marked as 'failed'."""
    changes = {"src/service/a.py": {1, 2, 3}}
    failed_nodes = {"node_C"}
    cleared_nodes = {"node_B"}

    impact = classify_change_impact(
        sample_graph,
        changes=changes,
        cleared_nodes=cleared_nodes,
        failed_nodes=failed_nodes
    )

    assert impact["nodes"]["node_B"]["status"] == "safe"
    assert impact["nodes"]["node_C"]["status"] == "failed"
    assert "Test failed" in impact["nodes"]["node_C"]["reason"]

    counts = {"edited": 0, "affected": 0, "safe": 0, "failed": 0, "critical": 0}
    for info in impact["nodes"].values():
        counts[info["status"]] += 1

    assert counts["safe"] == 1
    assert counts["failed"] == 1
    assert counts["affected"] == 0


def test_legend_html_contains_safe_to_push():
    """Verifies that _legend_html renders the Safe to push counter."""
    impact = {"nodes": {"n1": {"edited": "yes", "status": "edited"}}, "message": ""}
    counts = {"edited": 1, "affected": 3, "safe": 2, "critical": 0}

    html = _legend_html(impact, counts)

    assert "Git change impact" in html
    assert "Safe to push" in html
    assert ">2<" in html  # Safe to push count
    assert "Could be affected" in html
    assert ">3<" in html  # Could be affected count
    assert "✓" in html


def test_apply_overlay_markup_idempotency(tmp_path):
    """Verifies that multiple overlay injections cleanly update without duplicating legends."""
    initial_html = (
        "<!DOCTYPE html><html><head></head><body>"
        "<div id=\"sidebar\"><div id=\"legend-wrap\"><h3>Communities</h3></div></div>"
        "<script>const RAW_NODES = [{\"id\": \"node_B\", \"title\": \"func_b\", \"color\": {}}];</script>"
        "</body></html>"
    )

    impact_1 = {
        "nodes": {
            "node_B": {"status": "affected", "reason": "Could be affected by change", "edited": "no"}
        }
    }
    applied_1 = _apply_overlay_markup(initial_html, impact_1)
    assert applied_1.count('id="change-legend"') == 1
    assert "Could be affected" in applied_1

    # Second injection with cleared node (safe)
    impact_2 = {
        "nodes": {
            "node_B": {"status": "safe", "reason": "Safe to push: tests passed", "edited": "no"}
        }
    }
    applied_2 = _apply_overlay_markup(applied_1, impact_2)

    # Must still have exactly ONE change-legend div (no duplication)
    assert applied_2.count('id="change-legend"') == 1
    assert "Safe to push" in applied_2


def test_classify_change_impact_edited_node_cleared(sample_graph):
    """Verifies that an edited node whose tests pass is marked as safe."""
    changes = {"src/service/a.py": {1, 2, 3}}
    cleared_files = {"src/service/a.py"}

    impact = classify_change_impact(sample_graph, changes=changes, cleared_files=cleared_files)
    assert impact["nodes"]["node_A"]["status"] == "safe"
    assert impact["nodes"]["node_A"]["edited"] == "yes"
    assert "Safe to push" in impact["nodes"]["node_A"]["reason"]


def test_safe_to_push_strictly_bounded_by_change_scope(sample_graph):
    """Verifies that unrelated cleared nodes across the repository cannot inflate Safe to push."""
    # Only a.py is changed in git -> change scope is node_A (edited), node_B (caller), node_C (caller of B)
    changes = {"src/service/a.py": {1, 2, 3}}

    # Suppose 100 unrelated hub nodes were cleared in past test runs
    stale_cleared_nodes = {f"hub_{i}" for i in range(10)} | {"node_B"}
    stale_cleared_files = {"src/hub.py"}

    impact = classify_change_impact(
        sample_graph,
        changes=changes,
        cleared_nodes=stale_cleared_nodes,
        cleared_files=stale_cleared_files,
    )

    nodes = impact["nodes"]
    # Total nodes in change impact must ONLY be the nodes affected by the change (A, B, C)
    assert len(nodes) == 3
    assert "node_A" in nodes
    assert "node_B" in nodes
    assert "node_C" in nodes

    # Unrelated hub nodes must NEVER be included in the change impact
    for i in range(10):
        assert f"hub_{i}" not in nodes

    # Safe to push count must ONLY count nodes within the change scope (node_B)
    safe_count = sum(1 for n in nodes.values() if n["status"] == "safe")
    assert safe_count == 1  # Only node_B, NOT 11!

