import fitz  # PyMuPDF


def extract_text_from_pdf(file_path: str) -> str:
    """
    Extract text from a PDF file.

    Args:
        file_path: Path to the PDF file.

    Returns:
        Extracted text as a single string.
    """
    extracted_pages = []

    with fitz.open(file_path) as doc:
        for page in doc:
            text = page.get_text()
            extracted_pages.append(text)

    return "\n".join(extracted_pages)


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python pdf_reader.py <path_to_pdf>")
        sys.exit(1)

    path = sys.argv[1]
    result = extract_text_from_pdf(path)
    print(result)
