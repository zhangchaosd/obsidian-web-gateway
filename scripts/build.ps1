$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot

npm --prefix "$ProjectDir/web" ci
npm --prefix "$ProjectDir/web" run build
cargo build --manifest-path "$ProjectDir/Cargo.toml" --release
