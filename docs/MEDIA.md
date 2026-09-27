# Media: images, speech, video

Every media capability runs on software you can host yourself. When a capability is not
configured, the API returns a capability error and the UI says it is not configured. There is
no placeholder output unless `ALLOW_MOCK_PROVIDERS=true`, which only tests use and production refuses.

`GET /api/v1/providers` reports, for each of image, video and speech: `available`, the provider
`name`, whether it `isMock`, and (for video) its `technique`.

## Images

| Provider | Configuration | Notes |
|---|---|---|
| **stable-diffusion.cpp** (local, CPU or GPU) | `IMAGE_SD_CLI_PATH`, `IMAGE_SD_MODEL_PATH`; `IMAGE_SD_STEPS`, `IMAGE_SD_CFG_SCALE`, `IMAGE_SD_SIZE`, `IMAGE_SD_THREADS`, `IMAGE_SD_TIMEOUT_MS` | Runs one generation at a time (`maxConcurrency: 1`); the video scene worker sizes itself from that |
| OpenAI-compatible `/v1/images/generations` (OpenAI, LocalAI, …) | `IMAGE_BASE_URL`, `IMAGE_MODEL`, `IMAGE_API_KEY` | Fixture-tested; no credentials in this environment |

**Models.** CI uses SD-Turbo (1 step, CFG 1, the config defaults). Where Hugging Face is not
reachable, `scripts/models/` fetches SDXL base 1.0 from Docker Hub's `ai/stable-diffusion`
artifact and prepares it for stable-diffusion.cpp:

```bash
python3 scripts/models/fetch-sdxl-docker-hub.py /opt/models/sdxl        # ~6.5 GB, range requests
sd-cli -M convert -m /opt/models/sdxl -o sdxl-q8_0.gguf --type q8_0      # ~4.2 GB
pip install gguf && python3 scripts/models/fix-sdxl-gguf-names.py sdxl-q8_0.gguf sdxl-q8_0-ldm.gguf
```

The last step works around three gaps in stable-diffusion.cpp's diffusers→LDM name mapping for
SDXL (commit `168f7b8`). Without it the model is detected as SD 1.x and refuses to load. SDXL base
needs more steps than SD-Turbo: `IMAGE_SD_STEPS=12`, `IMAGE_SD_CFG_SCALE=6` were used here.

**Measured** (SDXL q8_0, 512×512, 12 steps, 4 CPU cores, no GPU): 292 s from the CLI; 341 s through
`POST /api/v1/images`, with the chat model loaded beside it. The result is a real PNG, verified by
decoding its pixels: a flat or blank image fails the acceptance check.

## Speech

| Provider | Configuration |
|---|---|
| **Piper** (offline neural TTS) | `SPEECH_PROVIDER=piper`, `PIPER_PATH`, `PIPER_VOICE` |
| OpenAI-compatible `/v1/audio/speech` | `SPEECH_PROVIDER=openai`, `SPEECH_BASE_URL`, `SPEECH_MODEL`, `SPEECH_API_KEY` |
| Windows SAPI | `SPEECH_PROVIDER=sapi` (Windows only) |

**Measured**: a two-sentence narration in 1–3 s with the `en-us-lessac-low` voice; a 16 kHz PCM
WAV whose samples are measured (RMS 0.137), so silence fails.

## Video

| Provider | Configuration | What it is |
|---|---|---|
| **image-motion** (local) | automatic when a real image provider and a working `ffmpeg` are present | A generated still per scene, animated by ffmpeg: **motion, not a video model**, and it says so in its name, its capabilities and every clip's metadata |
| Replicate | `VIDEO_PROVIDER=replicate`, `VIDEO_API_TOKEN`, `VIDEO_MODEL_VERSION` | A hosted video model; fixture-tested, no token here |

### The long-form pipeline

```
POST /api/v1/videos ──▶ project in `planning` (202 immediately)
                         │
            video.plan job (API role — it needs the chat model)
                         │  script + storyboard: one shot and one narration line per scene
                         ▼
                   `generating_scenes`  ── video.generate_scene × N (worker role)
                         │                    still → motion clip; narration → speech
                         ▼
                   video.render job (worker role)
                         │  ffmpeg: clips + narration + subtitles on one timeline
                         ▼
              MP4 (H.264 + AAC + mov_text), SRT and WebVTT assets
```

- **The storyboard is written in a job, not in the request.** It used to run inside the POST
  under a 25-second ceiling, which a local 7B model on four CPU cores did not meet. Every video
  then fell back to the deterministic storyboard ("Scene 1 of 2: <prompt>") with no narration,
  no audio track and no subtitles. The job's deadline is `VIDEO_SCRIPT_TIMEOUT_MS` (default 180 s).
  The call asks for JSON mode, and one unusable (not truncated) reply gets one corrective retry;
  both calls are metered. Measured after that change: 5 of 5 storyboards written by qwen2.5:7b,
  26–30 s each.
- **A fallback is recorded, never hidden.** If the storyboard stage cannot run, the project's
  `script.scriptSource` is `deterministic` and `script.fallbackReason` says why; the video page
  shows both.
- **Statuses**: `planning`, `generating_scenes`, `assembling`, then `succeeded`,
  `partially_succeeded`, `failed` or `cancelled`; a separate `renderStatus` for the ffmpeg step
  (`skipped_no_ffmpeg` when there is none: the clips exist and are downloadable, and no MP4 is
  pretended).
- **Cancellation** reaches a running provider call; **retry** resumes only unfinished work (a
  project stuck in `planning` is re-planned).

Verification uses `ffprobe` on the downloaded MP4. The acceptance check requires an H.264 video
stream, an AAC audio stream, a subtitle stream, a duration of at least 4 s, a valid WebVTT asset,
and at least one narrated scene.
