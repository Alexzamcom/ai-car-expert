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
