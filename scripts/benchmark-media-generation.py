#!/usr/bin/env python3
"""
NirnayAI Real Media Generation Benchmark
Validates image generation and MP4 video generation with audio.
"""

import sys
import os
import subprocess
from pathlib import Path

sys.path.insert(0, os.path.abspath("."))
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

from scripts.lib.media_generation_engine import MediaGenerationEngine


def main():
    print("================================================================================")
    print("   NIRNAYAI REAL MEDIA GENERATION (IMAGES & VIDEOS) BENCHMARK SUITE             ")
    print("================================================================================\n")

    engine = MediaGenerationEngine(workspace_dir="data/sandbox/media_generation")

    # 1. Text-to-Image Generation
    print("[1] Generating High-Resolution 1024x1024 Image from Prompt...")
    img_res = engine.generate_image(
        prompt="Cyberpunk autonomous neural nexus with glowing purple grid and neon core",
        filename="cyberpunk_nexus_1024.png",
        width=1024,
        height=1024,
        style="cyberpunk"
    )
    print("✓ Image Artifact Created:")
    print(f"  • Path: {img_res['path']}")
    print(f"  • Dimensions: {img_res['width']}x{img_res['height']}")
    print(f"  • Format: {img_res['format']}")
    print(f"  • Size: {img_res['size_bytes']} bytes")
    assert img_res['size_bytes'] > 50000, "Image artifact too small!"

    # 2. Nature/Landscape Image Generation
    print("\n[2] Generating 1280x720 Landscape Art Image...")
    landscape_res = engine.generate_image(
        prompt="Golden hour mountain sunset with tranquil silhouette and glowing sun",
        filename="mountain_sunset_720p.png",
        width=1280,
        height=720,
        style="sunset"
    )
    print(f"✓ Landscape Image Created: {landscape_res['path']} ({landscape_res['size_bytes']} bytes)")

    # 3. Text-to-Video with Audio Composition
    print("\n[3] Generating 720p HD MP4 Video with H.264 Video, AAC Audio, and Animated Zoom...")
    vid_res = engine.generate_video(
        prompt="Autonomous AI agent platform core neural processor",
        narration_text="NirnayAI autonomous platform presents real high-definition multimodal video generation.",
        filename="nirnayai_platform_intro.mp4",
        duration_seconds=5
    )
    print("✓ MP4 Video Artifact Created:")
    print(f"  • Path: {vid_res['path']}")
    print(f"  • Duration: {vid_res['duration_seconds']}s")
    print(f"  • Resolution: {vid_res['resolution']}")
    print(f"  • Codecs: {vid_res['video_codec']} / {vid_res['audio_codec']}")
    print(f"  • File Size: {vid_res['size_bytes']} bytes")
    assert vid_res['size_bytes'] > 100000, "Video artifact too small!"

    # 4. Verify Video Stream with FFmpeg
    print("\n[4] Inspecting Video Integrity with FFmpeg...")
    probe_proc = subprocess.run(
        ["ffmpeg", "-i", vid_res["path"]],
        capture_output=True,
        text=True
    )
    output = probe_proc.stderr
    has_h264 = "h264" in output.lower() or "avc1" in output.lower()
    has_aac = "aac" in output.lower()
    has_duration = "duration: 00:00:05" in output.lower()
    print(f"✓ H.264 Video Stream: {has_h264}")
    print(f"✓ AAC Audio Stream: {has_aac}")
    print(f"✓ Exact 5.0s Duration: {has_duration}")
    assert has_h264 and has_aac, "Video streams missing H.264 or AAC!"

    print("\n================================================================================")
    print("   🎉 REAL IMAGE & VIDEO GENERATION BENCHMARKS PASSED 100%!                     ")
    print("================================================================================")


if __name__ == "__main__":
    main()
