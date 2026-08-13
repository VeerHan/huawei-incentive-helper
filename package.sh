#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
version="$(node -p "require('${script_dir}/manifest.json').version")"
dist_dir="${script_dir}/dist"
archive_path="${dist_dir}/huawei-incentive-helper-${version}.zip"
stage_root="$(mktemp -d)"
stage_dir="${stage_root}/huawei-incentive-helper"

cleanup() {
  rm -rf "${stage_root}"
}
trap cleanup EXIT

mkdir -p "${stage_dir}" "${dist_dir}"
cp "${script_dir}/manifest.json" "${stage_dir}/manifest.json"
cp "${script_dir}/personal-config.js" "${stage_dir}/personal-config.js"
cp "${script_dir}/content.js" "${stage_dir}/content.js"
cp "${script_dir}/styles.css" "${stage_dir}/styles.css"
cp "${script_dir}/INSTALL.md" "${stage_dir}/INSTALL.md"
cp "${script_dir}/LICENSE" "${stage_dir}/LICENSE"

rm -f "${archive_path}"
(
  cd "${stage_root}"
  zip -q -r "${archive_path}" "huawei-incentive-helper"
)

echo "${archive_path}"
