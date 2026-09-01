fn main() {
    let Some(manifest) = std::env::var_os("CARGO_MANIFEST_DIR") else {
        panic!("CARGO_MANIFEST_DIR is not set");
    };
    let manifest = std::path::PathBuf::from(manifest);
    let dist = manifest.join("../../web/dist");
    if let Err(error) = std::fs::create_dir_all(&dist) {
        panic!("failed to prepare frontend output directory: {error}");
    }
    println!("cargo:rerun-if-changed={}", dist.display());
}
