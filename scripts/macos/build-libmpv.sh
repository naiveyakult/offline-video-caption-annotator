#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="${ROOT_DIR}/scripts/macos/libmpv-runtime.json"
MPV_PATCH="${ROOT_DIR}/scripts/macos/patches/mpv-0.41.0-coreaudio-utils.patch"
DLOPEN_CHECK="${ROOT_DIR}/scripts/macos/check-libmpv-dlopen.py"
# Keep the dependency prefix on an ASCII-only path. pkgconf output is consumed by
# Meson as UTF-8, while absolute paths containing CJK characters can be emitted in
# the active macOS locale encoding and make Meson's Python process fail to decode.
WORK_DIR="${LIBMPV_BUILD_DIR:-${HOME}/Library/Caches/offline-video-caption-annotator/libmpv-build}"
PREFIX="${WORK_DIR}/prefix"
DOWNLOADS="${WORK_DIR}/downloads"
SOURCES="${WORK_DIR}/sources"
OUTPUT_DIR="${LIBMPV_OUTPUT_DIR:-${ROOT_DIR}/src-tauri/frameworks}"
JOBS="${LIBMPV_JOBS:-$(sysctl -n hw.logicalcpu 2>/dev/null || echo 4)}"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "libmpv runtime must be built on Apple Silicon macOS" >&2
  exit 1
fi

mkdir -p "${DOWNLOADS}" "${SOURCES}" "${PREFIX}" "${OUTPUT_DIR}"

if [[ ! -x "${WORK_DIR}/venv/bin/meson" ]]; then
  python3 -m venv "${WORK_DIR}/venv"
  "${WORK_DIR}/venv/bin/python" -m pip install --disable-pip-version-check \
    'meson==1.7.0' 'ninja==1.11.1.3'
fi
export PATH="${WORK_DIR}/venv/bin:${PREFIX}/bin:${PATH}"
export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"
export PKG_CONFIG_PATH="${PREFIX}/lib/pkgconfig"
export PKG_CONFIG="${PREFIX}/bin/pkgconf"
# pkgconf is installed into PREFIX and otherwise treats that same prefix as a
# system path, stripping the -I/-L flags that mpv needs to consume static FFmpeg.
export PKG_CONFIG_ALLOW_SYSTEM_CFLAGS=1
export PKG_CONFIG_ALLOW_SYSTEM_LIBS=1
export MACOSX_DEPLOYMENT_TARGET=13.0
export CFLAGS="${CFLAGS:-} -mmacosx-version-min=13.0"
export CXXFLAGS="${CXXFLAGS:-} -mmacosx-version-min=13.0"
export LDFLAGS="${LDFLAGS:-} -mmacosx-version-min=13.0 -L${PREFIX}/lib"

while IFS=$'\t' read -r name version url sha256; do
  extension="tar.gz"
  [[ "${url}" == *.tar.xz ]] && extension="tar.xz"
  archive="${DOWNLOADS}/${name}-${version}.${extension}"
  if [[ ! -f "${archive}" ]] || [[ "$(shasum -a 256 "${archive}" | awk '{print $1}')" != "${sha256}" ]]; then
    curl --fail --location --retry 3 --output "${archive}" "${url}"
  fi
  echo "${sha256}  ${archive}" | shasum -a 256 --check --status
  source_dir="${SOURCES}/${name}"
  source_stamp="${source_dir}/.source-sha256"
  if [[ ! -f "${source_stamp}" ]] || [[ "$(<"${source_stamp}")" != "${sha256}" ]]; then
    rm -rf "${source_dir}"
    mkdir -p "${source_dir}"
    tar -xf "${archive}" --strip-components=1 -C "${source_dir}"
    printf '%s' "${sha256}" > "${source_stamp}"
  fi
done < <(python3 - "${MANIFEST}" <<'PY'
import json, sys
for source in json.load(open(sys.argv[1], encoding="utf-8"))["sources"]:
    print(source["name"], source["version"], source["url"], source["sha256"], sep="\t")
PY
)

if patch --directory="${SOURCES}/mpv" --strip=1 --forward --dry-run < "${MPV_PATCH}" >/dev/null 2>&1; then
  patch --directory="${SOURCES}/mpv" --strip=1 --forward < "${MPV_PATCH}"
elif patch --directory="${SOURCES}/mpv" --strip=1 --reverse --dry-run < "${MPV_PATCH}" >/dev/null 2>&1; then
  echo "mpv CoreAudio helper patch already applied"
else
  echo "mpv CoreAudio helper patch does not apply cleanly" >&2
  exit 1
fi

build_meson() {
  local name="$1"
  shift
  rm -rf "${SOURCES:?}/${name}/build"
  meson setup "${SOURCES}/${name}/build" "${SOURCES}/${name}" \
    --prefix="${PREFIX}" --libdir=lib --buildtype=release \
    -Ddefault_library=static "$@"
  meson compile -C "${SOURCES}/${name}/build" -j "${JOBS}"
  meson install -C "${SOURCES}/${name}/build"
}

if [[ ! -x "${PREFIX}/bin/pkgconf" ]]; then
  pushd "${SOURCES}/pkgconf" >/dev/null
  ./configure --prefix="${PREFIX}" --disable-shared --enable-static
  make -j "${JOBS}"
  make install
  popd >/dev/null
fi

if [[ ! -f "${PREFIX}/lib/libfreetype.a" ]]; then
  build_meson freetype \
    -Dbrotli=disabled -Dbzip2=disabled -Dharfbuzz=disabled -Dpng=disabled \
    -Dzlib=disabled -Dtests=disabled
fi
if [[ ! -f "${PREFIX}/lib/libfribidi.a" ]]; then
  build_meson fribidi -Ddocs=false -Dbin=false -Dtests=false
fi
if [[ ! -f "${PREFIX}/lib/libharfbuzz.a" ]]; then
  build_meson harfbuzz \
    -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dchafa=disabled \
    -Dicu=disabled -Dfreetype=enabled -Dcoretext=disabled -Dtests=disabled \
    -Dintrospection=disabled -Ddocs=disabled -Dutilities=disabled
fi
if [[ ! -f "${PREFIX}/lib/libass.a" ]]; then
  build_meson libass \
    -Dfontconfig=disabled -Ddirectwrite=disabled -Dcoretext=enabled -Dasm=disabled \
    -Dlibunibreak=disabled -Drequire-system-font-provider=true -Dtest=false
fi

if [[ ! -f "${PREFIX}/lib/libavcodec.a" ]] || [[ ! -x "${PREFIX}/bin/ffmpeg" ]]; then
  rm -rf "${SOURCES}/ffmpeg/build"
  mkdir -p "${SOURCES}/ffmpeg/build"
  pushd "${SOURCES}/ffmpeg/build" >/dev/null
  ../configure \
    --prefix="${PREFIX}" --libdir="${PREFIX}/lib" \
    --disable-shared --enable-static --enable-pic \
    --disable-programs --enable-ffmpeg --disable-ffplay --disable-ffprobe \
    --disable-doc --disable-debug --disable-network --disable-autodetect \
    --enable-videotoolbox --enable-audiotoolbox
  make -j "${JOBS}"
  make install
  popd >/dev/null
fi

for submodule in glad jinja markupsafe Vulkan-Headers fast_float; do
  rm -rf "${SOURCES}/libplacebo/3rdparty/${submodule}"
  cp -R "${SOURCES}/${submodule}" "${SOURCES}/libplacebo/3rdparty/${submodule}"
done

if [[ ! -f "${PREFIX}/lib/libplacebo.a" ]]; then
  build_meson libplacebo \
    -Dvulkan=disabled -Dopengl=enabled -Dgl-proc-addr=enabled \
    -Dglslang=disabled -Dshaderc=disabled -Dlcms=disabled -Ddovi=disabled \
    -Dlibdovi=disabled -Dunwind=disabled -Dxxhash=disabled -Ddemos=false -Dtests=false
fi

rm -rf "${SOURCES}/mpv/build"
meson setup "${SOURCES}/mpv/build" "${SOURCES}/mpv" \
  --prefix="${PREFIX}" --libdir=lib --buildtype=release \
  -Ddefault_library=shared -Dbuild-date=false -Dgpl=false -Dcplayer=false -Dlibmpv=true \
  -Djavascript=disabled -Dlua=disabled -Dlibarchive=disabled \
  -Drubberband=disabled -Duchardet=disabled -Dzimg=disabled \
  -Dcoreaudio=enabled -Dcocoa=disabled -Dgl-cocoa=disabled \
  -Dvideotoolbox-gl=disabled -Dvideotoolbox-pl=disabled \
  -Dmacos-cocoa-cb=disabled -Dswift-build=disabled \
  -Dhtml-build=disabled -Dmanpage-build=disabled
meson compile -C "${SOURCES}/mpv/build" -j "${JOBS}"
meson install -C "${SOURCES}/mpv/build"

runtime="$(find "${PREFIX}/lib" -maxdepth 1 -name 'libmpv.*.dylib' -print -quit)"
if [[ -z "${runtime}" ]]; then
  echo "libmpv dylib was not produced" >&2
  exit 1
fi
cp "${runtime}" "${OUTPUT_DIR}/libmpv.2.dylib"
install_name_tool -id '@rpath/libmpv.2.dylib' "${OUTPUT_DIR}/libmpv.2.dylib"

if nm -u "${OUTPUT_DIR}/libmpv.2.dylib" | grep -Eq '_cfstr_(from|get)_cstr'; then
  echo "libmpv still contains unresolved CoreFoundation string helpers" >&2
  exit 1
fi
python3 "${DLOPEN_CHECK}" "${OUTPUT_DIR}/libmpv.2.dylib"

unexpected="$(otool -L "${OUTPUT_DIR}/libmpv.2.dylib" | awk 'NR > 1 {print $1}' | grep -Ev '^(@rpath/libmpv\.2\.dylib|/System/Library/|/usr/lib/)' || true)"
if [[ -n "${unexpected}" ]]; then
  echo "Unexpected non-system libmpv dependencies:" >&2
  echo "${unexpected}" >&2
  exit 1
fi

codesign --force --sign - "${OUTPUT_DIR}/libmpv.2.dylib"

LICENSE_DIR="${OUTPUT_DIR}/licenses"
rm -rf "${LICENSE_DIR}"
mkdir -p "${LICENSE_DIR}"
cp "${SOURCES}/mpv/LICENSE.LGPL" "${LICENSE_DIR}/mpv-LGPL-2.1.txt"
cp "${SOURCES}/ffmpeg/LICENSE.md" "${LICENSE_DIR}/FFmpeg-LICENSE.md"
cp "${SOURCES}/ffmpeg/COPYING.LGPLv2.1" "${LICENSE_DIR}/FFmpeg-LGPL-2.1.txt"
cp "${SOURCES}/libplacebo/LICENSE" "${LICENSE_DIR}/libplacebo-LGPL-2.1.txt"
cp "${SOURCES}/libass/COPYING" "${LICENSE_DIR}/libass-ISC.txt"
cp "${SOURCES}/harfbuzz/COPYING" "${LICENSE_DIR}/HarfBuzz-COPYING.txt"
cp "${SOURCES}/freetype/LICENSE.TXT" "${LICENSE_DIR}/FreeType-LICENSE.txt"
cp "${SOURCES}/fribidi/COPYING" "${LICENSE_DIR}/FriBidi-LGPL-2.1.txt"
cp "${SOURCES}/pkgconf/COPYING" "${LICENSE_DIR}/pkgconf-ISC.txt"
cp "${SOURCES}/glad/LICENSE" "${LICENSE_DIR}/Glad-MIT.txt"
cp "${SOURCES}/jinja/LICENSE.txt" "${LICENSE_DIR}/Jinja-BSD-3-Clause.txt"
cp "${SOURCES}/markupsafe/LICENSE.txt" "${LICENSE_DIR}/MarkupSafe-BSD-3-Clause.txt"
cp "${SOURCES}/Vulkan-Headers/LICENSE.md" "${LICENSE_DIR}/Vulkan-Headers-Apache-2.0.md"
cp "${SOURCES}/fast_float/LICENSE-APACHE" "${LICENSE_DIR}/fast_float-Apache-2.0.txt"
cp "${SOURCES}/fast_float/LICENSE-MIT" "${LICENSE_DIR}/fast_float-MIT.txt"
shasum -a 256 "${OUTPUT_DIR}/libmpv.2.dylib"
