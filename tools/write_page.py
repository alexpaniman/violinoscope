#!/usr/bin/env python3
"""Writes OUT_DIR/index.html again from web/, keeping the data: for trying changes to the page without reading the
spans again.

  write_page.py OUT_DIR
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import violinoscope  # noqa: E402

if __name__ == '__main__':
    violinoscope.write_page(sys.argv[1])
