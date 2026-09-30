# Cold model load, before and after DL-27

The machine is 4 CPU cores, 16 GB RAM and a virtio disk. The model is qwen2.5:7b (4.7 GB) in
Ollama, in the Docker Compose stack.

| Run | Condition | Warm-up result | Ollama's request log |
|---|---|---|---|
| Before the fix (image `16d352b`) | First boot after a machine restart | **failed at 303.9 s**: "Could not reach the local model runtime at http://ollama:11434/v1: fetch failed" | `500 \| 5m3s`, and the load was cancelled |
| Isolated | Node's global `fetch` against a server that withholds headers for 310 s | failed after **301 s**, `UND_ERR_HEADERS_TIMEOUT` | — |
| After the fix (image `14c94f9`) | Page cache dropped (`echo 3 > /proc/sys/vm/drop_caches`) | warmed up in 151.6 s | `200 \| 2m31s` |
| After the fix (image `14c94f9`) | Page cache dropped **and** Ollama's disk reads limited to 12 MiB/s, so the load takes longer than 300 s | **warmed up in 383.1 s** | `200 \| 6m23s` |

The last row is the failing case of the first row, reproduced deliberately, and it now completes.
The read limit came from a compose override kept outside the repository:
`blkio_config.device_read_bps: [{path: /dev/vda, rate: 12mb}]`.
