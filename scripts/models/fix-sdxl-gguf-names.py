#!/usr/bin/env python3
"""
Rename the SDXL tensors stable-diffusion.cpp's diffusers loader maps wrongly, in a converted GGUF.

Checked against stable-diffusion.cpp commit 168f7b8 (2026-09-27): a GGUF converted from a diffusers
SDXL directory is detected as SD 1.x and fails to load, because
  - the second text encoder is loaded as "te.1.", which the name map's "te." entry swallows
    (first match in an unordered map), merging both encoders - renamed to "te2.";
  - unet.add_embedding has no mapping to LDM's label_emb.0.{0,2};
  - SDXL's first up-block has attention, so its upsampler is output_blocks.2.2, not SD 1.x's 2.1.
Names already in LDM form pass through the loader unchanged, so writing them that way fixes all three.

    pip install gguf
    python3 scripts/models/fix-sdxl-gguf-names.py in.gguf out.gguf
"""
import sys
from gguf import GGUFReader, GGUFWriter, GGUFValueType
src, dst = sys.argv[1], sys.argv[2]
r = GGUFReader(src)
arch = "sd"
for f in r.fields.values():
    if f.name == "general.architecture":
        arch = bytes(f.parts[f.data[0]]).decode()
w = GGUFWriter(dst, arch)
# Copy every metadata field except the ones GGUFWriter writes itself.
for f in r.fields.values():
    if f.name.startswith("GGUF.") or f.name == "general.architecture":
        continue
    t = f.types[0]
    if t == GGUFValueType.STRING:
        w.add_string(f.name, bytes(f.parts[f.data[0]]).decode())
    elif t == GGUFValueType.ARRAY:
        continue
    else:
        w.add_key_value(f.name, f.parts[f.data[0]][0], t)
renamed = 0
for t in r.tensors:
    name = t.name
    # Upstream sd.cpp's diffusers->LDM map has no entry for these SDXL tensors (checked against
    # commit 168f7b8): the second text encoder's "te.1." collides with "te.", add_embedding has no
    # mapping, and SDXL's first up-block upsampler follows an attention layer (slot .2, not .1).
    FIXED = {
        "unet.add_embedding.linear_1.": "model.diffusion_model.label_emb.0.0.",
        "unet.add_embedding.linear_2.": "model.diffusion_model.label_emb.0.2.",
        "unet.up_blocks.0.upsamplers.0.conv.": "model.diffusion_model.output_blocks.2.2.conv.",
    }
    if name.startswith("te.1."):
        name = "te2." + name[len("te.1."):]
        renamed += 1
    for old, new in FIXED.items():
        if name.startswith(old):
            name = new + name[len(old):]
            renamed += 1
    # Raw bytes with their original type: quantized tensors are copied, never re-quantized.
    w.add_tensor(name, t.data, raw_dtype=t.tensor_type)
print("renamed", renamed, "of", len(r.tensors))
w.write_header_to_file(); w.write_kv_data_to_file(); w.write_tensors_to_file()
w.close()
