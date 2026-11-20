#include "mic.h"

#include <M5Unified.h>

namespace {
constexpr uint32_t kSampleRate = 16000;
}

bool MicCapture::begin() {
  auto cfg = M5.Mic.config();
  cfg.sample_rate = kSampleRate;
  cfg.stereo = false;
  cfg.magnification = 16;
  cfg.noise_filter_level = 0;
  M5.Mic.config(cfg);
  return M5.Mic.begin();
}

int MicCapture::read(int16_t* buffer, int samples) {
  if (!M5.Mic.record(buffer, samples, kSampleRate)) return 0;
  return samples;
}

void MicCapture::end() { M5.Mic.end(); }
