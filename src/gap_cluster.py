from typing import List, Dict
from anthropic import Anthropic

client = Anthropic()

SYSTEM_PROMPT = """You are a research analyst. You will be given a list of research gaps extracted from a scientific paper.
Your task is to group semantically similar gaps into clusters and give each cluster a short descriptive theme label.

Respond ONLY in this exact JSON format:
{
  "clusters": [
    {
      "theme": "Short theme label",
      "gaps": ["gap text 1", "gap text 2"]
    }
  ]
}

Rules:
- Each gap must appear in exactly one cluster
- Merge only genuinely similar gaps
- Keep distinct gaps in their own cluster
- Theme labels should be concise (3-6 words)"""


def cluster_gaps(gaps: List[str]) -> Dict[str, List[str]]:
    """
    Group similar research gaps into thematic clusters using Claude.

    Args:
        gaps: List of research gap strings.

    Returns:
        Dictionary mapping theme label -> list of gaps in that cluster.
    """
    if not gaps:
        return {}

    numbered = "\n".join(f"{i+1}. {gap}" for i, gap in enumerate(gaps))

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": f"Cluster the following research gaps:\n\n{numbered}"
            }
        ]
    )

    raw = response.content[0].text.strip()

    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.strip("```").strip()
        if raw.startswith("json"):
            raw = raw[4:].strip()

    import json
    data = json.loads(raw)

    return {
        cluster["theme"]: cluster["gaps"]
        for cluster in data["clusters"]
    }


def print_clusters(clusters: Dict[str, List[str]]) -> None:
    """Pretty-print clustered research gaps."""
    print(f"\n=== Clustered Research Gaps ({len(clusters)} themes) ===\n")
    for theme, gaps in clusters.items():
        print(f"🔹 {theme}")
        for gap in gaps:
            print(f"   • {gap}")
        print()


if __name__ == "__main__":
    import sys
    sys.path.insert(0, ".")
    from pdf_reader import extract_text_from_pdf
    from text_chunker import chunk_text
    from gap_detector import detect_gaps

    if len(sys.argv) < 2:
        print("Usage: python gap_cluster.py <path_to_pdf>")
        sys.exit(1)

    print("Extracting text...")
    text = extract_text_from_pdf(sys.argv[1])

    print("Chunking text...")
    chunks = chunk_text(text)

    print(f"Detecting gaps across {len(chunks)} chunks...")
    gaps = detect_gaps(chunks)
    print(f"Found {len(gaps)} unique gaps.\n")

    print("Clustering gaps...")
    clusters = cluster_gaps(gaps)

    print_clusters(clusters)