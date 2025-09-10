---
author: Alexey Ermolaev
pubDatetime: 2025-09-10T15:01:00Z
modDatetime: 2025-09-10T15:01:00Z
title: Memory Optimization Deep Dive: Running 8B Models on a Single 4090 using vLLM
slug: vllm-benchmark-8b-4090
featured: true
draft: false
tags:
  - vLLM
  - ML inference
  - CUDA
  - GPU
  - Llama
  - quantization
description: An exploration of quantization techniques and memory optimization strategies for running Llama 8B models efficiently on consumer hardware using vLLM
---

## Introduction

Running large language models like Llama 8B (8 billion parameters) on consumer hardware presents challenges around GPU memory constraints. The RTX 4090, despite its 24GB of VRAM, requires careful optimization to run these models effectively while maintaining good performance and quality.

This experiment examines different quantization techniques and memory optimization strategies, providing concrete benchmarks and insights for running 8B models on a single RTX 4090.

## The Memory Challenge

### Understanding Model Memory Requirements

A typical Llama 8B model in FP16 precision requires approximately:
- **Model Weights**: 8B × 2 bytes = 16GB
- **KV Cache**: Variable, depends on context length and batch size
- **Activation Memory**: ~2-4GB during inference
- **Framework Overhead**: ~1-2GB

This puts us right at the edge of what a 24GB RTX 4090 can handle, leaving little room for longer contexts or batch processing.

**Note**: The actual 22.6GB usage measured in my experiments includes KV cache, activations, and framework overhead, which are larger than the estimated 3-5GB due to vLLM's memory management and pre-allocation strategies.

## Experimental Setup

### Hardware Configuration
- **GPU**: NVIDIA RTX 4090 (24GB VRAM, Ada Lovelace architecture)
- **CPU**: AMD/Intel CPU with sufficient cores
- **RAM**: 32GB DDR4/DDR5 system memory
- **CUDA**: 13.0
- **Driver**: NVIDIA driver (581.15)

### Software Stack
- **vLLM**: v0.10.1.1 (for FP16, AWQ, GPTQ experiments)
- **Transformers**: v4.56.1 (for BitsAndBytes experiments)
- **BitsAndBytes**: v0.47.0 (for 4-bit quantization)
- **AutoAWQ**: v0.2.9 (for AWQ quantization)
- **AutoGPTQ**: v0.7.1 (for GPTQ quantization)

### Benchmarking Methodology

Each experiment follows a standardized protocol:
1. **Memory Baseline**: Record initial GPU memory state
2. **Model Loading**: Load model and measure memory increase
3. **Inference Test**: Run 7 representative prompts (256 tokens each)
4. **Performance Metrics**: Measure tokens/second, memory usage, load time

## Experiment 1: FP16 Baseline

*Establishing performance and memory baseline with standard FP16 precision.*

### Configuration
```python
llm = LLM(
   model="meta-llama/Meta-Llama-3.1-8B-Instruct",
   dtype="float16",
   tensor_parallel_size=1,
   gpu_memory_utilization=0.9,
   max_model_len=4096,
   enforce_eager=True,  # Disable CUDA graphs for more consistent memory measurement
)
```

### Results

| Metric | Value |
|--------|-------|
| GPU Memory Used | 22,631MB (92.1% of VRAM) |
| Load Time | 16.1s |
| Tokens/Second | 339.6 |
| Peak GPU Utilization | 99.2% |
| Model Quality | Baseline |

### Analysis

The FP16 baseline establishes performance reference point. As expected, the full-precision model consumes nearly all available VRAM on the RTX 4090, leaving only ~200MB free. The model loads in a reasonable 16 seconds and delivers solid inference performance at 339.6 tokens/second across my 7-prompt test suite.

This near-maximum VRAM usage (99.2%) demonstrates why quantization is essential for practical deployment - there's virtually no headroom for longer contexts, batch processing, or other optimizations.

## Experiment 2: BitsAndBytes 4-bit Quantization

*Testing the most accessible quantization method with an up-to-date tooling support.*

### Why BitsAndBytes?

BitsAndBytes offers several advantages:
- **Easy Integration**: Works directly with Transformers library
- **Quality Preservation**: Uses advanced quantization schemes (NF4, double quantization)
- **Flexible**: Supports mixed precision and selective quantization

### Configuration
```python
bnb_config = BitsAndBytesConfig(
   load_in_4bit=True,
   bnb_4bit_compute_dtype=torch.float16,
   bnb_4bit_use_double_quant=True,  # Nested quantization for additional memory savings
   bnb_4bit_quant_type="nf4",  # Normal Float 4-bit quantization
)
```

### Results

| Metric | Value | vs FP16 |
|--------|-------|---------|
| GPU Memory Used | 7,711MB (31.4% of VRAM) | 66% reduction |
| Load Time | 6.6s | 59% faster |
| Tokens/Second | 42.4 | 87% slower |
| Peak GPU Utilization | 38.5% | 61% lower |
| Memory Savings | 14.9GB | - |

### Memory Usage Breakdown

BitsAndBytes delivers exceptional memory optimization results:
- **Model footprint**: Reduced from 22.6GB to 7.7GB
- **Free VRAM**: 15.1GB available (vs 0.2GB with FP16)
- **Memory efficiency**: 66% reduction in GPU memory usage

This dramatic improvement opens up possibilities for:
- Longer context lengths (up to ~32K tokens estimated)
- Batch processing multiple requests
- Running additional models simultaneously

### Quality Impact

While BitsAndBytes achieves outstanding memory savings, it comes with a significant performance trade-off. Inference speed drops to 42.4 tokens/second (87% slower than FP16). However, the quality of outputs remains good thanks to:
- **NF4 quantization**: Optimized for neural network weights
- **Double quantization**: Further compression without major quality loss
- **FP16 compute**: Maintains precision during computation

## Experiment 3: AWQ (Activation-aware Weight Quantization)

*Exploring hardware-optimized quantization designed for inference speed.*

### AWQ Advantages

AWQ offers unique benefits:
- **Hardware Optimized**: Designed for efficient GPU inference
- **Activation Aware**: Considers activation patterns during quantization
- **Speed Focused**: Minimal performance overhead
- **vLLM Integration**: Out-of-the-box support in production inference engines

### Results

| Metric | Value | vs FP16 | vs BnB 4-bit |
|--------|-------|---------|--------------|
| GPU Memory Used | 22,686MB (92.4% of VRAM) | +0.2% | +194% |
| Load Time | 10.4s | 35% faster | -58% |
| Tokens/Second | 579.1 | +70% | +1265% |
| Peak GPU Utilization | 99.5% | +0.3% | +159% |

### Performance Analysis

AWQ delivers surprising results that challenge conventional assumptions about quantization:

**Unexpected Memory Usage**: Despite being 4-bit quantized, AWQ uses nearly identical memory to FP16 (22.7GB vs 22.6GB). This suggests the pre-quantized model includes additional metadata or the quantization benefits are offset by implementation overhead.

**Superior Performance**: AWQ excels in inference speed, delivering 579.1 tokens/second - a 70% improvement over FP16 and a massive 1265% improvement over BitsAndBytes. This demonstrates the hardware optimization focus of AWQ.

**Fast Loading**: Model loading is 35% faster than FP16, indicating efficient initialization of the pre-quantized weights.

## Experiment 4: GPTQ Quantization

*Testing the established post-training quantization method.*

### GPTQ Characteristics

GPTQ provides:
- **Mature Implementation**: Well-established quantization method
- **Good Compression**: Effective weight compression
- **Quality Trade-offs**: Balanced quality preservation
- **Broad Support**: Available across multiple frameworks

### Results

| Metric | Value | vs FP16 | vs AWQ | vs BnB 4-bit |
|--------|-------|---------|--------|--------------|
| GPU Memory Used | 22,689MB (92.4% of VRAM) | +0.3% | +0.0% | +194% |
| Load Time | 21.0s | -31% | -101% | -219% |
| Tokens/Second | 598.7 | +76% | +3% | +1312% |
| Peak GPU Utilization | 99.5% | +0.3% | +0.0% | +159% |

**Key Findings:**

GPTQ shows similar patterns to AWQ with some notable differences:

**Memory Usage**: Like AWQ, GPTQ uses nearly full VRAM (22.7GB) despite 4-bit quantization, suggesting these pre-quantized models don't deliver the expected memory savings in vLLM.

**Peak Performance**: GPTQ achieves the highest inference speed at 598.7 tokens/second, slightly outperforming AWQ and delivering 76% better performance than FP16.

**Slower Loading**: GPTQ takes significantly longer to load (21.0s vs 16.1s for FP16), likely due to model preprocessing or initialization overhead.

## Comparative Analysis

### Memory Efficiency Comparison

[Insert comprehensive comparison chart showing memory usage across all methods]

### Performance Trade-offs

| Method | Memory Usage | Memory Savings | Speed | Load Time | Ease of Use |
|--------|--------------|----------------|-------|-----------|-------------|
| FP16 Baseline | 22.6GB (92%) | - | 339 t/s | 16.1s | ⭐⭐⭐⭐⭐ |
| BitsAndBytes 4-bit | 7.7GB (31%) | **66%** | 42 t/s | 6.6s | ⭐⭐⭐⭐⭐ |
| AWQ | 22.7GB (92%) | 0% | **579** t/s | 10.4s | ⭐⭐⭐⭐ |
| GPTQ | 22.7GB (92%) | 0% | **599** t/s | 21.0s | ⭐⭐⭐ |

### Real-World Scenarios

#### Scenario 1: Interactive Chat Application
**Requirements**: Low latency, moderate context length, good quality
**Recommended**: **GPTQ** - Delivers the highest inference speed (599 t/s) for responsive user interactions. While it uses full VRAM, the performance benefit justifies the memory cost for single-user scenarios.

#### Scenario 2: Batch Processing
**Requirements**: High throughput, cost efficiency, acceptable quality
**Recommended**: **AWQ** - Offers excellent throughput (579 t/s) with faster loading than GPTQ. The slight speed difference is offset by better operational characteristics for batch workloads.

#### Scenario 3: Long Document Analysis
**Requirements**: Extended context, memory efficiency, quality preservation
**Recommended**: **BitsAndBytes 4-bit** - Despite slower inference, the 66% memory reduction enables processing much longer documents (32K+ tokens) that wouldn't fit with other methods. Quality remains excellent for analytical tasks.

## Advanced Optimization Techniques

### vLLM Configuration Tuning

Beyond quantization, several vLLM parameters significantly impact memory usage:

```yaml
# Memory-optimized configuration
memory_optimized:
  gpu_memory_utilization: 0.95
  max_model_len: 2048
  swap_space: 8
  cpu_offload_gb: 2
  block_size: 8
  max_num_seqs: 64
```

### System-Level Optimizations

1. **CUDA Memory Management**
   - Pre-allocate GPU memory
   - Disable memory fragmentation
   - Optimize CUDA context switching

2. **Operating System Tuning**
   - Increase virtual memory
   - Optimize page file settings
   - Configure GPU scheduling mode

3. **Hardware Considerations**
   - PCIe bandwidth optimization
   - CPU-GPU data transfer minimization
   - Thermal management


## My learnings

### Key Findings

1. **Memory vs Quality Trade-offs**: BitsAndBytes is the only method that delivers significant memory savings (66% reduction), making it essential for memory-constrained scenarios despite the performance penalty.

2. **Performance vs Memory Trade-off**: AWQ and GPTQ deliver 70-76% better performance than FP16 but use identical memory (22.7GB vs 22.6GB). This counterintuitive result suggests these "4-bit" models are optimized for speed in vLLM's implementation, trading memory savings for performance gains.

3. **Practical Considerations**: The choice between methods depends heavily on ymy bottleneck - memory constraints favor BitsAndBytes, while performance requirements favor AWQ/GPTQ.

### Surprising Results

**The Quantization Paradox**: AWQ and GPTQ 4-bit models used identical memory to FP16 (22.7GB vs 22.6GB) while delivering superior performance. This challenges the assumption that quantization always reduces memory usage and suggests:
- Pre-quantized models may include additional metadata
- vLLM's implementation optimizes for speed over memory savings
- The "4-bit" designation refers to weight storage, not runtime memory


## Possible recommendations

### For Different Use Cases

**Development and Experimentation**:
- **Start with BitsAndBytes 4-bit** for maximum memory headroom and experimentation flexibility
- Use conservative memory settings (gpu_memory_utilization=0.7)
- Monitor GPU temperature and usage with the provided monitoring tools

**Production Deployment**:
- **GPTQ for speed-critical applications** - 599 tokens/sec with proven stability
- **AWQ for throughput-focused workloads** - 579 tokens/sec with faster loading
- **BitsAndBytes for memory-critical deployments** - only option for extended context lengths
- Implement proper monitoring, error handling, and graceful degradation

**Resmyce-Constrained Scenarios**:
- **BitsAndBytes is ymy only viable option** for significant memory reduction
- Consider CPU offloading configurations for extreme cases
- Optimize context length based on actual requirements rather than maximums

### Future Considerations

1. **Emerging Quantization Methods**: [What's coming next]
2. **Hardware Evolution**: [Next-gen GPU considerations]
3. **Framework Improvements**: [Expected software advances]

## Conclusion

Running Llama 8B models on a single RTX 4090 reveals surprising insights about modern quantization techniques. my comprehensive benchmarking shows that the choice of method depends critically on ymy primary constraint:

**For Memory-Constrained Scenarios**: BitsAndBytes 4-bit is the clear winner, delivering 66% memory reduction (22.6GB → 7.7GB) with acceptable quality preservation, despite 87% slower inference.

**For Performance-Critical Applications**: GPTQ achieves the highest throughput at 599 tokens/second, while AWQ offers similar performance (579 t/s) with better loading characteristics.

**The Quantization Paradox**: my most surprising finding is that pre-quantized AWQ and GPTQ models use identical memory to FP16 while delivering 70-76% better performance. This challenges conventional wisdom about quantization being primarily a memory optimization technique.

**Key Takeaway**: Modern quantization is more nuanced than expected. BitsAndBytes remains essential for memory optimization, while AWQ/GPTQ excel as performance optimizations rather than memory savers. Understanding these trade-offs enables informed decisions for ymy specific deployment requirements.

## Appendix

### Complete Benchmark Results

| Metric | FP16 Baseline | BitsAndBytes 4-bit | AWQ | GPTQ |
|--------|---------------|-------------------|-----|------|
| **Memory Performance** ||||
| GPU Memory Used | 22,631MB | 7,711MB | 22,686MB | 22,689MB |
| GPU Utilization | 99.2% | 38.5% | 99.5% | 99.5% |
| Memory Savings vs FP16 | - | 66.0% | 0.0% | 0.0% |
| Free VRAM | 196MB | 15,110MB | 124MB | 121MB |
| **Performance Metrics** ||||
| Model Load Time | 16.1s | 6.6s | 10.4s | 21.0s |
| Inference Speed | 339.6 t/s | 42.4 t/s | 579.1 t/s | 598.7 t/s |
| Speed vs FP16 | - | -87.5% | +70.5% | +76.3% |
| Total Tokens Generated | 1,792 | 1,799 | 1,792 | 1,792 |
| **System Resmyces** ||||
| System RAM Increase | 1,024MB | 163MB | 1,062MB | 1,385MB |
| System RAM % | 9.6% | 9.0% | 9.7% | 10.6% |
| **Configuration** ||||
| Model Smyce | HuggingFace | HuggingFace | Pre-quantized | Pre-quantized |
| Quantization Bits | 16 | 4 (NF4) | 4 | 4 |
| Framework | vLLM | Transformers+BnB | vLLM | vLLM |


### Reproducibility

All experiments in this analysis are fully reproducible using the provided [code](https://github.com/ermolushka/vllm-benchmark)


---

*This analysis was conducted using automated benchmarking tools. All performance measurements are specific to the tested hardware configuration and may vary on different systems.*