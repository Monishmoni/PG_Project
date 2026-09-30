import os
from typing import List
from anthropic import Anthropic

client = Anthropic()

SYSTEM_PROMPT = """You are an expert research analyst specializing in identifying gaps in scientific literature.
When given a passage from a research paper, extract any explicitly stated or implied research gaps, 
limitations, future work suggestions, or unanswered questions.

Respond ONLY as a numbered list of concise research gaps. If no gaps are found, respond with "NO_GAPS"."""


def detect_gaps_in_chunk(chunk: str) -> List[str]:
    """
    Detect research gaps in a single text chunk using Claude.

    Args:
        chunk: A text chunk from a research paper.

    Returns:
        List of identified research gaps.
    """
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": f"Identify research gaps in the following passage:\n\n{chunk}"
            }
        ]
    )

    raw = response.content[0].text.strip()

    if raw == "NO_GAPS":
        return []

    gaps = []
    for line in raw.splitlines():
        line = line.strip()
        if line and line[0].isdigit():
            # Strip leading number and punctuation, e.g. "1. " or "1) "
            gap = line.lstrip("0123456789").lstrip(".").lstrip(")").strip()
            if gap:
                gaps.append(gap)

    return gaps


def detect_gaps(chunks: List[str]) -> List[str]:
    """
    Detect research gaps across all text chunks.

    Args:
        chunks: List of text chunks from a research paper.

    Returns:
        Deduplicated list of all identified research gaps.
    """
    all_gaps = []

    for i, chunk in enumerate(chunks, 1):
        print(f"Analyzing chunk {i}/{len(chunks)}...")
        gaps = detect_gaps_in_chunk(chunk)
        all_gaps.extend(gaps)

    # Basic deduplication: remove exact duplicates while preserving order
    seen = set()
    unique_gaps = []
    for gap in all_gaps:
        normalized = gap.lower().strip()
        if normalized not in seen:
            seen.add(normalized)
            unique_gaps.append(gap)

    return unique_gaps


if __name__ == "__main__":
    import sys
    sys.path.insert(0, ".")
    from pdf_reader import extract_text_from_pdf
    from text_chunker import chunk_text

    if len(sys.argv) < 2:
        print("Usage: python gap_detector.py <path_to_pdf>")
        sys.exit(1)

    print("Extracting text...")
    text = extract_text_from_pdf(sys.argv[1])

    print("Chunking text...")
    chunks = chunk_text(text)

    print(f"Detecting gaps across {len(chunks)} chunks...\n")
    gaps = detect_gaps(chunks)

    print(f"\n=== Research Gaps Found ({len(gaps)}) ===")
    for i, gap in enumerate(gaps, 1):
        print(f"{i}. {gap}")