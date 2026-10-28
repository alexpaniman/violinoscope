#!/bin/bash
# Runs a Python script with Playwright's headless Chromium available. Machine-specific paths (where Playwright and
# its browsers are installed, extra shared libraries, fonts) go in tools/browser.env, which git ignores, e.g.:
#   export PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
#   export PYTHONPATH=/opt/pylib
HERE=$(dirname "$(readlink -f "$0")")
[ -f "$HERE/browser.env" ] && . "$HERE/browser.env"
exec python3 "$@"
