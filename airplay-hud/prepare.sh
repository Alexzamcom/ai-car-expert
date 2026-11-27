#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "$0")" && pwd)"
receiver="$(realpath "$1")"
revision=05b193662f7c33d6fe70b05a36895103a594922b
test "$(git -C "$receiver" rev-parse HEAD)" = "$revision"
git -C "$receiver" apply --check "$project/hud.patch"
git -C "$receiver" apply "$project/hud.patch"

# Use the official distribution and verify it against the release checksum.
openssl_cmake="$receiver/app/src/main/cpp/third_party/openssl-cmake/cmake/BuildOpenSSL.cmake"
sed -i 's|https://mirror.viaduck.org/openssl/openssl-${OPENSSL_BUILD_VERSION}.tar.gz|https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_BUILD_VERSION}/openssl-${OPENSSL_BUILD_VERSION}.tar.gz|' "$openssl_cmake"
grep -Fq 'https://github.com/openssl/openssl/releases/download/' "$openssl_cmake"
sed -i '/set(OPENSSL_BUILD_VERSION "3.4.4"/a set(OPENSSL_BUILD_HASH "7bdf55ac20f2779e99e5eca306f824fad2b37dee5a06cc35ed5a8b85a6060010" CACHE STRING "" FORCE)' "$receiver/app/src/main/cpp/CMakeLists.txt"

assets="$receiver/app/src/main/assets/ace-hud"
mkdir -p "$assets"
cp "$project"/web/* "$assets/"
cp "$project/../src/styles/hud.css" "$assets/"
downloads="$(mktemp -d)"
trap 'rm -rf "$downloads"' EXIT
fetch() {
  curl --fail --silent --show-error --location --retry 3 "$1" -o "$downloads/$2"
  printf '%s  %s\n' "$3" "$downloads/$2" | sha256sum -c -
}
fetch https://registry.npmjs.org/tesseract.js/-/tesseract.js-6.0.1.tgz web.tgz 4a208f2560a527ea9fc339ba2fdf125c13bca6638c194a149379601a1418d0ed
fetch https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-6.0.0.tgz core.tgz 197b53b6bc42b7270c99b079e438992096d71a2b9b8237c6349491bd22fbd5a0
tar -xzf "$downloads/web.tgz" -C "$assets" --strip-components=2 \
  package/dist/tesseract.min.js package/dist/worker.min.js \
  package/dist/tesseract.min.js.LICENSE.txt package/dist/worker.min.js.LICENSE.txt
tar -xzf "$downloads/core.tgz" -C "$assets" --strip-components=1 package/tesseract-core-lstm.wasm.js package/LICENSE
fetch https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/ukr.traineddata ukr.traineddata d59e53e2bded32f4445f124b4b00240fcac7e8044c003ab822ccb94f0b3db59b
fetch https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/rus.traineddata rus.traineddata e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225
cp "$downloads"/*.traineddata "$assets/"
cp "$project"/native/*.kt "$receiver/app/src/main/kotlin/io/github/jqssun/airplay/ui/"
