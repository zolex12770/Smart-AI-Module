#!/usr/bin/env python3
"""
NirnayAI Vision & Image Understanding Engine
Uses Pillow and OpenCV for real computer vision, image inspection, layout detection, and feature analysis.
"""

import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

import numpy as np
from PIL import Image, ImageDraw, ImageFont
import cv2


class VisionEngine:
    """Vision & Image Understanding Engine for NirnayAI."""

    def __init__(self, workspace_dir: str = "data/sandbox/test_vision"):
        self.workspace_dir = Path(workspace_dir)
        self.workspace_dir.mkdir(parents=True, exist_ok=True)

    def generate_synthetic_diagram(self, filename: str = "sample_architecture.png") -> Path:
        """Create a synthetic UI/architecture diagram image for vision analysis."""
        img_path = self.workspace_dir / filename
        width, height = 800, 500
        image = Image.new("RGB", (width, height), color="#0f172a")
        draw = ImageDraw.Draw(image)

        # Draw structural bounding boxes & banners
        # Title box
        draw.rectangle([40, 30, 760, 90], fill="#1e293b", outline="#3b82f6", width=2)
        draw.text((60, 50), "NIRNAYAI MULTIMODAL ORCHESTRATION PIPELINE", fill="#ffffff")

        # Three architecture layer boxes
        draw.rectangle([60, 130, 260, 380], fill="#1e293b", outline="#10b981", width=2)
        draw.text((80, 150), "1. Intelligence Layer", fill="#10b981")
        draw.text((80, 190), "Local Qwen 2.5 7B", fill="#cbd5e1")
        draw.text((80, 220), "Context Memory", fill="#cbd5e1")

        draw.rectangle([300, 130, 500, 380], fill="#1e293b", outline="#6366f1", width=2)
        draw.text((320, 150), "2. Specialist Engines", fill="#6366f1")
        draw.text((320, 190), "Document Engine", fill="#cbd5e1")
        draw.text((320, 220), "Vision & Speech", fill="#cbd5e1")
        draw.text((320, 250), "Coding Agent", fill="#cbd5e1")

        draw.rectangle([540, 130, 740, 380], fill="#1e293b", outline="#f59e0b", width=2)
        draw.text((560, 150), "3. Storage Layer", fill="#f59e0b")
        draw.text((560, 190), "PGlite / SQLite", fill="#cbd5e1")
        draw.text((560, 220), "Local Sandboxes", fill="#cbd5e1")

        # Connector line
        draw.line([(260, 250), (300, 250)], fill="#38bdf8", width=3)
        draw.line([(500, 250), (540, 250)], fill="#38bdf8", width=3)

        image.save(str(img_path))
        return img_path

    def analyze_image(self, img_path: Path) -> dict:
        """Perform comprehensive visual, structural, and contour analysis."""
        if not img_path.exists():
            raise FileNotFoundError(f"Image not found: {img_path}")

        # 1. Pillow Inspection
        with Image.open(str(img_path)) as pil_img:
            format_name = pil_img.format
            width, height = pil_img.size
            mode = pil_img.mode

        # 2. OpenCV Structural & Feature Analysis
        cv_img = cv2.imread(str(img_path))
        if cv_img is None:
            raise ValueError(f"Could not decode image at {img_path}")

        gray = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY)

        # Average brightness (0-255)
        mean_brightness = float(np.mean(gray))

        # Sharpness / Blur detection (variance of Laplacian)
        laplacian_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())

        # Edge detection & Contours
        edges = cv2.Canny(gray, threshold1=50, threshold2=150)
        contours, _ = cv2.findContours(edges, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

        # Detect high-contrast bounding boxes (UI cards / layout panels)
        bounding_boxes = []
        for c in contours:
            x, y, w, h = cv2.boundingRect(c)
            # Filter small noise artifacts
            if w > 50 and h > 30:
                bounding_boxes.append({"x": int(x), "y": int(y), "width": int(w), "height": int(h)})

        return {
            "path": str(img_path),
            "dimensions": {"width": width, "height": height},
            "color_mode": mode,
            "format": format_name,
            "mean_brightness": round(mean_brightness, 2),
            "sharpness_score": round(laplacian_var, 2),
            "contour_count": len(contours),
            "detected_structural_regions": len(bounding_boxes),
            "regions": bounding_boxes[:5],  # Sample first 5
            "status": "ANALYZED"
        }


def run_verification():
    print("=== NIRNAYAI VISION & IMAGE UNDERSTANDING ENGINE VERIFICATION ===")
    engine = VisionEngine(workspace_dir="data/sandbox/test_vision")

    print("[1] Generating architecture diagram artifact...")
    diag_path = engine.generate_synthetic_diagram("nirnay_arch_sample.png")
    print(f"✓ Diagram generated: {diag_path}")

    print("[2] Executing OpenCV & Pillow structural visual analysis...")
    analysis = engine.analyze_image(diag_path)
    print(f"✓ Dimensions: {analysis['dimensions']['width']}x{analysis['dimensions']['height']}")
    print(f"✓ Color Mode: {analysis['color_mode']}, Format: {analysis['format']}")
    print(f"✓ Sharpness Score (Laplacian variance): {analysis['sharpness_score']}")
    print(f"✓ Detected Structural Regions (Layout UI Boxes): {analysis['detected_structural_regions']}")

    assert analysis["dimensions"]["width"] == 800, "Image width incorrect!"
    assert analysis["detected_structural_regions"] >= 3, "Failed to detect primary UI layout blocks!"

    print("\n🎉 ALL VISION & IMAGE ANALYSIS TESTS PASSED WITH 100% SUCCESS!")


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--analyze":
        target = Path(sys.argv[2])
        engine = VisionEngine()
        result = engine.analyze_image(target)
        import json
        print(json.dumps(result))
    else:
        run_verification()
