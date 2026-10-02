---
author: Alexey Ermolaev
pubDatetime: 2026-10-02T10:00:00Z
modDatetime: 2026-10-02T10:00:00Z
title: Adding CUDA to my Rust LLM engine
slug: rvllm-cuda
featured: true
draft: false
tags:
  - rust
  - LLM
  - inference
  - CUDA
description: I added a CUDA backend to rvllm with hand written kernels, cuBLAS for matmuls, and a test that checks every step against the CPU path.
headerArt: /art/rvllm.svg
---

In the [last post](/posts/rvllm-memcpy) I fixed the CPU path of [rvllm](https://github.com/ermolushka/rvllm) and said GPU work was next. It's here now. rvllm can run SmolLM2-360M on an NVIDIA GPU with `--device cuda`, and the whole forward pass goes through CUDA code I wrote myself, not through candle's GPU backend.

I ran the benchmark on a Google Colab T4, a small and old GPU, so treat the numbers as a first look. They are in the [Numbers](#numbers) section below, and there is a lot of room left to make them better.

## The plan

The idea was to keep everything above the math the same. The scheduler, the paged KV cache, continuous batching and prefix caching don't know or care what runs the matmuls. Only the "do the math" part gets a second implementation.

So there are two paths now:

- **CPU path.** Candle tensors, like before.
- **CUDA path.** A `CudaModel` that mirrors the CPU `Model` line by line, but works on raw GPU buffers (`CudaSlice<f32>` from the `cudarc` crate). It lives in `src/cuda/` behind a `cuda` cargo feature.

I did not make a shared trait for the two. The CPU model is built out of candle `Tensor` types and the CUDA one out of raw buffers, so a trait would have been mostly glue. Two files that look alike is simpler to read and to compare.

The feature is opt in, so on a Mac or any machine without a GPU nothing changes. You also need to pass `--device cuda` at runtime. Building with the feature only makes the code available.

## No nvcc needed

The kernels are plain `.cu` files, and they are compiled at runtime with NVRTC, NVIDIA's runtime compiler. `cudarc` wraps it, so loading a kernel is just this:

```rust
let ptx = cudarc::nvrtc::compile_ptx(source)?;
let module = self.ctx.load_module(ptx)?;
let kernel = module.load_function(kernel_name)?;
```

There is no build script and no `nvcc` on the machine. The source files are embedded into the binary with `include_str!`, and all 12 kernels get compiled when the runtime starts up. The first version read them from disk with a relative path, which worked only when I started the binary from inside `src/cuda/`. Embedding fixed that for good.

## Matmuls go to cuBLAS

I wrote kernels for everything except matrix multiplication. Matmul goes to cuBLAS, because a naive matmul kernel would be slow and beating cuBLAS is a project of its own. It's the known good baseline I can improve on later.

The annoying part is that cuBLAS is column-major and all my buffers are row-major. The trick that made this easy: a row-major buffer of shape `(p, q)` is byte for byte the same as a column-major buffer of shape `(q, p)`. It's just the transpose, for free. So I never think in column-major. I write the result I want as a row-major product, transpose the whole equation, and read the cuBLAS arguments off that. For a linear layer (`y = x @ W^T`) it ends up as:

```rust
let cfg = GemmConfig {
    transa: cublasOperation_t::CUBLAS_OP_T,
    transb: cublasOperation_t::CUBLAS_OP_N,
    m: out_features as i32,
    n: rows as i32,
    k: in_features as i32,
    alpha: 1.0f32,
    lda: in_features as i32,
    ldb: in_features as i32,
    beta: 0.0f32,
    ldc: out_features as i32,
};
unsafe { cuda_runtime.blas.gemm(cfg, weight, x, output) }?;
```

The weights keep the same `[out, in]` layout as on the CPU, so nothing gets transposed or copied. After the last post I'm a bit paranoid about that.

Attention uses cuBLAS too, as a strided batched GEMM, so one call does `Q @ K^T` for every sequence and every KV head at once. There are two small tricks here:

- Grouped-query attention is folded into the row count. Several Q heads share one KV head, so I stack the group of Q heads as extra rows for the same K. That is a free reinterpretation of the buffer, no copy.
- The `1 / sqrt(head_dim)` scale goes into cuBLAS's `alpha`, so it needs no separate pass over the scores.

## The kernels

The other kernels are small. Most are one thread per output element, with the index math doing the work.

**RMSNorm and softmax** use one block per row. Each thread sums a strided slice of the row, then the block reduces those partial sums in shared memory:

```cuda
for (unsigned int s = blockDim.x / 2; s > 0; s >>= 1) {
    if (tid < s) {
        sdata[tid] += sdata[tid + s];
    }
    __syncthreads();
}
```

Softmax does three passes over the row: find the max, sum `exp(x - max)`, then divide. It keeps the exp values in the output buffer so the last pass doesn't compute `expf` again.

**RoPE** is one thread per pair of values. Each thread loads two numbers, rotates them with a precomputed cos and sin, and writes them back.

**SiLU and the gate multiply** are the easy ones. `silu(gate) * up` in one kernel, so the FFN doesn't write an intermediate buffer.

**The KV cache kernels** are where the paged cache from kv-cache-scheduler shows up on the GPU. The cache is one big buffer shaped `[num_blocks, block_size, n_kv_heads, head_dim]`.

- `kv_write` takes the new K and V for each token, plus a block id and an offset for that token. Each thread copies one float to its slot. Every thread writes a different place, so no synchronization is needed.
- `kv_gather` does the reverse. For every position in a sequence's context it figures out which block it lives in, looks that block up in the sequence's block table, and copies the value into a contiguous buffer for attention.

```cuda
unsigned int block_pos = pos / block_size;
unsigned int offset = pos % block_size;
unsigned int block = block_idx[b * max_blocks + block_pos];
```

This is the same scatter and gather math the CPU version does, just as raw offsets instead of tensor ops. It was the part I was least sure about in the first post, and it turned out to be the most mechanical. Mostly it's integer division and modulo, and I'd rather be careful than clever there.

A few plain helper kernels cover the things candle did for free on CPU: embedding lookup, residual add, attention mask add, and picking the last row of each sequence. And `transpose_axes12`, because a reshape or transpose that costs nothing in candle needs a real kernel when you manage the memory yourself.

## Things that were problematic

**`INFINITY` doesn't exist in NVRTC.** Softmax starts its max search from minus infinity. I wrote `-INFINITY`, and the kernel failed to compile, because NVRTC doesn't include `math.h`. I build it from the bit pattern instead: `-__int_as_float(0x7f800000)`, since `0x7f800000` is positive infinity in IEEE-754. It looks silly, but it works. It also matters that the start value is minus infinity and not zero, otherwise a row full of negative numbers would get the wrong max.

**Masked positions rely on that same infinity.** Padding in a batch gets a mask of minus infinity added to the scores. After the max subtraction, `expf(-inf)` is exactly 0 and the position drops out of the sum. No special case needed.

**Row-major against column-major.** This one is easy to get wrong without any error, because a transposed matrix is still a valid matrix. Reasoning in column-major directly made my head hurt, so the rule is: write the row-major answer, then transpose the equation. Each wrapper has a comment explaining the shapes.

## How I know it's correct

This is the part I care most about. The last post ended with "keep a checksum of the output", so the same idea is here.

The kernels and the cuBLAS wrappers have their own tests that run them on small inputs and compare against candle or a hand computed result. Then there are end to end tests on a tiny fake model (1 layer, 4 hidden dims, random weights). It runs the same tokens through the candle path and the CUDA path and checks that:

- the logits match within a small tolerance (1e-2, relative), and
- the greedy argmax token is the same.

One test does prefill with one sequence. Another does a batched decode step with two sequences at different positions, so the gather, masking and block table logic all get used.

All of these tests do `let Some(rt) = runtime() else { return };`, so on a machine without a GPU they pass without doing anything. That's on purpose, because my laptop has no CUDA device and CI runs on a normal GitHub runner. The downside is that CI can't catch a CUDA bug, so the CUDA tests only mean something when run on a machine with a GPU.

## Numbers

This is the `bench` binary from the earlier posts on a T4, with the same SmolLM2-360M Q8_0 file, a 128 token prompt, 64 generated tokens, greedy decoding:

```
batch   total tok/s   tok/s per request   decode ms/step   first token
1            96.6            96.6              9.9            28 ms
4           257.3            64.3             13.5            33 ms
8           342.1            42.8             19.2            34 ms
16          505.6            31.6             23.2            34 ms
32          678.2            21.2             30.1            34 ms
```

Two things I like here. Batching works: going from 1 request to 32 makes each step only 3 times slower (9.9 ms to 30 ms), while doing 32 times the work, so total throughput goes up 7 times. And the first token time stays around 30 ms no matter the batch size, with prefill at roughly 3.8 to 4.6 thousand tokens per second.

The part I don't like: 9.9 ms for one decode step of a 360M model is slow for a T4. Its memory bandwidth is about 320 GB/s, and the F32 weights are about 1.4 GB, so just reading them once should take around 4.5 ms. I'm at twice that, which fits the list of problems in the next section (F32 weights, allocations, host work every step). Going from batch 1 to 4 costing 36 percent more per step also hints that a chunk of the time is fixed overhead and not math.

For scale, the CPU path on my M5 MacBook did 16 tok/s at batch 1 and 27 tok/s at batch 4 in the last post. Different machines, so it's not a fair comparison, but it shows the GPU path is working and not secretly running on the CPU. I still haven't run llama.cpp on the same file, so I can't say where this stands against it.

## What's basic about it

Same honesty as before. It took me quite a while to make a basic version work (and sometimes my buddy Claude helped me to debug complex issues or indexing stuff). This works, but it's far from fast, and I know a lot of places where it leaves speed on the table:

- **Still F32 everywhere.** The GGUF file is Q8_0, but I dequantize on load and upload F32 weights, so the GPU moves 4 times more bytes than it needs to. Decode is mostly memory bound, so this is probably the biggest single thing.
- **Allocation inside the loop.** Each layer allocates fresh output buffers instead of reusing a pre-allocated workspace.
- **Host work every step.** RoPE tables, the attention mask and the gather plan are built on the CPU and uploaded on every forward pass.
- **Attention is three separate steps.** Scores, softmax, then `probs @ V`, and the scores matrix goes through global memory in between. A fused attention kernel would avoid that.
- **The gather copies the whole context.** Every decode step copies all the K and V for every sequence into a contiguous buffer before attention. A kernel that reads straight from blocks (what vLLM's paged attention does) wouldn't need that.
- **Naive reductions.** My shared memory reductions are the textbook version, not warp shuffles.

Some of these are probably the same kind of mistake as the memcpy one, something that looks cheap and isn't. I just haven't profiled it yet.

## What's next

1. **Profile the CUDA path.** Nsight, and a comparison against llama.cpp on the same model. I want to know what is actually slow before I touch anything.
2. **Fix the obvious things:** reuse buffers, stop uploading the same tables every step, then look at quantized weights.
3. **Metal**, with the same approach as CUDA.

The code is at [github.com/ermolushka/rvllm](https://github.com/ermolushka/rvllm). Everything CUDA is under `src/cuda/`, and the kernels are in `src/cuda/kernels/`, each under 70 lines, so they're a decent place to start reading if you want to see what a Llama layer looks like at the GPU level.
