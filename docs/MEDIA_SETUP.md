# Media setup

How to turn on image, speech and video generation on your own machine. [MEDIA.md](MEDIA.md)
explains how each capability works, the long-form video pipeline, and the measurements.

Every capability is off until its software is configured. Until then the API answers with a
capability error that names the variables to set, and the UI says the same. Nothing produces
placeholder output unless `ALLOW_MOCK_PROVIDERS=true`, which only tests set and production
refuses.

Check what the running backend picked up:

```bash
curl -s -b cookies.txt http://localhost:8787/api/v1/providers | jq '{image, video, speech}'
```

Each entry reports `available`, the provider `name` and `isMock`. The boot log says the same
thing, one line per capability.

## 1. ffmpeg (needed for video assembly and for measuring narration length)

| Platform | Install |
|---|---|
| Debian/Ubuntu | `sudo apt-get install -y ffmpeg` |
| macOS | `brew install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg` |

The backend probes `ffmpeg -version` at boot. The probe allows 30 s and makes 2 attempts, so a
cold disk does not disable video for the life of the process. Set `FFMPEG_PATH` (and
`FFPROBE_PATH`) when the binaries are not on `PATH`. Both Docker images include ffmpeg. The WebM rendition (DL-19) needs the `libvpx-vp9` and
`libopus` encoders, which the Debian, Ubuntu and Homebrew packages include; check with
`ffmpeg -hide_banner -encoders | grep -E "libvpx-vp9|libopus"`.

## 2. Speech — Piper (offline)

```bash
mkdir -p /opt/tools && cd /opt/tools
curl -L -o piper.tgz https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
tar xzf piper.tgz                                   # → /opt/tools/piper/piper
mkdir -p voices && cd voices
curl -L -O https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/low/en_US-lessac-low.onnx
curl -L -O https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/low/en_US-lessac-low.onnx.json
```

```dotenv
SPEECH_PROVIDER=piper
PIPER_PATH=/opt/tools/piper/piper
PIPER_VOICE=/opt/tools/voices/en_US-lessac-low.onnx
```

The API image already contains Piper and the `en_US-lessac-medium` voice. Where huggingface.co is
blocked, `PIPER_VOICE_ARCHIVE_URL` (a Docker build argument) takes the voice from a GitHub
release instead; [docker/README.md](../docker/README.md) has the details.

**Verify:** the Audio screen, or
`POST /api/v1/audio {"text":"Hello from Piper."}` followed by `GET /api/v1/audio/:id` until the
status is `succeeded`. The acceptance script's AUDIO check measures the WAV's RMS, so silence
fails it.

## 3. Images — stable-diffusion.cpp (local, CPU or GPU)

1. **Get a binary.** Either download a release of
   [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp/releases), or build one:
   `cmake -B build && cmake --build build --config Release -j`, which gives `build/bin/sd-cli`.
2. **Get a model.**
   - The quickest is SD-Turbo (`sd_turbo.safetensors`, about 2 GB, 1 step). CI uses it.
   - SDXL base looks better and is much slower on CPU.
   - Where Hugging Face is unreachable, `scripts/models/` builds an SDXL GGUF from Docker Hub's
     `ai/stable-diffusion` artifact. [MEDIA.md](MEDIA.md#images) has the three commands.
3. **Configure:**

   ```dotenv
   IMAGE_SD_CLI_PATH=/opt/tools/sd/sd-cli
   IMAGE_SD_MODEL_PATH=/opt/models/sd_turbo.safetensors
   # SD-Turbo needs none of the rest. For SDXL base:
   # IMAGE_SD_STEPS=12
   # IMAGE_SD_CFG_SCALE=6
   # IMAGE_SD_SIZE=512
   # IMAGE_SD_TIMEOUT_MS=1200000
   ```

One generation runs at a time, so two SDXL processes cannot exhaust memory beside a chat model.
Cancel stops a running generation: the process is killed and the image is settled `cancelled`
(DL-14).

**Measured here:** SDXL q8_0, 512×512, 12 steps, on 4 CPU cores with no GPU, took 292 s from the
CLI.

**Verify:** the Images screen. The acceptance script's IMAGE check decodes the PNG and fails a
flat or blank one.

With Docker Compose, the `docker-compose.sdcpp.yml` overlay mounts a host sd-cli and model into
the API and worker containers:

```bash
SD_CLI_DIR=/opt/tools/sd SD_MODEL_DIR=/opt/models IMAGE_SD_MODEL_FILE=sd_turbo.safetensors \
  docker compose -f docker-compose.yml -f docker-compose.sdcpp.yml up -d
```

## 4. Video

Nothing extra is needed. With a real image provider (step 3) and ffmpeg (step 1), the
**image-motion** provider is selected automatically. It renders one generated still per scene and
animates it with ffmpeg. It is labelled as motion, not a video model, everywhere it appears.

With speech (step 2), scenes are narrated and the rendered MP4 carries an AAC track and subtitles
(SRT, and WebVTT for the browser).

The storyboard is written by the chat model, so a model runtime is needed too
([LOCAL_SETUP.md](LOCAL_SETUP.md)).

For a hosted video model, set `VIDEO_PROVIDER=replicate`, `VIDEO_API_TOKEN` and
`VIDEO_MODEL_VERSION`. This path is fixture-tested; it has not been run with a real token here.

**Verify:** the Videos screen. The acceptance script's VIDEO check runs ffprobe on the MP4 and
requires H.264, AAC and a subtitle stream, plus a WebVTT asset.

## Limits

To bound media spend, set `DAILY_IMAGE_LIMIT`, `MONTHLY_VIDEO_SECONDS_LIMIT`,
`DAILY_SPEECH_CHARACTER_LIMIT` and `MONTHLY_SPEECH_CHARACTER_LIMIT`. They apply per organization,
and the Usage screen shows each of them.
