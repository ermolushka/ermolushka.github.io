---
author: Alexey Ermolaev
pubDatetime: 2024-11-14T15:22:00Z
modDatetime: 2024-11-14T15:22:00Z
title: Implementing ZIP unarchiver in Rust
slug: rust-zip-unarchiver
featured: true
draft: false
tags:
  - rust
  - zip
  - compression
description: A quick overview of a ZIP unarchiver tool written in Rust just for fun.
---

Recently, I came across the idea of implementing a universal unarchiver written in Rust. Why exactly? Well, because for my projects where I had to unpack various data sources and some of it where `.zip` archives while the other could be `.tar` or `.tar.gz` or whatever else.

Of course, I already almost remembered all the syntax like

`7z x archive.7z` or maybe `unzip archive.zip` but it was annoying. Partially, because some of the toold were not installed in Ubuntu by default and I had to do it manually.

The original idea was to create a universal unarchiver which support various archive formats. Quite quickly I gave up on this idea as it was too much of work for a simple excercise. So, I ended up implementing for the `ZIP` archives.

My original plan was:

- Check out the ZIP format specification
- Start implementing it in Rust just in the `main.rs` function for simplicity as I knew I had to deal with byte manipulation quite a lot
- Once logic is ready, test it for archive with a single file and later with multi-file archive
- Cover with the tests

Sounds like a fun, let's start.

## ZIP format specification

A ZIP file consists of the following logic parts:

```
[Local File Header 1]
[File Data 1]
[Local File Header 2]
[File Data 2]
...
[Local File Header n]
[File Data n]
[Central Directory]
[End of Central Directory]
```

### 1. Local File Header

Located immediately before each file's data.

```
Signature: 0x04034b50 (4 bytes, little-endian)
Version needed to extract (2 bytes)
General purpose bit flag (2 bytes)
Compression method (2 bytes)

0 = no compression
8 = deflate


Last mod file time (2 bytes)
Last mod file date (2 bytes)
CRC-32 (4 bytes)
Compressed size (4 bytes)
Uncompressed size (4 bytes)
Filename length (2 bytes)
Extra field length (2 bytes)
Filename (variable size)
Extra field (variable size)

Total fixed-length portion: 30 bytes.
```

### 2. File Data

Compressed or stored data immediately follows its local header. Size is specified in the local header's compressed size field. Compression method specified in local header determines format.

### 3. Central Directory

Contains entries for each file in the archive. Located after all file data.

Central Directory Header

```
Signature: 0x02014b50 (4 bytes, little-endian)
Version made by (2 bytes)
Version needed to extract (2 bytes)
General purpose bit flag (2 bytes)
Compression method (2 bytes)
Last mod file time (2 bytes)
Last mod file date (2 bytes)
CRC-32 (4 bytes)
Compressed size (4 bytes)
Uncompressed size (4 bytes)
Filename length (2 bytes)
Extra field length (2 bytes)
File comment length (2 bytes)
Disk number start (2 bytes)
Internal file attributes (2 bytes)
External file attributes (4 bytes)
Relative offset of local header (4 bytes)
Filename (variable size)
Extra field (variable size)
File comment (variable size)

Total fixed-length portion: 46 bytes
```

### 4. End of Central Directory

Always located at the end of the ZIP file.

```
Signature: 0x06054b50 (4 bytes, little-endian)
Number of this disk (2 bytes)
Disk where central directory starts (2 bytes)
Number of central directory records on this disk (2 bytes)
Total number of central directory records (2 bytes)
Size of central directory (4 bytes)
Offset of start of central directory (4 bytes)
Comment length (2 bytes)
Comment (variable size)

Total fixed-length portion: 22 bytes
```

Given that format, I was thinking of:

- Finding end of the central directory
- Get central directory offset from there
- Read central directory, skip metadata I don't need and collect files metadata
- Read all the files data and extract + decompress

## Reading end of the central directory

I came up with pretty straightforward logic

```rust
fn read_end_central_dir(path: &str) -> io::Result<Option<u64>> {
    let mut f: File = File::open(path)?;

    f.seek(SeekFrom::End(0))?;
    let file_size: u64 = f.stream_position()?;
    eprintln!("File size: {} bytes", file_size);

    // as we need to check the last 1024
    let search_size: u64 = min(1024, file_size);
    f.seek(SeekFrom::End(-(search_size as i64)))?;
    let mut buf: Vec<u8> = vec![0; search_size as usize];
    f.read_exact(&mut buf)?;

    let signature_bytes: [u8; 4] = END_CENTRAL_DIR_SIGNATURE.to_le_bytes();

    let mut signature_position: i64 = -1;

    for i in (0..buf.len().saturating_sub(4)).rev() {
        if buf[i..i + 4] == signature_bytes {
            signature_position = i as i64;
            break;
        }
    }

    if signature_position == -1 {
        eprintln!("Signature not found!");
        return Ok(None);
    }

    // Read the record bytes and print them before parsing
    let pos: usize = signature_position as usize;
    let record_bytes: &[u8] = &buf[pos + 4..pos + 22]; // 18 bytes after signature

    let end_central_dir: EndCentralDirectory = EndCentralDirectory {
        dir_offset: u32::from_le_bytes(record_bytes[12..16].try_into().unwrap()),
    };

    Ok(Some(end_central_dir.dir_offset as u64))
}
```

We now have `dir_offset` which can be used later to read the central directory.

## Reading the central directory

```rust
fn read_central_directory(
    path: &str,
    offset: Option<u64>,
) -> io::Result<Option<Vec<ZipFileEntry>>> {
    let mut f: File = File::open(path)?;
    let mut file_entries: Vec<ZipFileEntry> = vec![];
    let mut current_offset: u64 = offset.unwrap();

    loop {
        f.seek(SeekFrom::Start(current_offset))?;

        // Read signature
        let mut buf: [u8; 4] = [0u8; 4];
        match f.read_exact(&mut buf) {
            Ok(_) => {
                if buf != CENTRAL_DIR_SIGNATURE.to_le_bytes() {
                    break;
                }
            }
            Err(_) => break,
        }

        // Skip version made by (2), version needed (2), flags (2)
        f.seek(SeekFrom::Current(6))?;

        // Read compression method
        let mut compression_method_buf = [0u8; 2];
        f.read_exact(&mut compression_method_buf)?;
        let compression_method = u16::from_le_bytes(compression_method_buf);

        // Skip last mod time (2), last mod date (2), CRC32 (4)
        f.seek(SeekFrom::Current(8))?;

        // Read sizes
        let mut compressions_buf: [u8; 8] = [0u8; 8];
        f.read_exact(&mut compressions_buf)?;
        let compressed_size: u32 = u32::from_le_bytes(compressions_buf[0..4].try_into().unwrap());
        let uncompressed_size: u32 = u32::from_le_bytes(compressions_buf[4..8].try_into().unwrap());

        // Read lengths
        let mut lengths_buf: [u8; 6] = [0u8; 6];
        f.read_exact(&mut lengths_buf)?;
        let filename_length: u16 = u16::from_le_bytes(lengths_buf[0..2].try_into().unwrap());
        let extra_length: u16 = u16::from_le_bytes(lengths_buf[2..4].try_into().unwrap());
        let comment_length: u16 = u16::from_le_bytes(lengths_buf[4..6].try_into().unwrap());

        // Skip to local header offset
        f.seek(SeekFrom::Current(8))?;

        // Read local header offset
        let mut offset_buf: [u8; 4] = [0u8; 4];
        f.read_exact(&mut offset_buf)?;
        let file_offset: u32 = u32::from_le_bytes(offset_buf);

        // Read filename
        let mut filename_buf: Vec<u8> = vec![0u8; filename_length as usize];
        f.read_exact(&mut filename_buf)?;
        let filename: String =
            String::from_utf8(filename_buf).map_err(|e: std::string::FromUtf8Error| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, e)
            })?;

        file_entries.push(ZipFileEntry {
            filename,
            compressed_size,
            uncompressed_size,
            compression_method,
            file_offset,
        });
        // Skip extra field and comment
        f.seek(SeekFrom::Current((extra_length + comment_length) as i64))?;
        current_offset = f.stream_position()?;
    }
    eprintln!("file_entries: {:?}", file_entries);

    Ok(Some(file_entries))
}
```

Here, we start reading from the beginning of the central directory, skipping on the way what's not needed and then we read files metadata in the `loop {}`.

## Extraction of files

The simplest here

```rust
fn extract_file(
    path: &str,
    entry: &ZipFileEntry,
    path_to_unpack: &str,
) -> io::Result<Option<Vec<u8>>> {
    eprintln!("Starting extract_file with:");
    eprintln!("  filename: {}", entry.filename);

    let mut f: File = File::open(path)?;
    f.seek(SeekFrom::Start(entry.file_offset as u64))?;

    // Read and verify local file header
    let mut local_header: [u8; 30] = [0u8; 30];
    f.read_exact(&mut local_header)?;

    // Check signature
    if local_header[0..4] != LOCAL_FILE_HEADER_SIGNATURE.to_le_bytes() {
        eprintln!("Invalid local file header signature");
        return Ok(None);
    }

    let local_name_length: u16 = u16::from_le_bytes(local_header[26..28].try_into().unwrap());
    let local_extra_length: u16 = u16::from_le_bytes(local_header[28..30].try_into().unwrap());

    // Skip variable length fields
    f.seek(SeekFrom::Current(
        (local_name_length + local_extra_length) as i64,
    ))?;

    // Read compressed data
    let mut compressed_data_buf: Vec<u8> = vec![0u8; entry.compressed_size as usize];
    f.read_exact(&mut compressed_data_buf)?;

    match entry.compression_method {
        0 => {
            eprintln!("No compression, returning raw data");
            Ok(Some(compressed_data_buf))
        }
        8 => {
            eprintln!("Using Deflate decompression");
            eprintln!("Compressed size: {}", compressed_data_buf.len());

            use flate2::read::DeflateDecoder;
            use std::io::Read;

            let mut decoder: DeflateDecoder<&[u8]> = DeflateDecoder::new(&compressed_data_buf[..]);
            let mut decompressed_data: Vec<u8> =
                Vec::with_capacity(entry.uncompressed_size as usize);

            match decoder.read_to_end(&mut decompressed_data) {
                Ok(size) => {
                    eprintln!("Successfully decompressed {} bytes", size);
                    if size != entry.uncompressed_size as usize {
                        eprintln!(
                            "Warning: Decompressed size {} differs from expected {}",
                            size, entry.uncompressed_size
                        );
                    }
                    let folder_path: &Path = Path::new(&path_to_unpack);
                    let full_path: String = format!("{}{}", path_to_unpack, entry.filename);
                    let path: &Path = Path::new(&full_path);

                    match folder_path.exists() {
                        true => {
                            let mut file: File = File::create(path)?;
                            file.write_all(&decompressed_data)?;
                            file.flush()?;

                            eprintln!("Successfully saved file to {}", full_path);

                            Ok(Some(decompressed_data))
                        }
                        false => {
                            eprintln!("FAIL: Output path doesnt exist: {:?}", path_to_unpack);
                            Err(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                "Output path doesnt exist",
                            ))
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Decompression error: {}", e);
                    eprintln!("Full compressed data: {:02X?}", compressed_data_buf);
                    Err(std::io::Error::new(std::io::ErrorKind::InvalidData, e))
                }
            }
        }
        _ => {
            eprintln!(
                "Unsupported compression method: {}",
                entry.compression_method
            );
            Ok(None)
        }
    }
}
```

That's pretty much it. The whole code is accessible [here](https://github.com/ermolushka/xpack)
