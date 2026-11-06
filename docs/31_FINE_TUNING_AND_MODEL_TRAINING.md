# Fine-Tuning, Domain Adaptation & Custom Model Training Architecture

## 1. Executive Summary

In enterprise agent systems such as the **Smart AI Module / Universal AI Agent**, off-the-shelf foundation models provide exceptional general reasoning and zero-shot fluency. However, mission-critical production deployments encounter domain friction in three key areas:
1. **Tool Invocation Reliability & Schema Adherence:** Foundation models occasionally hallucinate arguments, violate JSON/Pydantic schemas, or fail to follow multi-turn tool calling protocols.
2. **Domain-Specific Nomenclature & Procedural Logic:** Highly regulated domains (such as rail reservations, enterprise procurement, compliance auditing, and security patch verification) require specialized behavioral policies that cannot be reliably steered by system prompts alone.
3. **Latency, Cost, and Data Privacy:** Repeatedly packing hundreds of lines of few-shot instructions, API schemas, and historical examples into the prompt context window causes linear degradation in time-to-first-token (TTFT) and token costs, while sending proprietary workflows to external commercial APIs creates compliance risks.

This document establishes the official engineering architecture and operational strategy for **Domain Adaptation, Parameter-Efficient Fine-Tuning (PEFT/LoRA/QLoRA), Preference Alignment (DPO/RLHF), and Quantized Local Deployment** within the Smart AI Module ecosystem.

---

## 2. AI Customization Spectrum: Decision Framework

Before initiating any training pipeline, engineering teams must evaluate the task across the customization spectrum. Training model weights is computationally intensive and incurs ongoing maintenance overhead; therefore, it should only be employed when lower-cost interventions fail to meet quality criteria.

| Intervention | Primary Mechanism | Data Freshness | Hallucination Reduction | Context Consumption | Latency Impact | Operational Complexity | Best Use Case |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Prompt Engineering** | Zero-shot & system instructions | Instant (runtime) | Low | High | High (prompt processing) | Minimal | General task steering, format shaping, persona framing |
| **In-Context Learning (Few-Shot)** | 2–5 exemplar demonstrations in context | Instant (runtime) | Moderate | Very High | High | Low | Rare formatting patterns, edge-case disambiguation |
| **Retrieval-Augmented Generation (RAG)** | Dynamic retrieval from vector / hybrid index | Near real-time (index updates) | Very High (grounded in docs) | Moderate | Moderate (search overhead) | Moderate | Up-to-date documentation, enterprise knowledge bases, codebases |
| **Agent Memory (Episodic / Semantic)** | User and session memory stores | Real-time | Moderate | Low | Low | Moderate | Personalized preferences, user identity, cross-session facts |
| **Parameter-Efficient Fine-Tuning (PEFT / LoRA)** | Low-rank weight adaptation ($0.1\% - 2\%$ of parameters) | Static (until retrained) | High (for behavioral style) | Lowest (zero in-context tokens) | Lowest (fast inference) | Moderate to High | Tool calling syntax, specialized reasoning trajectories, domain tone |
| **Continued Pre-Training / Full Fine-Tuning** | Training all weights on large domain corpora | Static | High | Lowest | Lowest | Very High | Entirely new languages, heavily proprietary dialects, internal codebases |

### The "When to Train" Decision Rule:
```
           +---------------------------------------------+
           | Does the task require access to rapidly      |
           | changing knowledge or proprietary documents?|
           +---------------------------------------------+
                               |
                   +-----------+-----------+
                   | YES                   | NO
                   v                       v
          +------------------+    +------------------------------------+
          | Deploy RAG or    |    | Does the model consistently fail   |
          | Agent Memory     |    | output schema, tool invocation, or |
          +------------------+    | domain reasoning despite few-shot? |
                                  +------------------------------------+
                                           |
                               +-----------+-----------+
                               | YES                   | NO
                               v                       v
                      +------------------+    +------------------------+
                      | Fine-Tune via    |    | Optimize System Prompt |
                      | LoRA / QLoRA     |    | & Context Assembly     |
                      +------------------+    +------------------------+
```

---

## 3. Parameter-Efficient Fine-Tuning (PEFT) Mechanics

### 3.1 LoRA (Low-Rank Adaptation)
In standard fine-tuning, full model weights $W_0 \in \mathbb{R}^{d \times k}$ are updated by calculating dense gradient matrices $\Delta W$. For a 7B parameter model, full 16-bit fine-tuning requires $>56$ GB of VRAM solely for optimizer states (AdamW tracks first and second moments).

LoRA decomposes $\Delta W$ into the product of two low-rank matrices:
$$\Delta W = B \cdot A$$
where $B \in \mathbb{R}^{d \times r}$, $A \in \mathbb{R}^{r \times k}$, and rank $r \ll \min(d, k)$.

During forward pass computation:
$$h = W_0 x + \frac{\alpha}{r} B A x$$
- $A$ is initialized from a Gaussian distribution $\mathcal{N}(0, \sigma^2)$ and $B$ is initialized to 0, ensuring $\Delta W = 0$ at step 0.
- $\alpha$ is a constant scaling hyperparameter (typically set to $2r$ or $r$).
- For modern LLMs (e.g., Llama 3, Qwen 2.5, Mistral), target modules include:
  - Attention projections: `q_proj`, `k_proj`, `v_proj`, `o_proj`
  - MLP projections: `gate_proj`, `up_proj`, `down_proj`

### 3.2 QLoRA (Quantized LoRA)
QLoRA achieves state-of-the-art fine-tuning efficiency by quantizing the frozen base model to 4-bit NormalFloat (NF4) while maintaining 16-bit Brain Floating Point (BF16) LoRA adapter weights:
1. **NF4 Data Type:** Information-theoretically optimal quantile quantization for normally distributed weights.
2. **Double Quantization (DQ):** Quantizes the quantization constants themselves, saving ~0.37 bits per parameter (~3 GB on a 65B model).
3. **Paged Optimizers:** Uses CUDA unified memory to page optimizer states between GPU VRAM and CPU RAM during gradient checkpointing spikes, eliminating Out-Of-Memory (OOM) crashes.

---

## 4. Dataset Engineering & Preparation Pipeline

High-quality instruction data is vastly more important than quantity. For parameter-efficient domain adaptation of the Smart AI Module agent, 1,500 to 5,000 rigorous multi-turn trajectory examples consistently outperform 100,000 noisy web scraped samples.

### 4.1 Trajectory Schema (ChatML Standard)
The Smart AI Module standardizes on the **ChatML** multi-role schema with explicit tool call markers:

```json
{
  "messages": [
    {
      "role": "system",
      "content": "You are the Universal AI Agent. You have access to authorized tools: [web_search, execute_shell, file_read, db_query]. Respond with tool invocations using JSON format when external information or actions are required."
    },
    {
      "role": "user",
      "content": "Find the current status of booking PNR 8452194820 and update the customer notes."
    },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_irctc_01",
          "type": "function",
          "function": {
            "name": "check_pnr_status",
            "arguments": "{\"pnr\": \"8452194820\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_irctc_01",
      "content": "{\"status\": \"CONFIRMED\", \"coach\": \"B2\", \"berth\": 41, \"quota\": \"GENERAL\"}"
    },
    {
      "role": "assistant",
      "content": "PNR 8452194820 is confirmed in Coach B2, Berth 41 (General Quota). Proceeding to record these details in customer notes."
    }
  ]
}
```

### 4.2 Curation & Filtering Standards
1. **Deduplication:** Use MinHash LSH with Jaccard similarity threshold $> 0.85$ to remove redundant instruction pairs.
2. **Syntax Validation:** Every JSON tool call in training targets is parsed with `JSON.parse` / `json.loads` against the production JSON Schema before inclusion. Invalid trajectories are discarded.
3. **Length Distribution:** Sequence lengths capped at 4,096 or 8,192 tokens with packing enabled (`packing=True` in HuggingFace TRL) to eliminate padding waste and optimize GPU throughput.

---

## 5. Training Pipeline Architecture

### 5.1 Training Recipe (HuggingFace TRL + PEFT)
```python
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from trl import SFTTrainer, SFTConfig
import torch

# 1. 4-Bit NF4 Quantization Configuration
bnb_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=torch.bfloat16,
    bnb_4bit_use_double_quant=True
)

# 2. Base Model Loading (e.g., Qwen 2.5 7B or Llama 3.1 8B)
model_id = "Qwen/Qwen2.5-7B-Instruct"
tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
model = AutoModelForCausalLM.from_pretrained(
    model_id,
    quantization_config=bnb_config,
    device_map="auto",
    torch_dtype=torch.bfloat16
)
model = prepare_model_for_kbit_training(model)

# 3. LoRA Configuration
peft_config = LoraConfig(
    r=16,
    lora_alpha=32,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    lora_dropout=0.05,
    bias="none",
    task_type="CAUSAL_LM"
)

# 4. SFT Trainer Settings
training_args = SFTConfig(
    output_dir="./weights/smart-agent-qwen2.5-7b-lora",
    max_seq_length=4096,
    per_device_train_batch_size=4,
    gradient_accumulation_steps=4,
    learning_rate=2e-4,
    lr_scheduler_type="cosine",
    warmup_ratio=0.03,
    weight_decay=0.01,
    logging_steps=10,
    save_strategy="steps",
    save_steps=100,
    evaluation_strategy="steps",
    eval_steps=100,
    fp16=False,
    bf16=True,
    packing=True
)

trainer = SFTTrainer(
    model=model,
    train_dataset=dataset["train"],
    eval_dataset=dataset["test"],
    peft_config=peft_config,
    tokenizer=tokenizer,
    args=training_args
)

trainer.train()
```

---

## 6. Evaluation & Alignment Validation Suite

Trained checkpoints must pass three sequential gates before promotion to staging:

1. **Loss & Perplexity Gate:**
   - Training loss curve must exhibit steady convergence without overfitting divergence ($Eval\ Loss \le 1.15 \times Train\ Loss$).
   - Perplexity on unseen domain test sets must decrease relative to base model.
2. **Automated Schema & Tool Execution Gate:**
   - 100 out-of-domain synthetic test prompts requiring multi-tool invocation are evaluated.
   - **Pass Criteria:** $\ge 98\%$ valid JSON formatting, $0\%$ hallucinated tool names, $100\%$ argument type adherence.
3. **LLM-as-a-Judge Alignment Gate:**
   - Blind pairwise comparison between base model and fine-tuned model scored by a neutral judge model (e.g. Gemini 2.5 Flash / Claude 3.5 Sonnet) on helpfulness, accuracy, brevity, and safety.
   - **Pass Criteria:** Win rate $\ge 70\%$ against base model on domain tasks.

---

## 7. Model Export, Quantization, and Runtime Serving

To serve the fine-tuned model efficiently within the Smart AI Module platform:

### 7.1 Weight Merging
```python
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

base_model = AutoModelForCausalLM.from_pretrained("Qwen/Qwen2.5-7B-Instruct", torch_dtype="auto")
model = PeftModel.from_pretrained(base_model, "./weights/smart-agent-qwen2.5-7b-lora")
merged_model = model.merge_and_unload()
merged_model.save_pretrained("./weights/smart-agent-qwen2.5-7b-merged")
```

### 7.2 Quantization to GGUF (for Ollama & llama.cpp)
```bash
# Convert HuggingFace format to GGUF FP16
python llama.cpp/convert_hf_to_gguf.py ./weights/smart-agent-qwen2.5-7b-merged --outfile smart-agent-7b.fp16.gguf

# Quantize to 4-bit medium (Q4_K_M)
llama.cpp/llama-quantize smart-agent-7b.fp16.gguf smart-agent-7b.Q4_K_M.gguf Q4_K_M
```

### 7.3 Serving via Ollama or vLLM
Create an Ollama `Modelfile`:
```dockerfile
FROM ./smart-agent-7b.Q4_K_M.gguf
PARAMETER temperature 0.2
PARAMETER top_p 0.95
PARAMETER stop "<|im_end|>"
PARAMETER stop "<|endoftext|>"
TEMPLATE """{{ if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}{{ range .Messages }}<|im_start|>{{ .Role }}
{{ .Content }}<|im_end|>
{{ end }}<|im_start|>assistant
"""
```

Register and serve:
```bash
ollama create smart-agent:7b -f Modelfile
ollama run smart-agent:7b
```

In the backend configuration (`backend/.env`):
```env
ALLOW_MOCK_PROVIDERS=false
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=smart-agent:7b
LLM_CONTEXT_WINDOW=8192
```

The Fastify backend automatically discovers, warms up, and routes all chat, coding, research, and multimodal agent workflows through `LocalOpenAICompatibleProvider`, delivering high-speed, 100% private, domain-adapted intelligence.
