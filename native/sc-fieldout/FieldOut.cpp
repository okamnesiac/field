// FieldOut: an scsynth UGen that writes its two audio inputs into a ring
// field-audiod reads (live-supercollider.md §2, chunk 2), so the voice
// `field keys` plays reaches the daemon's live session instead of the
// output device.
//
//     FieldOut.ar(ring, left, right)
//
// `ring` is the number the daemon's `input` op answered. The UGen has no
// outputs. When the ring does not exist, or is not a layout this build
// reads, it says why once and writes nothing.
//
// Copyright (C) 2026 the Field authors.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version. It is distributed in the hope that it will be
// useful, but WITHOUT ANY WARRANTY; see the GNU General Public License in
// LICENSE beside this file. It is GPL because it builds against
// SuperCollider's plugin interface (vendor/supercollider), which is; the
// rest of Field is MIT, and shares only the ring's layout with it
// (native/ring/field_ring.h).

#include "SC_PlugIn.h"
#include "field_ring.h"

static InterfaceTable* ft;

struct FieldOut : public Unit
{
    field::ring::Mapping mapping;
};

static void FieldOut_next (FieldOut* unit, int inNumSamples)
{
    field::ring::write (unit->mapping.header, IN (1), IN (2), inNumSamples);
}

static void FieldOut_none (FieldOut*, int) {}

static void FieldOut_Ctor (FieldOut* unit)
{
    // Opening the ring is a system call on the audio thread, once per
    // synth: the voice host starts one FieldOut for as long as it plays,
    // so the cost lands before the first note.
    unit->mapping = {};
    const auto id = (uint32_t) IN0 (0);
    const char* error = nullptr;
    if (id == 0 || id >= field::ring::maxId)
        error = "ring numbers run from 1 to 2^24";
    else
        unit->mapping = field::ring::open (id, error);
    if (unit->mapping.header == nullptr)
    {
        Print ("FieldOut: ring %u: %s; writing nothing\n", id, error);
        SETCALC (FieldOut_none);
        return;
    }
    if (unit->mapping.header->sampleRate != (uint32_t) SAMPLERATE)
        Print ("FieldOut: ring %u runs at %u Hz and this server at %d Hz; the voice will play at the wrong pitch\n", id,
               unit->mapping.header->sampleRate, (int) SAMPLERATE);
    SETCALC (FieldOut_next);
}

static void FieldOut_Dtor (FieldOut* unit)
{
    field::ring::unmap (unit->mapping);
}

PluginLoad (FieldOut)
{
    ft = inTable;
    DefineDtorUnit (FieldOut);
}
