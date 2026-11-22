// Thin C FFI bridge over BitChord's AGPL-3.0 analyzer and GPL-3.0 Signalsmith loopmix renderer.
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>

#include "analyzer/audio_analysis.h"
#include "loopmix/loop_mix_renderer.h"
#include "signalsmith-stretch/signalsmith-stretch.h"

extern "C" {

struct NativeAnalysisSummary {
    double bpm;
    double beat_confidence;
    double first_beat;
    double mix_in_time;
    double mix_out_time;
    double loudness_lufs;
    double peak_dbfs;
    double vocal_probability;
    char key[16];
};

int32_t bitchord_analyze_audio(
    const float* samples,
    size_t len,
    double sample_rate,
    double duration,
    NativeAnalysisSummary* out
) {
    if (!samples || len == 0 || !out || sample_rate <= 0.0) {
        return -1;
    }
    std::vector<float> pcm(samples, samples + len);
    const auto res = bitchord::smart::AnalyzeAudio(pcm, sample_rate, duration);
    out->bpm = res.bpm;
    out->beat_confidence = res.beat_confidence;
    out->first_beat = res.first_beat;
    out->mix_in_time = res.mix_in_time;
    out->mix_out_time = res.mix_out_time;
    out->loudness_lufs = res.loudness_lufs;
    out->peak_dbfs = res.peak_dbfs;
    out->vocal_probability = res.vocal_probability;
    std::memset(out->key, 0, sizeof(out->key));
    if (!res.key.empty()) {
        std::strncpy(out->key, res.key.c_str(), sizeof(out->key) - 1);
    }
    return 0;
}

struct NativeStretcher {
    signalsmith::stretch::SignalsmithStretch<float> stretch;
    std::vector<float> in_l;
    std::vector<float> in_r;
    std::vector<float> out_l;
    std::vector<float> out_r;
};

NativeStretcher* bitchord_stretcher_create(int32_t sample_rate) {
    auto* s = new NativeStretcher();
    s->stretch.presetDefault(2, static_cast<float>(sample_rate));
    return s;
}

void bitchord_stretcher_reset(NativeStretcher* s) {
    if (s) s->stretch.reset();
}

void bitchord_stretcher_process(
    NativeStretcher* s,
    const float* interleaved_in,
    int32_t in_frames,
    float* interleaved_out,
    int32_t out_frames
) {
    if (!s || !interleaved_in || !interleaved_out || in_frames <= 0 || out_frames <= 0) {
        return;
    }
    s->in_l.resize(static_cast<size_t>(in_frames));
    s->in_r.resize(static_cast<size_t>(in_frames));
    for (int32_t i = 0; i < in_frames; ++i) {
        s->in_l[i] = interleaved_in[i * 2];
        s->in_r[i] = interleaved_in[i * 2 + 1];
    }
    s->out_l.resize(static_cast<size_t>(out_frames));
    s->out_r.resize(static_cast<size_t>(out_frames));
    const float* inputs[2] = { s->in_l.data(), s->in_r.data() };
    float* outputs[2] = { s->out_l.data(), s->out_r.data() };
    s->stretch.process(inputs, in_frames, outputs, out_frames);
    for (int32_t i = 0; i < out_frames; ++i) {
        interleaved_out[i * 2] = s->out_l[i];
        interleaved_out[i * 2 + 1] = s->out_r[i];
    }
}

void bitchord_stretcher_destroy(NativeStretcher* s) {
    delete s;
}

}  // extern "C"
