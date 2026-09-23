//! Inspect Chrome's encoded image dimensions without allocating a decoded bitmap.
use anyhow::{bail, Context, Result};
use base64::Engine;

pub(super) fn dimensions(image: &str, png: bool) -> Result<(u32, u32)> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image)
        .context("browser_invalid_image")?;
    let size = if png {
        if bytes.get(..8) != Some(b"\x89PNG\r\n\x1a\n")
            || bytes.get(8..16) != Some(&[0, 0, 0, 13, b'I', b'H', b'D', b'R'])
        {
            bail!("browser_invalid_image");
        }
        let header = bytes.get(16..24).context("browser_invalid_image")?;
        (
            u32::from_be_bytes(header[..4].try_into()?),
            u32::from_be_bytes(header[4..].try_into()?),
        )
    } else {
        jpeg_dimensions(&bytes).context("browser_invalid_image")?
    };
    if size.0 == 0 || size.1 == 0 {
        bail!("browser_invalid_image");
    }
    Ok(size)
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(..2)? != [0xff, 0xd8] {
        return None;
    }
    let mut at = 2;
    while at < bytes.len() {
        if *bytes.get(at)? != 0xff {
            return None;
        }
        while bytes.get(at) == Some(&0xff) {
            at += 1;
        }
        let marker = *bytes.get(at)?;
        at += 1;
        if matches!(marker, 0xda | 0xd9 | 0x00) {
            return None;
        }
        if matches!(marker, 0x01 | 0xd0..=0xd7) {
            continue;
        }
        let length = u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?) as usize;
        if length < 2 {
            return None;
        }
        let segment = bytes.get(at..at.checked_add(length)?)?;
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            let height = u16::from_be_bytes(segment.get(3..5)?.try_into().ok()?) as u32;
            let width = u16::from_be_bytes(segment.get(5..7)?.try_into().ok()?) as u32;
            return Some((width, height));
        }
        at += length;
    }
    None
}

pub(super) fn within_bounds((width, height): (u32, u32), enhanced: bool) -> bool {
    let side = if enhanced { 2560 } else { 1280 };
    width > 0
        && height > 0
        && width <= side
        && height <= side
        && u64::from(width) * u64::from(height) <= 4_000_000
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_bounds_reject_compressible_oversize_and_area_overflow() {
        assert!(!within_bounds((3468, 2556), true));
        assert!(!within_bounds((2560, 2560), true));
        assert!(within_bounds((2000, 2000), true));
        assert!(!within_bounds((1281, 400), false));
        assert!(within_bounds((1280, 960), false));
        assert!(!within_bounds((0, 10), true));
    }
    #[test]
    fn reads_png_and_jpeg_headers_and_rejects_truncation() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend(3468u32.to_be_bytes());
        png.extend(2556u32.to_be_bytes());
        let encode = |data: &[u8]| base64::engine::general_purpose::STANDARD.encode(data);
        assert_eq!(dimensions(&encode(&png), true).unwrap(), (3468, 2556));
        for end in 0..png.len() {
            assert!(dimensions(&encode(&png[..end]), true).is_err());
        }
        // APP segment followed by a progressive SOF, as well as baseline JPEG.
        for marker in [0xc0, 0xc2] {
            let jpeg = [
                0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, marker, 0, 8, 8, 3, 0, 5, 0, 0,
            ];
            assert_eq!(dimensions(&encode(&jpeg), false).unwrap(), (1280, 768));
            for end in 0..jpeg.len() {
                assert!(dimensions(&encode(&jpeg[..end]), false).is_err());
            }
        }
        assert!(dimensions("not base64", true).is_err());
        assert!(dimensions(&encode(&[0xff, 0xd8, 0xff, 0xe0, 0, 1]), false).is_err());
    }
}
