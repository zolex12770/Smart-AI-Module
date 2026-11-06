#!/usr/bin/env python3
"""
NirnayAI Video Understanding Engine
Provides video metadata inspection, frame extraction, scene change detection, and timestamp-aware summarization using OpenCV and MoviePy.
"""

import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

import cv2
import numpy as np


class VideoEngine:
    """Video Understanding Engine for NirnayAI."""

    def __init__(self, workspace_dir: str = "data/sandbox/test_video"):
        self.workspace_dir = Path(workspace_dir)
        self.workspace_dir.mkdir(parents=True, exist_ok=True)

    def generate_synthetic_video(self, filename: str = "sample_clip.avi", duration_sec: int = 3, fps: int = 24) -> Path:
        """Create a synthetic video clip with distinct visual scenes for analysis."""
        out_path = self.workspace_dir / filename
        width, height = 640, 360
        fourcc = cv2.VideoWriter_fourcc(*'MJPG')
        writer = cv2.VideoWriter(str(out_path), fourcc, fps, (width, height))

        total_frames = duration_sec * fps
        # Scene 1: Dark Blue with text (0 to 1.5s)
        # Scene 2: Emerald Green with moving box (1.5s to 3.0s)
        for frame_idx in range(total_frames):
            frame = np.zeros((height, width, 3), dtype=np.uint8)
            t = frame_idx / float(fps)

            if t < 1.5:
                # Scene 1
                frame[:] = (50, 20, 15)  # BGR
                cv2.putText(frame, f"Scene 1: Introduction (t={t:.2f}s)", (40, 180),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
            else:
                # Scene 2
                frame[:] = (20, 60, 20)  # BGR
                box_x = int(50 + (t - 1.5) * 200)
                cv2.rectangle(frame, (box_x, 120), (box_x + 80, 220), (0, 255, 120), -1)
                cv2.putText(frame, f"Scene 2: Data Processing (t={t:.2f}s)", (40, 80),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)

            writer.write(frame)

        writer.release()
        return out_path

    def analyze_video(self, video_path: Path, extract_frames_every_sec: float = 1.0) -> dict:
        """Extract metadata, sample frames, detect scene changes, and generate structured summary."""
        if not video_path.exists():
            raise FileNotFoundError(f"Video not found: {video_path}")

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise RuntimeError(f"Could not open video at {video_path}")

        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration_sec = total_frames / float(fps)

        extracted_frames = []
        scene_changes = []

        prev_hist = None
        frame_idx = 0
        frames_dir = self.workspace_dir / "frames"
        frames_dir.mkdir(parents=True, exist_ok=True)

        sample_interval_frames = int(fps * extract_frames_every_sec)

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            current_time = frame_idx / float(fps)

            # Scene Change Detection via Color Histogram Comparison
            hist = cv2.calcHist([frame], [0, 1, 2], None, [8, 8, 8], [0, 256, 0, 256, 0, 256])
            cv2.normalize(hist, hist)

            if prev_hist is not None:
                similarity = cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL)
                # If correlation drops significantly, a scene transition occurred
                if similarity < 0.6:
                    scene_changes.append({
                        "timestamp_sec": round(current_time, 2),
                        "frame_index": frame_idx,
                        "similarity_score": round(float(similarity), 3)
                    })

            prev_hist = hist

            # Periodic frame extraction
            if frame_idx % sample_interval_frames == 0:
                frame_filename = f"frame_{frame_idx}_t{current_time:.1f}s.jpg"
                frame_out = frames_dir / frame_filename
                cv2.imwrite(str(frame_out), frame)
                extracted_frames.append({
                    "timestamp_sec": round(current_time, 2),
                    "frame_index": frame_idx,
                    "path": str(frame_out)
                })

            frame_idx += 1

        cap.release()

        # Build timestamp-aware summary
        scenes_summary = []
        if len(scene_changes) == 0:
            scenes_summary.append({"scene": 1, "start_time": 0.0, "end_time": round(duration_sec, 2), "description": "Single continuous shot."})
        else:
            prev_time = 0.0
            for idx, sc in enumerate(scene_changes):
                scenes_summary.append({
                    "scene": idx + 1,
                    "start_time": prev_time,
                    "end_time": sc["timestamp_sec"],
                    "description": f"Scene segment {idx + 1}"
                })
                prev_time = sc["timestamp_sec"]
            scenes_summary.append({
                "scene": len(scene_changes) + 1,
                "start_time": prev_time,
                "end_time": round(duration_sec, 2),
                "description": f"Scene segment {len(scene_changes) + 1}"
            })

        return {
            "path": str(video_path),
            "dimensions": {"width": width, "height": height},
            "fps": round(fps, 2),
            "total_frames": total_frames,
            "duration_seconds": round(duration_sec, 2),
            "extracted_frame_count": len(extracted_frames),
            "extracted_frames": extracted_frames,
            "detected_scene_transitions": len(scene_changes),
            "scenes": scenes_summary,
            "status": "ANALYZED"
        }


def run_verification():
    print("=== NIRNAYAI VIDEO UNDERSTANDING ENGINE VERIFICATION ===")
    engine = VideoEngine(workspace_dir="data/sandbox/test_video")

    print("[1] Generating synthetic multi-scene test video...")
    video_path = engine.generate_synthetic_video("test_sequence.avi", duration_sec=3, fps=24)
    print(f"✓ Video generated: {video_path}")

    print("[2] Analyzing video structure, extracting frames, and detecting scene transitions...")
    res = engine.analyze_video(video_path, extract_frames_every_sec=1.0)

    print(f"✓ Video Resolution: {res['dimensions']['width']}x{res['dimensions']['height']} @ {res['fps']} FPS")
    print(f"✓ Duration: {res['duration_seconds']}s ({res['total_frames']} total frames)")
    print(f"✓ Frames Extracted to Disk: {res['extracted_frame_count']}")
    print(f"✓ Detected Scene Transitions: {res['detected_scene_transitions']}")
    for s in res["scenes"]:
        print(f"   * Scene {s['scene']}: {s['start_time']}s - {s['end_time']}s ({s['description']})")

    assert res["duration_seconds"] == 3.0, "Video duration mismatch!"
    assert res["extracted_frame_count"] >= 3, "Failed to extract required keyframes!"
    assert res["detected_scene_transitions"] >= 1, "Failed to detect deliberate scene transition at t=1.5s!"

    print("\n🎉 ALL VIDEO UNDERSTANDING TESTS PASSED WITH 100% SUCCESS!")


if __name__ == "__main__":
    run_verification()
