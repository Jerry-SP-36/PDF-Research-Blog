"""Read-only decoder/page-count verification after the JS report validator."""
import json
import re
import subprocess
import sys
from PIL import Image

request = json.load(sys.stdin)
errors = []
page_counts = {}
for source in request["sources"]:
    try:
        process = subprocess.run([request["pdfinfo"], source["path"]], capture_output=True, text=True, timeout=30)
        match = re.search(r"^Pages:\s+(\d+)\s*$", process.stdout, re.MULTILINE)
        if process.returncode or not match:
            raise ValueError("PDF page count could not be read")
        total = int(match.group(1))
        page_counts[source["id"]] = total
        if any(page > total for page in source["pagesRead"]):
            raise ValueError("a cited page exceeds the PDF page count")
    except Exception as error:
        errors.append(f'{source["id"]}: {error}')
for figure in request["figures"]:
    try:
        with Image.open(figure["path"]) as im:
            im.verify()
        with Image.open(figure["path"]) as im:
            im.load()
            if min(im.size) < 80:
                raise ValueError("figure is too small to read")
    except Exception as error:
        errors.append(f'{figure["id"]}: {error}')
json.dump({"valid": not errors, "errors": errors, "pageCounts": page_counts}, sys.stdout, ensure_ascii=False)
