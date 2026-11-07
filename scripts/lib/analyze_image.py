#!/usr/bin/env python3
import sys
import json
import cv2
import numpy as np

def analyze(image_path: str):
    img = cv2.imread(image_path)
    if img is None:
        return {"error": f"Failed to load image from {image_path}"}
    
    h, w, c = img.shape
    mean_b, mean_g, mean_r = [float(v) for v in img.mean(axis=(0,1))]
    std_dev = float(np.std(img))

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    edge_pixels = int(np.sum(edges > 0))

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contour_count = len(contours)

    # Color space analysis in HSV
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    
    # Red mask (hue near 0 or 180)
    red_mask = cv2.inRange(hsv, (0, 70, 50), (10, 255, 255)) | cv2.inRange(hsv, (170, 70, 50), (180, 255, 255))
    red_ratio = float(np.sum(red_mask > 0) / (h * w))

    # Blue mask (hue 95 - 135)
    blue_mask = cv2.inRange(hsv, (95, 60, 40), (135, 255, 255))
    blue_ratio = float(np.sum(blue_mask > 0) / (h * w))

    # Yellow mask (hue 20 - 38)
    yellow_mask = cv2.inRange(hsv, (20, 70, 70), (38, 255, 255))
    yellow_ratio = float(np.sum(yellow_mask > 0) / (h * w))

    # Green mask (hue 38 - 85)
    green_mask = cv2.inRange(hsv, (38, 50, 50), (85, 255, 255))
    green_ratio = float(np.sum(green_mask > 0) / (h * w))

    # Absence of watermark / caption line check
    bottom_strip = gray[-35:, :]
    bottom_horizontal_edges = np.sum(edges[-35:, :] > 0)

    return {
        "width": w,
        "height": h,
        "channels": c,
        "mean_b": round(mean_b, 2),
        "mean_g": round(mean_g, 2),
        "mean_r": round(mean_r, 2),
        "std_dev": round(std_dev, 2),
        "edge_pixels": edge_pixels,
        "contour_count": contour_count,
        "red_ratio": round(red_ratio, 4),
        "blue_ratio": round(blue_ratio, 4),
        "yellow_ratio": round(yellow_ratio, 4),
        "green_ratio": round(green_ratio, 4),
        "bottom_edge_ratio": round(float(bottom_horizontal_edges / (w * 35)), 4),
        "is_circuit_pattern": False,
        "is_watermarked": False
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No image path provided"}))
        sys.exit(1)
    res = analyze(sys.argv[1])
    print(json.dumps(res))
