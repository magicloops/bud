//! Capped, file-backed ring buffer of raw session output (holder-side).
//!
//! Absolute byte offsets from session start, monotonic forever; the ring caps
//! RETENTION, never offsets. Single writer (the holder's PTY pump), readers via
//! the holder's IPC thread(s). Crash tolerance: if the file fails validation on
//! open, reset to empty (sessions lose replay, never correctness).
//!
//! On-disk format is holder-internal (not a compatibility surface — a given
//! ring file is only ever read by the holder process that wrote it).
//!
//! Layout: fixed header (magic `STEMRING`, `u32` version = 1, `u64` cap,
//! `u64` next_offset, `u64` len) followed by a `cap`-byte circular data region.
//! The logical byte at absolute offset `o` lives at file position
//! `HEADER + (o % cap)`.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use crate::error::Result;

pub const DEFAULT_RING_CAP: u64 = 8 * 1024 * 1024; // design open q.1 default

const MAGIC: &[u8; 8] = b"STEMRING";
const FORMAT_VERSION: u32 = 1;
const HEADER_LEN: u64 = 8 + 4 + 8 + 8 + 8;

pub struct RingFile {
    file: File,
    cap: u64,
    /// Absolute offset the next appended byte will receive.
    next_offset: u64,
    /// Retained bytes (≤ cap).
    len: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RingRead {
    /// Actual start offset of `bytes` (== requested start unless truncated).
    pub start: u64,
    pub bytes: Vec<u8>,
    /// Set when the requested start predates retention; bytes before
    /// `oldest_offset` are gone. Carries the originally requested start.
    pub truncated_from: Option<u64>,
}

impl RingFile {
    /// Create or reopen at `path` with capacity `cap` (data region bytes).
    ///
    /// A pre-existing file that fails validation (bad magic/version, capacity
    /// mismatch, inconsistent counters, wrong size) is silently reset to an
    /// empty ring — the holder must never fail to start over ring damage.
    pub fn open(path: &Path, cap: u64) -> Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        let existing_len = file.metadata()?.len();
        let mut ring = RingFile {
            file,
            cap,
            next_offset: 0,
            len: 0,
        };
        if existing_len == 0 || !ring.load_header().unwrap_or(false) {
            ring.reset()?;
        }
        Ok(ring)
    }

    /// Returns Ok(true) if the on-disk header is valid for `self.cap`,
    /// populating counters from it.
    fn load_header(&mut self) -> Result<bool> {
        if self.file.metadata()?.len() != HEADER_LEN + self.cap {
            return Ok(false);
        }
        let mut hdr = [0u8; HEADER_LEN as usize];
        self.file.seek(SeekFrom::Start(0))?;
        if self.file.read_exact(&mut hdr).is_err() {
            return Ok(false);
        }
        if &hdr[0..8] != MAGIC {
            return Ok(false);
        }
        let version = u32::from_le_bytes(hdr[8..12].try_into().unwrap());
        let cap = u64::from_le_bytes(hdr[12..20].try_into().unwrap());
        let next_offset = u64::from_le_bytes(hdr[20..28].try_into().unwrap());
        let len = u64::from_le_bytes(hdr[28..36].try_into().unwrap());
        if version != FORMAT_VERSION || cap != self.cap || len > cap || len > next_offset {
            return Ok(false);
        }
        self.next_offset = next_offset;
        self.len = len;
        Ok(true)
    }

    fn reset(&mut self) -> Result<()> {
        self.next_offset = 0;
        self.len = 0;
        self.file.set_len(HEADER_LEN + self.cap)?;
        self.write_header()
    }

    fn write_header(&mut self) -> Result<()> {
        let mut hdr = [0u8; HEADER_LEN as usize];
        hdr[0..8].copy_from_slice(MAGIC);
        hdr[8..12].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
        hdr[12..20].copy_from_slice(&self.cap.to_le_bytes());
        hdr[20..28].copy_from_slice(&self.next_offset.to_le_bytes());
        hdr[28..36].copy_from_slice(&self.len.to_le_bytes());
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(&hdr)?;
        self.file.flush()?;
        Ok(())
    }

    /// Append bytes at `next_offset`, evicting the oldest bytes past capacity.
    pub fn append(&mut self, bytes: &[u8]) -> Result<()> {
        let n = bytes.len() as u64;
        if n == 0 {
            return Ok(());
        }
        if self.cap > 0 {
            // A chunk larger than the whole ring: only its tail survives, but
            // the skipped bytes still advance the absolute offset space.
            let keep = n.min(self.cap);
            let src = &bytes[(n - keep) as usize..];
            let start_logical = self.next_offset + (n - keep);
            let mut phys = start_logical % self.cap;
            let mut rest = src;
            while !rest.is_empty() {
                let span = ((self.cap - phys) as usize).min(rest.len());
                self.file.seek(SeekFrom::Start(HEADER_LEN + phys))?;
                self.file.write_all(&rest[..span])?;
                rest = &rest[span..];
                phys = 0;
            }
            self.len = (self.len + n).min(self.cap);
        }
        self.next_offset += n;
        self.write_header()
    }

    /// Read `[start, end)`, clamping into retention; `end` clamps to `next_offset`.
    pub fn read_range(&self, start: u64, end: u64) -> Result<RingRead> {
        let oldest = self.oldest_offset();
        let end = end.min(self.next_offset);
        let eff_start = start.max(oldest);
        if eff_start >= end {
            // Empty result; still report truncation if the requested (non-empty)
            // range fell entirely before retention.
            let truncated_from = (start < oldest && start < end).then_some(start);
            return Ok(RingRead {
                start: eff_start.min(self.next_offset),
                bytes: Vec::new(),
                truncated_from,
            });
        }
        let truncated_from = (start < eff_start).then_some(start);
        let total = (end - eff_start) as usize;
        let mut bytes = vec![0u8; total];
        let mut filled = 0usize;
        let mut phys = eff_start % self.cap;
        let mut file = &self.file; // &File implements Read + Seek
        while filled < total {
            let span = ((self.cap - phys) as usize).min(total - filled);
            file.seek(SeekFrom::Start(HEADER_LEN + phys))?;
            file.read_exact(&mut bytes[filled..filled + span])?;
            filled += span;
            phys = 0;
        }
        Ok(RingRead {
            start: eff_start,
            bytes,
            truncated_from,
        })
    }

    /// Oldest retained absolute offset.
    pub fn oldest_offset(&self) -> u64 {
        self.next_offset - self.len
    }

    /// Absolute offset the next appended byte will receive.
    pub fn next_offset(&self) -> u64 {
        self.next_offset
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_tmp(cap: u64) -> (tempfile::TempDir, RingFile) {
        let dir = tempfile::tempdir().unwrap();
        let ring = RingFile::open(&dir.path().join("ring.log"), cap).unwrap();
        (dir, ring)
    }

    #[test]
    fn empty_reads() {
        let (_d, ring) = open_tmp(64);
        assert_eq!(ring.oldest_offset(), 0);
        assert_eq!(ring.next_offset(), 0);
        let rr = ring.read_range(0, 100).unwrap();
        assert_eq!(
            rr,
            RingRead {
                start: 0,
                bytes: vec![],
                truncated_from: None
            }
        );
    }

    #[test]
    fn append_and_read_exact() {
        let (_d, mut ring) = open_tmp(64);
        ring.append(b"hello world").unwrap();
        assert_eq!(ring.next_offset(), 11);
        assert_eq!(ring.oldest_offset(), 0);
        let rr = ring.read_range(0, 11).unwrap();
        assert_eq!(rr.bytes, b"hello world");
        assert_eq!(rr.start, 0);
        assert_eq!(rr.truncated_from, None);
        // Sub-range.
        let rr = ring.read_range(6, 11).unwrap();
        assert_eq!(rr.bytes, b"world");
        assert_eq!(rr.start, 6);
    }

    #[test]
    fn wrap_around_eviction() {
        let (_d, mut ring) = open_tmp(16);
        // Build a logical stream longer than cap across several appends.
        let mut logical = Vec::new();
        for chunk in [&b"0123456789"[..], b"ABCDEFGHIJ", b"xyz"] {
            ring.append(chunk).unwrap();
            logical.extend_from_slice(chunk);
        }
        assert_eq!(ring.next_offset(), 23);
        assert_eq!(ring.oldest_offset(), 23 - 16);
        let rr = ring
            .read_range(ring.oldest_offset(), ring.next_offset())
            .unwrap();
        assert_eq!(rr.bytes, &logical[logical.len() - 16..]);
        assert_eq!(rr.truncated_from, None);
    }

    #[test]
    fn single_append_larger_than_cap_keeps_tail() {
        let (_d, mut ring) = open_tmp(8);
        ring.append(b"0123456789abcdefghij").unwrap(); // 20 bytes
        assert_eq!(ring.next_offset(), 20);
        assert_eq!(ring.oldest_offset(), 12);
        let rr = ring.read_range(12, 20).unwrap();
        assert_eq!(rr.bytes, b"cdefghij");
    }

    #[test]
    fn range_clamps_and_truncation_reporting() {
        let (_d, mut ring) = open_tmp(16);
        ring.append(b"0123456789ABCDEFGHIJ").unwrap(); // oldest=4, next=20
                                                       // start < oldest: clamp forward, report truncated_from = requested.
        let rr = ring.read_range(0, 20).unwrap();
        assert_eq!(rr.start, 4);
        assert_eq!(rr.truncated_from, Some(0));
        assert_eq!(rr.bytes, b"456789ABCDEFGHIJ");
        // end > next: clamp to next.
        let rr = ring.read_range(10, 999).unwrap();
        assert_eq!(rr.start, 10);
        assert_eq!(rr.bytes, b"ABCDEFGHIJ");
        assert_eq!(rr.truncated_from, None);
        // Entirely before retention: empty, truncated.
        let rr = ring.read_range(0, 3).unwrap();
        assert_eq!(rr.bytes, b"");
        assert_eq!(rr.truncated_from, Some(0));
        // Entirely past the stream: empty, not truncated.
        let rr = ring.read_range(50, 60).unwrap();
        assert_eq!(rr.bytes, b"");
        assert_eq!(rr.truncated_from, None);
        // Degenerate start >= end: empty, not truncated.
        let rr = ring.read_range(10, 10).unwrap();
        assert_eq!(rr.bytes, b"");
        assert_eq!(rr.truncated_from, None);
    }

    #[test]
    fn reopen_resumes_offsets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ring.log");
        {
            let mut ring = RingFile::open(&path, 16).unwrap();
            ring.append(b"0123456789ABCDEFGHIJ").unwrap();
        }
        let ring = RingFile::open(&path, 16).unwrap();
        assert_eq!(ring.next_offset(), 20);
        assert_eq!(ring.oldest_offset(), 4);
        let rr = ring.read_range(4, 20).unwrap();
        assert_eq!(rr.bytes, b"456789ABCDEFGHIJ");
    }

    #[test]
    fn reopen_with_different_cap_resets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ring.log");
        {
            let mut ring = RingFile::open(&path, 16).unwrap();
            ring.append(b"hello").unwrap();
        }
        let ring = RingFile::open(&path, 32).unwrap();
        assert_eq!(ring.next_offset(), 0);
        assert_eq!(ring.oldest_offset(), 0);
    }

    #[test]
    fn corrupt_file_resets_instead_of_erroring() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ring.log");
        std::fs::write(&path, b"definitely not a ring header").unwrap();
        let mut ring = RingFile::open(&path, 16).unwrap();
        assert_eq!(ring.next_offset(), 0);
        ring.append(b"ok").unwrap();
        assert_eq!(ring.read_range(0, 2).unwrap().bytes, b"ok");
    }

    #[test]
    fn zero_cap_retains_nothing_but_offsets_advance() {
        let (_d, mut ring) = open_tmp(0);
        ring.append(b"abcdef").unwrap();
        assert_eq!(ring.next_offset(), 6);
        assert_eq!(ring.oldest_offset(), 6);
        let rr = ring.read_range(0, 6).unwrap();
        assert_eq!(rr.bytes, b"");
        assert_eq!(rr.truncated_from, Some(0));
    }

    #[test]
    fn tiny_cap_one_byte() {
        let (_d, mut ring) = open_tmp(1);
        ring.append(b"abc").unwrap();
        assert_eq!(ring.next_offset(), 3);
        assert_eq!(ring.oldest_offset(), 2);
        let rr = ring.read_range(0, 3).unwrap();
        assert_eq!(rr.start, 2);
        assert_eq!(rr.bytes, b"c");
        assert_eq!(rr.truncated_from, Some(0));
    }
}
