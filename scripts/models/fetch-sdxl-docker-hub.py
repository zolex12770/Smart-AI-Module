#!/usr/bin/env python3
"""
Fetch SDXL base 1.0 from Docker Hub's `ai/stable-diffusion` model artifact, for stable-diffusion.cpp.

For a network that can reach Docker Hub but not Hugging Face (where SD-Turbo, the CI model, lives).
The artifact is one DDUF file: an uncompressed ZIP of a diffusers directory. This reads its central
directory with HTTP range requests and downloads only the members stable-diffusion.cpp loads, straight
to disk - no 7 GB intermediate.

    python3 scripts/models/fetch-sdxl-docker-hub.py /opt/models/sdxl
    sd-cli -M convert -m /opt/models/sdxl -o sdxl-q8_0.gguf --type q8_0
    python3 scripts/models/fix-sdxl-gguf-names.py sdxl-q8_0.gguf sdxl-q8_0-ldm.gguf   # needs `pip install gguf`

Standard library only.
"""
import json, struct, sys, urllib.request, os
out = sys.argv[1] if len(sys.argv) > 1 else "sdxl"
repo, tag = "ai/stable-diffusion", "latest"
tok = json.load(urllib.request.urlopen(f"https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull"))["token"]
H = {"Authorization": f"Bearer {tok}", "Accept": "application/vnd.oci.image.manifest.v1+json"}
m = json.load(urllib.request.urlopen(urllib.request.Request(f"https://registry-1.docker.io/v2/{repo}/manifests/{tag}", headers=H)))
layer = [l for l in m["layers"] if "dduf" in l["mediaType"]][0]
size, digest = layer["size"], layer["digest"]
url = f"https://registry-1.docker.io/v2/{repo}/blobs/{digest}"
def rng(a, b):
    req = urllib.request.Request(url, headers={**H, "Range": f"bytes={a}-{b}"})
    return urllib.request.urlopen(req).read()
tail = rng(size - 65536, size - 1)
i = tail.rfind(b"PK\x05\x06")
eocd = tail[i:]
cd_size, cd_off = struct.unpack("<II", eocd[12:20])
if cd_off == 0xFFFFFFFF:  # zip64
    j = tail.rfind(b"PK\x06\x07"); z64off = struct.unpack("<Q", tail[j+8:j+16])[0]
    z = rng(z64off, z64off + 55)
    cd_size, cd_off = struct.unpack("<QQ", z[40:56])
cd = rng(cd_off, cd_off + cd_size - 1)
p = 0; entries = []
while p < len(cd) and cd[p:p+4] == b"PK\x01\x02":
    method, = struct.unpack("<H", cd[p+10:p+12])
    csize, usize = struct.unpack("<II", cd[p+20:p+28])
    nlen, xlen, clen = struct.unpack("<HHH", cd[p+28:p+34])
    loff, = struct.unpack("<I", cd[p+42:p+46])
    name = cd[p+46:p+46+nlen].decode()
    extra = cd[p+46+nlen:p+46+nlen+xlen]
    q = 0
    while q < len(extra):
        hid, hlen = struct.unpack("<HH", extra[q:q+4])
        if hid == 1:
            vals = list(struct.unpack("<" + "Q" * (hlen // 8), extra[q+4:q+4+hlen])); k = 0
            if usize == 0xFFFFFFFF: usize = vals[k]; k += 1
            if csize == 0xFFFFFFFF: csize = vals[k]; k += 1
            if loff == 0xFFFFFFFF: loff = vals[k]; k += 1
        q += 4 + hlen
    entries.append(dict(name=name, method=method, size=usize, offset=loff))
    p += 46 + nlen + xlen + clen

if os.environ.get("LIST_ONLY"):
    for e in entries: print(e["size"], e["name"])
    sys.exit(0)

# ---- download only what stable-diffusion.cpp loads ----
want = ["model_index.json", "vae/diffusion_pytorch_model.safetensors", "text_encoder/model.safetensors",
        "text_encoder_2/model.safetensors", "unet/diffusion_pytorch_model.safetensors"]
for e in entries:
    if e["name"] not in want: continue
    path = os.path.join(out, e["name"]); os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path) and os.path.getsize(path) == e["size"]: print("have", e["name"]); continue
    lh = urllib.request.urlopen(urllib.request.Request(url, headers={**H, "Range": f"bytes={e['offset']}-{e['offset']+29}"})).read()
    nlen, xlen = struct.unpack("<HH", lh[26:30])
    start = e["offset"] + 30 + nlen + xlen
    req = urllib.request.Request(url, headers={**H, "Range": f"bytes={start}-{start + e['size'] - 1}"})
    with urllib.request.urlopen(req) as r, open(path, "wb") as f:
        while True:
            chunk = r.read(8 << 20)
            if not chunk: break
            f.write(chunk)
    assert os.path.getsize(path) == e["size"], (e["name"], os.path.getsize(path), e["size"])
    print("ok", e["name"], e["size"], flush=True)
print("DONE")
