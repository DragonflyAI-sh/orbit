#!/bin/sh
# Rebuilds pico.orbit.min.css from Pico CSS's own Sass sources and orbit-pico.scss (README.md in this folder).
# A one-off vendoring step, run by hand when the library is upgraded or its module list changes; ORBIT itself has no
# build step and never runs this. It needs Node and npm, and network access to the npm registry, in a temporary folder.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
PICO_VERSION=2.1.1
SASS_VERSION=1.107.1
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund --ignore-scripts "@picocss/pico@$PICO_VERSION" "sass@$SASS_VERSION"
npx --no-install sass --no-source-map --style=compressed --quiet --load-path=node_modules/@picocss \
  "$here/orbit-pico.scss" "$work/out.css"
# Sass writes a byte-order mark when the output has non-ASCII text (Pico's banner); the server sends charset=utf-8 instead.
node -e 'const fs = require("node:fs"); fs.writeFileSync(process.argv[2], fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, ""))' \
  "$work/out.css" "$here/pico.orbit.min.css"
cp node_modules/@picocss/pico/LICENSE.md "$here/LICENSE.md"
node -e 'console.log(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$here/pico.orbit.min.css"
