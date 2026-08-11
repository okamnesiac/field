#pragma once

// One floating-point environment for both render paths (realtime.md
// decision 6): audio callbacks conventionally run with denormals flushed
// to zero, and bit-identity between the offline stem op and the live
// engine requires the offline pass to match. Flushing is output-invariant
// for everything in this directory today — the doubles it affects sit
// below 1e−308, which rounds to 0.0f at the float boundary either way,
// and every feedback path only decays — but that is an argument, and the
// render goldens are the check.

#if defined(__aarch64__) || defined(_M_ARM64)
#include <cstdint>
#elif defined(__SSE2__) || defined(_M_X64) || (defined(_M_IX86_FP) && _M_IX86_FP >= 2)
#include <immintrin.h>
#define FIELD_DSP_SSE 1
#endif

namespace field::dsp
{

// RAII: flush-to-zero (and denormals-are-zero where the ISA splits them)
// for the enclosing scope, restoring the previous mode on exit.
class ScopedFlushDenormals
{
public:
    ScopedFlushDenormals()
    {
#if defined(__aarch64__) || defined(_M_ARM64)
        asm volatile ("mrs %0, fpcr" : "=r" (saved));
        const uint64_t fz = saved | (1ull << 24); // FPCR.FZ
        asm volatile ("msr fpcr, %0" : : "r" (fz));
#elif defined(FIELD_DSP_SSE)
        saved = _mm_getcsr();
        _mm_setcsr (saved | 0x8040); // FTZ (bit 15) | DAZ (bit 6)
#endif
    }

    ~ScopedFlushDenormals()
    {
#if defined(__aarch64__) || defined(_M_ARM64)
        asm volatile ("msr fpcr, %0" : : "r" (saved));
#elif defined(FIELD_DSP_SSE)
        _mm_setcsr (saved);
#endif
    }

    ScopedFlushDenormals (const ScopedFlushDenormals&) = delete;
    ScopedFlushDenormals& operator= (const ScopedFlushDenormals&) = delete;

private:
#if defined(__aarch64__) || defined(_M_ARM64)
    uint64_t saved = 0;
#elif defined(FIELD_DSP_SSE)
    unsigned int saved = 0;
#endif
};

} // namespace field::dsp
