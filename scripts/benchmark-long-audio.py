#!/usr/bin/env python3
"""
NirnayAI Long-Form Audio & Voice Persona Benchmark Suite
Executes and validates short, medium, long, 20-minute, and 30-minute audio generations.
"""

import sys
import time
import os
from pathlib import Path

sys.path.insert(0, os.path.abspath("."))
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

from scripts.lib.long_form_audio_synthesizer import LongFormAudioSynthesizer


def main():
    print("================================================================================")
    print("   NIRNAYAI LONG-FORM AUDIO (20–30 MINUTE) & VOICE PERSONA BENCHMARK            ")
    print("================================================================================\n")

    synthesizer = LongFormAudioSynthesizer(workspace_dir="data/sandbox/long_form_audio")

    # Sample paragraph text generator (~75 words / 30 seconds of speech per paragraph)
    def make_paragraph(num, topic):
        return (
            f"Section {num} explores {topic} in autonomous intelligence engineering. "
            "A robust AI platform requires reliable task routing, verifiable sandbox security, and persistent context retention. "
            "Every component operates with strict boundary isolation, preventing unauthorized side effects while delivering high-throughput performance."
        )

    # 1. Short Sample (1 paragraph, ~25-30s)
    print("[1] Generating Short Audio Sample (~30 seconds) with Voice: Microsoft Zira Desktop...")
    t0 = time.time()
    res_short = synthesizer.generate_long_form_narration(
        [make_paragraph(1, "system architecture")],
        "01_short_sample.wav",
        voice="Microsoft Zira Desktop"
    )
    print(f"✓ Short Sample Generated in {round(time.time() - t0, 2)}s: {res_short['duration_seconds']}s ({res_short['size_bytes']} bytes)")

    # 2. Medium Sample (5 paragraphs, ~2 minutes)
    print("\n[2] Generating Medium Audio Sample (~2 minutes) with Voice: Microsoft David Desktop...")
    t0 = time.time()
    res_med = synthesizer.generate_long_form_narration(
        [make_paragraph(i, f"module {i}") for i in range(1, 6)],
        "02_medium_sample.wav",
        voice="Microsoft David Desktop"
    )
    print(f"✓ Medium Sample Generated in {round(time.time() - t0, 2)}s: {res_med['duration_minutes']} min ({res_med['duration_seconds']}s, {res_med['size_bytes']} bytes)")

    # 3. 20-Minute Narration Sample (~55 paragraphs, ~1,270 seconds / ~21.2 minutes)
    print("\n[3] Generating Full 20-Minute Master Narration with Chunked Pipeline...")
    t0 = time.time()
    res_20min = synthesizer.generate_long_form_narration(
        [make_paragraph(i, f"chapter {i}") for i in range(1, 56)],
        "03_master_20_minute_narration.wav",
        voice="Microsoft Zira Desktop"
    )
    t_20 = round(time.time() - t0, 2)
    print(f"✓ 20-Minute Master Narration Generated in {t_20}s:")
    print(f"  • Total Duration: {res_20min['duration_minutes']} minutes ({res_20min['duration_seconds']} seconds)")
    print(f"  • File Size: {res_20min['size_bytes']} bytes (~{round(res_20min['size_bytes'] / (1024*1024), 2)} MB)")
    print(f"  • Chunks Synthesized & Concatenated: {res_20min['chunk_count']}")
    assert res_20min['duration_minutes'] >= 20.0, f"Expected at least 20.0 minutes, got {res_20min['duration_minutes']}"

    # 4. 30-Minute Narration Sample (~82 paragraphs, ~1,900 seconds / ~31.6 minutes)
    print("\n[4] Generating Full 30-Minute Master Narration with Chunked Pipeline...")
    t0 = time.time()
    res_30min = synthesizer.generate_long_form_narration(
        [make_paragraph(i, f"deep-dive {i}") for i in range(1, 83)],
        "04_master_30_minute_narration.wav",
        voice="Microsoft David Desktop"
    )
    t_30 = round(time.time() - t0, 2)
    print(f"✓ 30-Minute Master Narration Generated in {t_30}s:")
    print(f"  • Total Duration: {res_30min['duration_minutes']} minutes ({res_30min['duration_seconds']} seconds)")
    print(f"  • File Size: {res_30min['size_bytes']} bytes (~{round(res_30min['size_bytes'] / (1024*1024), 2)} MB)")
    print(f"  • Chunks Synthesized & Concatenated: {res_30min['chunk_count']}")
    assert res_30min['duration_minutes'] >= 30.0, f"Expected at least 30.0 minutes, got {res_30min['duration_minutes']}"

    print("\n================================================================================")
    print("   🎉 ALL LONG-FORM AUDIO (20-MIN & 30-MIN) BENCHMARKS PASSED 100%!             ")
    print("================================================================================")


if __name__ == "__main__":
    main()
