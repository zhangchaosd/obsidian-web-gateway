#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"

npm --prefix "$project_dir/web" ci
npm --prefix "$project_dir/web" run build
cargo build --manifest-path "$project_dir/Cargo.toml" --release
