---
author: Alexey Ermolaev
pubDatetime: 2026-09-20T10:00:00Z
modDatetime: 2026-09-20T10:00:00Z
title: rvllm - A Small LLM Inference Engine in Rust
slug: rvllm
featured: true
draft: false
tags:
  - rust
  - LLM
  - inference
  - candle
description: A basic local LLM inference engine written from scratch in Rust, running SmolLM2 on CPU with continuous batching and paged KV cache, and where CUDA and Metal support fit in next.
headerArt: /art/rvllm.svg
---

After building [kv-cache-scheduler](/posts/kv-cache-scheduler) I wanted to actually wire it into a real model instead of just running it against synthetic data. So I built [rvllm](https://github.com/ermolushka/rvllm), a small LLM inference engine in Rust that loads a GGUF model and runs it on CPU using [candle](https://github.com/huggingface/candle) as the tensor backend.

Right now it's simple and basic. It runs SmolLM2-360M on CPU, does continuous batching across multiple prompts, and shares KV cache blocks between requests with the same prefix. No GPU support yet. This post is mostly a walkthrough of what's there today and what I want to add next.

## What it does

The CLI takes a GGUF model file and a tokenizer, then runs one or more prompts through the model:

```bash
cargo run --release -- \
  --model ../SmolLM2-360M.Q8_0.gguf \
  --tokenizer tokenizer.json \
  --prompt "The capital of France is" \
  --prompt "The sky is" \
  --prompt "2 + 2 =" \
  --max-tokens 20
```

Passing `--prompt` more than once runs all of them concurrently through continuous batching, sharing one KV block pool. There's also `--arrival-step` to simulate requests showing up at different decode steps, which is handy for testing the scheduler's waiting queue instead of only ever seeing the happy path where everything arrives at once.

Sampling is either greedy argmax (`--temperature 0.0`, the default, fully deterministic) or nucleus sampling with `--temperature` and `--top-p`, seeded for reproducibility.

## How it's put together

The model itself is a fairly standard Llama-family architecture, since that's what SmolLM2 is built on:

- **RMSNorm** instead of LayerNorm - just rescale by root-mean-square, no mean centering
- **RoPE** (rotary position embeddings) for positional info, rotate-half convention
- **Grouped-query attention** - fewer KV heads than Q heads, each KV head shared by a group of Q heads
- **SwiGLU** feed-forward blocks

None of this is unusual, it's the same shape as most small open models right now. The more interesting part is how it's wired to the KV cache.

Instead of one big tensor per sequence, the KV cache is a pool of fixed-size blocks managed by kv-cache-scheduler, the crate from my last post. Every forward pass takes explicit `write_positions` (where to store the new K/V) and `read_blocks` (which physical blocks to attend over), both computed from the scheduler's block table:

```rust
let logits = model::forward(
    config,
    &tokens[skip_tokens..],
    device,
    &mut kv_storage,
    &write_positions,
    &read_blocks,
    read_num_tokens,
    skip_tokens,
)?;
```

The `skip_tokens` part is prefix caching in action. Before running the forward pass, the engine checks the prefix cache for a token match and only computes the tokens after the matched prefix, reading the rest straight from already-written blocks. If two prompts share a system prompt prefix, the second one skips recomputing it entirely.

Decoding runs as a loop with three stages each step: admit any requests whose arrival step has been reached, prefill as many waiting requests as there's pool capacity for, then run one batched decode step for everything currently running. All the currently-running sequences share a single `forward_batch` call, each contributing exactly one new token, which is the "continuous" part of continuous batching - sequences join and leave the batch between steps instead of waiting for the whole batch to finish.

## What's basic about it right now

To be upfront, this is a learning project, not something you'd want to deploy:

- **CPU only.** Everything runs through candle's CPU backend. This is fine for a 360M model but obviously won't scale.
- **One model architecture.** It's written specifically for SmolLM2's config shape, not a general loader for arbitrary Llama-family checkpoints.
- **No quantized compute.** The GGUF file gets read for weights but the actual matmuls run in F32, no int8 or 4-bit kernels.
- **No streaming output**, no server, no OpenAI-compatible API - just a CLI that runs to completion and prints the result.

## What's next: CUDA and Metal, the hard way

Here's the part that might be surprising: I'm not planning to just flip on candle's `cuda` feature and call it done. The actual goal of this project is to beat llama.cpp on batched throughput (tokens/sec at batch size above 1, not single-request latency, that's llama.cpp's game with its SIMD kernels). To get there I want to actually understand what happens at the GPU kernel level, so candle stays CPU only on purpose, and GPU support comes in as hand-written kernels instead.

The plan, roughly:

1. **CUDA first, via `cudarc`, not candle's GPU backend.** Matmul starts on cuBLAS through `cudarc::cublas` as a known-good baseline. Everything else gets a hand-written kernel: RMSNorm, RoPE, softmax, SiLU plus residual add, and the KV cache write/gather logic that currently lives in `kv_storage.rs`. That last one is the part I'm least sure about, it needs to become the same block-indexed scatter/gather math as today but as raw pointer offsets into a `CudaSlice` instead of tensor ops. I'm building this up in small steps: first just prove the toolchain works (allocate a buffer, copy data to the device and back), then one trivial kernel to get the compile and launch plumbing right, then RMSNorm and RoPE since those are small but easy to get subtly wrong, then softmax and the KV kernels, and only then wire it all into a `KvStorage` that can hold either CPU tensors or CUDA buffers. Every step gets checked token for token against the CPU path before moving to the next one.
2. **Metal after that**, same approach, hand-written kernels via `metal-rs` instead of candle's Metal backend, using `MPSMatrixMultiplication` as the matmul baseline. Doing CUDA first because the tooling for debugging it (NVRTC, Nsight) is more mature.
3. **After both GPU backends work**, the plan is to rewrite the CPU math itself from scratch too, dropping candle entirely, informed by whatever gets learned writing the CUDA and Metal kernels. The architecture and KV cache design carry over unchanged, only the "do the math" layer gets replaced. Right now that's deliberately vague until the GPU kernel work is actually done.

If you want to see how a paged KV cache actually gets wired into forward passes rather than just simulated, the code is at [github.com/ermolushka/rvllm](https://github.com/ermolushka/rvllm).
