fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_prost_build::configure()
        .build_server(false)
        .build_transport(false)
        .compile_protos(&["../proto/bud/v1/bud.proto"], &["../proto"])?;
    Ok(())
}
