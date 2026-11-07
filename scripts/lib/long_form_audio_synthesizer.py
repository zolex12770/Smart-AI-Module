#!/usr/bin/env python3
"""
NirnayAI Long-Form Audio Synthesis & Persona Engine
Supports long-form narration (20 to 30 minutes) via text segmentation, chunked synthesis,
silence insertion, and seamless concatenation.
"""

import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

import os
import wave
import subprocess
import base64
import time


class LongFormAudioSynthesizer:
    def __init__(self, workspace_dir: str = "data/sandbox/long_form_audio"):
        self.workspace_dir = Path(workspace_dir)
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        self.chunks_dir = self.workspace_dir / "chunks"
        self.chunks_dir.mkdir(parents=True, exist_ok=True)

    def synthesize_single_chunk(self, text: str, output_path: Path, voice: str = "Microsoft Zira Desktop", rate: int = 0) -> None:
        """Synthesize an individual speech chunk safely using base64 environment encoding."""
        text_b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
        safe_out = str(output_path).replace("\\", "/")

        ps_script = (
            "$raw = [System.Convert]::FromBase64String($env:NIRNAY_TTS_TEXT);"
            "$text = [System.Text.Encoding]::UTF8.GetString($raw);"
            "Add-Type -AssemblyName System.Speech;"
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
            f"$s.SelectVoice('{voice}');"
            f"$s.Rate = {rate};"
            f"$s.SetOutputToWaveFile('{safe_out}');"
            "$s.Speak($text);"
            "$s.Dispose();"
        )

        env = os.environ.copy()
        env["NIRNAY_TTS_TEXT"] = text_b64

        cmd = ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script]
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=120)
        if proc.returncode != 0:
            raise RuntimeError(f"Chunk synthesis failed: {proc.stderr}")

        if not output_path.exists() or output_path.stat().st_size == 0:
            raise RuntimeError(f"Chunk output empty: {output_path}")

    def create_silence_chunk(self, output_path: Path, duration_seconds: float = 0.4, sample_rate: int = 22050) -> None:
        """Generate a silent PCM wave chunk to insert natural breathing pauses between paragraphs."""
        num_frames = int(sample_rate * duration_seconds)
        silence_data = b"\x00\x00" * num_frames  # 16-bit mono silence (0 value)

        with wave.open(str(output_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(silence_data)

    def concatenate_wav_files(self, wav_files: list[Path], output_path: Path) -> dict:
        """Concatenate multiple PCM WAV files into one master continuous audio track."""
        if not wav_files:
            raise ValueError("No WAV files provided for concatenation.")

        data = []
        sample_rate = None
        channels = None
        sample_width = None

        for wf_path in wav_files:
            with wave.open(str(wf_path), "rb") as wf:
                if sample_rate is None:
                    sample_rate = wf.getframerate()
                    channels = wf.getnchannels()
                    sample_width = wf.getsampwidth()
                data.append(wf.readframes(wf.getnframes()))

        with wave.open(str(output_path), "wb") as out_wf:
            out_wf.setnchannels(channels)
            out_wf.setsampwidth(sample_width)
            out_wf.setframerate(sample_rate)
            for chunk_data in data:
                out_wf.writeframes(chunk_data)

        size_bytes = output_path.stat().st_size
        with wave.open(str(output_path), "rb") as wf:
            n_frames = wf.getnframes()
            duration_sec = n_frames / float(sample_rate)

        return {
            "path": str(output_path),
            "size_bytes": size_bytes,
            "duration_seconds": round(duration_sec, 2),
            "duration_minutes": round(duration_sec / 60.0, 2),
            "sample_rate": sample_rate,
            "channels": channels,
            "bit_depth": sample_width * 8,
        }

    def synthesize_chunks_batch(self, chunks: list[tuple[str, Path]], voice: str = "Microsoft Zira Desktop", rate: int = 0) -> None:
        """Synthesize multiple speech chunks in a single high-performance PowerShell session."""
        import json
        manifest = [
            {"text": text, "path": str(out_path).replace("\\", "/")}
            for text, out_path in chunks
        ]
        manifest_path = self.chunks_dir / "manifest.json"
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f)

        safe_manifest = str(manifest_path).replace("\\", "/")
        ps_script = (
            f"$manifest = Get-Content '{safe_manifest}' -Raw | ConvertFrom-Json;"
            "Add-Type -AssemblyName System.Speech;"
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
            f"$s.SelectVoice('{voice}');"
            f"$s.Rate = {rate};"
            "foreach ($item in $manifest) {"
            "    $s.SetOutputToWaveFile($item.path);"
            "    $s.Speak($item.text);"
            "}"
            "$s.Dispose();"
        )

        cmd = ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            raise RuntimeError(f"Batch chunk synthesis failed: {proc.stderr}")

        for _, out_path in chunks:
            if not out_path.exists() or out_path.stat().st_size == 0:
                raise RuntimeError(f"Chunk output empty: {out_path}")

    def generate_long_form_narration(
        self,
        paragraphs: list[str],
        output_filename: str,
        voice: str = "Microsoft Zira Desktop",
        rate: int = 0,
        pause_between_paragraphs: float = 0.4
    ) -> dict:
        """Generate long-form narration through segmenting, chunking, silence buffering, and concatenation."""
        chunk_items = []
        for idx, para in enumerate(paragraphs, start=1):
            chunk_file = self.chunks_dir / f"chunk_{output_filename}_{idx:03d}.wav"
            chunk_items.append((para, chunk_file))

        # Batch synthesize all chunks in one high-performance persistent session
        self.synthesize_chunks_batch(chunk_items, voice=voice, rate=rate)

        silence_path = self.chunks_dir / "silence_pause.wav"
        self.create_silence_chunk(silence_path, duration_seconds=pause_between_paragraphs)

        ordered_wavs = []
        for idx, (_, chunk_file) in enumerate(chunk_items, start=1):
            ordered_wavs.append(chunk_file)
            if idx < len(chunk_items):
                ordered_wavs.append(silence_path)

        master_path = self.workspace_dir / output_filename
        res = self.concatenate_wav_files(ordered_wavs, master_path)
        res["chunk_count"] = len(paragraphs)
        res["voice"] = voice
        return res
