from typing import List


def chunk_text(text: str, chunk_size: int = 500, overlap: int = 100) -> List[str]:
    """
    Split text into overlapping chunks using a sliding window approach.

    Args:
        text:       The full extracted text string.
        chunk_size: Number of words per chunk.
        overlap:    Number of words to overlap between consecutive chunks.

    Returns:
        List of text chunks.
    """
    words = text.split()
    chunks = []
    step = chunk_size - overlap
    start = 0

    while start < len(words):
        end = start + chunk_size
        chunk = " ".join(words[start:end])
        chunks.append(chunk)
        start += step

    return chunks


if __name__ == "__main__":
    import sys
    from pdf_reader import extract_text_from_pdf

    if len(sys.argv) < 2:
        print("Usage: python text_chunker.py <path_to_pdf>")
        sys.exit(1)

    text = extract_text_from_pdf(sys.argv[1])
    chunks = chunk_text(text)

    print(f"Total chunks: {len(chunks)}\n")
    for i, chunk in enumerate(chunks[:3], 1):
        print(f"--- Chunk {i} ---\n{chunk}\n")