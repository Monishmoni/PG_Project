

import sys
import os

from src.pdf_reader import extract_text_from_pdf
from src.text_chunker import chunk_text
from src.gap_detector import detect_gaps
from src.gap_cluster import cluster_gaps, print_clusters


def main():
    if len(sys.argv) < 2:
        print("Usage: python main.py <path_to_pdf>")
        sys.exit(1)

    pdf_path = sys.argv[1]

    if not os.path.exists(pdf_path):
        print(f"Error: File not found: {pdf_path}")
        sys.exit(1)

    print("=" * 50)
    print("  LLM-Based Research Gap Identifier")
    print("=" * 50)

    # Step 1: Extract text
    print(f"\n[1/4] Extracting text from: {pdf_path}")
    text = extract_text_from_pdf(pdf_path)
    word_count = len(text.split())
    print(f"      ✓ Extracted {word_count:,} words")

    # Step 2: Chunk text
    print("\n[2/4] Chunking text (window=500 words, overlap=100)...")
    chunks = chunk_text(text, chunk_size=500, overlap=100)
    print(f"      ✓ Created {len(chunks)} chunks")

    # Step 3: Detect gaps
    print(f"\n[3/4] Detecting research gaps across {len(chunks)} chunks...")
    gaps = detect_gaps(chunks)

    if not gaps:
        print("\n  No research gaps were identified in this paper.")
        sys.exit(0)

    print(f"      ✓ Found {len(gaps)} unique research gaps")

    # Step 4: Cluster gaps
    print("\n[4/4] Clustering gaps by theme...")
    clusters = cluster_gaps(gaps)
    print(f"      ✓ Grouped into {len(clusters)} themes")

    # Final output
    print_clusters(clusters)

    print("=" * 50)
    print(f"  Done! {len(gaps)} gaps across {len(clusters)} themes.")
    print("=" * 50)


if __name__ == "__main__":
    main()