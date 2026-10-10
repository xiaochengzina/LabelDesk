//! 通用工具：PNG 编码、base64、Windows 命令行封装。

use base64::Engine;
use std::process::Command;

/// 解码 `data:image/png;base64,....` 形式的数据 URL。
/// 返回 `(原始字节, 声明的 MIME)`。
pub fn decode_data_url(input: &str) -> Result<(Vec<u8>, String), String> {
    let trimmed = input.trim();
    let (mime, payload) = if let Some(rest) = trimmed.strip_prefix("data:") {
        match rest.split_once(',') {
            Some((head, body)) => {
                let mime = head.split(';').next().unwrap_or("image/png").to_string();
                let body = if head.contains(";base64") {
                    body.to_string()
                } else {
                    // 非 base64 的 data URL：做百分号解码
                    percent_decode(body)
                };
                (mime, body)
            }
            None => return Err("数据 URL 格式不合法：缺少 ','".into()),
        }
    } else {
        ("image/png".to_string(), trimmed.to_string())
    };

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("base64 解码失败: {e}"))?;

    if bytes.is_empty() {
        return Err("图像数据为空".into());
    }
    Ok((bytes, mime))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 在 Windows 下隐藏子进程控制台窗口。
pub fn hidden_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 运行 PowerShell 脚本文件并返回 stdout（UTF-8 解码、宽松失败）。
pub fn run_powershell(script: &std::path::Path, args: &[String]) -> Result<String, String> {
    if !script.exists() {
        return Err(format!("缺少打印辅助脚本: {}", script.display()));
    }
    let mut cmd = hidden_command("powershell.exe");
    cmd.arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(script);
    for a in args {
        cmd.arg(a);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("无法启动 PowerShell: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() && stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("PowerShell 执行失败 ({}): {stderr}", output.status));
    }
    Ok(stdout)
}

/// 取最后一个 JSON 对象/数组行，忽略脚本可能输出的其它噪音行（如 CLIXML）。
pub fn last_json_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|l| l.starts_with('{') || l.starts_with('['))
        .last()
        .unwrap_or("")
        .to_string()
}

/// 把任意字符串转成安全的文件名片段。
///
/// 除了替换 Windows 非法字符，还必须消除 `..`：Windows 会在打开文件时
/// 对路径做规范化，含 `..` 的字符串可能被解析到目标目录之外。
pub fn sanitize_file_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    // 连续点号一律压成下划线，彻底断掉目录穿越的可能
    let mut cleaned = cleaned.replace("..", "_");
    cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        cleaned = format!("label-{}", now_millis());
    }
    cleaned.chars().take(80).collect()
}

pub fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 把 RGBA 像素按亮度阈值二值化：true = 需要打印的黑点。
/// 采用整数权重（ITU-R BT.601）避免浮点误差。
pub fn rgba_to_mono(rgba: &[u8], width: u32, height: u32, threshold: u8) -> Vec<bool> {
    let mut out = vec![false; (width as usize) * (height as usize)];
    let t = threshold as u32;
    for i in 0..out.len() {
        let p = i * 4;
        if p + 3 >= rgba.len() {
            break;
        }
        let a = rgba[p + 3] as u32;
        // 与白底合成后再判断
        let blend = |c: u8| -> u32 {
            let c = c as u32;
            (c * a + 255 * (255 - a)) / 255
        };
        let lum = (blend(rgba[p]) * 299 + blend(rgba[p + 1]) * 587 + blend(rgba[p + 2]) * 114) / 1000;
        out[i] = lum < t;
    }
    out
}

/// 打包成「每字节 8 像素、高位在前」的行位图。宽度不足 8 的倍数时右侧补白。
/// `dark_bit_zero = true` 时使用 TSPL 规范的极性（0 = 打印）。
pub fn mono_to_row_bytes(
    mono: &[bool],
    width: u32,
    height: u32,
    dark_bit_zero: bool,
) -> (Vec<u8>, u32) {
    let w_bytes = (width as usize).div_ceil(8);
    // TSPL 极性下默认全 1（未打印），随后把黑点清零；另一种极性默认全 0（不打印）再置位
    let mut out = vec![if dark_bit_zero { 0xFFu8 } else { 0x00u8 }; w_bytes * height as usize];

    for y in 0..height as usize {
        for x in 0..width as usize {
            if !mono[y * width as usize + x] {
                continue;
            }
            let byte_index = y * w_bytes + x / 8;
            let bit = 7 - (x % 8);
            if dark_bit_zero {
                out[byte_index] &= !(1u8 << bit);
            } else {
                out[byte_index] |= 1u8 << bit;
            }
        }
        // 宽度不是 8 的倍数时，最右侧补白必须保持「不打点」。
        // 只处理该行最后一个字节里超出 width 的那几位——若整字节覆盖，
        // 会把同一字节内真实的像素一起抹掉。
        for x in width as usize..(w_bytes * 8) {
            let byte_index = y * w_bytes + x / 8;
            let bit = 7 - (x % 8);
            if dark_bit_zero {
                out[byte_index] |= 1u8 << bit;
            } else {
                out[byte_index] &= !(1u8 << bit);
            }
        }
    }
    (out, w_bytes as u32)
}

/// 生成 8 位灰阶 PNG（单通道），供 Windows 驱动打印与预览使用。
/// 打印黑白标签时体积远小于 RGBA，且 GDI 缩放质量更好。
pub fn encode_gray_png(mono: &[bool], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut raw = Vec::with_capacity((width as usize + 1) * height as usize);
    for y in 0..height as usize {
        raw.push(0u8); // filter type: none
        for x in 0..width as usize {
            raw.push(if mono[y * width as usize + x] { 0 } else { 255 });
        }
    }
    let idat = zlib_compress(&raw)?;
    Ok(build_png(width, height, 8, 0, &idat))
}

fn build_png(width: u32, height: u32, bit_depth: u8, color_type: u8, idat: &[u8]) -> Vec<u8> {
    let mut png = Vec::with_capacity(idat.len() + 128);
    png.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.push(bit_depth);
    ihdr.push(color_type);
    ihdr.extend_from_slice(&[0, 0, 0]); // deflate / adaptive filter / no interlace
    write_chunk(&mut png, b"IHDR", &ihdr);
    write_chunk(&mut png, b"IDAT", idat);
    write_chunk(&mut png, b"IEND", &[]);
    png
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn zlib_compress(data: &[u8]) -> Result<Vec<u8>, String> {
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::new(6));
    enc.write_all(data).map_err(|e| format!("压缩失败: {e}"))?;
    enc.finish().map_err(|e| format!("压缩失败: {e}"))
}

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, entry) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *entry = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_packing_tspl_polarity() {
        // 8x1：最左一个黑点
        let mono = vec![true, false, false, false, false, false, false, false];
        let (bytes, wb) = mono_to_row_bytes(&mono, 8, 1, true);
        assert_eq!(wb, 1);
        assert_eq!(bytes, vec![0b0111_1111]);

        let (bytes, _) = mono_to_row_bytes(&mono, 8, 1, false);
        assert_eq!(bytes, vec![0b1000_0000]);
    }

    #[test]
    fn mono_packing_pads_right_edge() {
        // 宽 3 的逻辑像素打包成 1 字节：超出宽度的 5 个位是补白，TSPL 极性下必须为 1（不打点）
        let mono = vec![true, true, true, false, false, true];
        let (bytes, wb) = mono_to_row_bytes(&mono, 3, 2, true);
        assert_eq!(wb, 1);
        // 第一行 000 -> 0b0001_1111 = 31
        // 第二行 001 -> 0b0011_1111? 不：黑点在 x=2，对应 bit5 清零 -> 0b1101_1111 = 223
        assert_eq!(bytes, vec![0b0001_1111, 0b1101_1111]);
        assert_eq!(bytes, vec![0b0001_1111, 0b1101_1111]);

        // 另一种极性：补白必须是 0（与上面逐位取反）
        let (bytes2, _) = mono_to_row_bytes(&mono, 3, 2, false);
        assert_eq!(bytes2[0], !0b0001_1111);
        assert_eq!(bytes2[1], !0b1101_1111);
    }

    #[test]
    fn png_signature_and_crc() {
        let png = encode_gray_png(&vec![true; 4], 2, 2).unwrap();
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
    }

    #[test]
    fn data_url_roundtrip() {
        let (bytes, mime) = decode_data_url("data:image/png;base64,aGVsbG8=").unwrap();
        assert_eq!(bytes, b"hello");
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn file_stem_sanitizing() {
        assert_eq!(sanitize_file_stem("A/B:C*?"), "A_B_C__");
        assert!(!sanitize_file_stem("   ").is_empty());
        // 目录穿越必须被彻底消除
        assert!(!sanitize_file_stem("../../evil").contains(".."));
        assert!(!sanitize_file_stem("..").contains(".."));
        assert!(!sanitize_file_stem("a..b").contains(".."));
    }
}
