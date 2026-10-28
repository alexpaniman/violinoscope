#!/usr/bin/env python3
"""Writes artifact.html next to a generated explorer's index.html: the same page without the document skeleton,
which the artifact host adds itself.

  artifact_page.py OUT_DIR
"""
import os
import re
import sys


def main():
    out = sys.argv[1]
    page = open(os.path.join(out, 'index.html')).read()
    page = re.sub(r'\A<!doctype html>\n<html[^>]*><head>.*?</style>\n', '', page, flags=re.S)
    page = page.replace('</head><body>\n', '').replace('</body></html>\n', '')
    if '<html' in page or '<body' in page:
        sys.exit('artifact_page.py: unexpected skeleton in index.html')
    with open(os.path.join(out, 'artifact.html'), 'w') as f:
        f.write(page)


if __name__ == '__main__':
    main()
