---
author: Alexey Ermolaev
pubDatetime: 2026-06-25T10:00:00Z
modDatetime: 2026-06-25T10:00:00Z
title: Building a KV Cache Block Scheduler in Rust
slug: kv-cache-scheduler
featured: true
draft: false
tags:
  - rust
  - LLM
  - inference
  - memory
description: A from-scratch PagedAttention-style KV cache block manager in Rust - reference counting, prefix caching via radix trie, LRU eviction, and copy-on-write for beam search.
headerArt: /art/kv-cache-scheduler.svg
---

I've been spending a lot of time recently thinking about LLM inference memory and challenges which come with it. After writing that [vLLM benchmark post](/posts/vllm-benchmark-4090) and seeing how vLLM's KV cache pre-allocation works, I wanted to understand the block scheduler internals in more details. So I built one: [kv-cache-scheduler](https://github.com/ermolushka/kv-cache-scheduler), a pure Rust implementation of the PagedAttention-style memory manager from the vLLM paper.

No GPU tensors, no CUDA - just the allocation logic for now, which turns out to be the interesting part.

## The problem with naive KV cache allocation

When an LLM generates tokens, it needs to store the key-value attention cache for every token (and for evey layer) in the context. The straightforward approach is to allocate a contiguous chunk of memory per request, sized to the maximum possible sequence length. This works, but it has two nasty properties:

1. **Fragmentation** - if you reserve 4096 tokens worth of memory for a request that uses 200, the rest is wasted until the request finishes.
2. **No sharing** - if 100 concurrent requests all start with the same system prompt, you're storing the same KV values 100 times (caching, huh?).

The PagedAttention insight (from the [vLLM paper](https://arxiv.org/abs/2309.06180)) is to treat KV cache like virtual memory. Instead of contiguous per-request allocations, you keep a pool of fixed-size blocks and map logical token positions to physical blocks through a page table - exactly how an OS manages process memory.

This allows two things: multiple requests can share physical blocks when their token prefixes are identical, and you can evict the LRU request when the pool fills up rather than rejecting it.

## What the scheduler actually does

The project is structured in six phases that build on each other:

### 1. BlockPool - the allocator

The foundation is a fixed-size pool of `N` blocks. Each block is just an `BlockID(u32)` - an index into the pool. The pool tracks a free list and a reference count per block:

```rust
pub struct BlockPool {
    free_list: VecDeque<BlockID>,
    ref_count: Vec<u32>,
}
```

Allocation pops from the free list and sets `ref_count = 1`. When you decrement the ref count to zero, the block goes back to the free list. Easy as it sounds - no heap allocation, no fragmentation.

### 2. BlockTable - the page table

Each sequence gets a `BlockTable`: a `Vec<BlockID>` mapping logical block indices to physical block IDs. Token index `i` maps to block `i / block_size` at offset `i % block_size`. Straightforward virtual memory paging.

The interesting method is `ensure_unshared`:

```rust
fn ensure_unshared(&mut self, slot: usize, pool: &mut BlockPool) -> BlockID {
    let block = self.blocks[slot];
    if pool.get_ref_count(block) > 1 {
        let new_block = pool.alloc().unwrap();
        pool.decref(block);
        self.blocks[slot] = new_block;
        new_block
    } else {
        block
    }
}
```

This is copy-on-write (CoW). Before writing to a shared block, allocate a fresh one. This is what makes beam search efficient - you fork sequences freely (just incrementing ref counts), and copy only when a branch actually changes direction.

### 3. Sequence Manager - the lifecycle

The `Scheduler` orchestrates the whole thing. The sequence lifecycle looks like:

```
add_request(tokens) -> Waiting
    |
prefill(seq_id) -> Decoding   <- prefix cache consulted here
    | (loop)
step() -> append one token per decode step
    |
finish_sequence(seq_id) -> decref all blocks
```

During prefill, the scheduler checks the prefix cache before allocating. If the first `N` tokens match a cached prefix, it reuses those physical blocks (incrementing ref counts). Only the unmatched tail gets fresh allocations. After prefill, it inserts the full sequence into the cache for future requests.

### 4. LRU Eviction

When `step()` fails to allocate because the pool is exhausted, `handle_pool_full()` runs:

1. Find the least-recently-used block with `ref_count == 1` (blocks with higher ref counts are shared and ineligible)
2. Find which sequence owns that block
3. Preempt the entire sequence - decref all its blocks, move it back to `Waiting`
4. Retry the allocation

The LRU tracking uses a `LinkedHashMap` - access moves a block to the front, so the tail is always the oldest. Looking up the first entry with `ref_count == 1` takes O(n) in the worst case, but in practice most blocks aren't shared.

Evicting the whole sequence rather than individual blocks is a known simplification. It avoids leaving sequences in a half-valid state and matches how vLLM handles memory pressure in production.

### 5. Prefix Cache - the radix trie

The prefix cache is a radix trie over token IDs. Each node can hold a `BlockID` at block-aligned depths (every `block_size` tokens):

```rust
struct TrieNode {
    children: HashMap<TokenId, TrieNode>,
    block_id: Option<BlockID>,
}
```

Lookup walks the trie until the tokens differ, returning all matched blocks. Insertion stores block IDs at each block boundary. The trie holds references to physical blocks (incrementing ref counts), so blocks shared with the cache won't get evicted while they're in use.

When eviction happens, the cache marks affected nodes as `None` but keeps the trie structure. Future requests can still match partial prefixes - they just won't get a cached block for the evicted portion.

### 6. Copy-on-Write for Beam Search

Beam search forks a sequence into `K` candidates from the same prefix. With CoW, the fork is free - `fork_sequence` clones the block table and increments ref counts on every block:

```rust
fn fork_sequence(&mut self, parent_id: SequenceId) -> SequenceId {
    let new_id = self.next_seq_id();
    let forked_table = self.sequences[parent_id].block_table.fork(&mut self.pool);
    // fork() incrubs all block ref counts
    ...
}
```

All branches share blocks until one writes a new token that crosses into a partial block. At that point, `append_token_cow` calls `ensure_unshared` on just that one block. Full blocks (already sealed) stay shared indefinitely since no new tokens will go into them.

## Benchmarks

The benchmark runs 300 synthetic requests against a 512-block pool with `block_size=16`. Half the requests share a 64-token system prompt (4 prefix blocks), the other half are unique.

```
Shared prefix scenario:
  blocks allocated:  1,643
  prefix hit rate:   69.9%
  avg pool util:     12.9%

No sharing scenario:
  blocks allocated:  2,070
  prefix hit rate:   0.0%
  avg pool util:     16.1%
```

About 20% fewer allocations just from prefix caching. The hit rate of 69.9% means roughly 70% of prompt tokens were served from cached blocks. In a real serving setup with a fixed system prompt across all requests, this would be even higher.

## What I found interesting

**Reference counting as the core invariant.** Almost everything else in the system depends on ref counts being correct. A block can be owned by the free pool, one or more sequences, the prefix cache, or some combination. The invariant is simple - a block returns to the free list exactly when its ref count hits zero - but getting there requires care in every code path.

**Whole-sequence eviction is underappreciated.** I initially thought block-level eviction would be more efficient (evict just the minimal set of blocks to make room), but it creates too many edge cases. Where do you put a sequence whose first 3 blocks are evicted? The simplicity of "preempt the whole thing, put it back in the waiting queue" is actually a better tradeoff.

**The trie keeps the structure even after eviction.** This was by design. When a block gets evicted from the pool, I mark its trie node as `None` but don't prune the branch. The next request that shares a prefix up to that node can still match the sub-prefix before it, which is often better than a full cache miss. Pruning would be cleaner but wasteful.

**Sealed blocks are immutable.** Full blocks (containing exactly `block_size` tokens) are never modified again. This is what makes sharing safe - there's no need for locks or copies on reads. Only the last partial block in a sequence is mutable, which is why CoW only triggers there.

The project is around 600 lines of core logic across five source files. It's not a GPU KV cache (no actual tensor management), but the allocation, eviction, prefix caching, and CoW logic are directly applicable to real inference engines. If you're building something in this space or just want to understand how vLLM's memory management works underneath, the code is at [github.com/ermolushka/kv-cache-scheduler](https://github.com/ermolushka/kv-cache-scheduler).
