//! Minimal fragmented-MP4 muxer for one H.264 video track (timescale 90 kHz).

fn bx(t: &[u8; 4], parts: &[&[u8]]) -> Vec<u8> {
    let len: usize = 8 + parts.iter().map(|p| p.len()).sum::<usize>();
    let mut v = Vec::with_capacity(len);
    v.extend_from_slice(&(len as u32).to_be_bytes());
    v.extend_from_slice(t);
    for p in parts {
        v.extend_from_slice(p);
    }
    v
}

fn u32s(xs: &[u32]) -> Vec<u8> {
    xs.iter().flat_map(|x| x.to_be_bytes()).collect()
}

const MATRIX: [u32; 9] = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x4000_0000];

/// ftyp + moov. `sps`/`pps` are raw NAL units without start codes.
pub fn init_segment(sps: &[u8], pps: &[u8], w: u16, h: u16) -> Vec<u8> {
    let ftyp = bx(b"ftyp", &[b"isom", &u32s(&[0x200]), b"isomiso6avc1mp41"]);

    let mvhd = bx(b"mvhd", &[&u32s(&[0, 0, 0, 1000, 0, 0x10000]), &[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        &u32s(&MATRIX), &[0u8; 24], &u32s(&[2])]);
    let tkhd = {
        let mut p = Vec::new();
        p.extend(u32s(&[7, 0, 0, 1, 0, 0])); // ver/flags, ctime, mtime, id, reserved, duration
        p.extend([0u8; 8]); // reserved
        p.extend([0u8; 8]); // layer, alt group, volume, reserved
        p.extend(u32s(&MATRIX));
        p.extend(u32s(&[(w as u32) << 16, (h as u32) << 16]));
        bx(b"tkhd", &[&p])
    };

    let mdhd = bx(b"mdhd", &[&u32s(&[0, 0, 0, 90000, 0]), &[0x55, 0xc4, 0, 0]]);
    let hdlr = bx(b"hdlr", &[&u32s(&[0, 0]), b"vide", &[0u8; 12], b"v\0"]);

    let avcc = bx(b"avcC", &[&[1, sps[1], sps[2], sps[3], 0xFF, 0xE1], &(sps.len() as u16).to_be_bytes(), sps,
        &[1], &(pps.len() as u16).to_be_bytes(), pps]);
    let mut e = Vec::new();
    e.extend([0u8; 6]);
    e.extend(1u16.to_be_bytes());
    e.extend([0u8; 16]);
    e.extend(w.to_be_bytes());
    e.extend(h.to_be_bytes());
    e.extend(u32s(&[0x0048_0000, 0x0048_0000, 0]));
    e.extend(1u16.to_be_bytes());
    e.extend([0u8; 32]);
    e.extend(0x0018u16.to_be_bytes());
    e.extend(0xFFFFu16.to_be_bytes());
    let avc1 = bx(b"avc1", &[&e, &avcc]);
    let stsd = bx(b"stsd", &[&u32s(&[0, 1]), &avc1]);
    let empty = |t: &[u8; 4], n: usize| bx(t, &[&u32s(&vec![0; n])]);
    let stbl = bx(b"stbl", &[&stsd, &empty(b"stts", 2), &empty(b"stsc", 2), &empty(b"stsz", 3), &empty(b"stco", 2)]);
    let vmhd = bx(b"vmhd", &[&u32s(&[1, 0, 0])]);
    let url = bx(b"url ", &[&u32s(&[1])]);
    let dinf = bx(b"dinf", &[&bx(b"dref", &[&u32s(&[0, 1]), &url])]);
    let minf = bx(b"minf", &[&vmhd, &dinf, &stbl]);
    let mdia = bx(b"mdia", &[&mdhd, &hdlr, &minf]);
    let trak = bx(b"trak", &[&tkhd, &mdia]);
    let mvex = bx(b"mvex", &[&bx(b"trex", &[&u32s(&[0, 1, 1, 0, 0, 0])])]);
    let moov = bx(b"moov", &[&mvhd, &trak, &mvex]);
    [ftyp, moov].concat()
}

/// One moof+mdat holding a single sample (AVCC, length-prefixed NALs).
pub fn fragment(seq: u32, tfdt: u64, dur: u32, key: bool, sample: &[u8]) -> Vec<u8> {
    let flags: u32 = if key { 0x0200_0000 } else { 0x0101_0000 };
    let build = |offset: u32| {
        let mfhd = bx(b"mfhd", &[&u32s(&[0, seq])]);
        let tfhd = bx(b"tfhd", &[&u32s(&[0x0002_0000, 1])]);
        let tfdt = bx(b"tfdt", &[&u32s(&[0x0100_0000]), &tfdt.to_be_bytes()]);
        let trun = bx(b"trun", &[&u32s(&[0x701, 1, offset, dur, sample.len() as u32, flags])]);
        bx(b"moof", &[&mfhd, &bx(b"traf", &[&tfhd, &tfdt, &trun])])
    };
    let moof_len = build(0).len();
    let moof = build(moof_len as u32 + 8);
    [moof, bx(b"mdat", &[sample])].concat()
}
