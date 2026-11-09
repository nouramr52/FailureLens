"""
FailureLens Knowledge Engine - Interactive Visualizer
Generates a standalone, dark-themed interactive Vis.js network graph HTML.
"""
from pathlib import Path
from typing import Dict, List, Optional
import networkx as nx

def generate_graph_html(
    G: nx.Graph,
    communities: Dict[int, List[str]],
    output_path: Path,
    community_labels: Optional[Dict[int, str]] = None
) -> bool:
    """
    Renders an interactive D3 / Vis.js network visualization of the repository knowledge graph.
    """
    from src.engine.core.export import to_html

    out_file = str(output_path.resolve())
    output_path.parent.mkdir(parents=True, exist_ok=True)

    success = to_html(
        G=G,
        communities=communities,
        output_path=out_file,
        community_labels=community_labels
    )

    if success and output_path.exists():
        # Inject FailureLens custom header and branding
        try:
            content = output_path.read_text(encoding="utf-8")
            if "<title>" in content:
                content = content.replace(
                    "<title>Knowledge Graph</title>",
                    "<title>FailureLens Repository Knowledge Graph</title>"
                )
            output_path.write_text(content, encoding="utf-8")
        except Exception:
            pass

    return success
