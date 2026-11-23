//! Pure-Rust `symphonia` 16 kHz mono decoding, streaming linear resampler, and WAV writer.
use anyhow::{anyhow, Result};
use std::path::Path;

pub fn write_wav(path: &Path, samples: &[f32]) -> Result<()> {
    use std::io::Write;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    let data_len = (samples.len() * 2) as u32;
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_len).to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?;
    f.write_all(&16000u32.to_le_bytes())?;
    f.write_all(&32000u32.to_le_bytes())?;
    f.write_all(&2u16.to_le_bytes())?;
    f.write_all(&16u16.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&data_len.to_le_bytes())?;
    for s in samples {
        f.write_all(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())?;
    }
    f.flush()?;
    Ok(())
}

/// Generate a 1.5s 16 kHz mono WAV for CrispASR hardware smoke-probing.
pub fn synth_probe_wav(path: &Path) -> Result<()> {
    let total = 24_000usize; // 1.5s @ 16 kHz
    let mut samples = Vec::with_capacity(total);
    for i in 0..total {
        if (4_000..16_800).contains(&i) {
            let t = i as f32 / 16_000.0;
            let env = (std::f32::consts::PI * ((i - 4_000) as f32 / 12_800.0)).sin();
            let tone = (2.0 * std::f32::consts::PI * 260.0 * t).sin() * 0.55
                + (2.0 * std::f32::consts::PI * 520.0 * t).sin() * 0.25;
            samples.push(tone * env * 0.35);
        } else {
            samples.push(0.0);
        }
    }
    write_wav(path, &samples)
}

pub fn decode_16k_mono(path: &Path) -> Result<Vec<f32>> {
    use symphonia::core::{
        audio::SampleBuffer, codecs::DecoderOptions, errors::Error, formats::FormatOptions, io::MediaSourceStream,
        meta::MetadataOptions, probe::Hint,
    };
    let file = std::fs::File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| anyhow!("无法识别音频格式：{e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("文件中没有可用音轨"))?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| anyhow!("不支持的音频编码：{e}"))?;
    let mut resampler: Option<Resampler> = None;
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => break,
            Err(e) => return Err(anyhow!("读取音频失败：{e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(anyhow!("解码失败：{e}")),
        };
        let spec = *decoded.spec();
        let r = resampler.get_or_insert_with(|| Resampler::new(spec.rate, 16000));
        let channels = spec.channels.count().max(1);
        if buf.as_ref().is_none_or(|b| b.capacity() < decoded.capacity() * channels) {
            buf = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
        }
        let b = buf.as_mut().unwrap();
        b.copy_interleaved_ref(decoded);
        for frame in b.samples().chunks(channels) {
            r.push(frame.iter().sum::<f32>() / channels as f32);
        }
    }
    Ok(resampler.map(Resampler::finish).unwrap_or_default())
}

#[cfg(test)]
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let mut r = Resampler::new(from, to);
    for &x in input {
        r.push(x);
    }
    r.finish()
}

pub struct Resampler {
    ratio: f64,
    width: usize,
    hist: std::collections::VecDeque<f32>,
    acc: f32,
    count: usize,
    prev: Option<f32>,
    next: usize,
    out: Vec<f32>,
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Self {
        let ratio = from as f64 / to as f64;
        let width = ratio.ceil().max(1.0) as usize;
        Self {
            ratio,
            width,
            hist: std::collections::VecDeque::with_capacity(width + 1),
            acc: 0.0,
            count: 0,
            prev: None,
            next: 0,
            out: Vec::new(),
        }
    }
    pub fn push(&mut self, x: f32) {
        let f = if self.width > 1 {
            self.acc += x;
            self.hist.push_back(x);
            if self.hist.len() > self.width {
                self.acc -= self.hist.pop_front().unwrap_or(0.0);
            }
            self.acc / self.hist.len() as f32
        } else {
            x
        };
        let i = self.count;
        self.count += 1;
        if let Some(p) = self.prev {
            loop {
                let pos = self.next as f64 * self.ratio;
                let j = pos as usize;
                if j + 1 != i {
                    break;
                }
                let frac = (pos - j as f64) as f32;
                self.out.push(p + (f - p) * frac);
                self.next += 1;
            }
        }
        self.prev = Some(f);
    }
    pub fn finish(mut self) -> Vec<f32> {
        let n = (self.count as f64 / self.ratio) as usize;
        if let Some(p) = self.prev {
            while self.next < n {
                self.out.push(p);
                self.next += 1;
            }
        }
        self.out.truncate(n);
        self.out
    }
}

#[cfg(test)]
mod resample_tests {
    fn batch(input: &[f32], from: u32, to: u32) -> Vec<f32> {
        if from == to || input.is_empty() {
            return input.to_vec();
        }
        let ratio = from as f64 / to as f64;
        let width = ratio.ceil().max(1.0) as usize;
        let filtered: Vec<f32> = if width > 1 {
            let mut acc = 0.0f32;
            let mut out = Vec::with_capacity(input.len());
            for i in 0..input.len() {
                acc += input[i];
                if i >= width {
                    acc -= input[i - width];
                }
                out.push(acc / width.min(i + 1) as f32);
            }
            out
        } else {
            input.to_vec()
        };
        let n = (input.len() as f64 / ratio) as usize;
        (0..n)
            .map(|i| {
                let pos = i as f64 * ratio;
                let j = pos as usize;
                let frac = (pos - j as f64) as f32;
                let a = filtered[j.min(filtered.len() - 1)];
                let b = filtered[(j + 1).min(filtered.len() - 1)];
                a + (b - a) * frac
            })
            .collect()
    }

    #[test]
    fn streaming_matches_batch() {
        let input: Vec<f32> = (0..100_003)
            .map(|i| ((i as f32) * 0.013).sin() * 0.7 + ((i * 7919 % 1000) as f32 / 1000.0 - 0.5) * 0.2)
            .collect();
        for (from, to) in [(48_000, 16_000), (44_100, 16_000), (22_050, 16_000), (8_000, 16_000), (16_000, 16_000)] {
            let a = batch(&input, from, to);
            let b = super::resample(&input, from, to);
            assert_eq!(a.len(), b.len(), "{from}->{to} length");
            let worst = a.iter().zip(&b).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
            assert!(worst < 1e-4, "{from}->{to} differs by {worst}");
        }
    }
}

#[cfg(test)]
mod media_tests {
    use super::*;

    #[test]
    fn write_wav_and_decode_round_trip() {
        let dir = std::env::temp_dir().join(format!("pdesk-wav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("sine.wav");
        let input: Vec<f32> = (0..8000).map(|i| ((i as f32) * 0.08).sin() * 0.4).collect();
        write_wav(&wav, &input).unwrap();
        let decoded = decode_16k_mono(&wav).unwrap();
        assert!(!decoded.is_empty() && decoded.len() <= input.len() + 32);
        let max_diff = input
            .iter()
            .zip(&decoded)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(max_diff < 0.01, "max_diff={max_diff}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generates_valid_probe_wav() {
        let dir = std::env::temp_dir().join(format!("pdesk-probe-wav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("probe.wav");
        synth_probe_wav(&wav).unwrap();
        let decoded = decode_16k_mono(&wav).unwrap();
        assert_eq!(decoded.len(), 24_000);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
